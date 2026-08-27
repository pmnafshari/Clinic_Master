import { Injectable } from '@nestjs/common';
import { ToolTier, VoiceTool, VoiceToolResult } from './tool-definition.interface';
import { VoiceSession } from '../session/voice-session';
import { OtpService } from '../otp/otp.service';
import { PhoneLookupService } from '../otp/phone-lookup.service';

/**
 * What the caller is told, whatever actually happened.
 *
 * One sentence covers every outcome that is not an outright backend failure:
 * the number matched nobody, matched several people, or matched one and a code
 * went out. An automated prober learns nothing from the difference because
 * there is no difference to read.
 */
const UNIFORM_REPLY =
  'If that number is on file, a verification code has been sent to it. ' +
  'Please read the six digits back when it arrives.';

/**
 * Sends a one-time code to the number the caller is already calling from.
 *
 * **The schema is empty, and that is the security property.** There is no phone
 * number to supply, so a prompt injection has no parameter to attack — the same
 * rule the tier-2 tools follow for patient identity. The number comes from the
 * caller record the transport wrote server-side when the call arrived, and
 * nothing the model says can reach it.
 *
 * Public tier because an anonymous caller has to be able to reach it at all;
 * that is the point of it. It does NOT declare `needsPatientContext`: it never
 * reads or writes the session's patient, only its id, so the narrowed session
 * the executor hands it is all it needs. Claiming a capability it does not use
 * would hand it an identity it has no reason to hold.
 */
@Injectable()
export class RequestVerificationCodeTool implements VoiceTool {
  name = 'request_verification_code';
  tier: ToolTier = 'public';
  description =
    'Send a verification code by text to the number the caller is calling from. ' +
    'Use this when the caller asks about their own appointments, bills or balance ' +
    'and has not verified yet. It takes no arguments.';
  inputSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };

  constructor(
    private readonly otp: OtpService,
    private readonly lookup: PhoneLookupService
  ) {}

  async execute(_input: Record<string, unknown>, session: VoiceSession): Promise<VoiceToolResult> {
    // `_input` is never read. The only trustworthy source for the number is the
    // record the transport wrote, keyed by session.
    const caller = await this.otp.callerFor(session.sessionId);
    if (!caller) {
      // A browser session has no caller record and never will. So does a phone
      // session whose backing store is unreachable — both are "cannot do this
      // here", and neither says anything about a patient.
      return { status: 'failed', error: 'verification_unavailable' };
    }

    const patientId = await this.lookup.eligiblePatient(caller);
    if (!patientId) {
      // No match and several matches land here together, and leave together.
      // Nothing below this line distinguishes them — not the status, not the
      // message, not a metric, not a log line.
      return { status: 'ok', message: UNIFORM_REPLY };
    }

    const outcome = await this.otp.requestCode(session.sessionId, caller, patientId);

    if (outcome.status === 'unavailable') {
      return { status: 'failed', error: 'verification_unavailable' };
    }

    // 'sent', 'cooldown' and 'capped' all answer the same way. A caller being
    // rate limited is told what a caller who succeeded is told; the limits are
    // there to slow an attacker down, not to narrate themselves to one.
    return { status: 'ok', message: UNIFORM_REPLY };
  }
}
