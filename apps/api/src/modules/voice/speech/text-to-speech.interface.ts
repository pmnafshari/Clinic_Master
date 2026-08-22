/** DI token so a fake can be substituted without touching the gateway. */
export const TEXT_TO_SPEECH = Symbol('TEXT_TO_SPEECH');

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
