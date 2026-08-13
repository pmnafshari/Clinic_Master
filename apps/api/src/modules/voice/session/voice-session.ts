import { randomBytes } from 'crypto';

/**
 * 256 bits from the platform CSPRNG, base64url encoded (43 characters, no
 * padding, and no character outside `[A-Za-z0-9_-]`).
 *
 * Used for both the session id and the idempotency nonce. Both are opaque
 * bearer values: anything that can be guessed or enumerated is a way into
 * somebody else's conversation.
 */
export function newOpaqueId(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Per-conversation state. The patient a verified session may act on is fixed
 * here, server-side — it is never supplied by the model.
 */
export interface VoiceSession {
  /**
   * Server-issued and server-owned. A client can echo one back to resume, but
   * can never choose one: an id the server did not issue is not adopted.
   */
  sessionId: string;

  /**
   * Namespaces this session's idempotency keys.
   *
   * The keys cannot be derived from `sessionId` + `turnIndex`, because those
   * two repeat: if a session is evicted from the store and the caller returns,
   * a fresh session is created and `turnIndex` starts again at 0. Keys built
   * from them would collide with the evicted session's, and a cached
   * `confirmed` would be replayed for a write that never ran — the agent
   * telling a patient their appointment is booked when it is not.
   *
   * A fresh nonce per session makes that collision impossible: a recreated
   * session cannot address the old namespace at all.
   */
  idempotencyNonce: string;

  userId: string | null;
  patientId: string | null;
  identityVerified: boolean;
  turnIndex: number;
}

export function createAnonymousSession(sessionId: string = newOpaqueId()): VoiceSession {
  return {
    sessionId,
    idempotencyNonce: newOpaqueId(),
    userId: null,
    patientId: null,
    identityVerified: false,
    turnIndex: 0,
  };
}

export function createVerifiedSession(
  sessionId: string,
  userId: string,
  patientId: string
): VoiceSession {
  return {
    sessionId,
    idempotencyNonce: newOpaqueId(),
    userId,
    patientId,
    identityVerified: true,
    turnIndex: 0,
  };
}
