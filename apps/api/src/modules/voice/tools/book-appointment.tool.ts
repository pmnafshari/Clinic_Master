import { Injectable } from '@nestjs/common';
import { VoiceTool, VoiceToolResult, ToolTier } from './tool-definition.interface';
import { VoiceSession } from '../session/voice-session';
import { AppointmentsService } from '../../appointments/appointments.service';
import { UsersService } from '../../users/users.service';
import { IdempotencyService } from '../idempotency/idempotency.service';

/**
 * No patient identifier in the schema — deliberately. The patient comes from
 * the session, either because the caller verified or because intake just
 * created one, so no prompt injection has a parameter to attack.
 *
 * The write goes through AppointmentsService.create, which runs the conflict
 * check and the insert inside one serializable transaction and is backed by a
 * database exclusion constraint. Writing to Prisma from here would look
 * equivalent and silently lose both.
 */
@Injectable()
export class BookAppointmentTool implements VoiceTool {
  name = 'book_appointment';
  tier: ToolTier = 'public';
  needsPatientContext = true;
  description =
    'Book an appointment for the patient in this conversation. Confirm the ' +
    'date and time out loud before calling this. Only report a booking as made ' +
    'if this returns status "confirmed".';
  inputSchema = {
    type: 'object',
    properties: {
      startTime: { type: 'string', description: 'Start time, ISO 8601.' },
      endTime: { type: 'string', description: 'End time, ISO 8601.' },
      reason: { type: 'string', description: 'Reason for the visit.' },
    },
    required: ['startTime', 'endTime'],
    additionalProperties: false,
  };

  constructor(
    private appointments: AppointmentsService,
    private users: UsersService,
    private idempotency: IdempotencyService
  ) {}

  async execute(
    input: Record<string, unknown>,
    session: VoiceSession
  ): Promise<VoiceToolResult> {
    const patientId = session.patientId;
    if (!patientId) {
      /**
       * Recoverable, and said so explicitly.
       *
       * The session has no patient yet, which for a new caller simply means
       * intake has not run. The booking is still refused here — that invariant
       * is not negotiable and is what stops an appointment being created for
       * nobody — but the agent is told what would make it possible instead of
       * being left to infer it from an error code.
       */
      return {
        status: 'failed',
        error: 'no_patient_in_session',
        nextStep:
          'Register this caller with start_patient_intake first, then book again.',
      };
    }

    const key = this.idempotency.keyFor(session, this.name, input);

    // One committed write per turn: the caller consented once, so at most
    // one write may follow. See IdempotencyService.scopeFor.
    const commit = {
      scope: this.idempotency.scopeFor(session, this.name),
      nextStep:
        'An appointment is already booked for this caller in this turn. Tell ' +
        'them the time that is booked and ask whether they want a second ' +
        'appointment as well before booking anything further.',
    };

    return this.idempotency.runOnce(key, async () => {
      const providers = await this.users.findProviders();
      if (!providers || providers.length === 0) {
        return { status: 'failed' as const, error: 'no_provider_available' };
      }

      try {
        const appointment = await this.appointments.create({
          patientId,
          providerId: providers[0].id,
          startTime: String(input.startTime),
          endTime: String(input.endTime),
          reason: input.reason === undefined ? undefined : String(input.reason),
        });

        return {
          status: 'confirmed' as const,
          appointmentId: appointment.id,
          startTime: appointment.startTime,
        };
      } catch {
        // The conflict check, the serializable transaction and the exclusion
        // constraint all surface here. Never report this as booked.
        return { status: 'failed' as const, error: 'slot_unavailable' };
      }
    }, commit);
  }
}
