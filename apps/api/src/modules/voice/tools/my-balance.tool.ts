import { Injectable } from '@nestjs/common';
import { VoiceTool, VoiceToolResult, ToolTier } from './tool-definition.interface';
import { VoiceSession } from '../session/voice-session';
import { BillingService } from '../../billing/billing.service';

@Injectable()
export class MyBalanceTool implements VoiceTool {
  name = 'get_my_balance';
  tier: ToolTier = 'verified';
  needsPatientContext = true;
  description = "Get the caller's own outstanding balance across all invoices.";
  inputSchema = { type: 'object', properties: {}, additionalProperties: false };

  constructor(private billing: BillingService) {}

  async execute(
    _input: Record<string, unknown>,
    session: VoiceSession
  ): Promise<VoiceToolResult> {
    if (!session.patientId) {
      return { status: 'failed', error: 'no_patient_in_session' };
    }

    const balance = await this.billing.getPatientBalance(session.patientId);

    return {
      status: 'ok',
      totalBilled: balance?.totalBilled,
      totalPaid: balance?.totalPaid,
      balance: balance?.balance,
    };
  }
}
