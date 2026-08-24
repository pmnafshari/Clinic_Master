import type Anthropic from '@anthropic-ai/sdk';
import type { Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

import { TransportMetricsService } from '../../src/modules/voice/transport/transport-metrics.service';
import { VoiceGateway } from '../../src/modules/voice/transport/voice.gateway';
import { VoiceTurnRunner } from '../../src/modules/voice/transport/voice-turn-runner';
import { AudioTransport } from '../../src/modules/voice/transport/audio-transport.interface';
import { ServerFrame } from '../../src/modules/voice/transport/frames';
import { VoiceErrorCode } from '../../src/modules/voice/transport/error-codes';
import { WS_MAX_TURNS_PER_MINUTE } from '../../src/modules/voice/transport/transport-limits';
import {
  SPEECH_TO_TEXT_FACTORY,
  SpeechToText,
  SttFinal,
} from '../../src/modules/voice/speech/speech-to-text.interface';
import {
  TEXT_TO_SPEECH_FACTORY,
  TextToSpeech,
} from '../../src/modules/voice/speech/text-to-speech.interface';
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
import { ToolTier } from '../../src/modules/voice/tools/tool-definition.interface';

class FakeTransport implements AudioTransport {
  readonly sent: ServerFrame[] = [];
  closedWith: VoiceErrorCode | null = null;
  private teardowns: Array<() => void | Promise<void>> = [];
  send(f: ServerFrame): void {
    this.sent.push(f);
  }
  sendAudio(): void {}
  close(c: VoiceErrorCode): void {
    this.closedWith = c;
  }
  onTeardown(fn: () => void | Promise<void>): void {
    this.teardowns.push(fn);
  }
  async fireTeardown(): Promise<void> {
    for (const fn of this.teardowns) await fn();
  }
}

class FakeStt implements SpeechToText {
  private finals: Array<(f: SttFinal) => void | Promise<void>> = [];
  failStart = false;
  async start(_s: VoiceSession): Promise<void> {
    if (this.failStart) throw new Error('Deepgram: 401 Unauthorized (project 9f2a)');
  }
  write(): void {}
  async end(): Promise<void> {}
  onPartial(): void {}
  onFinal(h: (f: SttFinal) => void | Promise<void>): void {
    this.finals.push(h);
  }
  async emitFinal(text: string, confidence: number): Promise<void> {
    for (const h of this.finals) await h({ text, confidence });
  }
}

class FakeTts implements TextToSpeech {
  fail = false;
  async *synthesise(): AsyncIterable<Buffer> {
    if (this.fail) throw new Error('ElevenLabs quota exceeded for voice rachel');
    yield Buffer.from('a');
  }
  cancel(): void {}
}

class FakeIntakeTool {
  name = 'start_patient_intake';
  description = 'collect caller details';
  tier: ToolTier = 'public';
  needsPatientContext = true;
  inputSchema = { type: 'object' as const, properties: {}, required: [] as string[] };
  async execute(_i: Record<string, unknown>, session: VoiceSession) {
    session.patientId = 'patient-1';
    return { status: 'confirmed' as const, patientId: 'patient-1' };
  }
}

const SECRET_SPEECH = 'my card number is four four four four and my name is Dana Whitfield';

async function build(options: { intake?: boolean } = {}) {
  const client: AnthropicLike = {
    messages: {
      create: async (params) => {
        const last = params.messages[params.messages.length - 1];
        const text = typeof last?.content === 'string' ? last.content : '';
        if (options.intake && text.includes('my name is')) {
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'start_patient_intake', input: {} }],
          } as unknown as Anthropic.Message;
        }
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
    TransportMetricsService,
    ToolRegistryService,
    ToolExecutorService,
    ClaudeAgentService,
    IdempotencyService,
    { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
    { provide: ANTHROPIC_CLIENT, useValue: client },
    { provide: SPEECH_TO_TEXT_FACTORY, useValue: () => stt },
    { provide: TEXT_TO_SPEECH_FACTORY, useValue: () => tts },
  ];

  const moduleRef = await Test.createTestingModule({ providers }).compile();
  if (options.intake) {
    moduleRef.get(ToolRegistryService).register(new FakeIntakeTool() as never);
  }

  return {
    gateway: moduleRef.get(VoiceGateway),
    store: moduleRef.get(VoiceSessionStore),
    stt,
    tts,
  };
}

/** Captures everything the transport writes to a log, at any level. */
function captureLogs() {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation((m) => {
      lines.push(String(m));
    })
  );
  return {
    lines,
    joined: () => lines.join('\n'),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}

function readyId(t: FakeTransport): string {
  return (t.sent[0] as { type: 'session.ready'; sessionId: string }).sessionId;
}

describe('the metrics service records the lifecycle', () => {
  it('emits a line per event, each carrying the logId', () => {
    const logs = captureLogs();
    const metrics = new TransportMetricsService();

    metrics.connectionOpened('aaaaaaaaaaaaaaaa');
    metrics.turnCompleted('aaaaaaaaaaaaaaaa', 1234);
    metrics.sttConfidence('aaaaaaaaaaaaaaaa', 0.91);
    metrics.ttsFirstFrame('aaaaaaaaaaaaaaaa', 210);
    metrics.providerError('aaaaaaaaaaaaaaaa', 'stt');
    metrics.sessionRotated('aaaaaaaaaaaaaaaa');
    metrics.connectionClosed('aaaaaaaaaaaaaaaa', 'client');

    const joined = logs.joined();
    expect(joined).toMatch(/connection\.opened/);
    expect(joined).toMatch(/turn\.completed/);
    expect(joined).toMatch(/stt\.confidence/);
    expect(joined).toMatch(/tts\.first_frame/);
    expect(joined).toMatch(/provider\.error/);
    expect(joined).toMatch(/session\.rotated/);
    expect(joined).toMatch(/connection\.closed/);
    expect(logs.lines).toHaveLength(7);
    for (const line of logs.lines) {
      expect(line).toContain('aaaaaaaaaaaaaaaa');
    }
    logs.restore();
  });

  it('rounds confidence rather than emitting a full-precision score', () => {
    const logs = captureLogs();
    new TransportMetricsService().sttConfidence('bbbbbbbbbbbbbbbb', 0.9137281);
    expect(logs.joined()).toContain('0.91');
    expect(logs.joined()).not.toContain('0.9137281');
    logs.restore();
  });
});

describe('metric signatures cannot carry a credential or a transcript', () => {
  const SOURCE = readFileSync(
    join(__dirname, '../../src/modules/voice/transport/transport-metrics.service.ts'),
    'utf8'
  );

  // Comments are stripped first. The file's own doc comment explains why a
  // sessionId must never appear here, and a raw text match would flag that
  // prose as the violation it warns against.
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('never names a sessionId parameter', () => {
    // Rollback condition: a metric method taking a sessionId would make the
    // hygiene rule a convention rather than a property of the signature.
    expect(CODE).not.toMatch(/sessionId/);
  });

  it('never names a transcript, text or audio parameter', () => {
    expect(CODE).not.toMatch(/\btranscript\b|\btext\b|\baudio\b|\bchunk\b/);
  });

  it('takes logId first on every public method', () => {
    const methods = [...SOURCE.matchAll(/^\s{2}([a-zA-Z]+)\(([^)]*)\)/gm)];
    expect(methods.length).toBeGreaterThanOrEqual(7);
    for (const [, name, params] of methods) {
      expect(`${name}:${params.trim()}`).toMatch(/^[a-zA-Z]+:logId: string/);
    }
  });
});

describe('the transport records real traffic', () => {
  it('records a connection opening and closing', async () => {
    const logs = captureLogs();
    const { gateway } = await build();
    const t = new FakeTransport();

    await gateway.handleFrame(t, { type: 'session.start' });
    await t.fireTeardown();

    expect(logs.joined()).toMatch(/connection\.opened/);
    expect(logs.joined()).toMatch(/connection\.closed/);
    logs.restore();
  });

  it('records a completed turn with a duration', async () => {
    const logs = captureLogs();
    const { gateway } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    await gateway.handleFrame(t, { type: 'turn.text', text: 'what are your hours?' });

    expect(logs.joined()).toMatch(/turn\.completed .* ms=\d+/);
    logs.restore();
  });

  it('records STT confidence and TTS first-frame latency', async () => {
    const logs = captureLogs();
    const { gateway, stt } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    await gateway.handleAudio(t, Buffer.alloc(640));

    await stt.emitFinal('book me a cleaning', 0.93);

    expect(logs.joined()).toMatch(/stt\.confidence .* value=0\.93/);
    expect(logs.joined()).toMatch(/tts\.first_frame .* ms=\d+/);
    logs.restore();
  });

  it('records a rotation event', async () => {
    const logs = captureLogs();
    const { gateway } = await build({ intake: true });
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    await gateway.handleFrame(t, { type: 'turn.text', text: 'my name is Dana' });

    expect(logs.joined()).toMatch(/session\.rotated/);
    logs.restore();
  });

  it('records a provider error for each failing provider', async () => {
    const logs = captureLogs();
    const { gateway, stt } = await build();
    stt.failStart = true;
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    await gateway.handleAudio(t, Buffer.alloc(640));

    expect(logs.joined()).toMatch(/provider\.error .* provider=stt/);
    logs.restore();
  });

  it('records a tts provider error', async () => {
    const logs = captureLogs();
    const { gateway, tts } = await build();
    tts.fail = true;
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    await gateway.handleFrame(t, { type: 'turn.text', text: 'hours?' });

    expect(logs.joined()).toMatch(/provider\.error .* provider=tts/);
    logs.restore();
  });

  it('records why a connection closed when a limit ended it', async () => {
    const logs = captureLogs();
    const { gateway } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });

    for (let i = 0; i < WS_MAX_TURNS_PER_MINUTE + 1; i++) {
      await gateway.handleFrame(t, { type: 'turn.text', text: `turn ${i}` });
    }
    // A real socket's close() raises its close event, which runs teardown.
    await t.fireTeardown();

    expect(t.closedWith).toBe('rate_limited');
    expect(logs.joined()).toMatch(/connection\.closed .* reason=rate_limited/);
    logs.restore();
  });
});

describe('nothing sensitive reaches a log line', () => {
  it('emits no session id, transcript, or reply text across a whole conversation', async () => {
    const logs = captureLogs();
    const { gateway, stt } = await build({ intake: true });
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    const firstId = readyId(t);
    await gateway.handleAudio(t, Buffer.alloc(640));

    await stt.emitFinal(SECRET_SPEECH, 0.95);
    await gateway.handleFrame(t, { type: 'turn.text', text: SECRET_SPEECH });
    await t.fireTeardown();

    const joined = logs.joined();
    const rotated = t.sent.find((f) => f.type === 'session.rotated') as
      | { sessionId: string }
      | undefined;

    expect(joined).not.toContain(firstId);
    if (rotated) expect(joined).not.toContain(rotated.sessionId);
    expect(joined).not.toContain('card number');
    expect(joined).not.toContain('Dana Whitfield');
    expect(joined).not.toContain('We are open eight to six');
    // The correlation id is present, so the trail is still followable.
    expect(joined).toMatch(/[0-9a-f]{16}/);
    logs.restore();
  });

  it('emits no audio bytes', async () => {
    const logs = captureLogs();
    const { gateway, stt } = await build();
    const t = new FakeTransport();
    await gateway.handleFrame(t, { type: 'session.start' });
    await gateway.handleAudio(t, Buffer.from('RAW_AUDIO_PAYLOAD_MARKER'));
    await stt.emitFinal('hello', 0.99);

    expect(logs.joined()).not.toContain('RAW_AUDIO_PAYLOAD_MARKER');
    logs.restore();
  });
});
