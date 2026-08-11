import { Injectable } from '@nestjs/common';
import { VoiceTool, VoiceToolResult, ToolTier } from './tool-definition.interface';
import { VoiceSession } from '../session/voice-session';
import { BillingService } from '../../billing/billing.service';

@Injectable()
export class MyInvoicesTool implements VoiceTool {
  name = 'get_my_invoices';
  tier: ToolTier = 'verified';
  needsPatientContext = true;
  description = "Get the caller's own invoices and their payment status.";
  inputSchema = { type: 'object', properties: {}, additionalProperties: false };

  constructor(private billing: BillingService) {}

  async execute(
    _input: Record<string, unknown>,
    session: VoiceSession
  ): Promise<VoiceToolResult> {
    if (!session.patientId) {
      return { status: 'failed', error: 'no_patient_in_session' };
    }

    const results = await this.billing.findAllInvoices(session.patientId);

    const invoices = (results ?? []).map(
      (invoice: { invoiceNumber: string; total: unknown; status: string; dueAt: Date }) => ({
        invoiceNumber: invoice.invoiceNumber,
        total: String(invoice.total),
        status: invoice.status,
        dueAt: invoice.dueAt,
      })
    );

    return { status: 'ok', invoices };
  }
}
