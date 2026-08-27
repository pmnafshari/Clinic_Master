/**
 * The phone channel is default-deny, exactly like the browser widget.
 *
 * An inbound call is a public, unauthenticated entry point that costs real
 * money per minute, so it stays off unless a deployment turns it on
 * deliberately. Absent reads the same as false, and so does every value that is
 * merely close to true: a missing or approximate variable is not consent.
 *
 * Only the runtime declaration lives here. Documenting the flag is a separate
 * concern that stays with the rest of the phase's documentation.
 */
export interface VoicePhoneFlag {
  phoneEnabled: boolean;
}

export const VOICE_PHONE_FLAG = Symbol('VOICE_PHONE_FLAG');

export const VOICE_PHONE_CONFIG: VoicePhoneFlag = {
  get phoneEnabled(): boolean {
    return process.env.VOICE_PHONE_ENABLED === 'true';
  },
};
