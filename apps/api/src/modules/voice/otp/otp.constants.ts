/** How long a caller has to read a code out of a text message and say it. */
export const OTP_CODE_TTL_MS = 5 * 60 * 1000;

/**
 * The "short expiry" the design asks for.
 *
 * Sits below PHONE_MAX_CONNECTION_MS so a long call re-verifies mid-conversation
 * rather than quietly keeping access, and well below SESSION_TTL_MS so
 * verification always lapses before the session it belongs to.
 */
export const OTP_VERIFIED_TTL_MS = 10 * 60 * 1000;

/** Guesses before the challenge is destroyed and the session is locked out. */
export const OTP_MAX_ATTEMPTS = 5;

/** Minimum gap between codes for one session. */
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

/** Ceiling per phone number, so a cooldown cannot be dodged by reconnecting. */
export const OTP_MAX_REQUESTS_PER_PHONE_PER_HOUR = 5;

export const OTP_REQUEST_WINDOW_MS = 60 * 60 * 1000;

/** How long a locked-out session stays locked. */
export const OTP_LOCK_MS = 15 * 60 * 1000;

export const OTP_CODE_DIGITS = 6;

/** Bounded by the session it belongs to, not by the verification window. */
export const OTP_CALLER_TTL_MS = 30 * 60 * 1000;
