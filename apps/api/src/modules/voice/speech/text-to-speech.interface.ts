import { AudioFormat } from './audio-format';

/**
 * DI token for a FACTORY, not an instance.
 *
 * A TextToSpeech owns an in-flight request and a cancel signal, so it is
 * per-connection state — the same lifecycle invariant the speech recogniser
 * needed. A shared instance would mean one caller hanging up calls cancel()
 * on every live call at once.
 */
export const TEXT_TO_SPEECH_FACTORY = Symbol('TEXT_TO_SPEECH_FACTORY');

export type TextToSpeechFactory = (format?: AudioFormat) => TextToSpeech;

/**
 * The seam between a reply and whatever speaks it.
 *
 * `cancel()` is implemented and used for teardown only: clean disconnect,
 * dropped connection, connection-duration cap, session expiry. It is NOT wired
 * to barge-in detection; nothing listens for caller speech during playback.
 *
 * Declared here alongside AudioTransport so the transport can speak through a
 * seam without depending on a provider. The implementation behind it is a
 * separate concern and lives elsewhere.
 */
export interface TextToSpeech {
  synthesise(text: string): AsyncIterable<Buffer>;
  cancel(): void;
}
