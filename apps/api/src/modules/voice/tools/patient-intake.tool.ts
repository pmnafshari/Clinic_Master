import { Injectable } from '@nestjs/common';
import { VoiceTool, VoiceToolResult, ToolTier } from './tool-definition.interface';
import { VoiceSession } from '../session/voice-session';
import { PatientsService } from '../../patients/patients.service';
import { IdempotencyService } from '../idempotency/idempotency.service';

/**
 * The first tool in this system that writes. It takes no patient identifier —
 * it creates one — and then binds the created record to the session so that a
 * following book_appointment in the same conversation has a patient to act on.
 *
 * That write is why `needsPatientContext` is declared: ToolExecutorService
 * hands a declaring tool the real session object, and hands everything else a
 * narrowed copy whose writes are discarded.
 */
@Injectable()
export class PatientIntakeTool implements VoiceTool {
  name = 'start_patient_intake';
  tier: ToolTier = 'public';
  needsPatientContext = true;
  description =
    'Register a new patient after collecting their details. Read the details ' +
    'back to the caller and get confirmation before calling this.';
  inputSchema = {
    type: 'object',
    properties: {
      firstName: { type: 'string', description: 'Given name.' },
      lastName: { type: 'string', description: 'Family name.' },
      phone: { type: 'string', description: 'Contact phone number.' },
      dateOfBirth: { type: 'string', description: 'Date of birth, YYYY-MM-DD.' },
      email: { type: 'string', description: 'Email address, if given.' },
      reason: { type: 'string', description: 'Why they are getting in touch.' },
    },
    required: ['firstName', 'lastName', 'phone', 'dateOfBirth'],
    additionalProperties: false,
  };

  constructor(
    private patients: PatientsService,
    private idempotency: IdempotencyService
  ) {}

  async execute(
    input: Record<string, unknown>,
    session: VoiceSession
  ): Promise<VoiceToolResult> {
    const key = this.idempotency.keyFor(session, this.name, input);

    const result = await this.idempotency.runOnce(key, async () => {
      try {
        const patient = await this.patients.create({
          firstName: String(input.firstName),
          lastName: String(input.lastName),
          phone: String(input.phone),
          dateOfBirth: String(input.dateOfBirth),
          email: input.email === undefined ? undefined : String(input.email),
          notes: input.reason === undefined ? undefined : String(input.reason),
        });

        return {
          status: 'confirmed' as const,
          patientId: patient.id,
          message: 'Patient record created.',
        };
      } catch {
        return { status: 'failed' as const, error: 'could_not_create_patient' };
      }
    });

    // Bind the new patient to this session so booking can proceed. The only id
    // that can ever land here is one this call just created, so it cannot move
    // the session onto an existing patient's records.
    if (result.status === 'confirmed' && typeof result.patientId === 'string') {
      session.patientId = result.patientId;
    }

    return result;
  }
}
