import { VoiceSession } from './voice-session';

export interface PrivilegeSnapshot {
  patientId: string | null;
  identityVerified: boolean;
}

/**
 * Copied by value, deliberately. Holding a reference to the session would mean
 * comparing it against itself after a tool mutated it in place, which never
 * reports a change.
 */
export function snapshotPrivilege(session: VoiceSession): PrivilegeSnapshot {
  return {
    patientId: session.patientId,
    identityVerified: session.identityVerified,
  };
}

/**
 * True when the session can now do something it could not do before.
 *
 * `start_patient_intake` binding a patientId is the only trigger reachable in
 * Phase 1 — it holds the sole `session.patientId =` assignment in the codebase.
 * The identityVerified arm cannot fire in Phase 1 (nothing sets it, and a test
 * pins that); it is here so the behaviour is inherited rather than rediscovered
 * when identity verification is built.
 */
export function privilegeChanged(
  before: PrivilegeSnapshot,
  after: VoiceSession
): boolean {
  const gainedPatient = before.patientId === null && after.patientId !== null;
  const gainedVerification = !before.identityVerified && after.identityVerified;
  return gainedPatient || gainedVerification;
}
