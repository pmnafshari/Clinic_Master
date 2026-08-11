import { VoiceSession } from '../session/voice-session';

/**
 * 'public'   — callable by anyone, exposes no patient-specific data.
 * 'verified' — requires session.identityVerified === true.
 */
export type ToolTier = 'public' | 'verified';

/**
 * Every tool reports an explicit status. The agent is instructed never to
 * claim an action happened without a 'confirmed' result in hand.
 */
export interface VoiceToolResult {
  status: 'ok' | 'confirmed' | 'failed';
  [key: string]: unknown;
}

export interface VoiceTool {
  name: string;
  tier: ToolTier;
  description: string;
  /** JSON Schema. Tier-2 tools MUST NOT expose a patient identifier. */
  inputSchema: Record<string, unknown>;
  /**
   * Opt in to receiving patient identity. A tool that does not declare this is
   * handed a session with `userId` and `patientId` nulled, so it cannot read or
   * act on a patient even inside a verified session.
   *
   * This is a server-side capability declaration, never a model-supplied input
   * field — it must not appear in `inputSchema`.
   */
  needsPatientContext?: boolean;
  execute(
    input: Record<string, unknown>,
    session: VoiceSession
  ): Promise<VoiceToolResult>;
}
