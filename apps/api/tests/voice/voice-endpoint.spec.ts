import type Anthropic from '@anthropic-ai/sdk';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as request from 'supertest';

import { VoiceController } from '../../src/modules/voice/voice.controller';
import { VoiceTextDto } from '../../src/modules/voice/dto/voice-text.dto';
import {
  ClaudeAgentService,
  ANTHROPIC_CLIENT,
  AnthropicLike,
} from '../../src/modules/voice/agent/claude.agent';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
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
    const send = () =>
      request(app.getHttpServer())
        .post('/api/voice/text')
        .send({ sessionId: 'sess-abc123', message: 'hello' })
        .expect(200);

    expect((await send()).body.turnIndex).toBe(1);
    expect((await send()).body.turnIndex).toBe(2);
    expect((await send()).body.turnIndex).toBe(3);
  });

  it('keeps turn indexes independent per session', async () => {
    await request(app.getHttpServer())
      .post('/api/voice/text')
      .send({ sessionId: 'sess-one', message: 'hello' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/voice/text')
      .send({ sessionId: 'sess-one', message: 'hello again' })
      .expect(200);

    const other = await request(app.getHttpServer())
      .post('/api/voice/text')
      .send({ sessionId: 'sess-two', message: 'hello' })
      .expect(200);

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
    const send = (turnIndex: number) =>
      request(permissive.getHttpServer())
        .post('/api/voice/text')
        .send({ sessionId: 'sess-abc123', message: 'hello', turnIndex })
        .expect(200);

    expect((await send(500)).body.turnIndex).toBe(1);
    expect((await send(0)).body.turnIndex).toBe(2);
    expect((await send(-1)).body.turnIndex).toBe(3);
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
