/**
 * Socket limits. All are per-session or per-connection and are NOT related to:
 *
 *   - MAX_HISTORY_TURNS (12) — how much transcript is resent to the model.
 *     A caller may exceed it; they simply lose the earliest context.
 *   - @Throttle({ limit: 10, ttl: 60000 }) — per-IP cap on POST /voice/text.
 *     It cannot apply to socket frames, and a socket neither consumes nor is
 *     limited by that budget.
 *
 * Conflating any of the three has been proposed once already, so each is named
 * distinctly and pinned to a literal in transport-limits.spec.ts.
 */

/** One audio frame. ~20 ms of 16 kHz linear16 is ~640 bytes, so this is ample. */
export const WS_MAX_FRAME_BYTES = 64 * 1024;

/** Lifetime ceiling on agent turns, so one socket cannot spend unbounded model budget. */
export const WS_MAX_TURNS_PER_SESSION = 40;

/** Rate ceiling on agent turns. A person speaking to a receptionist never exceeds this. */
export const WS_MAX_TURNS_PER_MINUTE = 10;

/**
 * Bounds a single turn's audio: 2 MB is far past any plausible utterance.
 *
 * DECLARED BUT NOT YET ENFORCED. There is no audio uplink path in the
 * transport — no frame carries audio, so there is nothing to count. The
 * enforcement point is the audio-frame handler, which arrives with the
 * speech-to-text integration; this constant is pinned here so that work has a
 * value to enforce rather than inventing one.
 *
 * Every other constant in this file IS enforced today:
 *   WS_MAX_FRAME_BYTES                   — ws server `maxPayload` (ws-origin.adapter.ts)
 *   WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE — verifyClient (ws-origin.adapter.ts)
 *   WS_MAX_TURNS_PER_SESSION             — voice.gateway.ts underTurnLimits
 *   WS_MAX_TURNS_PER_MINUTE              — voice.gateway.ts underTurnLimits
 *   WS_MAX_CONNECTION_MS                 — voice.gateway.ts duration cap timer
 */
export const WS_MAX_UPLINK_BYTES_PER_TURN = 2 * 1024 * 1024;

/** Hard connection cap, independent of and shorter than the session TTL. */
export const WS_MAX_CONNECTION_MS = 10 * 60 * 1000;

/** New sockets per IP per minute, checked at upgrade. */
export const WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE = 20;

/** The sliding window both rate limits are measured over. */
export const WS_RATE_WINDOW_MS = 60 * 1000;
