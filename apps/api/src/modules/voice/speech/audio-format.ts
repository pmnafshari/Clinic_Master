/**
 * What a connection's audio sounds like on the wire, in both directions.
 *
 * A channel decides this, not a provider and not the agent. The browser
 * downsamples to 16 kHz PCM before sending and can play anything back; Twilio
 * Media Streams are μ-law 8 kHz in both directions and negotiate nothing.
 *
 * Both providers support both natively, which is the whole reason this is a
 * configuration seam and not a transcoding layer. There is deliberately no
 * resampler here: a format a provider will not accept fails the connection
 * rather than being quietly converted into one it will.
 */
export type AudioFormat = 'linear16_16000' | 'mulaw_8000';

export const BROWSER_AUDIO_FORMAT: AudioFormat = 'linear16_16000';
export const PHONE_AUDIO_FORMAT: AudioFormat = 'mulaw_8000';

export interface SttWireFormat {
  encoding: string;
  sampleRate: number;
}

const STT_WIRE: Record<AudioFormat, SttWireFormat> = {
  linear16_16000: { encoding: 'linear16', sampleRate: 16000 },
  mulaw_8000: { encoding: 'mulaw', sampleRate: 8000 },
};

/**
 * What the browser receives is whatever the provider sends by default, and that
 * is stated here as `null` rather than as a format string on purpose: naming the
 * current default explicitly would change the request that a deployed widget
 * already depends on.
 */
const TTS_OUTPUT: Record<AudioFormat, string | null> = {
  linear16_16000: null,
  mulaw_8000: 'ulaw_8000',
};

function known<T>(table: Record<AudioFormat, T>, format: AudioFormat): T {
  if (!Object.prototype.hasOwnProperty.call(table, format)) {
    // Names the format, which is a channel's own configuration and carries
    // nothing sensitive. Failing here means a connection fails closed rather
    // than falling back to a codec the caller cannot hear.
    throw new Error(`unsupported audio format: ${format}`);
  }
  return table[format];
}

export function sttWireFormat(format: AudioFormat): SttWireFormat {
  return known(STT_WIRE, format);
}

export function ttsOutputFormat(format: AudioFormat): string | null {
  return known(TTS_OUTPUT, format);
}
