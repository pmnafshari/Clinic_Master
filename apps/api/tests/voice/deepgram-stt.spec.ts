import { Logger } from '@nestjs/common';
import {
  DeepgramSttService,
  parseDeepgramMessage,
  STT_ENCODING,
  STT_SAMPLE_RATE,
  STT_ENDPOINTING_MS,
} from '../../src/modules/voice/speech/deepgram-stt.service';
import { createAnonymousSession } from '../../src/modules/voice/session/voice-session';

function message(over: Record<string, unknown> = {}) {
  return {
    speech_final: true,
    channel: { alternatives: [{ transcript: 'book me a cleaning', confidence: 0.94 }] },
    ...over,
  };
}

describe('deepgram wire format', () => {
  it('pins the audio format the browser must produce', () => {
    expect(STT_ENCODING).toBe('linear16');
    expect(STT_SAMPLE_RATE).toBe(16000);
    expect(STT_ENDPOINTING_MS).toBe(800);
  });

  it('reads a finished utterance', () => {
    expect(parseDeepgramMessage(message())).toEqual({
      kind: 'final',
      result: { text: 'book me a cleaning', confidence: 0.94 },
    });
  });

  // is_final marks a settled fragment, not a finished utterance. Dispatching
  // on it cuts the caller off mid sentence.
  it('treats a settled fragment as a partial, not a turn', () => {
    const parsed = parseDeepgramMessage(message({ speech_final: false, is_final: true }));
    expect(parsed).toEqual({ kind: 'partial', text: 'book me a cleaning' });
  });

  it('treats an interim result as a partial', () => {
    const parsed = parseDeepgramMessage(message({ speech_final: false, is_final: false }));
    expect(parsed).toEqual({ kind: 'partial', text: 'book me a cleaning' });
  });

  it('ignores an empty or whitespace transcript', () => {
    expect(parseDeepgramMessage(message({ channel: { alternatives: [{ transcript: '' }] } }))).toBeNull();
    expect(
      parseDeepgramMessage(message({ channel: { alternatives: [{ transcript: '   ' }] } }))
    ).toBeNull();
  });

  it('ignores a message with no alternatives', () => {
    expect(parseDeepgramMessage(message({ channel: { alternatives: [] } }))).toBeNull();
    expect(parseDeepgramMessage(message({ channel: {} }))).toBeNull();
    expect(parseDeepgramMessage({ speech_final: true })).toBeNull();
  });

  it('ignores a message that is not an object', () => {
    expect(parseDeepgramMessage(null)).toBeNull();
    expect(parseDeepgramMessage('final')).toBeNull();
    expect(parseDeepgramMessage(42)).toBeNull();
  });

  // A missing confidence must not read as a confident transcript.
  it('scores a final with no confidence as zero, so the gate re-prompts', () => {
    const parsed = parseDeepgramMessage(
      message({ channel: { alternatives: [{ transcript: 'five five five' }] } })
    );
    expect(parsed).toEqual({ kind: 'final', result: { text: 'five five five', confidence: 0 } });
  });

  it('trims the transcript it hands on', () => {
    const parsed = parseDeepgramMessage(
      message({ channel: { alternatives: [{ transcript: '  book me in  ', confidence: 0.9 }] } })
    );
    expect(parsed).toEqual({ kind: 'final', result: { text: 'book me in', confidence: 0.9 } });
  });
});

describe('deepgram credential handling', () => {
  const original = process.env.DEEPGRAM_API_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = original;
  });

  it('fails closed when no key is configured', async () => {
    delete process.env.DEEPGRAM_API_KEY;
    const service = new DeepgramSttService();

    await expect(service.start(createAnonymousSession())).rejects.toThrow(
      /DEEPGRAM_API_KEY is not configured/
    );
  });

  it('never puts the key in the error it throws', async () => {
    process.env.DEEPGRAM_API_KEY = 'dg_secret_value_do_not_leak';
    const service = new DeepgramSttService();

    // No network here: an unreachable host still proves the key is not in the
    // failure surface.
    await expect(
      service.start({ ...createAnonymousSession(), logId: 'aaaaaaaaaaaaaaaa' })
    ).rejects.not.toThrow(/dg_secret_value_do_not_leak/);
  }, 20000);

  it('never writes the key to a log line', async () => {
    const lines: string[] = [];
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation((m) => lines.push(String(m)));
    process.env.DEEPGRAM_API_KEY = 'dg_secret_value_do_not_leak';
    const service = new DeepgramSttService();

    await service.start(createAnonymousSession()).catch(() => undefined);

    expect(lines.join('\n')).not.toContain('dg_secret_value_do_not_leak');
    warn.mockRestore();
  }, 20000);

  it('is safe to end a stream that never started', async () => {
    const service = new DeepgramSttService();
    await expect(service.end()).resolves.toBeUndefined();
  });

  it('drops writes when no stream is open rather than throwing', () => {
    const service = new DeepgramSttService();
    expect(() => service.write(Buffer.alloc(640))).not.toThrow();
  });
});
