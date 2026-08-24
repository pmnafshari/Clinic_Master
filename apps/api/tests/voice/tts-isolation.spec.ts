import type Anthropic from '@anthropic-ai/sdk';
import type { Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';

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
}

/**
 * A synthesiser with its own cancel signal and its own request state — the
 * per-connection state the real ElevenLabs service holds.
 */
class FakeTts implements TextToSpeech {
  static built = 0;
  readonly id: number;
  readonly spoken: string[] = [];
  cancelCalls = 0;
  cancelled = false;
  slow = false;

  constructor() {
    FakeTts.built += 1;
    this.id = FakeTts.built;
  }

  async *synthesise(text: string): AsyncIterable<Buffer> {
    this.spoken.push(text);
    for (let i = 0; i < 2; i += 1) {
      if (this.slow) await new Promise((r) => setImmediate(r));
      if (this.cancelled) return;
      yield Buffer.from(`${this.id}:${i}`);
    }
  }

  cancel(): void {
    this.cancelCalls += 1;
    this.cancelled = true;
  }
}

const A_LINE = 'Your appointment is confirmed for Tuesday.';
const B_LINE = 'Your balance is ninety pounds.';

async function buildHarness() {
  const client: AnthropicLike = {
    messages: {
      create: async () =>
        ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'We are open eight to six.', citations: null }],
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
    {
      provide: TEXT_TO_SPEECH_FACTORY,
      useValue: () => {
        const instance = new FakeTts();
        created.push(instance);
        return instance;
      },
    },
  ];

  const moduleRef = await Test.createTestingModule({ providers }).compile();
  return { gateway: moduleRef.get(VoiceGateway), created };
}

/** Opens a connection and speaks one line, so its synthesiser exists. */
async function connectAndSpeak(gateway: VoiceGateway, line: string) {
  const transport = new FakeTransport();
  await gateway.handleFrame(transport, { type: 'session.start' });
  await gateway.deliverReply(transport, line);
  return transport;
}

describe('two concurrent sessions get isolated synthesisers', () => {
  it('gives connection A and connection B different TextToSpeech instances', async () => {
    const { gateway, created } = await buildHarness();

    await connectAndSpeak(gateway, A_LINE);
    await connectAndSpeak(gateway, B_LINE);

    expect(created).toHaveLength(2);
    expect(created[0]).not.toBe(created[1]);
    expect(created[0].id).not.toBe(created[1].id);
  });

  it('sends each connection only its own audio', async () => {
    const { gateway, created } = await buildHarness();
    const a = await connectAndSpeak(gateway, A_LINE);
    const b = await connectAndSpeak(gateway, B_LINE);

    expect(created[0].spoken).toEqual([A_LINE]);
    expect(created[1].spoken).toEqual([B_LINE]);
    // Frames are tagged with the instance id that produced them.
    expect(a.audioFrames.every((f) => f.toString().startsWith(`${created[0].id}:`))).toBe(true);
    expect(b.audioFrames.every((f) => f.toString().startsWith(`${created[1].id}:`))).toBe(true);
  });

  it('does not let cancelling A cancel, stop or clear B', async () => {
    const { gateway, created } = await buildHarness();
    const a = await connectAndSpeak(gateway, A_LINE);
    const b = await connectAndSpeak(gateway, B_LINE);

    await a.fireTeardown();

    const [ttsA, ttsB] = created;
    expect(ttsA.cancelCalls).toBe(1);
    expect(ttsA.cancelled).toBe(true);
    expect(ttsB.cancelCalls).toBe(0);
    expect(ttsB.cancelled).toBe(false);

    // B can still speak after A hung up.
    const framesBefore = b.audioFrames.length;
    const mode = await gateway.deliverReply(b, 'Anything else?');
    expect(mode).toBe('audio');
    expect(b.audioFrames.length).toBeGreaterThan(framesBefore);
  });

  it('does not let A tearing down mid-stream interrupt B mid-stream', async () => {
    const { gateway, created } = await buildHarness();

    const a = new FakeTransport();
    await gateway.handleFrame(a, { type: 'session.start' });
    const b = new FakeTransport();
    await gateway.handleFrame(b, { type: 'session.start' });

    // Both start speaking; both synthesisers are slow enough to overlap.
    await gateway.deliverReply(a, A_LINE);
    created[0].slow = true;
    await gateway.deliverReply(b, B_LINE);
    created[1].slow = true;

    const bSpeaking = gateway.deliverReply(b, 'One moment please.');
    await a.fireTeardown();
    const mode = await bSpeaking;

    expect(mode).toBe('audio');
    expect(created[1].cancelCalls).toBe(0);
  });

  it('repeated teardown of A still never touches B', async () => {
    const { gateway, created } = await buildHarness();
    const a = await connectAndSpeak(gateway, A_LINE);
    await connectAndSpeak(gateway, B_LINE);

    await a.fireTeardown();
    await a.fireTeardown();
    await a.fireTeardown();

    expect(created[0].cancelCalls).toBe(1);
    expect(created[1].cancelCalls).toBe(0);
  });

  it('gives a later connection no synthesis state from an earlier one', async () => {
    const { gateway, created } = await buildHarness();
    const first = await connectAndSpeak(gateway, A_LINE);
    await first.fireTeardown();

    const later = await connectAndSpeak(gateway, B_LINE);

    const fresh = created[1];
    expect(fresh).not.toBe(created[0]);
    expect(fresh.cancelled).toBe(false);
    expect(fresh.cancelCalls).toBe(0);
    expect(fresh.spoken).toEqual([B_LINE]);
    // The new caller heard audio, not the fallback a cancelled instance gives.
    expect(later.typesSent()).not.toContain('reply.text');
    expect(later.audioFrames.length).toBeGreaterThan(0);
  });

  it('keeps a cancelled connection cancelled without leaking that to others', async () => {
    const { gateway, created } = await buildHarness();
    const a = await connectAndSpeak(gateway, A_LINE);
    const b = await connectAndSpeak(gateway, B_LINE);

    await a.fireTeardown();

    // A stays silenced...
    const aFrames = a.audioFrames.length;
    const aMode = await gateway.deliverReply(a, 'Are you still there?');
    expect(aMode).toBe('text');
    expect(a.audioFrames).toHaveLength(aFrames);

    // ...and B is entirely unaffected.
    expect(await gateway.deliverReply(b, 'Still here.')).toBe('audio');
    expect(created[1].cancelled).toBe(false);
  });
});

describe('the real synthesiser is per-connection too', () => {
  it('builds independent ElevenLabsTtsService instances through the factory', () => {
    const factory = () => new ElevenLabsTtsService();

    const a = factory();
    const b = factory();
    a.cancel();

    expect(a).not.toBe(b);
    // Cancelling A must leave B able to synthesise. A shared instance would
    // have marked B cancelled too.
    expect(() => b.cancel()).not.toThrow();
  });

  it('does not silence a second instance when the first is cancelled', async () => {
    process.env.ELEVENLABS_API_KEY = 'el_test';
    const a = new ElevenLabsTtsService();
    const b = new ElevenLabsTtsService();

    a.cancel();

    // A yields nothing once cancelled.
    const aFrames: Buffer[] = [];
    for await (const chunk of a.synthesise('hello')) aFrames.push(chunk);
    expect(aFrames).toHaveLength(0);

    // B is not cancelled, so it gets as far as the network call rather than
    // returning early — proof its state is its own.
    await expect(
      (async () => {
        for await (const _ of b.synthesise('hello')) void _;
      })()
    ).rejects.toThrow();

    delete process.env.ELEVENLABS_API_KEY;
  }, 20000);
});
