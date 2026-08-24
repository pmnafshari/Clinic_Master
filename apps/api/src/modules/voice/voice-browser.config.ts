/**
 * Public browser voice is default-deny.
 *
 * The widget is the first unauthenticated surface in this application, so it
 * stays off unless a deployment turns it on deliberately. Absent reads the same
 * as false: a missing variable is not consent.
 *
 * Only the runtime declaration and enforcement live here. Documenting the flag
 * — `.env.example`, the README, the single-process warning — is a separate
 * concern and stays with the rest of the phase's documentation.
 */
export interface VoiceBrowserFlag {
  browserEnabled: boolean;
}

export const VOICE_BROWSER_FLAG = Symbol('VOICE_BROWSER_FLAG');

export const VOICE_BROWSER_CONFIG: VoiceBrowserFlag = {
  get browserEnabled(): boolean {
    return process.env.VOICE_BROWSER_ENABLED === 'true';
  },
};
