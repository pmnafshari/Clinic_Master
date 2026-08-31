import { AuditService } from '../../src/modules/audit/audit.service';
import { BookAppointmentTool } from '../../src/modules/voice/tools/book-appointment.tool';
import { PatientIntakeTool } from '../../src/modules/voice/tools/patient-intake.tool';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { IdempotencyService } from '../../src/modules/voice/idempotency/idempotency.service';
import { createAnonymousSession, VoiceSession } from '../../src/modules/voice/session/voice-session';
import { testRedis } from './redis-test-util';

const SLOT = { startTime: '2026-10-06T09:00:00.000Z', endTime: '2026-10-06T09:30:00.000Z', reason: 'cleaning' };

function build() {
  const created: Array<Record<string, unknown>> = [];
  const appointments = {
    create: jest.fn(async (data: Record<string, unknown>) => {
      created.push(data);
      return { id: `appt-${created.length}`, startTime: data.startTime };
    }),
  };
  const users = { findProviders: jest.fn(async () => [{ id: 'provider-1' }]) };
  const patients = {
    create: jest.fn(async () => ({ id: 'patient-created', firstName: 'Test', lastName: 'Person' })),
  };
  const idempotency = new IdempotencyService(testRedis());

  const registry = new ToolRegistryService();
  const book = new BookAppointmentTool(appointments as never, users as never, idempotency);
  const intake = new PatientIntakeTool(patients as never, idempotency);
  registry.register(book);
  registry.register(intake);

  const executor = new ToolExecutorService(registry, {
    log: jest.fn().mockResolvedValue(undefined),
  } as unknown as AuditService);

  return { executor, appointments, patients, created };
}

describe('booking cannot happen before intake', () => {
  let session: VoiceSession;
  let n = 0;

  beforeEach(() => {
    process.env.OTP_HMAC_SECRET = 'test-otp-secret';
    n += 1;
    session = createAnonymousSession(`s-book-${n}-${Date.now()}`);
  });

  it('refuses to book when the session has no patient', async () => {
    const { executor, appointments } = build();

    const result = await executor.execute('book_appointment', SLOT, session);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('no_patient_in_session');
    // The invariant: nothing reached the appointments service.
    expect(appointments.create).not.toHaveBeenCalled();
  });

  it('tells the agent how to recover instead of leaving it to guess', async () => {
    const { executor } = build();

    const result = await executor.execute('book_appointment', SLOT, session);

    /**
     * The failure that ended conversations carried only an opaque code, and the
     * agent had been told to treat any failure as terminal. Naming the
     * prerequisite is what makes the difference recoverable.
     */
    expect(result.nextStep).toEqual(expect.stringContaining('start_patient_intake'));
  });

  it('books once intake has actually created the patient', async () => {
    const { executor, appointments } = build();

    const intake = await executor.execute(
      'start_patient_intake',
      { firstName: 'Test', lastName: 'Person', phone: '+15550001111', dateOfBirth: '1990-01-01' },
      session
    );
    expect(intake.status).toBe('confirmed');
    // Intake writes the patient back onto the session; that is the prerequisite.
    expect(session.patientId).toBe('patient-created');

    const booking = await executor.execute('book_appointment', SLOT, session);

    expect(booking.status).toBe('confirmed');
    expect(appointments.create).toHaveBeenCalledTimes(1);
    expect((appointments.create.mock.calls[0][0] as { patientId: string }).patientId).toBe('patient-created');
  });

  it('never books for a patient the model names itself', async () => {
    const { executor, appointments } = build();

    // A model that invents identity has no parameter to put it in, and any it
    // adds is not read.
    await executor.execute(
      'book_appointment',
      { ...SLOT, patientId: 'someone-elses-patient', userId: 'someone-else' },
      session
    );

    expect(appointments.create).not.toHaveBeenCalled();
  });

  it('books for the session patient, never one supplied as input', async () => {
    const { executor, appointments } = build();
    await executor.execute(
      'start_patient_intake',
      { firstName: 'Test', lastName: 'Person', phone: '+15550001111', dateOfBirth: '1990-01-01' },
      session
    );

    await executor.execute('book_appointment', { ...SLOT, patientId: 'attacker-patient' }, session);

    expect((appointments.create.mock.calls[0][0] as { patientId: string }).patientId).toBe('patient-created');
  });

  it('does not double-book an identical repeated request', async () => {
    const { executor, appointments } = build();
    await executor.execute(
      'start_patient_intake',
      { firstName: 'Test', lastName: 'Person', phone: '+15550001111', dateOfBirth: '1990-01-01' },
      session
    );

    const first = await executor.execute('book_appointment', SLOT, session);
    const second = await executor.execute('book_appointment', SLOT, session);

    expect(first.status).toBe('confirmed');
    expect(second).toEqual(first);
    // Idempotency, not luck: the service was only ever asked once.
    expect(appointments.create).toHaveBeenCalledTimes(1);
  });

  it('reports a terminal failure without a recovery hint', async () => {
    const { executor } = build();
    await executor.execute(
      'start_patient_intake',
      { firstName: 'Test', lastName: 'Person', phone: '+15550001111', dateOfBirth: '1990-01-01' },
      session
    );

    // A slot clash is not something the agent can fix by calling another tool.
    const { executor: e2, appointments } = build();
    appointments.create.mockRejectedValueOnce(new Error('overlap'));
    await e2.execute(
      'start_patient_intake',
      { firstName: 'Test', lastName: 'Person', phone: '+15550001111', dateOfBirth: '1990-01-01' },
      session
    );
    const result = await e2.execute('book_appointment', SLOT, session);

    expect(result.status).toBe('failed');
    expect(result.nextStep).toBeUndefined();
  });

  it('keeps one session\'s patient out of another session', async () => {
    const { executor, appointments } = build();
    const a = createAnonymousSession(`s-a-${Date.now()}`);
    const b = createAnonymousSession(`s-b-${Date.now()}`);

    await executor.execute(
      'start_patient_intake',
      { firstName: 'Test', lastName: 'Person', phone: '+15550001111', dateOfBirth: '1990-01-01' },
      a
    );

    const forB = await executor.execute('book_appointment', SLOT, b);

    expect(forB.status).toBe('failed');
    expect(b.patientId).toBeNull();
    expect(appointments.create).not.toHaveBeenCalled();
  });
});
