import type Anthropic from '@anthropic-ai/sdk';
import type { Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

import { VoiceGateway } from '../../src/modules/voice/transport/voice.gateway';
import { VoiceTurnRunner } from '../../src/modules/voice/transport/voice-turn-runner';
import { AudioTransport } from '../../src/modules/voice/transport/audio-transport.interface';
import { ServerFrame } from '../../src/modules/voice/transport/frames';
import {
  VoiceErrorCode,
  VOICE_ERROR_CODES,
} from '../../src/modules/voice/transport/error-codes';
import {
  toClientError,
  logServerError,
} from '../../src/modules/voice/transport/error-mapper';
import { TEXT_TO_SPEECH_FACTORY, TextToSpeech } from '../../src/modules/voice/speech/text-to-speech.interface';
import {
  SPEECH_TO_TEXT_FACTORY,
  SpeechToText,
} from '../../src/modules/voice/speech/speech-to-text.interface';
import { VoiceSessionStore } from '../../src/modules/voice/session/voice-session.store';
import {
  ClaudeAgentService,
  ANTHROPIC_CLIENT,
  AnthropicLike,
} from '../../src/modules/voice/agent/claude.agent';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { IdempotencyService } from '../../src/modules/voice/idempotency/idempotency.service';

class FakeTransport implements AudioTransport {
  readonly sent: ServerFrame[] = [];
  closedWith: VoiceErrorCode | null = null;
  send(f: ServerFrame): void {
    this.sent.push(f);
  }
  sendAudio(): void {}
  close(c: VoiceErrorCode): void {
    this.closedWith = c;
  }
  onTeardown(): void {}
  typesSent(): string[] {
    return this.sent.map((f) => f.type);
  }
}

/** Errors that carry exactly the sort of detail that must never leave the server. */
const LEAKY_ERRORS: Array<[string, unknown]> = [
  ['socket', new Error('connect ECONNREFUSED 10.0.0.5:5432')],
  ['deepgram', new Error('Deepgram: 401 Unauthorized (project 9f2a)')],
  ['elevenlabs', new Error('ElevenLabs quota exceeded for voice rachel')],
  ['anthropic', new Error('AnthropicError: overloaded_error')],
  ['prisma', Object.assign(new Error('PrismaClientKnownRequestError'), { code: 'P2002' })],
];

const FORBIDDEN = /ECONNREFUSED|10\.0\.0\.5|5432|Deepgram|401|9f2a|ElevenLabs|quota|rachel|Anthropic|overloaded|Prisma|P2002/i;

async function buildGatewayThatThrows(error: unknown) {
  const client: AnthropicLike = {
    messages: {
      create: async () => {
        throw error;
      },
    },
  };

  const providers: Provider[] = [
    VoiceGateway,
    VoiceTurnRunner,
    VoiceSessionStore,
    ToolRegistryService,
    ToolExecutorService,
    ClaudeAgentService,
    IdempotencyService,
    { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
    { provide: ANTHROPIC_CLIENT, useValue: client },
  ];

  const moduleRef = await Test.createTestingModule({ providers }).compile();
  return { gateway: moduleRef.get(VoiceGateway) };
}

async function buildGatewayWithThrowingRunner(error: unknown) {
  const client: AnthropicLike = {
    messages: {
      create: async () =>
        ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok', citations: null }],
        }) as unknown as Anthropic.Message,
    },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      VoiceGateway,
      VoiceSessionStore,
      ToolRegistryService,
      ToolExecutorService,
      ClaudeAgentService,
      IdempotencyService,
      { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      { provide: ANTHROPIC_CLIENT, useValue: client },
      {
        provide: VoiceTurnRunner,
        useValue: {
          runTurn: async () => {
            throw error;
          },
        },
      },
    ],
  }).compile();

  return { gateway: moduleRef.get(VoiceGateway) };
}

/** A recogniser that cannot start, carrying provider detail in its failure. */
async function buildGatewayWithFailingStt(error: unknown) {
  const client: AnthropicLike = {
    messages: {
      create: async () =>
        ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok', citations: null }],
        }) as unknown as Anthropic.Message,
    },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      VoiceGateway,
      VoiceTurnRunner,
      VoiceSessionStore,
      ToolRegistryService,
      ToolExecutorService,
      ClaudeAgentService,
      IdempotencyService,
      { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      { provide: ANTHROPIC_CLIENT, useValue: client },
      {
        provide: SPEECH_TO_TEXT_FACTORY,
        useValue: () =>
          ({
            async start() {
              throw error;
            },
            write() {},
            async end() {},
            onPartial() {},
            onFinal() {},
          }) as SpeechToText,
      },
    ],
  }).compile();

  return { gateway: moduleRef.get(VoiceGateway) };
}

/** A synthesiser that throws whatever it is given, on every attempt. */
function throwingTtsFactory(error: unknown) {
  return () =>
    ({
      // eslint-disable-next-line require-yield -- the point is that it throws
      async *synthesise(): AsyncIterable<Buffer> {
        throw error;
      },
      cancel(): void {},
    }) as TextToSpeech;
}

async function buildGatewayWithThrowingTts(error: unknown) {
  const client: AnthropicLike = {
    messages: {
      create: async () =>
        ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'We are open eight to six.', citations: null }],
        }) as unknown as Anthropic.Message,
    },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      VoiceGateway,
      VoiceTurnRunner,
      VoiceSessionStore,
      ToolRegistryService,
      ToolExecutorService,
      ClaudeAgentService,
      IdempotencyService,
      { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      { provide: ANTHROPIC_CLIENT, useValue: client },
      { provide: TEXT_TO_SPEECH_FACTORY, useValue: throwingTtsFactory(error) },
    ],
  }).compile();

  return { gateway: moduleRef.get(VoiceGateway) };
}

describe('the error mapper', () => {
  it.each(LEAKY_ERRORS)('maps a %s error to an enumerated code and nothing else', (_label, error) => {
    const frame = toClientError(error, 'internal');

    expect(VOICE_ERROR_CODES).toContain(frame.code);
    expect(Object.keys(frame).sort()).toEqual(['code', 'type']);
    expect(JSON.stringify(frame)).not.toMatch(FORBIDDEN);
  });

  it('returns the fallback code it was given', () => {
    expect(toClientError(new Error('x'), 'stt_unavailable').code).toBe('stt_unavailable');
    expect(toClientError(new Error('x'), 'agent_unavailable').code).toBe('agent_unavailable');
  });

  it('handles a thrown non-error without reading it', () => {
    const frame = toClientError('Deepgram: 401 Unauthorized', 'internal');
    expect(JSON.stringify(frame)).not.toMatch(FORBIDDEN);
    expect(frame).toEqual({ type: 'error', code: 'internal' });
  });

  it('logs the real error against logId, and never a session id', () => {
    const lines: string[] = [];
    const logger = { error: (m: string) => lines.push(m) } as unknown as Logger;

    logServerError(logger, 'aaaaaaaaaaaaaaaa', new Error('Deepgram: 401 Unauthorized (project 9f2a)'));

    // The detail must reach the server log — that is the whole point of not
    // sending it to the client.
    expect(lines.join('\n')).toContain('Deepgram: 401 Unauthorized');
    expect(lines.join('\n')).toContain('aaaaaaaaaaaaaaaa');
  });

  it('logs a thrown non-error without crashing', () => {
    const lines: string[] = [];
    const logger = { error: (m: string) => lines.push(m) } as unknown as Logger;

    expect(() => logServerError(logger, 'bbbbbbbbbbbbbbbb', { weird: true })).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe('no provider text reaches the client through the gateway', () => {
  it.each(LEAKY_ERRORS)('an agent %s failure surfaces as an enumerated code', async (_l, error) => {
    const { gateway } = await buildGatewayThatThrows(error);
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    await gateway.handleFrame(t, { type: 'turn.text', text: 'hours?' });

    expect(JSON.stringify(t.sent)).not.toMatch(FORBIDDEN);
    for (const frame of t.sent) {
      if (frame.type === 'error') {
        expect(Object.keys(frame).sort()).toEqual(['code', 'type']);
      }
    }
  });

  it.each(LEAKY_ERRORS)('a synthesis %s failure surfaces as tts_unavailable only', async (_l, error) => {
    const { gateway } = await buildGatewayWithThrowingTts(error);
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    await gateway.handleFrame(t, { type: 'turn.text', text: 'hours?' });

    expect(JSON.stringify(t.sent)).not.toMatch(FORBIDDEN);
    expect(t.sent).toContainEqual({ type: 'error', code: 'tts_unavailable' });
  });

  it('does not let an unexpected throw escape handleFrame as a rejected promise', async () => {
    // ClaudeAgentService catches its own failures, so a model outage never
    // throws — see the front-desk test below. This reproduces the case that
    // does escape: something the transport calls failing unexpectedly.
    const { gateway } = await buildGatewayWithThrowingRunner(
      new Error('connect ECONNREFUSED 10.0.0.5:5432')
    );
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    // An unhandled rejection here would take the connection down without ever
    // telling the caller anything.
    await expect(
      gateway.handleFrame(t, { type: 'turn.text', text: 'hours?' })
    ).resolves.toBeUndefined();
    expect(t.sent).toContainEqual({ type: 'error', code: 'agent_unavailable' });
    expect(JSON.stringify(t.sent)).not.toMatch(FORBIDDEN);
  });

  it('turns a model outage into the front-desk reply, not an error code', async () => {
    // Phase 0 behaviour, preserved: the caller hears a handoff sentence rather
    // than a failure. Nothing here should convert that into an error frame.
    const { gateway } = await buildGatewayThatThrows(new Error('AnthropicError: overloaded_error'));
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    await gateway.handleFrame(t, { type: 'turn.text', text: 'hours?' });

    const spoken = t.sent.find((f) => f.type === 'reply.text') as { text: string };
    expect(spoken.text).toMatch(/front desk/i);
    expect(t.sent).not.toContainEqual({ type: 'error', code: 'agent_unavailable' });
    expect(JSON.stringify(t.sent)).not.toMatch(FORBIDDEN);
  });

  it.each(LEAKY_ERRORS)('a recogniser %s failure surfaces as stt_unavailable only', async (_l, error) => {
    const { gateway } = await buildGatewayWithFailingStt(error);
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    await gateway.handleAudio(t, Buffer.alloc(640));

    expect(JSON.stringify(t.sent)).not.toMatch(FORBIDDEN);
    expect(t.sent).toContainEqual({ type: 'error', code: 'stt_unavailable' });
    for (const frame of t.sent) {
      if (frame.type === 'error') {
        expect(Object.keys(frame).sort()).toEqual(['code', 'type']);
      }
    }
  });

  it('never sends a frame carrying more than type and code on any error path', async () => {
    const { gateway } = await buildGatewayThatThrows(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    await gateway.handleFrame(t, { type: 'turn.text', text: 'hours?' });
    await gateway.handleFrame(t, { type: 'turn.text', text: 'hi', patientId: 'p1' });

    const errors = t.sent.filter((f) => f.type === 'error');
    expect(errors.length).toBeGreaterThan(0);
    for (const frame of errors) {
      expect(Object.keys(frame).sort()).toEqual(['code', 'type']);
    }
  });
});

describe('server-side logging', () => {
  it('logs the real error against logId without the session id', async () => {
    const lines: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((m) => lines.push(String(m)));

    const { gateway } = await buildGatewayWithThrowingRunner(
      new Error('Deepgram: 401 Unauthorized (project 9f2a)')
    );
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    const sessionId = (t.sent[0] as { sessionId: string }).sessionId;

    await gateway.handleFrame(t, { type: 'turn.text', text: 'hours?' });

    const joined = lines.join('\n');
    expect(joined).toContain('Deepgram: 401 Unauthorized');
    expect(joined).not.toContain(sessionId);
    expect(joined).toMatch(/[0-9a-f]{16}/);

    spy.mockRestore();
  });

  it('logs a bounded synthesis retry against logId', async () => {
    const lines: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((m) => lines.push(String(m)));

    const { gateway } = await buildGatewayWithThrowingTts(new Error('transient upstream failure'));
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    const sessionId = (t.sent[0] as { sessionId: string }).sessionId;

    await gateway.handleFrame(t, { type: 'turn.text', text: 'hours?' });

    // Spec: every retry is bounded AND logged against logId.
    const joined = lines.join('\n');
    expect(joined).toMatch(/retr/i);
    expect(joined).toMatch(/[0-9a-f]{16}/);
    expect(joined).not.toContain(sessionId);
    expect(joined).not.toMatch(FORBIDDEN);

    spy.mockRestore();
  });
});

describe('the global HTTP filter is left alone', () => {
  it('still returns exception.message, because that is a later phase', () => {
    const source = readFileSync(
      join(__dirname, '../../src/common/filters/all-exceptions.filter.ts'),
      'utf8'
    );
    expect(source).toContain('exception.message');
  });
});

// ---------------------------------------------------------------------------
// The error boundary has two lanes, and they must not blur:
//
//   1. Direct `type: 'error'` sends carry a CLOSED, server-defined literal
//      code derived from protocol state (a malformed frame, an expired
//      session, a limit reached). These hold no error object, so there is
//      nothing to leak.
//   2. Anything derived from a caught exception or a provider must pass
//      through toClientError(), which never reads the error.
//
// A caught exception reaching lane 1 is how provider text starts leaking, so
// the distinction is enforced statically rather than trusted.
// ---------------------------------------------------------------------------

const TRANSPORT_DIR = join(__dirname, '../../src/modules/voice/transport');

/** Extracts each catch block's body by brace matching. */
function catchBodies(source: string): string[] {
  const bodies: string[] = [];
  const pattern = /catch\s*(?:\([^)]*\))?\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') depth -= 1;
      i += 1;
    }
    bodies.push(source.slice(start, i - 1));
  }

  return bodies;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('the error boundary keeps its two lanes separate', () => {
  const files = readdirSync(TRANSPORT_DIR).filter((f) => f.endsWith('.ts'));

  it('has transport files to check', () => {
    // A sweep over an empty directory passes for the wrong reason.
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files)('%s: every direct error send uses a closed literal code', (file) => {
    const source = stripComments(readFileSync(join(TRANSPORT_DIR, file), 'utf8'));
    const sends = [...source.matchAll(/type:\s*'error'\s*,\s*code:\s*([^\s,}]+)/g)];

    for (const [, code] of sends) {
      // A quoted literal, and one the enumeration actually declares.
      expect(code).toMatch(/^'[a-z_]+'$/);
      expect(VOICE_ERROR_CODES).toContain(code.slice(1, -1) as VoiceErrorCode);
    }
  });

  it.each(files)('%s: no catch block builds an error frame by hand', (file) => {
    const source = stripComments(readFileSync(join(TRANSPORT_DIR, file), 'utf8'));

    for (const body of catchBodies(source)) {
      // Inside a catch there is an error object in scope, so a hand-built
      // frame is exactly where provider text starts riding along. The mapper
      // is the only sanctioned way out.
      expect(body).not.toMatch(/type:\s*'error'/);
    }
  });

  it('the mapper is the only thing that ever receives an error object', () => {
    const source = stripComments(readFileSync(join(TRANSPORT_DIR, 'voice.gateway.ts'), 'utf8'));

    for (const body of catchBodies(source)) {
      if (!/\berror\b/.test(body)) {
        continue;
      }
      // A catch that names its error must hand it to the mapper, the logger,
      // or rethrow it — never to transport.send.
      const usesSanctioned =
        /toClientError\(/.test(body) || /logServerError\(/.test(body) || /logRetry\(/.test(body) ||
        /lastError\s*=\s*error/.test(body);
      expect(usesSanctioned).toBe(true);
    }
  });
});
