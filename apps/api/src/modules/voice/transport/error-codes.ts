/**
 * Everything the browser is ever told about a failure.
 *
 * Enumerated deliberately: an Anthropic, Deepgram or ElevenLabs SDK error
 * carries provider identity and internal state, and the global HTTP filter
 * still returns exception.message verbatim. Nothing on this path forwards a
 * provider string.
 */
export type VoiceErrorCode =
  | 'stt_unavailable'
  | 'agent_unavailable'
  | 'tts_unavailable'
  | 'rate_limited'
  | 'session_expired'
  | 'session_conflict'
  | 'bad_frame'
  | 'internal';

export const VOICE_ERROR_CODES: readonly VoiceErrorCode[] = [
  'stt_unavailable',
  'agent_unavailable',
  'tts_unavailable',
  'rate_limited',
  'session_expired',
  'session_conflict',
  'bad_frame',
  'internal',
];
