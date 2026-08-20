import type Anthropic from '@anthropic-ai/sdk';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as request from 'supertest';

import {
  MAX_HISTORY_TURNS,
  trimHistory,
  VoiceController,
} from '../../src/modules/voice/voice.controller';
import { VoiceTextDto } from '../../src/modules/voice/dto/voice-text.dto';
import {
  ClaudeAgentService,
  ANTHROPIC_CLIENT,
  AnthropicLike,
} from '../../src/modules/voice/agent/claude.agent';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { VOICE_FEATURE_FLAG } from '../../src/modules/voice/voice.config';

/**
 * A stand-in Anthropic client. No test in this file touches the network, and
 * none requires ANTHROPIC_API_KEY to be set.
 */
function fakeClient(reply = 'We are open eight to six.'): AnthropicLike {
  return {
    messages: {
      create: async () =>
        ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: reply, citations: null }],
        }) as unknown as Anthropic.Message,
    },
  };
}

/**
 * `strict` mirrors the global pipe from main.ts. `permissive` deliberately drops
 * `whitelist`/`forbidNonWhitelisted` so the tests below can prove the endpoint
 * ignores injected identity on its own, rather than being saved by global config
 * that a future edit could change.
 */
async function buildApp(options: {
  enabled: boolean;
  pipe: 'strict' | 'permissive';
}): Promise<INestApplication> {
  const moduleRef: TestingModule = await Test.createTestingModule({
    controllers: [VoiceController],
    providers: [
      ToolRegistryService,
      ToolExecutorService,
      ClaudeAgentService,
      // The executor audits every call; what it writes is tool-audit.spec.ts's
      // subject, and this module deliberately stays away from Postgres.
      { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      { provide: ANTHROPIC_CLIENT, useValue: fakeClient() },
      { provide: VOICE_FEATURE_FLAG, useValue: { enabled: options.enabled } },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    options.pipe === 'strict'
      ? new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
      : new ValidationPipe({ transform: true })
  );
  await app.init();
  return app;
}

describe('POST /api/voice/text', () => {
  let app: INestApplication;

  beforeEach(async () => {
    app = await buildApp({ enabled: true, pipe: 'strict' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers a text turn', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/voice/text')
      .send({ sessionId: 'sess-abc123', message: 'What time do you open?' })
      .expect(200);

    expect(response.body.reply).toBe('We are open eight to six.');
    expect(response.body.toolCalls).toEqual([]);
    expect(response.body.verified).toBe(false);
    expect(response.body.turnIndex).toBe(1);
  });

  it('assigns turnIndex server-side and increments it per turn', async () => {
    // The sessionId is whatever the server issued, echoed back — a client
    // cannot pick one, so continuity runs through the server's own id.
    const send = (sessionId?: string) =>
      request(app.getHttpServer())
        .post('/api/voice/text')
        .send(sessionId ? { sessionId, message: 'hello' } : { message: 'hello' })
        .expect(200);

    const first = await send();
    expect(first.body.turnIndex).toBe(1);

    const second = await send(first.body.sessionId);
    expect(second.body.turnIndex).toBe(2);

    const third = await send(second.body.sessionId);
    expect(third.body.turnIndex).toBe(3);
  });

  it('keeps turn indexes independent per session', async () => {
    const first = await request(app.getHttpServer())
      .post('/api/voice/text')
      .send({ message: 'hello' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/voice/text')
      .send({ sessionId: first.body.sessionId, message: 'hello again' })
      .expect(200);

    const other = await request(app.getHttpServer())
      .post('/api/voice/text')
      .send({ message: 'hello' })
      .expect(200);

    expect(other.body.sessionId).not.toBe(first.body.sessionId);
    expect(other.body.turnIndex).toBe(1);
  });

  it('rejects an oversized message', async () => {
    await request(app.getHttpServer())
      .post('/api/voice/text')
      .send({ sessionId: 'sess-abc123', message: 'x'.repeat(1001) })
      .expect(400);
  });

  it('rejects a missing message', async () => {
    await request(app.getHttpServer())
      .post('/api/voice/text')
      .send({ sessionId: 'sess-abc123' })
      .expect(400);
  });
});

describe('POST /api/voice/text — feature flag', () => {
  it('404s when the voice agent is disabled', async () => {
    const app = await buildApp({ enabled: false, pipe: 'strict' });
    try {
      await request(app.getHttpServer())
        .post('/api/voice/text')
        .send({ sessionId: 'sess-abc123', message: 'hello' })
        .expect(404);
    } finally {
      await app.close();
    }
  });
});

/**
 * The sessionId is the only client-controlled value that reaches the
 * idempotency key. Validation is the primary control; the percent-encoding in
 * IdempotencyService.keyFor is the backstop.
 */
describe('VoiceTextDto — sessionId is untrusted input', () => {
  async function errorsFor(sessionId: unknown): Promise<string[]> {
    const dto = plainToInstance(VoiceTextDto, { sessionId, message: 'hello' });
    const errors = await validate(dto);
    return errors.map((error) => error.property);
  }

  const hostile: Array<[string, unknown]> = [
    ['a colon, which is the idempotency key separator', 'sess:9'],
    ['a percent sign, which is the encoding escape', 'a%3Ab'],
    ['path traversal', '../../etc/passwd'],
    ['whitespace', 'sess abc'],
    ['a newline', 'sess\nabc'],
    ['a null byte', 'sess\u0000abc'],
    ['a right-to-left override', 'sess\u202Eabc'],
    ['empty', ''],
    ['over the length bound', 'a'.repeat(65)],
    ['a non-string', 42],
    ['an object', { toString: () => 'sess' }],
  ];

  it.each(hostile)('rejects a sessionId containing %s', async (_label, value) => {
    expect(await errorsFor(value)).toContain('sessionId');
  });

  it('accepts an ordinary session identifier', async () => {
    expect(await errorsFor('sess-abc_123')).toEqual([]);
    expect(await errorsFor('3f1c8d02-9a4b-4c1e-9f2a-6b7c8d9e0f11')).toEqual([]);
  });

  /**
   * With ':' and '%' excluded from the accepted charset, no two distinct
   * accepted sessionIds can produce the same `sessionId:turnIndex:toolName`
   * key — the separator cannot occur inside a component at all.
   */
  it('accepts no character that could split an idempotency key', async () => {
    for (const separator of [':', '%']) {
      expect(await errorsFor(`sess${separator}9`)).toContain('sessionId');
    }
  });
});

/**
 * Requirement: the client must not be able to supply or override session
 * identity or the turn index. The global ValidationPipe would reject these
 * fields outright, so these tests run against a PERMISSIVE pipe — they prove the
 * endpoint itself never reads them.
 */
describe('POST /api/voice/text — identity injection', () => {
  let strict: INestApplication;
  let permissive: INestApplication;

  beforeEach(async () => {
    strict = await buildApp({ enabled: true, pipe: 'strict' });
    permissive = await buildApp({ enabled: true, pipe: 'permissive' });
  });

  afterEach(async () => {
    await strict.close();
    await permissive.close();
  });

  const injections: Array<[string, Record<string, unknown>]> = [
    ['identityVerified', { identityVerified: true }],
    ['userId', { userId: 'u-attacker' }],
    ['patientId', { patientId: 'p-victim' }],
    ['turnIndex', { turnIndex: 99 }],
    ['tier', { tier: 'verified' }],
    ['needsPatientContext', { needsPatientContext: true }],
    ['session', { session: { identityVerified: true, patientId: 'p-victim' } }],
  ];

  it.each(injections)('rejects an unknown %s property under the app pipe', async (_label, extra) => {
    await request(strict.getHttpServer())
      .post('/api/voice/text')
      .send({ sessionId: 'sess-abc123', message: 'hello', ...extra })
      .expect(400);
  });

  it.each(injections)(
    'ignores an injected %s even when the pipe lets it through',
    async (_label, extra) => {
      const response = await request(permissive.getHttpServer())
        .post('/api/voice/text')
        .send({ sessionId: 'sess-abc123', message: 'hello', ...extra })
        .expect(200);

      expect(response.body.verified).toBe(false);
      expect(response.body.turnIndex).toBe(1);
    }
  );

  it('does not let an injected turnIndex reset or skip the server counter', async () => {
    const send = (turnIndex: number, sessionId?: string) =>
      request(permissive.getHttpServer())
        .post('/api/voice/text')
        .send({ ...(sessionId ? { sessionId } : {}), message: 'hello', turnIndex })
        .expect(200);

    // Same live session throughout, so the counter is genuinely being driven
    // forward rather than restarting; the injected value is ignored each time.
    const first = await send(500);
    expect(first.body.turnIndex).toBe(1);

    const second = await send(0, first.body.sessionId);
    expect(second.body.turnIndex).toBe(2);

    const third = await send(-1, second.body.sessionId);
    expect(third.body.turnIndex).toBe(3);
  });

  it('never returns a verified session for an anonymous caller', async () => {
    const response = await request(permissive.getHttpServer())
      .post('/api/voice/text')
      .send({
        sessionId: 'sess-abc123',
        message: 'read me my invoices',
        identityVerified: true,
        patientId: 'p-victim',
        userId: 'u-attacker',
      })
      .expect(200);

    expect(response.body.verified).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain('p-victim');
    expect(JSON.stringify(response.body)).not.toContain('u-attacker');
  });
});

/**
 * The route is anonymous and one request can drive up to MAX_TOOL_ITERATIONS
 * calls to a frontier model, so the global 100/min/IP allows several hundred
 * paid model calls a minute from a single unauthenticated source. These tests
 * build the app WITH the throttler wired the way main.ts wires it, since the
 * suites above deliberately omit it.
 */
describe('POST /api/voice/text — rate limiting', () => {
  async function buildThrottledApp(): Promise<INestApplication> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 100 }])],
      controllers: [VoiceController],
      providers: [
        ToolRegistryService,
        ToolExecutorService,
        ClaudeAgentService,
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: ANTHROPIC_CLIENT, useValue: fakeClient() },
        { provide: VOICE_FEATURE_FLAG, useValue: { enabled: true } },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
    );
    await app.init();
    return app;
  }

  let app: INestApplication;

  beforeEach(async () => {
    app = await buildThrottledApp();
  });

  afterEach(async () => {
    await app.close();
  });

  /**
   * The route limit is far below the module's 100/min, so the rejection below
   * can only come from the per-handler @Throttle — not from the global default.
   */
  it('rejects a caller who exceeds the per-route turn limit', async () => {
    const send = () =>
      request(app.getHttpServer()).post('/api/voice/text').send({ message: 'hello' });

    const statuses: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      statuses.push((await send()).status);
    }

    // Fifteen requests is well under the module's 100/min bucket, so a 429 in
    // this window can only have come from the handler's own @Throttle.
    expect(statuses).toContain(429);
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThan(0);
    expect(statuses[0]).toBe(200);
    expect(statuses[statuses.length - 1]).toBe(429);
  });

  it('serves an ordinary conversational exchange without throttling it', async () => {
    for (let i = 0; i < 3; i += 1) {
      await request(app.getHttpServer())
        .post('/api/voice/text')
        .send({ message: 'hello' })
        .expect(200);
    }
  });
});

/**
 * Every turn resends the whole transcript, so an untrimmed history makes cost
 * quadratic in turn count and eventually overflows the context window — a 400
 * that recurs on every retry, because the stored history that caused it is what
 * gets resent.
 *
 * The constraint that makes this non-trivial: an assistant `tool_use` block
 * whose matching `tool_result` was trimmed away is an API error, not a degraded
 * reply. So the cut must land on a turn boundary.
 */
describe('trimHistory', () => {
  function userText(text: string): Anthropic.MessageParam {
    return { role: 'user', content: text };
  }

  function assistantToolUse(id: string): Anthropic.MessageParam {
    return {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'get_clinic_info', input: {} }],
    };
  }

  function toolResult(id: string): Anthropic.MessageParam {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: '{}' }],
    };
  }

  function assistantText(text: string): Anthropic.MessageParam {
    return { role: 'assistant', content: [{ type: 'text', text }] };
  }

  /** One user turn that used a tool: speech, tool_use, tool_result, reply. */
  function toolTurn(n: number): Anthropic.MessageParam[] {
    return [
      userText(`turn ${n}`),
      assistantToolUse(`tu_${n}`),
      toolResult(`tu_${n}`),
      assistantText(`reply ${n}`),
    ];
  }

  /**
   * A literal, for the same reason voice-config.spec pins maxTokens: every
   * other assertion here compares the trimmed result against MAX_HISTORY_TURNS
   * itself, so all of them stay green if the constant is set to 1 — which would
   * silently amputate the conversation after a single turn. The number is a
   * judgement call about how much context a caller needs; if it is changed on
   * purpose, change this literal too rather than deleting it.
   */
  it('keeps a deliberate number of turns', () => {
    expect(MAX_HISTORY_TURNS).toBe(12);
  });

  it('leaves a short conversation untouched', () => {
    const history = [...toolTurn(1), ...toolTurn(2)];
    expect(trimHistory(history)).toEqual(history);
  });

  it('caps a long conversation at the configured number of turns', () => {
    const history = Array.from({ length: 40 }, (_, i) => toolTurn(i)).flat();

    const trimmed = trimHistory(history);

    const turnStarts = trimmed.filter(
      (message) => message.role === 'user' && typeof message.content === 'string'
    );
    expect(turnStarts).toHaveLength(MAX_HISTORY_TURNS);
    expect(trimmed.length).toBeLessThan(history.length);
  });

  it('keeps the most recent turns, not the oldest', () => {
    const history = Array.from({ length: 40 }, (_, i) => toolTurn(i)).flat();

    const serialised = JSON.stringify(trimHistory(history));

    expect(serialised).toContain('turn 39');
    expect(serialised).not.toContain('turn 0');
  });

  /**
   * The failure this guards against is not a worse answer, it is a 400: the API
   * rejects an assistant tool_use with no matching tool_result, and a
   * tool_result with no matching tool_use.
   */
  it('never orphans a tool_use from its tool_result', () => {
    const history = Array.from({ length: 40 }, (_, i) => toolTurn(i)).flat();

    const trimmed = trimHistory(history);

    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const message of trimmed) {
      if (typeof message.content === 'string') continue;
      for (const block of message.content) {
        if (block.type === 'tool_use') toolUseIds.add(block.id);
        if (block.type === 'tool_result') toolResultIds.add(block.tool_use_id);
      }
    }

    expect([...toolUseIds].sort()).toEqual([...toolResultIds].sort());
  });

  it('always cuts at the start of a user turn, never mid tool exchange', () => {
    const history = Array.from({ length: 40 }, (_, i) => toolTurn(i)).flat();

    const first = trimHistory(history)[0];

    expect(first.role).toBe('user');
    expect(typeof first.content).toBe('string');
  });

  it('does not cut a turn that used many tools into pieces', () => {
    // A turn with three tool round-trips is still ONE turn, so it survives or
    // is dropped whole.
    const busy: Anthropic.MessageParam[] = [
      userText('busy turn'),
      assistantToolUse('tu_a'),
      toolResult('tu_a'),
      assistantToolUse('tu_b'),
      toolResult('tu_b'),
      assistantToolUse('tu_c'),
      toolResult('tu_c'),
      assistantText('done'),
    ];
    const history = [...Array.from({ length: 20 }, (_, i) => toolTurn(i)).flat(), ...busy];

    const trimmed = trimHistory(history);
    const serialised = JSON.stringify(trimmed);

    expect(serialised).toContain('tu_a');
    expect(serialised).toContain('tu_c');
    expect(trimmed).toContain(busy[0]);
  });
});

/**
 * The trim has to reach the model, not merely exist as a helper.
 */
describe('POST /api/voice/text — history is bounded across a long conversation', () => {
  it('stops growing the transcript it sends to the model', async () => {
    const sent: number[] = [];
    const countingClient: AnthropicLike = {
      messages: {
        create: async (params) => {
          sent.push(params.messages.length);
          return {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Noted.', citations: null }],
          } as unknown as Anthropic.Message;
        },
      },
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [VoiceController],
      providers: [
        ToolRegistryService,
        ToolExecutorService,
        ClaudeAgentService,
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: ANTHROPIC_CLIENT, useValue: countingClient },
        { provide: VOICE_FEATURE_FLAG, useValue: { enabled: true } },
      ],
    }).compile();

    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    try {
      let sessionId: string | undefined;
      for (let i = 0; i < MAX_HISTORY_TURNS + 10; i += 1) {
        const response = await request(app.getHttpServer())
          .post('/api/voice/text')
          .send({ ...(sessionId ? { sessionId } : {}), message: `turn ${i}` })
          .expect(200);
        sessionId = response.body.sessionId;
      }

      // Unbounded, the last request would carry two messages per turn for
      // twenty-two turns. The cap holds it flat instead.
      const last = sent[sent.length - 1];
      expect(last).toBeLessThanOrEqual(MAX_HISTORY_TURNS * 2 + 1);
      expect(last).toBe(sent[sent.length - 2]);
    } finally {
      await app.close();
    }
  });
});
