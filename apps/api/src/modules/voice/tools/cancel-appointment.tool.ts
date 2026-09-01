import { Injectable } from '@nestjs/common';
import { VoiceTool, VoiceToolResult, ToolTier } from './tool-definition.interface';
import { VoiceSession } from '../session/voice-session';
import { AppointmentsService } from '../../appointments/appointments.service';
import { IdempotencyService } from '../idempotency/idempotency.service';

@Injectable()
export class CancelAppointmentTool implements VoiceTool {
  name = 'cancel_appointment';
  tier: ToolTier = 'verified';
  needsPatientContext = true;
  description =
    "Cancel one of the caller's own appointments. Confirm which appointment " +
    'out loud first. Only report it as cancelled if this returns status "confirmed".';
  inputSchema = {
    type: 'object',
    properties: {
      appointmentId: { type: 'string', description: 'The appointment to cancel.' },
    },
    required: ['appointmentId'],
    additionalProperties: false,
  };

  constructor(
    private appointments: AppointmentsService,
    private idempotency: IdempotencyService
  ) {}

  async execute(
    input: Record<string, unknown>,
    session: VoiceSession
  ): Promise<VoiceToolResult> {
    if (!session.patientId) {
      return { status: 'failed', error: 'no_patient_in_session' };
    }

    const appointmentId = String(input.appointmentId);

    // Same ownership check as reschedule: a model-supplied id is never trusted
    // to identify an appointment the caller may touch.
    let existing: { patientId: string } | null = null;
    try {
      existing = await this.appointments.findById(appointmentId);
    } catch {
      existing = null;
    }

    if (!existing || existing.patientId !== session.patientId) {
      return { status: 'failed', error: 'not_your_appointment' };
    }

    const key = this.idempotency.keyFor(session, this.name, input);

    // One committed write per turn: the caller consented once, so at most
    // one write may follow. See IdempotencyService.scopeFor.
    const commit = {
      scope: this.idempotency.scopeFor(session, this.name),
      nextStep:
        'A cancellation is already confirmed for this caller in this turn. Tell ' +
        'them which appointment was cancelled and get a clear yes before ' +
        'cancelling another.',
    };

    return this.idempotency.runOnce(key, async () => {
      try {
        const cancelled = await this.appointments.cancel(appointmentId);
        return {
          status: 'confirmed' as const,
          appointmentId: cancelled.id,
          newStatus: cancelled.status,
        };
      } catch {
        return { status: 'failed' as const, error: 'could_not_cancel' };
      }
    }, commit);
  }
}
