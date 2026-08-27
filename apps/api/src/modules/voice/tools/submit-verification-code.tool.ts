import { Injectable } from '@nestjs/common';
import { ToolTier, VoiceTool, VoiceToolResult } from './tool-definition.interface';
import { promoteToPhoneVerified, VoiceSession } from '../session/voice-session';
import { OtpService } from '../otp/otp.service';
import { OTP_CODE_DIGITS, OTP_VERIFIED_TTL_MS } from '../otp/otp.constants';

const CODE_PATTERN = new RegExp(`^\\d{${OTP_CODE_DIGITS}}$`);

/**
 * Checks a code the caller read out, and promotes the session if it is right.
 *
 * The code is the only thing the model may supply. There is no phone number and
 * no patient identifier in the schema: which patient this verifies is decided
 * by the challenge the server issued, and is read back out of it rather than
 * named by anyone.
 *
 * Promotion goes through `promoteToPhoneVerified`, which sets the finite
 * deadline. Rotating the bearer credential afterwards is deliberately not done
 * here — the turn runner already compares effective verification before and
 * after every turn and rotates on a gain. Doing it in both places would rotate
 * twice, and doing it only here would miss every other way privilege can be
 * gained.
 */
@Injectable()
export class SubmitVerificationCodeTool implements VoiceTool {
  name = 'submit_verification_code';
  tier: ToolTier = 'public';
  needsPatientContext = true;
  description =
    'Check the verification code the caller read out. Call this with the six ' +
    'digits exactly as they said them.';
  inputSchema = {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'The six digits the caller read out.' },
    },
    required: ['code'],
    additionalProperties: false,
  };

  constructor(private readonly otp: OtpService) {}

  async execute(input: Record<string, unknown>, session: VoiceSession): Promise<VoiceToolResult> {
    const code = typeof input.code === 'string' ? input.code : '';

    // Shape-checked here so a malformed value never becomes a guess. Counting
    // it would let an attacker burn a caller's attempt budget with input that
    // could never have been right.
    if (!CODE_PATTERN.test(code)) {
      return { status: 'failed', error: 'invalid_code' };
    }

    const outcome = await this.otp.submitCode(session.sessionId, code);

    if (outcome.status !== 'verified') {
      // Wrong, expired, locked and unavailable answer alike. The caller who
      // typed a digit wrong hears the same thing as one working through a
      // guess space, and neither learns which challenge is still live.
      return { status: 'failed', error: 'verification_failed' };
    }

    promoteToPhoneVerified(session, {
      userId: session.userId,
      patientId: outcome.patientId,
      now: Date.now(),
      ttlMs: OTP_VERIFIED_TTL_MS,
    });

    return { status: 'ok', message: 'Thanks, you are verified.' };
  }
}
