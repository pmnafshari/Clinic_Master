
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { createVerifiedSession } from '../../src/modules/voice/session/voice-session';
import { VoiceToolResult } from '../../src/modules/voice/tools/tool-definition.interface';


const OWNER = 'patient-owner';
const OTHER = 'patient-other';

/**
 * Records which patient each backing service was asked about. The ownership
 * property is not "the call failed" — it is "the call was never made for a
 * patient the session does not act for".
 */
const VERIFIED_TOOLS = [
  'get_my_appointments',
  'get_my_invoices',
  'get_my_balance',
  'reschedule_appointment',
  'cancel_appointment',
] as const;

describe('a verified session acts only for its own patient', () => {
  it('gives every verified tool the session patient, never one from tool input', async () => {
    const registry = new ToolRegistryService();
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const executor = new ToolExecutorService(registry, audit as never);

    // A stand-in for each verified tool that records the patient it was handed.
    const handed: Record<string, string | null> = {};
    for (const name of VERIFIED_TOOLS) {
      registry.register({
        name,
        description: name,
        tier: 'verified',
        needsPatientContext: true,
        inputSchema: { type: 'object', properties: {}, required: [] },
        async execute(_input: Record<string, unknown>, session: { patientId: string | null }) {
          handed[name] = session.patientId;
          return { status: 'confirmed' } as VoiceToolResult;
        },
      } as never);
    }

    const session = createVerifiedSession('s-owner', 'user-owner', OWNER);

    for (const name of VERIFIED_TOOLS) {
      // The model asks for another patient's records by name. The executor
      // narrows to the session's own patient regardless.
      await executor.execute(name, { patientId: OTHER, patient_id: OTHER, userId: 'user-other' }, session);
    }

    for (const name of VERIFIED_TOOLS) {
      expect(handed[name]).toBe(OWNER);
      expect(handed[name]).not.toBe(OTHER);
    }
  });

  it('never lets tool input rewrite the session identity itself', async () => {
    const registry = new ToolRegistryService();
    const executor = new ToolExecutorService(
      registry,
      { log: jest.fn().mockResolvedValue(undefined) } as never
    );
    registry.register({
      name: 'get_my_balance',
      description: 'balance',
      tier: 'verified',
      needsPatientContext: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async execute() { return { status: 'confirmed' } as VoiceToolResult; },
    } as never);

    const session = createVerifiedSession('s1', 'user-owner', OWNER);
    await executor.execute(
      'get_my_balance',
      { patientId: OTHER, identityVerified: true, tier: 'public' },
      session
    );

    expect(session.patientId).toBe(OWNER);
    expect(session.userId).toBe('user-owner');
    expect(session.identityVerified).toBe(true);
  });

  it('still refuses every verified tool for an anonymous session', async () => {
    const registry = new ToolRegistryService();
    const executor = new ToolExecutorService(
      registry,
      { log: jest.fn().mockResolvedValue(undefined) } as never
    );
    for (const name of VERIFIED_TOOLS) {
      registry.register({
        name, description: name, tier: 'verified', needsPatientContext: true,
        inputSchema: { type: 'object', properties: {}, required: [] },
        async execute() { return { status: 'confirmed' } as VoiceToolResult; },
      } as never);
    }

    const anonymous = { ...createVerifiedSession('s2', 'u', OWNER), identityVerified: false, patientId: null, userId: null };

    for (const name of VERIFIED_TOOLS) {
      const result = await executor.execute(name, {}, anonymous);
      expect(result).toEqual({ status: 'failed', error: 'verification_required' });
    }
  });

  it('audits a verified tool call against the real user', async () => {
    const registry = new ToolRegistryService();
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const executor = new ToolExecutorService(registry, audit as never);
    registry.register({
      name: 'get_my_balance', description: 'balance', tier: 'verified', needsPatientContext: true,
      inputSchema: { type: 'object', properties: {}, required: [] },
      async execute() { return { status: 'confirmed' } as VoiceToolResult; },
    } as never);

    const session = createVerifiedSession('s3', 'user-owner', OWNER);
    await executor.execute('get_my_balance', {}, session);

    const call = audit.log.mock.calls.find((c) => c[0].action === 'get_my_balance');
    expect(call?.[0].userId).toBe('user-owner');
    expect(call?.[0].entityId).toBe(OWNER);
    // The bearer credential must not reach the audit row.
    expect(JSON.stringify(call?.[0])).not.toContain('s3');
  });
});
