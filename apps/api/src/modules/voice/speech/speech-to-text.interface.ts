import { VoiceSession } from '../session/voice-session';

/**
 * DI token for a FACTORY, not an instance.
 *
 * A SpeechToText holds one provider socket and one set of handlers, so it is
 * per-connection state by construction. Injecting an instance into the
 * singleton gateway gave every concurrent caller the same object: the second
 * caller's `start()` replaced the first's socket, and both callers' handlers
 * accumulated on one list, so each of them received the other's transcript.
 *
 * A factory makes the lifetime explicit — one recogniser per accepted
 * connection, created when that connection first sends audio and discarded
 * with it. Scope.TRANSIENT would not fix this: the gateway is a singleton, so
 * it would still receive a single instance for its whole lifetime.
 */
export const SPEECH_TO_TEXT_FACTORY = Symbol('SPEECH_TO_TEXT_FACTORY');

export type SpeechToTextFactory = () => SpeechToText;

/**
 * Below this, the transport asks the caller to repeat instead of guessing.
 *
 * Intake collects names, dates of birth and phone numbers, where a confident
 * mishearing is worse than an extra question: a wrong digit in a phone number
 * is a booking nobody can confirm.
 */
export const STT_MIN_CONFIDENCE = 0.6;

export const LOW_CONFIDENCE_REPROMPT = "Sorry, I didn't catch that. Could you say it again?";

export interface SttFinal {
  text: string;
  confidence: number;
}

/**
 * The seam between caller audio and a transcript.
 *
 * Deepgram sits behind this in production; every test drives a fake, so no
 * test needs a network, a microphone, or a credential.
 */
export interface SpeechToText {
  start(session: VoiceSession): Promise<void>;
  write(chunk: Buffer): void;
  end(): Promise<void>;
  onPartial(handler: (text: string) => void): void;
  onFinal(handler: (result: SttFinal) => void | Promise<void>): void;
}

/**
 * A provider event is not trusted until it matches the contract.
 *
 * A missing confidence must never read as a confident transcript: that is the
 * difference between asking the caller to repeat their phone number and
 * booking an appointment against a number nobody said.
 */
export function isUsableFinal(candidate: unknown): candidate is SttFinal {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const { text, confidence } = candidate as Record<string, unknown>;
  return (
    typeof text === 'string' &&
    text.trim().length > 0 &&
    typeof confidence === 'number' &&
    Number.isFinite(confidence)
  );
}
