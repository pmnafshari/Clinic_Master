import { VoiceSession } from './voice-session';

/**
 * Whether a session may reach a Tier 2 tool right now.
 *
 * The single reader of `identityVerified` for authorization purposes. Two
 * channels grant verification on very different terms and the difference is
 * entirely in the deadline, so keeping the rule in one pure function is what
 * stops a caller somewhere reading the flag alone and silently ignoring
 * expiry.
 *
 *     identityVerified === true
 *     AND (verifiedUntil === null OR verifiedUntil > now)
 *
 * `null` is the browser case: the JWT was checked at connect, the connection is
 * the grant, and the session's own TTL is the only bound. A number is the phone
 * case: a six-digit code proves control of a phone number, which is a far
 * weaker credential than a JWT, so what it grants is time-boxed independently
 * of the session.
 *
 * An expired session is deliberately indistinguishable from one that was never
 * verified. Both are simply "not verified": saying which would tell a caller
 * something about a session they may not own.
 *
 * `now` is a parameter rather than an injected clock because this is pure.
 * Tests pass one; production takes the default.
 */
export function isVerificationActive(
  session: Pick<VoiceSession, 'identityVerified' | 'verifiedUntil'>,
  now: number = Date.now()
): boolean {
  if (!session.identityVerified) {
    return false;
  }

  // Undefined as well as null: a record written before this field existed
  // parses with the key absent, and every such record is a browser session.
  if (session.verifiedUntil === null || session.verifiedUntil === undefined) {
    return true;
  }

  return session.verifiedUntil > now;
}
