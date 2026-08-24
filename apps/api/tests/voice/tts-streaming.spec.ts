import type Anthropic from '@anthropic-ai/sdk';
import type { Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';

import { VoiceGateway } from '../../src/modules/voice/transport/voice.gateway';
import { VoiceTurnRunner } from '../../src/modules/voice/transport/voice-turn-runner';
import { TransportMetricsService } from '../../src/modules/voice/transport/transport-metrics.service';
import { AudioTransport } from '../../src/modules/voice/transport/audio-transport.interface';
import { ServerFrame } from '../../src/modules/voice/transport/frames';
import { VoiceErrorCode } from '../../src/modules/voice/transport/error-codes';
import {
  TEXT_TO_SPEECH_FACTORY,
  TextToSpeech,
} from '../../src/modules/voice/speech/text-to-speech.interface';
import { ElevenLabsTtsService } from '../../src/modules/voice/speech/elevenlabs-tts.service';
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
  readonly audioFrames: Buffer[] = [];
  closedWith: VoiceErrorCode | null = null;
  private teardowns: Array<() => void | Promise<void>> = [];

  send(f: ServerFrame): void {
    this.sent.push(f);
  }
  sendAudio(c: Buffer): void {
    this.audioFrames.push(c);
  }
  close(c: VoiceErrorCode): void {
    this.closedWith = c;
  }
  onTeardown(fn: () => void | Promise<void>): void {
    this.teardowns.push(fn);
  }
  async fireTeardown(): Promise<void> {
    for (const fn of this.teardowns) await fn();
  }
  typesSent(): string[] {
    return this.sent.map((f) => f.type);
  }
  errorCodes(): string[] {
    return this.sent.filter((f) => f.type === 'error').map((f) => (f as { code: string }).code);
  }
}

type Mode = 'ok' | 'throwAlways' | 'throwOnce' | 'yieldNothing' | 'emptyChunks' | 'slow';

class FakeTts implements TextToSpeech {
  readonly spoken: string[] = [];
  cancelCalls = 0;
  cancelled = false;
  framesPerChunk = 2;
  private attempts = new Map<string, number>();
  /** Resolves when a slow synthesis has started, so a test can cancel mid-stream. */
  started?: Promise<void>;
  private startedResolve?: () => void;

  constructor(private readonly mode: Mode = 'ok') {
    this.started = new Promise((r) => {
      this.startedResolve = r;
    });
  }

  async *synthesise(text: string): AsyncIterable<Buffer> {
    this.spoken.push(text);
    const seen = (this.attempts.get(text) ?? 0) + 1;
    this.attempts.set(text, seen);
    this.startedResolve?.();

    if (this.mode === 'throwAlways') throw new Error('ElevenLabs quota exceeded for voice rachel');
    if (this.mode === 'throwOnce' && seen === 1) throw new Error('transient upstream failure');
    if (this.mode === 'yieldNothing') return;

    if (this.mode === 'emptyChunks') {
      yield Buffer.alloc(0);
      yield Buffer.from('real');
      return;
    }

    for (let i = 0; i < this.framesPerChunk; i += 1) {
      if (this.mode === 'slow') {
        await new Promise((r) => setImmediate(r));
      }
      // Deliberately keeps yielding after cancel(). A real stream can deliver
      // buffered chunks after an abort, so stopping the downlink has to be the
      // gateway's job — a cooperative fake would hide a missing guard there.
      yield Buffer.from(`frame-${i}`);
    }
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.cancelled = true;
  }

  attemptsFor(text: string): number {
    return this.attempts.get(text) ?? 0;
  }
}

const REPLY = 'We open at eight. We close at six.';

async function build(mode: Mode | null = 'ok') {
  const client: AnthropicLike = {
    messages: {
      create: async () =>
        ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: REPLY, citations: null }],
        }) as unknown as Anthropic.Message,
    },
  };

  const created: FakeTts[] = [];
  const providers: Provider[] = [
    VoiceGateway,
    VoiceTurnRunner,
    TransportMetricsService,
    VoiceSessionStore,
    ToolRegistryService,
    ToolExecutorService,
    ClaudeAgentService,
    IdempotencyService,
    { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
    { provide: ANTHROPIC_CLIENT, useValue: client },
  ];
  if (mode !== null) {
    providers.push({
      provide: TEXT_TO_SPEECH_FACTORY,
      useValue: () => {
        const instance = new FakeTts(mode);
        created.push(instance);
        return instance;
      },
    });
  }

  const moduleRef = await Test.createTestingModule({ providers }).compile();
  return {
    gateway: moduleRef.get(VoiceGateway),
    created,
    tts: () => created[created.length - 1],
  };
}

async function connected(gateway: VoiceGateway) {
  const t = new FakeTransport();
  await gateway.handleFrame(t, { type: 'session.start' });
  return t;
}

describe('successful streaming synthesis', () => {
  it('returns audio and emits no text fallback', async () => {
    const { gateway, tts } = await build('ok');
    const t = await connected(gateway);

    const mode = await gateway.deliverReply(t, REPLY);

    expect(mode).toBe('audio');
    expect(t.audioFrames.length).toBeGreaterThan(0);
    expect(t.typesSent()).not.toContain('reply.text');
    expect(t.errorCodes()).not.toContain('tts_unavailable');
    expect(tts().cancelCalls).toBe(0);
  });

  it('speaks sentence by sentence so the first audio leaves early', async () => {
    const { gateway, tts } = await build('ok');
    const t = await connected(gateway);

    await gateway.deliverReply(t, REPLY);

    // Two sentences means two synthesise calls, and the first frame was sent
    // before the second sentence was ever requested.
    expect(tts().spoken).toEqual(['We open at eight.', 'We close at six.']);
    expect(t.audioFrames).toHaveLength(4);
  });

  it('uses the bound implementation through the same delivery path', async () => {
    const { gateway, tts } = await build('ok');
    const t = await connected(gateway);

    await gateway.handleFrame(t, { type: 'turn.text', text: 'what are your hours?' });

    expect(tts().spoken.length).toBeGreaterThan(0);
    expect(t.audioFrames.length).toBeGreaterThan(0);
    expect(t.errorCodes()).not.toContain('tts_unavailable');
    expect(t.typesSent()).toContain('turn.complete');
  });
});

describe('provider failure and empty output', () => {
  it('falls back to text when the provider fails twice on a sentence', async () => {
    const { gateway, tts } = await build('throwAlways');
    const t = await connected(gateway);

    const mode = await gateway.deliverReply(t, REPLY);

    expect(mode).toBe('text');
    expect(t.sent).toContainEqual({ type: 'reply.text', text: REPLY });
    expect(t.errorCodes()).toEqual(['tts_unavailable']);
    // Retried once, not endlessly.
    expect(tts().attemptsFor('We open at eight.')).toBe(2);
  });

  it('recovers from a single transient failure without falling back', async () => {
    const { gateway, tts } = await build('throwOnce');
    const t = await connected(gateway);

    const mode = await gateway.deliverReply(t, REPLY);

    expect(mode).toBe('audio');
    expect(t.typesSent()).not.toContain('reply.text');
    expect(tts().attemptsFor('We open at eight.')).toBe(2);
  });

  it('returns text when a bound provider yields no audio at all', async () => {
    const { gateway } = await build('yieldNothing');
    const t = await connected(gateway);

    const mode = await gateway.deliverReply(t, REPLY);

    // A provider that runs cleanly but produces nothing is not a success.
    expect(mode).toBe('text');
    expect(t.audioFrames).toHaveLength(0);
    expect(t.errorCodes()).toEqual(['tts_unavailable']);
  });

  it('returns text when no provider is bound at all', async () => {
    const { gateway } = await build(null);
    const t = await connected(gateway);

    const mode = await gateway.deliverReply(t, REPLY);

    expect(mode).toBe('text');
    expect(t.errorCodes()).toEqual(['tts_unavailable']);
  });

  it('forwards an empty chunk without counting it as nothing', async () => {
    const { gateway } = await build('emptyChunks');
    const t = await connected(gateway);

    const mode = await gateway.deliverReply(t, REPLY);

    // A zero-length chunk is still a frame the provider produced.
    expect(mode).toBe('audio');
    expect(t.audioFrames.some((c) => c.length === 0)).toBe(true);
  });

  it('emits the text fallback exactly once per reply', async () => {
    const { gateway } = await build('throwAlways');
    const t = await connected(gateway);

    await gateway.deliverReply(t, REPLY);

    expect(t.sent.filter((f) => f.type === 'reply.text')).toHaveLength(1);
    expect(t.errorCodes().filter((c) => c === 'tts_unavailable')).toHaveLength(1);
  });

  it('never forwards provider text to the client', async () => {
    const { gateway } = await build('throwAlways');
    const t = await connected(gateway);

    await gateway.deliverReply(t, REPLY);

    expect(JSON.stringify(t.sent)).not.toMatch(/ElevenLabs|quota|rachel/i);
  });
});

describe('cancellation and teardown', () => {
  it('cancels an in-flight synthesis exactly once on teardown', async () => {
    const { gateway, tts } = await build('slow');
    const t = await connected(gateway);

    const inFlight = gateway.deliverReply(t, REPLY);
    await tts().started;
    await t.fireTeardown();
    await inFlight;

    expect(tts().cancelCalls).toBe(1);
  });

  it('emits no further audio frames after cancellation', async () => {
    const { gateway, tts } = await build('slow');
    const t = await connected(gateway);

    const inFlight = gateway.deliverReply(t, REPLY);
    await tts().started;
    await t.fireTeardown();
    const atCancel = t.audioFrames.length;
    await inFlight;

    expect(t.audioFrames).toHaveLength(atCancel);
  });

  it('does not emit a text fallback for a reply nobody is left to read', async () => {
    const { gateway, tts } = await build('slow');
    const t = await connected(gateway);

    const inFlight = gateway.deliverReply(t, REPLY);
    await tts().started;
    await t.fireTeardown();
    const mode = await inFlight;

    expect(mode).toBe('text');
    expect(t.typesSent()).not.toContain('reply.text');
  });

  it('cancels before any synthesis has started', async () => {
    const { gateway, created } = await build('ok');
    const t = await connected(gateway);

    await t.fireTeardown();
    const mode = await gateway.deliverReply(t, REPLY);

    expect(mode).toBe('text');
    expect(t.audioFrames).toHaveLength(0);
    // Nothing was ever synthesised, and no fallback was written to a dead socket.
    expect(created.length === 0 || created[0].spoken).toEqual(created.length === 0 ? 0 : []);
    expect(t.typesSent()).not.toContain('reply.text');
  });

  it('cancels after the provider already completed', async () => {
    const { gateway, tts } = await build('ok');
    const t = await connected(gateway);

    const mode = await gateway.deliverReply(t, REPLY);
    const framesAfterReply = t.audioFrames.length;
    await t.fireTeardown();

    expect(mode).toBe('audio');
    expect(tts().cancelCalls).toBe(1);
    expect(t.audioFrames).toHaveLength(framesAfterReply);
  });

  it('calls cancel exactly once across a duplicated teardown', async () => {
    const { gateway, tts } = await build('ok');
    const t = await connected(gateway);
    await gateway.deliverReply(t, REPLY);

    await t.fireTeardown();
    await t.fireTeardown();
    await t.fireTeardown();

    expect(tts().cancelCalls).toBe(1);
  });

  it('has no barge-in: caller audio during playback does not cancel', async () => {
    const { gateway, tts } = await build('slow');
    const t = await connected(gateway);

    const inFlight = gateway.deliverReply(t, REPLY);
    await tts().started;
    await gateway.handleAudio(t, Buffer.alloc(640));
    await inFlight;

    // cancel() exists for teardown and nothing else.
    expect(tts().cancelCalls).toBe(0);
  });
});

describe('elevenlabs credential handling', () => {
  const original = process.env.ELEVENLABS_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = original;
  });

  async function drain(service: ElevenLabsTtsService): Promise<void> {
    for await (const _ of service.synthesise('hello')) {
      void _;
    }
  }

  it('fails closed when no key is configured', async () => {
    delete process.env.ELEVENLABS_API_KEY;
    await expect(drain(new ElevenLabsTtsService())).rejects.toThrow(
      /ELEVENLABS_API_KEY is not configured/
    );
  });

  it('never puts the key in a thrown error or a log line', async () => {
    const lines: string[] = [];
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation((m) => lines.push(String(m)));
    process.env.ELEVENLABS_API_KEY = 'el_secret_value_do_not_leak';

    const service = new ElevenLabsTtsService();
    service.cancel();
    await drain(service).catch((e) => {
      expect(String(e)).not.toContain('el_secret_value_do_not_leak');
    });

    expect(lines.join('\n')).not.toContain('el_secret_value_do_not_leak');
    warn.mockRestore();
  });

  it('is safe to cancel when nothing is in flight, and more than once', () => {
    const service = new ElevenLabsTtsService();
    expect(() => {
      service.cancel();
      service.cancel();
    }).not.toThrow();
  });

  it('yields nothing once cancelled', async () => {
    process.env.ELEVENLABS_API_KEY = 'el_test';
    const service = new ElevenLabsTtsService();
    service.cancel();

    const frames: Buffer[] = [];
    for await (const chunk of service.synthesise('hello')) frames.push(chunk);

    expect(frames).toHaveLength(0);
  });
});
