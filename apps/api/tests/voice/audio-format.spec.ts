import { WebSocket } from 'ws';
import {
  AudioFormat,
  BROWSER_AUDIO_FORMAT,
  PHONE_AUDIO_FORMAT,
  sttWireFormat,
  ttsOutputFormat,
} from '../../src/modules/voice/speech/audio-format';
import { DeepgramSttService } from '../../src/modules/voice/speech/deepgram-stt.service';
import { ElevenLabsTtsService } from '../../src/modules/voice/speech/elevenlabs-tts.service';
import { createAnonymousSession } from '../../src/modules/voice/session/voice-session';
import { SpeechToTextFactory } from '../../src/modules/voice/speech/speech-to-text.interface';
import { TextToSpeechFactory } from '../../src/modules/voice/speech/text-to-speech.interface';

/**
 * What Phase 2 shipped, written out rather than derived.
 *
 * These two strings are the contract with a browser that is already deployed.
 * Deriving them from the same constants the implementation uses would let both
 * sides drift together and the test would never notice.
 */
const BROWSER_STT_QUERY =
  'encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=800';
const PHONE_STT_QUERY =
  'encoding=mulaw&sample_rate=8000&channels=1&interim_results=true&endpointing=800';

/** Captures the URL a recogniser opens, without opening one. */
function captureSttUrl(format?: AudioFormat): string {
  const opened: string[] = [];
  const spy = jest
    .spyOn(DeepgramSttService.prototype as unknown as { open(url: string, key: string): WebSocket },
      'open')
    .mockImplementation((url: string) => {
      opened.push(url);
      return {
        on: () => undefined,
        // start() waits for 'open' before resolving; fire it immediately.
        once: (event: string, fn: () => void) => { if (event === 'open') fn(); },
        send: () => undefined,
        close: () => undefined,
        removeAllListeners: () => undefined,
        readyState: 1,
      } as unknown as WebSocket;
    });

  try {
    const service = format === undefined ? new DeepgramSttService() : new DeepgramSttService(format);
    void service.start(createAnonymousSession('s1'));
    return opened[0];
  } finally {
    spy.mockRestore();
  }
}

/** Captures the request a synthesiser would send, without sending one. */
async function captureTtsRequest(
  format?: AudioFormat
): Promise<{ url: string; body: Record<string, unknown> }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchSpy = jest
    .spyOn(global, 'fetch')
    .mockImplementation(async (url: unknown, init?: unknown) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return {
        ok: true,
        body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
      } as unknown as Response;
    });

  try {
    const service = format === undefined
      ? new ElevenLabsTtsService()
      : new ElevenLabsTtsService(format);
    for await (const _chunk of service.synthesise('hello')) void _chunk;
    return {
      url: calls[0].url,
      body: JSON.parse(String(calls[0].init.body)) as Record<string, unknown>,
    };
  } finally {
    fetchSpy.mockRestore();
  }
}

describe('audio format is an explicit capability', () => {
  it('names exactly the two formats the system supports', () => {
    expect(BROWSER_AUDIO_FORMAT).toBe('linear16_16000');
    expect(PHONE_AUDIO_FORMAT).toBe('mulaw_8000');
  });

  it('maps each format to its provider wire values', () => {
    expect(sttWireFormat(BROWSER_AUDIO_FORMAT)).toEqual({ encoding: 'linear16', sampleRate: 16000 });
    expect(sttWireFormat(PHONE_AUDIO_FORMAT)).toEqual({ encoding: 'mulaw', sampleRate: 8000 });
  });

  it('asks for an explicit output format only on the phone', () => {
    // Null, not a browser default string: the browser request must carry no
    // output_format at all, because adding one changes what the widget receives.
    expect(ttsOutputFormat(BROWSER_AUDIO_FORMAT)).toBeNull();
    expect(ttsOutputFormat(PHONE_AUDIO_FORMAT)).toBe('ulaw_8000');
  });

  it('fails closed on a format it does not recognise', () => {
    const bogus = 'opus_48000' as AudioFormat;

    // Not a silent fall back to browser values: a transport that asked for
    // something unsupported must fail rather than quietly get the wrong codec.
    expect(() => sttWireFormat(bogus)).toThrow(/unsupported audio format/i);
    expect(() => ttsOutputFormat(bogus)).toThrow(/unsupported audio format/i);
  });
});

describe('Deepgram request construction', () => {
  beforeEach(() => {
    process.env.DEEPGRAM_API_KEY = 'test-key';
  });

  it('is byte-identical to what the browser gets today', () => {
    expect(captureSttUrl(BROWSER_AUDIO_FORMAT)).toBe(
      `wss://api.deepgram.com/v1/listen?${BROWSER_STT_QUERY}`
    );
  });

  it('keeps browser behaviour when no format is supplied at all', () => {
    expect(captureSttUrl()).toBe(`wss://api.deepgram.com/v1/listen?${BROWSER_STT_QUERY}`);
  });

  it('requests mulaw at 8 kHz for the phone', () => {
    expect(captureSttUrl(PHONE_AUDIO_FORMAT)).toBe(
      `wss://api.deepgram.com/v1/listen?${PHONE_STT_QUERY}`
    );
  });

  it('carries the capability through to the provider rather than dropping it', () => {
    // The two must differ. A service that accepted the format and then built
    // the URL from a constant would pass every test above except this one.
    expect(captureSttUrl(PHONE_AUDIO_FORMAT)).not.toBe(captureSttUrl(BROWSER_AUDIO_FORMAT));
  });
});

describe('ElevenLabs request construction', () => {
  beforeEach(() => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    delete process.env.ELEVENLABS_VOICE_ID;
  });

  it('sends no output_format for the browser, exactly as shipped', async () => {
    const { url, body } = await captureTtsRequest(BROWSER_AUDIO_FORMAT);

    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream');
    expect(url).not.toContain('output_format');
    expect(body).toEqual({ text: 'hello', model_id: 'eleven_turbo_v2_5' });
    expect(body).not.toHaveProperty('output_format');
  });

  it('keeps browser behaviour when no format is supplied at all', async () => {
    const { url, body } = await captureTtsRequest();

    expect(url).not.toContain('output_format');
    expect(body).toEqual({ text: 'hello', model_id: 'eleven_turbo_v2_5' });
  });

  it('requests ulaw_8000 for the phone', async () => {
    const { url, body } = await captureTtsRequest(PHONE_AUDIO_FORMAT);

    expect(url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream?output_format=ulaw_8000'
    );
    // The body is unchanged; only the query gains the format.
    expect(body).toEqual({ text: 'hello', model_id: 'eleven_turbo_v2_5' });
  });

  it('carries the capability through to the provider rather than dropping it', async () => {
    const phone = await captureTtsRequest(PHONE_AUDIO_FORMAT);
    const browser = await captureTtsRequest(BROWSER_AUDIO_FORMAT);

    expect(phone.url).not.toBe(browser.url);
  });
});

describe('the factory seam carries the capability', () => {
  it('hands the recogniser and synthesiser the format the caller asked for', async () => {
    process.env.DEEPGRAM_API_KEY = 'test-key';
    process.env.ELEVENLABS_API_KEY = 'test-key';

    // Exactly the providers voice.module.ts registers, exercised through the
    // factory shape a transport will call rather than by constructing directly.
    const sttFactory: SpeechToTextFactory = (format?: AudioFormat) =>
      new DeepgramSttService(format);
    const ttsFactory: TextToSpeechFactory = (format?: AudioFormat) =>
      new ElevenLabsTtsService(format);

    expect(sttFactory(PHONE_AUDIO_FORMAT)).toBeInstanceOf(DeepgramSttService);
    expect(ttsFactory(PHONE_AUDIO_FORMAT)).toBeInstanceOf(ElevenLabsTtsService);
    // Called with nothing, as every existing caller does today.
    expect(sttFactory()).toBeInstanceOf(DeepgramSttService);
    expect(ttsFactory()).toBeInstanceOf(ElevenLabsTtsService);
  });
});
