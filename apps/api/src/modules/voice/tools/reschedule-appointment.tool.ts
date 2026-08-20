import { Injectable } from '@nestjs/common';
import { VoiceTool, VoiceToolResult, ToolTier } from './tool-definition.interface';
import { VoiceSession } from '../session/voice-session';
import { AppointmentsService } from '../../appointments/appointments.service';
import { IdempotencyService } from '../idempotency/idempotency.service';

@Injectable()
export class RescheduleAppointmentTool implements VoiceTool {
  name = 'reschedule_appointment';
  tier: ToolTier = 'verified';
  needsPatientContext = true;
  description =
    "Move one of the caller's own appointments to a new time. Only report it " +
    'as moved if this returns status "confirmed".';
  inputSchema = {
    type: 'object',
    properties: {
      appointmentId: { type: 'string', description: 'The appointment to move.' },
      startTime: { type: 'string', description: 'New start time, ISO 8601.' },
      endTime: { type: 'string', description: 'New end time, ISO 8601.' },
    },
    required: ['appointmentId', 'startTime', 'endTime'],
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

    // Ownership check: the model supplied this id, so it must be verified
    // against the session's patient before anything is written. A lookup that
    // throws (no such appointment) answers the same way as one that finds
    // someone else's, so the caller cannot probe for which ids exist.
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

    return this.idempotency.runOnce(key, async () => {
      try {
        const updated = await this.appointments.update(appointmentId, {
          startTime: String(input.startTime),
          endTime: String(input.endTime),
        });

        return {
          status: 'confirmed' as const,
          appointmentId: updated.id,
          startTime: updated.startTime,
        };
      } catch {
        return { status: 'failed' as const, error: 'slot_unavailable' };
      }
    });
  }
}
