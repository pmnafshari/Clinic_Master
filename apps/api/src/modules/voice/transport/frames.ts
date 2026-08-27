import { VoiceErrorCode } from './error-codes';

/** Caps a single spoken turn's transcript. Literal-pinned in frames.spec.ts. */
export const MAX_TURN_TEXT_LENGTH = 4000;

export type ClientFrame =
  | { type: 'session.start'; sessionId?: string }
  | { type: 'turn.text'; text: string }
  | { type: 'audio.end' };

export type ServerFrame =
  | { type: 'session.ready'; sessionId: string }
  | { type: 'session.rotated'; sessionId: string }
  | { type: 'stt.partial'; text: string }
  | { type: 'agent.thinking' }
  // The delivery half of the TTS fallback: the failure table promised the
  // reply as text on the socket, but no frame could carry it. Emitted only
  // when synthesis did not happen — never alongside audio.
  | { type: 'reply.text'; text: string }
  | { type: 'turn.complete' }
  | { type: 'error'; code: VoiceErrorCode };

export type ParsedFrame =
  | { ok: true; frame: ClientFrame }
  | { ok: false; code: 'bad_frame' };

/**
 * Fields a client must never be able to assert. The HTTP endpoint is protected
 * from these by the global ValidationPipe's forbidNonWhitelisted — but that
 * pipe is HTTP-only and a WebSocket gateway does not inherit it, so the same
 * property is enforced explicitly here.
 *
 * Listed rather than inferred so that adding a session field cannot silently
 * open a hole: the allowed-key lists below are exhaustive, and anything not on
 * them is refused regardless of this list. This is the belt to that braces.
 */
const FORBIDDEN_KEYS = new Set([
  'patientId',
  'patient_id',
  'userId',
  'user_id',
  'identityVerified',
  'identity_verified',
  'verifiedUntil',
  'verified_until',
  'turnIndex',
  'turn_index',
  'idempotencyNonce',
  'idempotency_nonce',
  'logId',
  'log_id',
  'tier',
]);

const ALLOWED_KEYS: Record<string, readonly string[]> = {
  'session.start': ['type', 'sessionId'],
  'turn.text': ['type', 'text'],
  'audio.end': ['type'],
};

const reject: ParsedFrame = { ok: false, code: 'bad_frame' };

export function parseClientFrame(raw: unknown): ParsedFrame {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return reject;
  }

  const candidate = raw as Record<string, unknown>;
  const type = candidate.type;

  if (typeof type !== 'string' || !(type in ALLOWED_KEYS)) {
    return reject;
  }

  const allowed = ALLOWED_KEYS[type];
  for (const key of Object.keys(candidate)) {
    if (FORBIDDEN_KEYS.has(key) || !allowed.includes(key)) {
      return reject;
    }
  }

  if (type === 'session.start') {
    const { sessionId } = candidate;
    if (sessionId !== undefined && typeof sessionId !== 'string') {
      return reject;
    }
    return { ok: true, frame: { type, sessionId: sessionId as string | undefined } };
  }

  if (type === 'turn.text') {
    const { text } = candidate;
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TURN_TEXT_LENGTH) {
      return reject;
    }
    return { ok: true, frame: { type, text } };
  }

  return { ok: true, frame: { type: 'audio.end' } };
}
