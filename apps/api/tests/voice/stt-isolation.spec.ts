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
  SPEECH_TO_TEXT_FACTORY,
  SpeechToText,
  SttFinal,
} from '../../src/modules/voice/speech/speech-to-text.interface';
import { DeepgramSttService } from '../../src/modules/voice/speech/deepgram-stt.service';
import { VoiceSessionStore } from '../../src/modules/voice/session/voice-session.store';
import { VoiceSession } from '../../src/modules/voice/session/voice-session';
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
  private teardowns: Array<() => void | Promise<void>> = [];

  send(frame: ServerFrame): void {
    this.sent.push(frame);
  }
  sendAudio(): void {
    /* no audio downlink in this task */
  }
  close(code: VoiceErrorCode): void {
    this.closedWith = code;
  }
  onTeardown(fn: () => void | Promise<void>): void {
    this.teardowns.push(fn);
  }
  async fireTeardown(): Promise<void> {
    for (const fn of this.teardowns) await fn();
  }
  texts(type: string): string[] {
    return this.sent
      .filter((f) => f.type === type)
      .map((f) => (f as { text?: string }).text ?? '');
  }
  typesSent(): string[] {
    return this.sent.map((f) => f.type);
  }
}

/**
 * A recogniser with its own socket, its own handlers, and its own lifecycle —
 * exactly the per-connection state the real Deepgram service holds.
 */
class FakeStt implements SpeechToText {
  static built = 0;
  readonly id: number;
  socketOpen = false;
  ended = 0;
  readonly written: Buffer[] = [];
  private partialHandlers: Array<(t: string) => void> = [];
  private finalHandlers: Array<(f: SttFinal) => void | Promise<void>> = [];

  constructor() {
    FakeStt.built += 1;
    this.id = FakeStt.built;
  }
  async start(_session: VoiceSession): Promise<void> {
    this.socketOpen = true;
  }
  write(chunk: Buffer): void {
    this.written.push(chunk);
  }
  async end(): Promise<void> {
    this.ended += 1;
    this.socketOpen = false;
  }
  onPartial(handler: (t: string) => void): void {
    this.partialHandlers.push(handler);
  }
  onFinal(handler: (f: SttFinal) => void | Promise<void>): void {
    this.finalHandlers.push(handler);
  }
  handlerCount(): number {
    return this.partialHandlers.length + this.finalHandlers.length;
  }
  emitPartial(text: string): void {
    for (const h of this.partialHandlers) h(text);
  }
  async emitFinal(text: string, confidence: number): Promise<void> {
    for (const h of this.finalHandlers) await h({ text, confidence });
  }
}

async function buildHarness() {
  const agentCalls: string[] = [];
  const client: AnthropicLike = {
    messages: {
      create: async (params) => {
        const last = params.messages[params.messages.length - 1];
        agentCalls.push(typeof last?.content === 'string' ? last.content : '');
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'We are open eight to six.', citations: null }],
        } as unknown as Anthropic.Message;
      },
    },
  };

  const created: FakeStt[] = [];
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
      provide: SPEECH_TO_TEXT_FACTORY,
      useValue: () => {
        const instance = new FakeStt();
        created.push(instance);
        return instance;
      },
    },
  ];

  const moduleRef = await Test.createTestingModule({ providers }).compile();
  return { gateway: moduleRef.get(VoiceGateway), created, agentCalls };
}

/** Opens a connection and pushes one audio chunk, so its recogniser exists. */
async function connect(gateway: VoiceGateway) {
  const transport = new FakeTransport();
  await gateway.handleFrame(transport, { type: 'session.start' });
  await gateway.handleAudio(transport, Buffer.alloc(640));
  return transport;
}

const A_SECRET = 'my card number is four four four four one one one one';
const B_SECRET = 'my date of birth is the third of March nineteen seventy';

describe('two concurrent sessions are isolated', () => {
  it('gives connection A and connection B different STT instances', async () => {
    const { gateway, created } = await buildHarness();

    await connect(gateway);
    await connect(gateway);

    expect(created).toHaveLength(2);
    expect(created[0]).not.toBe(created[1]);
    expect(created[0].id).not.toBe(created[1].id);
  });

  it('gives each connection an independent provider socket', async () => {
    const { gateway, created } = await buildHarness();
    const a = await connect(gateway);
    const b = await connect(gateway);

    await gateway.handleAudio(a, Buffer.alloc(100));
    await gateway.handleAudio(b, Buffer.alloc(200));
    await gateway.handleAudio(b, Buffer.alloc(300));

    const [sttA, sttB] = created;
    expect(sttA.socketOpen).toBe(true);
    expect(sttB.socketOpen).toBe(true);
    // A's audio went only to A's socket.
    expect(sttA.written.map((c) => c.length)).toEqual([640, 100]);
    expect(sttB.written.map((c) => c.length)).toEqual([640, 200, 300]);
  });

  it('registers each connection\'s handlers only on its own recogniser', async () => {
    const { gateway, created } = await buildHarness();
    await connect(gateway);
    await connect(gateway);

    // One partial + one final handler each. A shared instance would show four
    // on one object and none on the other.
    expect(created[0].handlerCount()).toBe(2);
    expect(created[1].handlerCount()).toBe(2);
  });

  it('delivers A\'s partial transcript only to A', async () => {
    const { gateway, created } = await buildHarness();
    const a = await connect(gateway);
    const b = await connect(gateway);

    created[0].emitPartial(A_SECRET);

    expect(a.texts('stt.partial')).toEqual([A_SECRET]);
    expect(b.texts('stt.partial')).toEqual([]);
    expect(JSON.stringify(b.sent)).not.toContain('card number');
  });

  it('lets A\'s final transcript trigger only A\'s turn path', async () => {
    const { gateway, created, agentCalls } = await buildHarness();
    const a = await connect(gateway);
    const b = await connect(gateway);

    await created[0].emitFinal('book me a cleaning please', 0.95);

    expect(agentCalls).toEqual(['book me a cleaning please']);
    expect(a.typesSent()).toContain('turn.complete');
    expect(b.typesSent()).not.toContain('turn.complete');
  });

  it('never leaks B\'s transcript to A, or A\'s to B', async () => {
    const { gateway, created } = await buildHarness();
    const a = await connect(gateway);
    const b = await connect(gateway);

    created[0].emitPartial(A_SECRET);
    created[1].emitPartial(B_SECRET);
    await created[0].emitFinal(A_SECRET, 0.95);
    await created[1].emitFinal(B_SECRET, 0.95);

    const seenByA = JSON.stringify(a.sent);
    const seenByB = JSON.stringify(b.sent);

    expect(seenByA).toContain('card number');
    expect(seenByA).not.toContain('date of birth');
    expect(seenByB).toContain('date of birth');
    expect(seenByB).not.toContain('card number');
  });

  it('does not let closing A end or clear B\'s stream', async () => {
    const { gateway, created } = await buildHarness();
    const a = await connect(gateway);
    const b = await connect(gateway);

    await a.fireTeardown();

    const [sttA, sttB] = created;
    expect(sttA.ended).toBe(1);
    expect(sttA.socketOpen).toBe(false);
    expect(sttB.ended).toBe(0);
    expect(sttB.socketOpen).toBe(true);

    // B keeps working after A is gone.
    await gateway.handleAudio(b, Buffer.alloc(777));
    expect(sttB.written.map((c) => c.length)).toEqual([640, 777]);
    created[1].emitPartial('still here');
    expect(b.texts('stt.partial')).toEqual(['still here']);
  });

  it('releases only the torn-down connection\'s provider state', async () => {
    const { gateway, created } = await buildHarness();
    const a = await connect(gateway);
    const b = await connect(gateway);

    await a.fireTeardown();
    await a.fireTeardown();

    // Repeated teardown of A must still not touch B.
    expect(created[0].ended).toBe(1);
    expect(created[1].ended).toBe(0);
    expect(created[1].socketOpen).toBe(true);
    await gateway.handleAudio(b, Buffer.alloc(11));
    expect(created[1].written).toHaveLength(2);
  });

  it('gives a later connection no handlers or transcript state from an earlier one', async () => {
    const { gateway, created } = await buildHarness();
    const first = await connect(gateway);
    created[0].emitPartial('earlier caller said this');
    await first.fireTeardown();

    const later = await connect(gateway);

    const fresh = created[1];
    expect(fresh).not.toBe(created[0]);
    expect(fresh.handlerCount()).toBe(2);
    expect(fresh.written.map((c) => c.length)).toEqual([640]);

    // Emitting on the dead recogniser must not reach the new connection.
    created[0].emitPartial('earlier caller said this');
    expect(later.texts('stt.partial')).toEqual([]);

    fresh.emitPartial('new caller');
    expect(later.texts('stt.partial')).toEqual(['new caller']);
  });
});

describe('the real provider is per-connection too', () => {
  it('builds independent DeepgramSttService instances through the factory', () => {
    const factory = () => new DeepgramSttService();

    const a = factory();
    const b = factory();
    const aGot: string[] = [];
    const bGot: string[] = [];
    a.onFinal((r) => { aGot.push(r.text); });
    b.onFinal((r) => { bGot.push(r.text); });

    // Deliver one provider message to B only.
    (b as unknown as { dispatch: (d: unknown, l: string) => void }).dispatch(
      JSON.stringify({
        speech_final: true,
        channel: { alternatives: [{ transcript: B_SECRET, confidence: 0.97 }] },
      }),
      'aaaaaaaaaaaaaaaa'
    );

    expect(a).not.toBe(b);
    expect(bGot).toEqual([B_SECRET]);
    expect(aGot).toEqual([]);
  });
});
