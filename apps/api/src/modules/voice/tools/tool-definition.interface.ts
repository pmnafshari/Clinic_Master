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
  execute(
    input: Record<string, unknown>,
    session: VoiceSession
  ): Promise<VoiceToolResult>;
}
