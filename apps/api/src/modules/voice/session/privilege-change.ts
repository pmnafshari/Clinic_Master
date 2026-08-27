import { isVerificationActive } from './verification';
import { VoiceSession } from './voice-session';

export interface PrivilegeSnapshot {
  patientId: string | null;
  /**
   * Effective verification, not the raw flag.
   *
   * A session that verified by phone, expired, and verified again has the raw
   * flag set on both sides of the comparison, so a raw snapshot reports no
   * change and nothing rotates — leaving in service a bearer id that existed
   * while the session was unverified. Comparing the effective value catches it.
   */
  verificationActive: boolean;
}

/**
 * Copied by value, deliberately. Holding a reference to the session would mean
 * comparing it against itself after a tool mutated it in place, which never
 * reports a change.
 */
export function snapshotPrivilege(
  session: VoiceSession,
  now: number = Date.now()
): PrivilegeSnapshot {
  return {
    patientId: session.patientId,
    verificationActive: isVerificationActive(session, now),
  };
}

/**
 * True when the session can now do something it could not do before.
 *
 * Two triggers. `start_patient_intake` binding a patientId is the older one.
 * Phone verification is the other: an anonymous caller who proves control of
 * the number on file gains Tier 2 mid-conversation, and re-verifying after a
 * deadline lapsed is a fresh gain for the same reason.
 *
 * Expiry is deliberately not a change here. Rotation exists to retire a
 * credential that was exposed while the session held less privilege, and losing
 * access does not create that exposure.
 *
 * The deadline itself is absent from the snapshot on purpose: a shrinking
 * deadline is not a privilege change.
 */
export function privilegeChanged(
  before: PrivilegeSnapshot,
  after: VoiceSession,
  now: number = Date.now()
): boolean {
  const gainedPatient = before.patientId === null && after.patientId !== null;
  const gainedVerification =
    !before.verificationActive && isVerificationActive(after, now);
  return gainedPatient || gainedVerification;
}
