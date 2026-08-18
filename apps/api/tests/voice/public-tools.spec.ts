import { ClinicInfoTool } from '../../src/modules/voice/tools/clinic-info.tool';
import { ServicePricingTool } from '../../src/modules/voice/tools/service-pricing.tool';
import { CheckAvailabilityTool } from '../../src/modules/voice/tools/check-availability.tool';
import { createAnonymousSession, createVerifiedSession } from '../../src/modules/voice/session/voice-session';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { VoiceTool } from '../../src/modules/voice/tools/tool-definition.interface';
import { VoiceSession } from '../../src/modules/voice/session/voice-session';


/**
 * The executor audits every tool call it handles. What that record contains —
 * and that it never carries the bearer sessionId — is covered in
 * tool-audit.spec.ts; here the audit service only has to exist.
 */
function stubAudit(): AuditService {
  return { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
}

describe('public tools', () => {
  const session = createAnonymousSession('s1');

  it('clinic info is public and returns hours and address', async () => {
    const tool: VoiceTool = new ClinicInfoTool();
    expect(tool.tier).toBe('public');
    const result = await tool.execute({}, session);
    expect(result.status).toBe('ok');
    expect(result.hours).toBeDefined();
    expect(result.address).toBeDefined();
  });

  it('service pricing is public and returns ranges', async () => {
    const tool: VoiceTool = new ServicePricingTool();
    expect(tool.tier).toBe('public');
    const result = await tool.execute({}, session);
    expect(result.status).toBe('ok');
    expect(Array.isArray(result.services)).toBe(true);
  });

  it('availability returns only slot times, never patient data', async () => {
    const appointments = {
      getAvailability: jest.fn().mockResolvedValue([
        { time: '09:00', available: true },
        { time: '09:30', available: false },
      ]),
    };
    const users = { findProviders: jest.fn().mockResolvedValue([{ id: 'prov-1' }]) };

    const tool: VoiceTool = new CheckAvailabilityTool(appointments as any, users as any);
    expect(tool.tier).toBe('public');

    const result = await tool.execute({ date: '2026-09-01' }, session);
    expect(result.status).toBe('ok');
    expect(result.availableTimes).toEqual(['09:00']);
    expect(JSON.stringify(result)).not.toMatch(/patient/i);
  });

  it('availability reports failure when no provider exists', async () => {
    const appointments = { getAvailability: jest.fn() };
    const users = { findProviders: jest.fn().mockResolvedValue([]) };

    const tool: VoiceTool = new CheckAvailabilityTool(appointments as any, users as any);
    const result = await tool.execute({ date: '2026-09-01' }, session);
    expect(result.status).toBe('failed');
  });
});

/**
 * The tests above call execute() directly. That proves the tools work, but not
 * that the security machinery actually protects them: a tool could quietly
 * start reading session.patientId and these tests would never notice, because
 * an anonymous session already has none to leak.
 *
 * These tests go through ToolExecutorService instead, with a FULLY VERIFIED
 * session, and prove the executor's projection still nulls out identity before
 * a public tool ever sees it — because none of these three tools declares
 * needsPatientContext.
 */
describe('public tools — executor projection protects patient identity', () => {
  const appointments = {
    getAvailability: jest.fn().mockResolvedValue([
      { time: '09:00', available: true },
      { time: '09:30', available: false },
    ]),
  };
  const users = { findProviders: jest.fn().mockResolvedValue([{ id: 'prov-1' }]) };

  const tools: VoiceTool[] = [
    new ClinicInfoTool(),
    new ServicePricingTool(),
    new CheckAvailabilityTool(appointments as any, users as any),
  ];

  let registry: ToolRegistryService;
  let executor: ToolExecutorService;
  const seenSessions: Record<string, VoiceSession | undefined> = {};

  beforeEach(() => {
    registry = new ToolRegistryService();
    executor = new ToolExecutorService(registry, stubAudit());

    // Wrap each tool so it records exactly the session object it was handed,
    // without changing its real execute() logic.
    for (const tool of tools) {
      const originalExecute = tool.execute.bind(tool);
      registry.register({
        ...tool,
        execute: async (input, session) => {
          seenSessions[tool.name] = session;
          return originalExecute(input, session);
        },
      });
    }
  });

  it('none of the three tools declares needsPatientContext', () => {
    for (const tool of tools) {
      expect(tool.needsPatientContext).toBeUndefined();
    }
  });

  it('narrows userId and patientId to null for each tool, even for a fully verified session', async () => {
    const verified = createVerifiedSession('s1', 'user-1', 'patient-1');

    for (const tool of tools) {
      const input = tool.name === 'check_availability' ? { date: '2026-09-01' } : {};
      const result = await executor.execute(tool.name, input, verified);

      expect(result.status).toBe('ok');
      expect(seenSessions[tool.name]?.patientId).toBeNull();
      expect(seenSessions[tool.name]?.userId).toBeNull();
    }
  });

  it("check_availability's result contains no patient-identifying field", async () => {
    const verified = createVerifiedSession('s1', 'user-1', 'patient-1');

    const result = await executor.execute(
      'check_availability',
      { date: '2026-09-01' },
      verified
    );

    expect(result.status).toBe('ok');
    expect(result).not.toHaveProperty('patientId');
    expect(result).not.toHaveProperty('patient_id');
    expect(result).not.toHaveProperty('userId');
    expect(JSON.stringify(result)).not.toMatch(/patient/i);
  });
});
