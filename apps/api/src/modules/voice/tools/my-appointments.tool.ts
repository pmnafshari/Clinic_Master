import { Injectable } from '@nestjs/common';
import { VoiceTool, VoiceToolResult, ToolTier } from './tool-definition.interface';
import { VoiceSession } from '../session/voice-session';
import { AppointmentsService } from '../../appointments/appointments.service';

/**
 * No patient identifier in the schema — deliberately. The patient comes from
 * the session, so no prompt injection has a parameter to attack.
 */
@Injectable()
export class MyAppointmentsTool implements VoiceTool {
  name = 'get_my_appointments';
  tier: ToolTier = 'verified';
  needsPatientContext = true;
  description = "Get the caller's own upcoming and past appointments.";
  inputSchema = { type: 'object', properties: {}, additionalProperties: false };

  constructor(private appointments: AppointmentsService) {}

  async execute(
    _input: Record<string, unknown>,
    session: VoiceSession
  ): Promise<VoiceToolResult> {
    if (!session.patientId) {
      return { status: 'failed', error: 'no_patient_in_session' };
    }

    const results = await this.appointments.findAll({ patientId: session.patientId });

    const appointments = (results ?? []).map(
      (appointment: { id: string; startTime: Date; endTime: Date; status: string; reason: string | null }) => ({
        id: appointment.id,
        startTime: appointment.startTime,
        endTime: appointment.endTime,
        status: appointment.status,
        reason: appointment.reason,
      })
    );

    return { status: 'ok', appointments };
  }
}
