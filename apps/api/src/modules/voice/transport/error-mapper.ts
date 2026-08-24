import { Logger } from '@nestjs/common';
import { VoiceErrorCode } from './error-codes';
import { ServerFrame } from './frames';

export type ClientErrorFrame = Extract<ServerFrame, { type: 'error' }>;

/**
 * Builds the only error shape the browser ever sees.
 *
 * It deliberately never reads the error. A Deepgram failure names the project,
 * a Prisma failure names the constraint, an Anthropic failure names the model
 * state, and a socket failure names the host and port. None of that is the
 * caller's business, and a client that never receives it cannot leak it
 * onwards.
 *
 * The parameter is kept, unused, so every call site reads as "this error
 * becomes this code" rather than inviting someone to build the frame by hand.
 */
export function toClientError(_error: unknown, code: VoiceErrorCode): ClientErrorFrame {
  return { type: 'error', code };
}

/**
 * The real error goes here — server-side, correlated by the non-secret logId.
 *
 * `logId` rather than `sessionId`: the session id is a bearer credential and a
 * log line is exactly the wrong place for one.
 */
export function logServerError(logger: Logger, logId: string, error: unknown): void {
  logger.error(`Voice transport failure for ${logId} — ${describe(error)}`);
}

/** Bounded retries are logged too, so a provider degrading is visible. */
export function logRetry(logger: Logger, logId: string, attempt: number): void {
  logger.warn(`Speech synthesis retry ${attempt} for ${logId}`);
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
