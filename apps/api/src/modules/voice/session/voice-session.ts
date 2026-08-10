/**
 * Per-conversation state. The patient a verified session may act on is fixed
 * here, server-side — it is never supplied by the model.
 */
export interface VoiceSession {
  sessionId: string;
  userId: string | null;
  patientId: string | null;
  identityVerified: boolean;
  turnIndex: number;
}

export function createAnonymousSession(sessionId: string): VoiceSession {
  return {
    sessionId,
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
    userId,
    patientId,
    identityVerified: true,
    turnIndex: 0,
  };
}
