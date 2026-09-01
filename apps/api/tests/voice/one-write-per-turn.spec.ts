import { BookAppointmentTool } from '../../src/modules/voice/tools/book-appointment.tool';
import { CancelAppointmentTool } from '../../src/modules/voice/tools/cancel-appointment.tool';
import { RescheduleAppointmentTool } from '../../src/modules/voice/tools/reschedule-appointment.tool';
import { PatientIntakeTool } from '../../src/modules/voice/tools/patient-intake.tool';
import { IdempotencyService } from '../../src/modules/voice/idempotency/idempotency.service';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { testRedis } from './redis-test-util';
import { createVerifiedSession } from '../../src/modules/voice/session/voice-session';

/**
 * A caller was double-booked in production.
 *
 * One assistant turn emitted two `book_appointment` blocks at once — the model
 * had offered two free times, the caller said only "yes", and rather than ask
 * which one it hedged and booked both. Both returned "confirmed" and both rows
 * reached the database:
 *
 *     ITER 0 calls=[book_appointment, book_appointment]  -> confirmed, confirmed
 *     patient Iter175625x5 | 2 | 11-14 11:30, 11-14 13:30
 *
 * The idempotency key hashes the tool input, so two different times are two
 * different keys and the guard never engaged. That was deliberate — it let
 * "book me Tuesday and Thursday" work in a single turn — but it traded away the
 * property that actually matters: the prompt requires the details to be read
 * back and an explicit yes before any write, so ONE turn carries at most ONE
 * consent. A second write in the same turn is by construction a write the
 * caller never agreed to.
 *
 * The unit of consent is the turn, so the unit of commitment is the turn.
 */
function stubAudit(): AuditService {
  return { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
}

describe('one committed write per turn', () => {
  let registry: ToolRegistryService;
  let executor: ToolExecutorService;
  let idempotency: IdempotencyService;
  let appointments: any;
  let users: any;
  let patients: any;

  const ELEVEN_THIRTY = {
    startTime: '2026-11-14T11:30:00.000Z',
    endTime: '2026-11-14T12:00:00.000Z',
  };
  const ONE_THIRTY = {
    startTime: '2026-11-14T13:30:00.000Z',
    endTime: '2026-11-14T14:00:00.000Z',
  };

  beforeEach(() => {
    registry = new ToolRegistryService();
    executor = new ToolExecutorService(registry, stubAudit());
    idempotency = new IdempotencyService(testRedis());

    appointments = {
      create: jest.fn().mockImplementation((args: { startTime: string }) =>
        Promise.resolve({
          id: args.startTime === ELEVEN_THIRTY.startTime ? 'a-1130' : 'a-1330',
          startTime: args.startTime,
        })
      ),
      cancel: jest.fn().mockResolvedValue({ id: 'a1', status: 'cancelled' }),
      findById: jest.fn().mockResolvedValue({ id: 'a1', patientId: 'patient-1' }),
    };
    users = { findProviders: jest.fn().mockResolvedValue([{ id: 'prov-1' }]) };
    appointments.update = jest
      .fn()
      .mockImplementation((id: string, args: { startTime: string }) =>
        Promise.resolve({ id, startTime: args.startTime })
      );
    patients = {
      create: jest
        .fn()
        .mockImplementation((args: { lastName: string }) =>
          Promise.resolve({ id: `p-${args.lastName}` })
        ),
    };

    registry.register(new BookAppointmentTool(appointments as any, users as any, idempotency));
    registry.register(new CancelAppointmentTool(appointments as any, idempotency));
    registry.register(new RescheduleAppointmentTool(appointments as any, idempotency));
    registry.register(new PatientIntakeTool(patients as any, idempotency));
  });

  it('registers one patient per turn, and does not move the session onto a second', async () => {
    // Two intake blocks in one turn is the same hedge as two bookings, and the
    // harm is worse: the session's patientId follows the LAST confirmed intake,
    // so a second registration silently repoints the conversation — and every
    // write after it — at a different record than the one read back aloud.
    const session = createVerifiedSession('s-intake', 'u1', null as any);
    session.patientId = null;

    const first = await executor.execute(
      'start_patient_intake',
      { firstName: 'Ada', lastName: 'Lovelace', phone: '555-0100', dateOfBirth: '1990-01-01' },
      session
    );
    const second = await executor.execute(
      'start_patient_intake',
      { firstName: 'Ada', lastName: 'Byron', phone: '555-0100', dateOfBirth: '1990-01-01' },
      session
    );

    expect(patients.create).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('confirmed');
    expect(second.status).toBe('failed');
    expect(session.patientId).toBe('p-Lovelace');
  });

  it('moves one appointment per turn', async () => {
    const session = createVerifiedSession('s-move', 'u1', 'patient-1');

    const first = await executor.execute(
      'reschedule_appointment',
      { appointmentId: 'a1', ...ELEVEN_THIRTY },
      session
    );
    const second = await executor.execute(
      'reschedule_appointment',
      { appointmentId: 'a1', ...ONE_THIRTY },
      session
    );

    expect(appointments.update).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('confirmed');
    expect(second.status).toBe('failed');
  });

  it('refuses a second booking at a different time in the same turn', async () => {
    const session = createVerifiedSession('s-hedge', 'u1', 'patient-1');

    const first = await executor.execute('book_appointment', ELEVEN_THIRTY, session);
    const second = await executor.execute('book_appointment', ONE_THIRTY, session);

    // The exact production symptom: two rows for one "yes".
    expect(appointments.create).toHaveBeenCalledTimes(1);
    expect(first.status).toBe('confirmed');
    expect(second.status).toBe('failed');
  });

  it('tells the agent what is already booked instead of an opaque code', async () => {
    // The refusal has to be speakable. A bare error code is what made the
    // original failure indistinguishable from a terminal one, and the agent
    // then either gave up or, here, apologised for a booking it could not name.
    const session = createVerifiedSession('s-speak', 'u1', 'patient-1');

    await executor.execute('book_appointment', ELEVEN_THIRTY, session);
    const second = await executor.execute('book_appointment', ONE_THIRTY, session);

    expect(second.nextStep).toEqual(expect.any(String));
    expect(second.appointmentId).toBe('a-1130');
    expect(second.startTime).toBe(ELEVEN_THIRTY.startTime);
  });

  it('still lets a booking succeed after an earlier attempt failed in the same turn', async () => {
    // Observed run 1: 9:00 was taken, the agent retried 10:00 in the same turn
    // and that booking was correct. Only a COMMITTED write closes the turn, so
    // a failure must leave it open.
    const session = createVerifiedSession('s-retry', 'u1', 'patient-1');
    appointments.create
      .mockRejectedValueOnce(new Error('slot taken'))
      .mockResolvedValueOnce({ id: 'a-later', startTime: ONE_THIRTY.startTime });

    const failed = await executor.execute('book_appointment', ELEVEN_THIRTY, session);
    const booked = await executor.execute('book_appointment', ONE_THIRTY, session);

    expect(failed.status).toBe('failed');
    expect(booked.status).toBe('confirmed');
    expect(booked.appointmentId).toBe('a-later');
  });

  it('opens the next turn for a genuine second appointment', async () => {
    // "Book me Tuesday and Thursday" is not refused, only slowed to the rate at
    // which the caller actually confirms: one per turn.
    const session = createVerifiedSession('s-two-turns', 'u1', 'patient-1');

    const tuesday = await executor.execute('book_appointment', ELEVEN_THIRTY, session);
    session.turnIndex += 1;
    const thursday = await executor.execute('book_appointment', ONE_THIRTY, session);

    expect(tuesday.status).toBe('confirmed');
    expect(thursday.status).toBe('confirmed');
    expect(thursday.appointmentId).toBe('a-1330');
    expect(appointments.create).toHaveBeenCalledTimes(2);
  });

  it('replays a byte-identical retry as confirmed rather than refusing it', async () => {
    // A pipeline resend is not a second booking, and must not be reported as a
    // failure the agent reads aloud.
    const session = createVerifiedSession('s-replay', 'u1', 'patient-1');

    const first = await executor.execute('book_appointment', ELEVEN_THIRTY, session);
    const retry = await executor.execute('book_appointment', { ...ELEVEN_THIRTY }, session);

    expect(appointments.create).toHaveBeenCalledTimes(1);
    expect(retry.status).toBe('confirmed');
    expect(retry.appointmentId).toBe(first.appointmentId);
  });

  it('closes the turn for cancellations too', async () => {
    // The same turn in production also emitted [cancel_appointment,
    // cancel_appointment]. Same defect, same class of harm.
    const session = createVerifiedSession('s-cancel', 'u1', 'patient-1');
    appointments.findById.mockResolvedValue({ id: 'a1', patientId: 'patient-1' });
    appointments.cancel.mockImplementation((id: string) =>
      Promise.resolve({ id, status: 'cancelled' })
    );

    const first = await executor.execute('cancel_appointment', { appointmentId: 'a1' }, session);
    const second = await executor.execute('cancel_appointment', { appointmentId: 'a2' }, session);

    expect(first.status).toBe('confirmed');
    expect(second.status).toBe('failed');
    expect(appointments.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not let one session close another session at the same turn index', async () => {
    const mine = createVerifiedSession('s-mine', 'u1', 'patient-1');
    const theirs = createVerifiedSession('s-theirs', 'u2', 'patient-2');

    const a = await executor.execute('book_appointment', ELEVEN_THIRTY, mine);
    const b = await executor.execute('book_appointment', ELEVEN_THIRTY, theirs);

    expect(a.status).toBe('confirmed');
    expect(b.status).toBe('confirmed');
    expect(appointments.create).toHaveBeenCalledTimes(2);
  });
});
