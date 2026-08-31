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

  /**
   * How to satisfy a prerequisite this call was missing, when there is one.
   *
   * Some failures are terminal — the slot is taken, the provider is gone — and
   * the caller should be told plainly. Others are simply out of order: booking
   * for someone who has not been registered yet cannot succeed, but registering
   * them makes it succeed. Those two are indistinguishable when a failure
   * carries only an opaque error code, and the agent was told to treat every
   * failure as terminal, so a recoverable one ended the conversation.
   *
   * The server names the prerequisite because the server is what enforces it.
   * This is guidance for the next step, never permission: the check that
   * produced the failure still runs on the retry, and nothing here lets a tool
   * be called that would otherwise be refused.
   */
  nextStep?: string;

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
