import type Anthropic from '@anthropic-ai/sdk';
import { Test } from '@nestjs/testing';
import type { Provider } from '@nestjs/common';
import { Logger } from '@nestjs/common';

import { VoiceGateway } from '../../src/modules/voice/transport/voice.gateway';
import { VoiceTurnRunner } from '../../src/modules/voice/transport/voice-turn-runner';
import { AudioTransport } from '../../src/modules/voice/transport/audio-transport.interface';
import { ServerFrame } from '../../src/modules/voice/transport/frames';
import { VoiceErrorCode } from '../../src/modules/voice/transport/error-codes';
import { WS_MAX_UPLINK_BYTES_PER_TURN } from '../../src/modules/voice/transport/transport-limits';
import {
  SPEECH_TO_TEXT,
  SpeechToText,
  SttFinal,
  STT_MIN_CONFIDENCE,
  LOW_CONFIDENCE_REPROMPT,
} from '../../src/modules/voice/speech/speech-to-text.interface';
import { TEXT_TO_SPEECH, TextToSpeech } from '../../src/modules/voice/speech/text-to-speech.interface';
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
  readonly audioFrames: Buffer[] = [];
  closedWith: VoiceErrorCode | null = null;
  private teardowns: Array<() => void | Promise<void>> = [];

  send(frame: ServerFrame): void {
    this.sent.push(frame);
  }
  sendAudio(chunk: Buffer): void {
    this.audioFrames.push(chunk);
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
  typesSent(): string[] {
    return this.sent.map((f) => f.type);
  }
}

/** A stand-in recogniser. Nothing here touches a network or a microphone. */
class FakeStt implements SpeechToText {
  started = 0;
  ended = 0;
  readonly written: Buffer[] = [];
  startError: Error | null = null;
  private partialHandlers: Array<(t: string) => void> = [];
  private finalHandlers: Array<(f: SttFinal) => void | Promise<void>> = [];

  async start(_session: VoiceSession): Promise<void> {
    if (this.startError) throw this.startError;
    this.started += 1;
  }
  write(chunk: Buffer): void {
    this.written.push(chunk);
  }
  async end(): Promise<void> {
    this.ended += 1;
  }
  onPartial(handler: (t: string) => void): void {
    this.partialHandlers.push(handler);
  }
  onFinal(handler: (f: SttFinal) => void | Promise<void>): void {
    this.finalHandlers.push(handler);
  }

  emitPartial(text: string): void {
    for (const h of this.partialHandlers) h(text);
  }
  async emitFinal(text: string, confidence: number): Promise<void> {
    for (const h of this.finalHandlers) await h({ text, confidence } as SttFinal);
  }
  /** A provider event that does not match the contract at all. */
  async emitRaw(payload: unknown): Promise<void> {
    for (const h of this.finalHandlers) await h(payload as SttFinal);
  }
}

class FakeTts implements TextToSpeech {
  readonly spoken: string[] = [];
  cancelCalls = 0;
  async *synthesise(text: string): AsyncIterable<Buffer> {
    this.spoken.push(text);
    yield Buffer.from('audio');
  }
  cancel(): void {
    this.cancelCalls += 1;
  }
}

async function build(options: { withTts?: boolean } = {}) {
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

  const stt = new FakeStt();
  const tts = new FakeTts();

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
    { provide: SPEECH_TO_TEXT, useValue: stt },
  ];
  if (options.withTts) providers.push({ provide: TEXT_TO_SPEECH, useValue: tts });

  const moduleRef = await Test.createTestingModule({ providers }).compile();

  return {
    gateway: moduleRef.get(VoiceGateway),
    store: moduleRef.get(VoiceSessionStore),
    stt,
    tts,
    agentCalls,
  };
}

function readyId(t: FakeTransport): string {
  return (t.sent[0] as { type: 'session.ready'; sessionId: string }).sessionId;
}

describe('STT confidence gate', () => {
  it('pins the threshold and the re-prompt to literals', () => {
    expect(STT_MIN_CONFIDENCE).toBe(0.6);
    expect(LOW_CONFIDENCE_REPROMPT).toBe("Sorry, I didn't catch that. Could you say it again?");
  });

  it('dispatches a turn when confidence is at or above the threshold', async () => {
    const { gateway, stt, agentCalls } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    await gateway.handleAudio(t, Buffer.alloc(640));

    await stt.emitFinal('I would like to book a cleaning', 0.95);

    expect(agentCalls).toEqual(['I would like to book a cleaning']);
    expect(t.typesSent()).toContain('turn.complete');
  });

  it('dispatches exactly at the threshold, not just above it', async () => {
    const { gateway, stt, agentCalls } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    await gateway.handleAudio(t, Buffer.alloc(640));

    await stt.emitFinal('book a cleaning', STT_MIN_CONFIDENCE);

    expect(agentCalls).toHaveLength(1);
  });

  it('re-prompts without invoking the agent when confidence is below threshold', async () => {
    const { gateway, stt, tts, agentCalls } = await build({ withTts: true });
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    await gateway.handleAudio(t, Buffer.alloc(640));

    await stt.emitFinal('my date of birth is nineteen eighty', 0.41);

    // The whole point: the model is never asked whether it heard correctly.
    expect(agentCalls).toHaveLength(0);
    expect(tts.spoken).toEqual([LOW_CONFIDENCE_REPROMPT]);
  });

  it('does not advance the turn counter on a re-prompt', async () => {
    const { gateway, store, stt } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    const id = readyId(t);
    await gateway.handleAudio(t, Buffer.alloc(640));

    await stt.emitFinal('mumble', 0.2);

    expect(store.get(id)?.session.turnIndex).toBe(0);
  });

  it('delivers the re-prompt through the same path as any other reply', async () => {
    const { gateway, stt, agentCalls } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    await gateway.handleAudio(t, Buffer.alloc(640));

    await stt.emitFinal('mumble', 0.2);

    // No TTS bound, so the shared delivery path falls back to text — the same
    // fallback any reply gets. A second re-prompt mechanism would show up here.
    expect(t.sent).toContainEqual({ type: 'reply.text', text: LOW_CONFIDENCE_REPROMPT });
    expect(agentCalls).toHaveLength(0);
  });
});

describe('interim results', () => {
  it('forwards partials for UI feedback and never dispatches on them', async () => {
    const { gateway, stt, agentCalls } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    await gateway.handleAudio(t, Buffer.alloc(640));

    stt.emitPartial('I would like');
    stt.emitPartial('I would like to book');

    expect(agentCalls).toHaveLength(0);
    expect(t.sent).toContainEqual({ type: 'stt.partial', text: 'I would like to book' });
  });
});

describe('provider and transcript failure states', () => {
  it('reports stt_unavailable when the recogniser cannot start', async () => {
    const { gateway, stt, agentCalls } = await build();
    stt.startError = new Error('Deepgram: 401 Unauthorized (project 9f2a)');
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    await gateway.handleAudio(t, Buffer.alloc(640));

    expect(t.sent).toContainEqual({ type: 'error', code: 'stt_unavailable' });
    expect(agentCalls).toHaveLength(0);
    // The provider's own words must not reach the browser.
    expect(JSON.stringify(t.sent)).not.toMatch(/Deepgram|401|9f2a/);
  });

  it('ignores an empty final transcript rather than dispatching a blank turn', async () => {
    const { gateway, stt, agentCalls } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    await gateway.handleAudio(t, Buffer.alloc(640));

    await stt.emitFinal('', 0.99);
    await stt.emitFinal('   ', 0.99);

    expect(agentCalls).toHaveLength(0);
  });

  it('ignores a malformed provider event instead of trusting it', async () => {
    const { gateway, stt, agentCalls } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    await gateway.handleAudio(t, Buffer.alloc(640));

    await stt.emitRaw({ text: 'book me in' });               // no confidence
    await stt.emitRaw({ confidence: 0.9 });                   // no text
    await stt.emitRaw({ text: 42, confidence: 0.9 });         // wrong type
    await stt.emitRaw({ text: 'hi', confidence: 'high' });     // wrong type
    await stt.emitRaw(null);

    // A missing confidence must not be read as a confident transcript.
    expect(agentCalls).toHaveLength(0);
  });

  it('ends the recogniser stream on teardown', async () => {
    const { gateway, stt } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    await gateway.handleAudio(t, Buffer.alloc(640));

    await t.fireTeardown();

    expect(stt.ended).toBe(1);
  });

  it('ends the recogniser stream when the caller signals audio.end', async () => {
    const { gateway, stt } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    await gateway.handleAudio(t, Buffer.alloc(640));

    await gateway.handleFrame(t, { type: 'audio.end' });

    expect(stt.ended).toBe(1);
  });

  it('starts the recogniser once per connection, not once per chunk', async () => {
    const { gateway, stt } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    await gateway.handleAudio(t, Buffer.alloc(640));
    await gateway.handleAudio(t, Buffer.alloc(640));
    await gateway.handleAudio(t, Buffer.alloc(640));

    expect(stt.started).toBe(1);
    expect(stt.written).toHaveLength(3);
  });

  it('drops audio from a socket with no session rather than starting a stream', async () => {
    const { gateway, stt } = await build();
    const t = new FakeTransport();

    await gateway.handleAudio(t, Buffer.alloc(640));

    expect(stt.started).toBe(0);
    expect(t.sent).toContainEqual({ type: 'error', code: 'session_expired' });
  });
});

describe('uplink byte cap at the audio-frame boundary', () => {
  it('closes the connection once a turn exceeds the uplink cap', async () => {
    const { gateway } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    const chunk = Buffer.alloc(64 * 1024);
    const needed = Math.ceil(WS_MAX_UPLINK_BYTES_PER_TURN / chunk.length) + 1;
    for (let i = 0; i < needed; i++) {
      await gateway.handleAudio(t, chunk);
    }

    expect(t.closedWith).toBe('rate_limited');
  });

  it('stops forwarding audio to the recogniser once the cap is hit', async () => {
    const { gateway, stt } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    const chunk = Buffer.alloc(64 * 1024);
    const needed = Math.ceil(WS_MAX_UPLINK_BYTES_PER_TURN / chunk.length) + 10;
    for (let i = 0; i < needed; i++) {
      await gateway.handleAudio(t, chunk);
    }

    const forwarded = stt.written.reduce((n, b) => n + b.length, 0);
    expect(forwarded).toBeLessThanOrEqual(WS_MAX_UPLINK_BYTES_PER_TURN);
  });

  it('resets the per-turn budget after a turn completes', async () => {
    const { gateway, stt } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    const chunk = Buffer.alloc(64 * 1024);
    const half = Math.floor(WS_MAX_UPLINK_BYTES_PER_TURN / chunk.length / 2);
    for (let i = 0; i < half; i++) await gateway.handleAudio(t, chunk);

    await stt.emitFinal('book a cleaning please', 0.95);

    for (let i = 0; i < half; i++) await gateway.handleAudio(t, chunk);

    // Two half-budgets across two turns must not trip a per-turn cap.
    expect(t.closedWith).toBeNull();
  });
});

describe('secret and transcript hygiene', () => {
  it('never writes a transcript or a provider key to a log line', async () => {
    const lines: string[] = [];
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation((m) => lines.push(String(m)));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation((m) => lines.push(String(m)));
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation((m) => lines.push(String(m)));

    const { gateway, stt } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    const sessionId = readyId(t);
    await gateway.handleAudio(t, Buffer.alloc(640));

    stt.emitPartial('my date of birth is the fourth of June');
    await stt.emitFinal('my phone number is five five five oh one hundred', 0.95);
    await stt.emitFinal('mumble mumble', 0.1);

    const joined = lines.join('\n');
    expect(joined).not.toContain('date of birth');
    expect(joined).not.toContain('phone number');
    expect(joined).not.toContain('mumble');
    expect(joined).not.toContain(sessionId);

    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });
});
