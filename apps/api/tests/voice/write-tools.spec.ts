import { PatientIntakeTool } from '../../src/modules/voice/tools/patient-intake.tool';
import { BookAppointmentTool } from '../../src/modules/voice/tools/book-appointment.tool';
import { RescheduleAppointmentTool } from '../../src/modules/voice/tools/reschedule-appointment.tool';
import { CancelAppointmentTool } from '../../src/modules/voice/tools/cancel-appointment.tool';
import { IdempotencyService } from '../../src/modules/voice/idempotency/idempotency.service';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { VoiceTool } from '../../src/modules/voice/tools/tool-definition.interface';
import {
  createAnonymousSession,
  createVerifiedSession,
} from '../../src/modules/voice/session/voice-session';

/**
 * These are the first tools that CHANGE state. Two separate things need
 * proving, and they need separate kinds of test:
 *
 *  - the tools themselves behave (direct execute() calls, below), and
 *  - the security machinery around them actually holds (routed through the
 *    real ToolExecutorService, further down). Calling execute() directly
 *    bypasses the tier gate and the session narrowing that are the whole point.
 */
describe('write tools', () => {
  let idempotency: IdempotencyService;

  beforeEach(() => {
    idempotency = new IdempotencyService();
  });

  it('intake creates a patient and binds it to the session', async () => {
    const patients = { create: jest.fn().mockResolvedValue({ id: 'p-new' }) };
    const tool = new PatientIntakeTool(patients as any, idempotency);
    const session = createAnonymousSession('s1');

    const result = await tool.execute(
      { firstName: 'Ada', lastName: 'Lovelace', phone: '555-0100', dateOfBirth: '1990-01-01' },
      session
    );

    expect(result.status).toBe('confirmed');
    expect(session.patientId).toBe('p-new');
  });

  it('intake is idempotent within a turn', async () => {
    const patients = { create: jest.fn().mockResolvedValue({ id: 'p-new' }) };
    const tool = new PatientIntakeTool(patients as any, idempotency);
    const session = createAnonymousSession('s1');
    const input = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '555-0100',
      dateOfBirth: '1990-01-01',
    };

    await tool.execute(input, session);
    await tool.execute(input, session);

    expect(patients.create).toHaveBeenCalledTimes(1);
  });

  it('booking reports failed, not confirmed, when the slot conflicts', async () => {
    const appointments = {
      create: jest.fn().mockRejectedValue(new Error('conflicting appointment')),
    };
    const users = { findProviders: jest.fn().mockResolvedValue([{ id: 'prov-1' }]) };
    const tool = new BookAppointmentTool(appointments as any, users as any, idempotency);

    const session = createAnonymousSession('s1');
    session.patientId = 'p1';

    const result = await tool.execute(
      { startTime: '2026-09-01T09:00:00.000Z', endTime: '2026-09-01T09:30:00.000Z' },
      session
    );

    expect(result.status).toBe('failed');
  });

  it('booking is idempotent within a turn', async () => {
    const appointments = { create: jest.fn().mockResolvedValue({ id: 'a1', startTime: 'x' }) };
    const users = { findProviders: jest.fn().mockResolvedValue([{ id: 'prov-1' }]) };
    const tool = new BookAppointmentTool(appointments as any, users as any, idempotency);

    const session = createAnonymousSession('s1');
    session.patientId = 'p1';
    const input = {
      startTime: '2026-09-01T09:00:00.000Z',
      endTime: '2026-09-01T09:30:00.000Z',
    };

    await tool.execute(input, session);
    await tool.execute(input, session);

    expect(appointments.create).toHaveBeenCalledTimes(1);
  });

  it('cancel refuses an appointment belonging to another patient', async () => {
    const appointments = {
      findById: jest.fn().mockResolvedValue({ id: 'a1', patientId: 'someone-else' }),
      cancel: jest.fn(),
    };
    const tool = new CancelAppointmentTool(appointments as any, idempotency);
    const session = createVerifiedSession('s1', 'u1', 'patient-1');

    const result = await tool.execute({ appointmentId: 'a1' }, session);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('not_your_appointment');
    expect(appointments.cancel).not.toHaveBeenCalled();
  });

  it('cancel succeeds for the session patient', async () => {
    const appointments = {
      findById: jest.fn().mockResolvedValue({ id: 'a1', patientId: 'patient-1' }),
      cancel: jest.fn().mockResolvedValue({ id: 'a1', status: 'cancelled' }),
    };
    const tool = new CancelAppointmentTool(appointments as any, idempotency);
    const session = createVerifiedSession('s1', 'u1', 'patient-1');

    const result = await tool.execute({ appointmentId: 'a1' }, session);

    expect(result.status).toBe('confirmed');
    expect(appointments.cancel).toHaveBeenCalledWith('a1');
  });

  it('a missing appointment reads as not_your_appointment rather than throwing', async () => {
    // AppointmentsService.findById throws NotFoundException. A throw here would
    // escape as a generic tool_error and also leak whether the id exists.
    const appointments = {
      findById: jest.fn().mockRejectedValue(new Error('Appointment not found')),
      cancel: jest.fn(),
      update: jest.fn(),
    };
    const cancel = new CancelAppointmentTool(appointments as any, idempotency);
    const reschedule = new RescheduleAppointmentTool(appointments as any, idempotency);
    const session = createVerifiedSession('s1', 'u1', 'patient-1');

    const cancelResult = await cancel.execute({ appointmentId: 'nope' }, session);
    const rescheduleResult = await reschedule.execute(
      {
        appointmentId: 'nope',
        startTime: '2026-09-01T09:00:00.000Z',
        endTime: '2026-09-01T09:30:00.000Z',
      },
      session
    );

    expect(cancelResult).toEqual({ status: 'failed', error: 'not_your_appointment' });
    expect(rescheduleResult).toEqual({ status: 'failed', error: 'not_your_appointment' });
    expect(appointments.cancel).not.toHaveBeenCalled();
    expect(appointments.update).not.toHaveBeenCalled();
  });
});

/**
 * Everything below runs through the real ToolExecutorService, because the
 * properties under test (identity resolution, tier gating, session narrowing)
 * live in the executor, not in the tools.
 */
describe('write tools — routed through ToolExecutorService', () => {
  let registry: ToolRegistryService;
  let executor: ToolExecutorService;
  let idempotency: IdempotencyService;
  let patients: { create: jest.Mock };
  let appointments: {
    create: jest.Mock;
    update: jest.Mock;
    cancel: jest.Mock;
    findById: jest.Mock;
  };
  let users: { findProviders: jest.Mock };

  const BOOKING_INPUT = {
    startTime: '2026-09-01T09:00:00.000Z',
    endTime: '2026-09-01T09:30:00.000Z',
  };
  const INTAKE_INPUT = {
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '555-0100',
    dateOfBirth: '1990-01-01',
  };

  beforeEach(() => {
    registry = new ToolRegistryService();
    executor = new ToolExecutorService(registry);
    idempotency = new IdempotencyService();

    patients = { create: jest.fn().mockResolvedValue({ id: 'p-new' }) };
    appointments = {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'a-new', startTime: '2026-09-01T09:00:00.000Z' }),
      update: jest
        .fn()
        .mockResolvedValue({ id: 'a1', startTime: '2026-09-02T09:00:00.000Z' }),
      cancel: jest.fn().mockResolvedValue({ id: 'a1', status: 'cancelled' }),
      findById: jest.fn().mockResolvedValue({ id: 'a1', patientId: 'patient-1' }),
    };
    users = { findProviders: jest.fn().mockResolvedValue([{ id: 'prov-1' }]) };

    registry.register(new PatientIntakeTool(patients as any, idempotency));
    registry.register(new BookAppointmentTool(appointments as any, users as any, idempotency));
    registry.register(new RescheduleAppointmentTool(appointments as any, idempotency));
    registry.register(new CancelAppointmentTool(appointments as any, idempotency));
  });

  // ---- Properties 1 and 2: declarations -----------------------------------

  it('all four write tools declare needsPatientContext = true', () => {
    const names = [
      'start_patient_intake',
      'book_appointment',
      'reschedule_appointment',
      'cancel_appointment',
    ];
    let checked = 0;

    for (const name of names) {
      const tool = registry.get(name);
      expect(tool).toBeDefined();
      expect((tool as VoiceTool).needsPatientContext).toBe(true);
      checked += 1;
    }

    // Without this the loop could pass over an empty or short list.
    expect(checked).toBe(4);
  });

  it('each write tool declares its intended tier', () => {
    const expected: Array<[string, 'public' | 'verified']> = [
      ['start_patient_intake', 'public'],
      ['book_appointment', 'public'],
      ['reschedule_appointment', 'verified'],
      ['cancel_appointment', 'verified'],
    ];
    let checked = 0;

    for (const [name, tier] of expected) {
      expect((registry.get(name) as VoiceTool).tier).toBe(tier);
      checked += 1;
    }

    expect(checked).toBe(4);
  });

  // ---- Property 4: no model-controlled patient identifier -----------------

  it('no write tool exposes a patient identifier in its inputSchema', () => {
    const forbidden = ['patientId', 'patient_id', 'userId', 'needsPatientContext'];
    let inspectedProperties = 0;

    for (const tool of registry.all()) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
      inspectedProperties += Object.keys(properties).length;
      expect(Object.keys(properties).filter((key) => forbidden.includes(key))).toEqual([]);
    }

    // The four schemas together declare real properties, so the sweep above
    // actually inspected something rather than passing over empty objects.
    expect(inspectedProperties).toBeGreaterThanOrEqual(9);
  });

  // ---- Property 3 and 4: identity comes only from the session -------------

  it('booking ignores an injected patientId and books for the session patient', async () => {
    const session = createVerifiedSession('s-inject', 'u1', 'patient-1');
    const hostile = { ...BOOKING_INPUT, patientId: 'victim', patient_id: 'victim' };

    const result = await executor.execute('book_appointment', hostile, session);

    expect(result.status).toBe('confirmed');
    expect(appointments.create).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: 'patient-1' })
    );
    expect(appointments.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ patientId: 'victim' })
    );
  });

  it('cancel ignores an injected patientId when deciding ownership', async () => {
    // The appointment belongs to patient-1; the caller is patient-2 and claims
    // to be patient-1 through the input. Ownership must resolve from session.
    appointments.findById.mockResolvedValue({ id: 'a1', patientId: 'patient-1' });
    const session = createVerifiedSession('s-inject', 'u2', 'patient-2');

    const result = await executor.execute(
      'cancel_appointment',
      { appointmentId: 'a1', patientId: 'patient-1' },
      session
    );

    expect(result).toEqual({ status: 'failed', error: 'not_your_appointment' });
    expect(appointments.cancel).not.toHaveBeenCalled();
  });

  it('booking on an anonymous session with an injected patientId cannot invent a patient', async () => {
    const session = createAnonymousSession('s-anon');

    const result = await executor.execute(
      'book_appointment',
      { ...BOOKING_INPUT, patientId: 'victim' },
      session
    );

    expect(result).toEqual({ status: 'failed', error: 'no_patient_in_session' });
    expect(appointments.create).not.toHaveBeenCalled();
  });

  // ---- Property 2 (enforced): tier gate -----------------------------------

  it('blocks reschedule and cancel for an unverified session without touching the service', async () => {
    const session = createAnonymousSession('s-anon');

    const rescheduled = await executor.execute(
      'reschedule_appointment',
      { appointmentId: 'a1', ...BOOKING_INPUT },
      session
    );
    const cancelled = await executor.execute('cancel_appointment', { appointmentId: 'a1' }, session);

    expect(rescheduled).toEqual({ status: 'failed', error: 'verification_required' });
    expect(cancelled).toEqual({ status: 'failed', error: 'verification_required' });
    expect(appointments.findById).not.toHaveBeenCalled();
    expect(appointments.update).not.toHaveBeenCalled();
    expect(appointments.cancel).not.toHaveBeenCalled();
  });

  // ---- Property 5: replay executes exactly once ---------------------------

  it('a replayed booking in the same turn writes exactly once', async () => {
    const session = createVerifiedSession('s-replay', 'u1', 'patient-1');

    const first = await executor.execute('book_appointment', BOOKING_INPUT, session);
    const second = await executor.execute('book_appointment', BOOKING_INPUT, session);

    expect(first.status).toBe('confirmed');
    expect(second).toEqual(first);
    expect(appointments.create).toHaveBeenCalledTimes(1);
  });

  it('a replayed cancel in the same turn cancels exactly once', async () => {
    const session = createVerifiedSession('s-replay', 'u1', 'patient-1');

    await executor.execute('cancel_appointment', { appointmentId: 'a1' }, session);
    await executor.execute('cancel_appointment', { appointmentId: 'a1' }, session);

    expect(appointments.cancel).toHaveBeenCalledTimes(1);
  });

  it('a replayed reschedule in the same turn updates exactly once', async () => {
    const session = createVerifiedSession('s-replay', 'u1', 'patient-1');
    const input = { appointmentId: 'a1', ...BOOKING_INPUT };

    await executor.execute('reschedule_appointment', input, session);
    await executor.execute('reschedule_appointment', input, session);

    expect(appointments.update).toHaveBeenCalledTimes(1);
  });

  it('a new turn is a new operation, not a replay', async () => {
    const session = createVerifiedSession('s-turns', 'u1', 'patient-1');

    await executor.execute('book_appointment', BOOKING_INPUT, session);
    session.turnIndex = 1;
    await executor.execute('book_appointment', BOOKING_INPUT, session);

    expect(appointments.create).toHaveBeenCalledTimes(2);
  });

  // ---- Property 6: failures stay retryable --------------------------------

  it('a failed booking is not cached, so the retry genuinely retries', async () => {
    appointments.create
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ id: 'a-new', startTime: '2026-09-01T09:00:00.000Z' });
    const session = createVerifiedSession('s-retry', 'u1', 'patient-1');

    const first = await executor.execute('book_appointment', BOOKING_INPUT, session);
    const second = await executor.execute('book_appointment', BOOKING_INPUT, session);

    expect(first.status).toBe('failed');
    expect(second.status).toBe('confirmed');
    expect(appointments.create).toHaveBeenCalledTimes(2);
  });

  // ---- Property 7: the exclusion constraint is inherited, not bypassed -----

  it('a slot conflict rejected by AppointmentsService is reported failed, never confirmed', async () => {
    appointments.create.mockRejectedValue(new Error('Provider has a conflicting appointment'));
    const session = createVerifiedSession('s-conflict', 'u1', 'patient-1');

    const result = await executor.execute('book_appointment', BOOKING_INPUT, session);

    expect(result.status).toBe('failed');
    expect(result.status).not.toBe('confirmed');
    expect(result.error).toBe('slot_unavailable');
    // The booking went through the service, which is what carries the
    // serializable transaction and the database exclusion constraint.
    expect(appointments.create).toHaveBeenCalledTimes(1);
  });

  it('a reschedule conflict rejected by AppointmentsService is reported failed', async () => {
    appointments.update.mockRejectedValue(new Error('Provider has a conflicting appointment'));
    const session = createVerifiedSession('s-conflict', 'u1', 'patient-1');

    const result = await executor.execute(
      'reschedule_appointment',
      { appointmentId: 'a1', ...BOOKING_INPUT },
      session
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('slot_unavailable');
    expect(appointments.update).toHaveBeenCalledTimes(1);
  });

  it('booking fails when no provider exists rather than writing without one', async () => {
    users.findProviders.mockResolvedValue([]);
    const session = createVerifiedSession('s-noprov', 'u1', 'patient-1');

    const result = await executor.execute('book_appointment', BOOKING_INPUT, session);

    expect(result).toEqual({ status: 'failed', error: 'no_provider_available' });
    expect(appointments.create).not.toHaveBeenCalled();
  });

  // ---- Property 8: intake then book, in one session ------------------------

  it('intake binds the new patient into the session and a later booking uses it', async () => {
    const session = createAnonymousSession('s-flow');

    const intake = await executor.execute('start_patient_intake', INTAKE_INPUT, session);
    expect(intake.status).toBe('confirmed');

    // The write survived the executor's session narrowing. This only holds
    // because PatientIntakeTool declares needsPatientContext and is therefore
    // handed the real session object rather than a throwaway copy.
    expect(session.patientId).toBe('p-new');

    const booking = await executor.execute('book_appointment', BOOKING_INPUT, session);

    expect(booking.status).toBe('confirmed');
    expect(appointments.create).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: 'p-new', providerId: 'prov-1' })
    );
  });

  it('the intake-to-book flow depends on the capability flag, not on luck', async () => {
    // Negative control for the test above. Same tools, same executor, but this
    // intake instance has the capability flag stripped — so the executor hands
    // it a narrowed copy and its write to session.patientId is discarded. If
    // the flow above passed for some other reason (a shared object smuggled in
    // by accident), this control would still succeed and reveal it.
    const flagless = new PatientIntakeTool(patients as any, idempotency) as VoiceTool;
    delete flagless.needsPatientContext;
    registry.register(flagless);

    const session = createAnonymousSession('s-control');

    const intake = await executor.execute('start_patient_intake', INTAKE_INPUT, session);
    expect(intake.status).toBe('confirmed');
    expect(session.patientId).toBeNull();

    const booking = await executor.execute('book_appointment', BOOKING_INPUT, session);
    expect(booking).toEqual({ status: 'failed', error: 'no_patient_in_session' });
    expect(appointments.create).not.toHaveBeenCalled();
  });

  it('a verified session can go straight to booking without intake', async () => {
    const session = createVerifiedSession('s-verified', 'u1', 'patient-1');

    const booking = await executor.execute('book_appointment', BOOKING_INPUT, session);

    expect(booking.status).toBe('confirmed');
    expect(patients.create).not.toHaveBeenCalled();
    expect(appointments.create).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: 'patient-1' })
    );
  });

  // ---- Property 9: cross-patient writes fail closed ------------------------

  it('reschedule of another patient’s appointment fails closed', async () => {
    appointments.findById.mockResolvedValue({ id: 'a1', patientId: 'patient-1' });
    const attacker = createVerifiedSession('s-attack', 'u2', 'patient-2');

    const result = await executor.execute(
      'reschedule_appointment',
      { appointmentId: 'a1', ...BOOKING_INPUT },
      attacker
    );

    expect(result).toEqual({ status: 'failed', error: 'not_your_appointment' });
    expect(appointments.update).not.toHaveBeenCalled();
  });

  it('cancel of another patient’s appointment fails closed', async () => {
    appointments.findById.mockResolvedValue({ id: 'a1', patientId: 'patient-1' });
    const attacker = createVerifiedSession('s-attack', 'u2', 'patient-2');

    const result = await executor.execute(
      'cancel_appointment',
      { appointmentId: 'a1' },
      attacker
    );

    expect(result).toEqual({ status: 'failed', error: 'not_your_appointment' });
    expect(appointments.cancel).not.toHaveBeenCalled();
  });

  it('the owner of the same appointment does succeed, so the refusals above are about ownership', async () => {
    appointments.findById.mockResolvedValue({ id: 'a1', patientId: 'patient-1' });
    const owner = createVerifiedSession('s-owner', 'u1', 'patient-1');

    const cancelled = await executor.execute('cancel_appointment', { appointmentId: 'a1' }, owner);

    expect(cancelled.status).toBe('confirmed');
    expect(appointments.cancel).toHaveBeenCalledWith('a1');
  });
});
