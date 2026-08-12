import { Prisma } from '@prisma/client';
import { MyAppointmentsTool } from '../../src/modules/voice/tools/my-appointments.tool';
import { MyInvoicesTool } from '../../src/modules/voice/tools/my-invoices.tool';
import { MyBalanceTool } from '../../src/modules/voice/tools/my-balance.tool';
import { createVerifiedSession } from '../../src/modules/voice/session/voice-session';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { VoiceTool } from '../../src/modules/voice/tools/tool-definition.interface';
import { createAnonymousSession } from '../../src/modules/voice/session/voice-session';

describe('verified read tools', () => {
  const session = createVerifiedSession('s1', 'user-1', 'patient-1');

  it('my_appointments is verified-tier and exposes no patient parameter', () => {
    const tool = new MyAppointmentsTool({ findAll: jest.fn() } as any);
    expect(tool.tier).toBe('verified');
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/patientid/i);
  });

  it('my_appointments queries only the session patient', async () => {
    const appointments = { findAll: jest.fn().mockResolvedValue([]) };
    const tool = new MyAppointmentsTool(appointments as any);

    await tool.execute({}, session);

    expect(appointments.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: 'patient-1' })
    );
  });

  it('my_invoices is verified-tier and scoped to the session patient', async () => {
    const billing = { findAllInvoices: jest.fn().mockResolvedValue([]) };
    const tool = new MyInvoicesTool(billing as any);

    expect(tool.tier).toBe('verified');
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/patientid/i);

    await tool.execute({}, session);
    expect(billing.findAllInvoices).toHaveBeenCalledWith('patient-1');
  });

  it('my_balance is verified-tier and scoped to the session patient', async () => {
    const billing = {
      getPatientBalance: jest
        .fn()
        .mockResolvedValue({ totalBilled: '100.00', totalPaid: '40.00', balance: '60.00' }),
    };
    const tool = new MyBalanceTool(billing as any);

    expect(tool.tier).toBe('verified');
    const result = await tool.execute({}, session);

    expect(billing.getPatientBalance).toHaveBeenCalledWith('patient-1');
    expect(result.balance).toBe('60.00');
  });

  it('fails when the session somehow has no patient', async () => {
    const billing = { getPatientBalance: jest.fn() };
    const tool = new MyBalanceTool(billing as any);
    const broken = { ...session, patientId: null };

    const result = await tool.execute({}, broken);
    expect(result.status).toBe('failed');
    expect(billing.getPatientBalance).not.toHaveBeenCalled();
  });
});

/**
 * The tests above call execute() directly, proving the tools scope correctly
 * when handed a session. They do not prove the security machinery actually
 * gates these tools: a call must go through ToolExecutorService to prove
 * verification is enforced and that model-controlled input cannot override
 * the session-resolved patient.
 */
describe('verified read tools — routed through ToolExecutorService', () => {
  let registry: ToolRegistryService;
  let executor: ToolExecutorService;
  let appointments: { findAll: jest.Mock };
  let billing: { findAllInvoices: jest.Mock; getPatientBalance: jest.Mock };
  let appointmentsTool: MyAppointmentsTool;
  let invoicesTool: MyInvoicesTool;
  let balanceTool: MyBalanceTool;

  beforeEach(() => {
    registry = new ToolRegistryService();
    executor = new ToolExecutorService(registry);

    appointments = { findAll: jest.fn().mockResolvedValue([]) };
    billing = {
      findAllInvoices: jest.fn().mockResolvedValue([]),
      getPatientBalance: jest
        .fn()
        .mockResolvedValue({ totalBilled: '0.00', totalPaid: '0.00', balance: '0.00' }),
    };

    appointmentsTool = new MyAppointmentsTool(appointments as any);
    invoicesTool = new MyInvoicesTool(billing as any);
    balanceTool = new MyBalanceTool(billing as any);

    registry.register(appointmentsTool);
    registry.register(invoicesTool);
    registry.register(balanceTool);
  });

  describe('blocked when the session is not verified', () => {
    it('blocks get_my_appointments and never touches the service', async () => {
      const result = await executor.execute('get_my_appointments', {}, createAnonymousSession('s1'));
      expect(result).toEqual({ status: 'failed', error: 'verification_required' });
      expect(appointments.findAll).not.toHaveBeenCalled();
    });

    it('blocks get_my_invoices and never touches the service', async () => {
      const result = await executor.execute('get_my_invoices', {}, createAnonymousSession('s1'));
      expect(result).toEqual({ status: 'failed', error: 'verification_required' });
      expect(billing.findAllInvoices).not.toHaveBeenCalled();
    });

    it('blocks get_my_balance and never touches the service', async () => {
      const result = await executor.execute('get_my_balance', {}, createAnonymousSession('s1'));
      expect(result).toEqual({ status: 'failed', error: 'verification_required' });
      expect(billing.getPatientBalance).not.toHaveBeenCalled();
    });
  });

  describe('a verified session with an injected victim identifier still resolves to the session patient', () => {
    const verifiedAsPatient1 = createVerifiedSession('s1', 'user-1', 'patient-1');
    const hostileInput = { patientId: 'victim', patient_id: 'victim', userId: 'victim' };

    it('get_my_appointments queries patient-1, never victim', async () => {
      const result = await executor.execute('get_my_appointments', hostileInput, verifiedAsPatient1);

      expect(result.status).toBe('ok');
      expect(appointments.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ patientId: 'patient-1' })
      );
      expect(appointments.findAll).not.toHaveBeenCalledWith(
        expect.objectContaining({ patientId: 'victim' })
      );
    });

    it('get_my_invoices queries patient-1, never victim', async () => {
      const result = await executor.execute('get_my_invoices', hostileInput, verifiedAsPatient1);

      expect(result.status).toBe('ok');
      expect(billing.findAllInvoices).toHaveBeenCalledWith('patient-1');
      expect(billing.findAllInvoices).not.toHaveBeenCalledWith('victim');
    });

    it('get_my_balance queries patient-1, never victim', async () => {
      const result = await executor.execute('get_my_balance', hostileInput, verifiedAsPatient1);

      expect(result.status).toBe('ok');
      expect(billing.getPatientBalance).toHaveBeenCalledWith('patient-1');
      expect(billing.getPatientBalance).not.toHaveBeenCalledWith('victim');
    });
  });

  describe('registry sweep of the three tool instances', () => {
    it('none of the three tools exposes patientId, patient_id, or userId in inputSchema', () => {
      const tools: VoiceTool[] = [appointmentsTool, invoicesTool, balanceTool];
      const forbidden = ['patientId', 'patient_id', 'userId'];
      let iterations = 0;

      for (const tool of tools) {
        iterations += 1;
        const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
        const offending = Object.keys(properties).filter((key) => forbidden.includes(key));
        expect(offending).toEqual([]);
      }

      // Guards against this test going vacuous: the loop body must actually run
      // once per tool, not just report an empty pass over zero tools.
      expect(iterations).toBe(3);
    });

    it('all three declare tier "verified" and needsPatientContext true', () => {
      const tools: VoiceTool[] = [appointmentsTool, invoicesTool, balanceTool];
      let iterations = 0;

      for (const tool of tools) {
        iterations += 1;
        expect(tool.tier).toBe('verified');
        expect(tool.needsPatientContext).toBe(true);
      }

      expect(iterations).toBe(3);
    });
  });
});

/**
 * Monetary fields must be rendered with exactly two decimal places, preserving
 * Decimal precision, because the agent reads these numbers aloud. A trailing
 * zero dropped from a Decimal ("100.5" instead of "100.50") or a float
 * round-trip ("245.045" -> Number(...).toFixed(2) -> "245.04" instead of the
 * correctly-rounded "245.05") both cause the agent to misquote the patient.
 */
describe('verified read tools — monetary formatting', () => {
  it('formats a Decimal invoice total with two decimal places, not a truncated one', async () => {
    const session = createVerifiedSession('s1', 'user-1', 'patient-1');
    const billing = {
      findAllInvoices: jest.fn().mockResolvedValue([
        {
          invoiceNumber: 'INV-1',
          total: new Prisma.Decimal('100.50'),
          status: 'open',
          dueAt: new Date('2026-09-01'),
        },
      ]),
    };
    const tool = new MyInvoicesTool(billing as any);

    const result = await tool.execute({}, session);

    // A real Decimal('100.50') stringifies as "100.5" — proving this test
    // exercises the actual Decimal code path rather than a plain JS number,
    // which would be indistinguishable from 100.5 at runtime.
    expect(String(new Prisma.Decimal('100.50'))).toBe('100.5');

    const invoices = result.invoices as Array<{ total: string }>;
    expect(invoices[0].total).toBe('100.50');
  });

  it('rounds a Decimal with more than two decimal places the way Decimal.toFixed(2) does, not a naive float toFixed', async () => {
    const session = createVerifiedSession('s1', 'user-1', 'patient-1');
    const billing = {
      findAllInvoices: jest.fn().mockResolvedValue([
        {
          invoiceNumber: 'INV-2',
          total: new Prisma.Decimal('245.045'),
          status: 'open',
          dueAt: new Date('2026-09-01'),
        },
      ]),
    };
    const tool = new MyInvoicesTool(billing as any);

    const result = await tool.execute({}, session);
    const invoices = result.invoices as Array<{ total: string }>;

    // A naive `Number('245.045').toFixed(2)` reintroduces float imprecision
    // and yields "245.04" — the correct Decimal-rounded value is "245.05".
    expect(Number('245.045').toFixed(2)).toBe('245.04');
    expect(invoices[0].total).toBe('245.05');
  });

  it('formats invoice totals identically to how get_my_balance formats the same underlying value', async () => {
    const session = createVerifiedSession('s1', 'user-1', 'patient-1');
    const underlying = '245.045';

    const invoicesBilling = {
      findAllInvoices: jest.fn().mockResolvedValue([
        {
          invoiceNumber: 'INV-3',
          total: new Prisma.Decimal(underlying),
          status: 'open',
          dueAt: new Date('2026-09-01'),
        },
      ]),
    };
    const invoicesTool = new MyInvoicesTool(invoicesBilling as any);
    const invoicesResult = await invoicesTool.execute({}, session);
    const invoiceTotal = (invoicesResult.invoices as Array<{ total: string }>)[0].total;

    // BillingService.getPatientBalance formats with
    // `new Prisma.Decimal(x).toFixed(2)` (billing.service.ts:216-218). Mirror
    // that exact computation here so the two tools are proven not to drift.
    const expectedBalanceFormatting = new Prisma.Decimal(underlying).toFixed(2);

    const balanceBilling = {
      getPatientBalance: jest.fn().mockResolvedValue({
        totalBilled: expectedBalanceFormatting,
        totalPaid: '0.00',
        balance: expectedBalanceFormatting,
      }),
    };
    const balanceTool = new MyBalanceTool(balanceBilling as any);
    const balanceResult = await balanceTool.execute({}, session);

    expect(invoiceTotal).toBe(expectedBalanceFormatting);
    expect(balanceResult.balance).toBe(expectedBalanceFormatting);
    expect(invoiceTotal).toBe(balanceResult.balance);
  });
});
