import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { Logger } from '@nestjs/common';

import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import {
  VoiceTool,
  VoiceToolResult,
} from '../../src/modules/voice/tools/tool-definition.interface';
import {
  createAnonymousSession,
  createVerifiedSession,
  newLogId,
} from '../../src/modules/voice/session/voice-session';

/**
 * Spec §7: every tool call must be reconstructible from `AuditLog`, including
 * the ones the executor refused. A refused attempt is precisely what an
 * investigation into a disputed booking needs to see.
 *
 * Two things constrain how that record is written:
 *
 * 1. `session.sessionId` is a bearer credential — whoever holds one can resume
 *    the conversation inside the session TTL, read back what intake collected,
 *    and inherit `patientId`. Persisting it in an audit table would put live
 *    credentials at rest, reachable by any DB read, backup, or ops query. The
 *    audit row therefore carries `session.logId` under `sessionLogId`: the
 *    non-secret correlation id, which is all auditing actually needs.
 * 2. Auditing is an observer, never a participant. A failed audit write must
 *    leave the tool's own result — and any business write it already
 *    committed — completely untouched.
 */

interface AuditStub {
  log: jest.Mock;
}

function auditStub(): AuditStub {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

function asAudit(stub: AuditStub): AuditService {
  return stub as unknown as AuditService;
}

function stubTool(
  name: string,
  tier: 'public' | 'verified',
  execute: VoiceTool['execute'] = async () => ({ status: 'ok' })
): VoiceTool {
  return {
    name,
    tier,
    description: `stub ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    needsPatientContext: true,
    execute,
  };
}

/** Everything the executor handed the audit service, as one searchable string. */
function auditPayloads(audit: AuditStub): string {
  return audit.log.mock.calls.map((call) => JSON.stringify(call[0])).join('\n');
}

describe('tool call auditing', () => {
  let registry: ToolRegistryService;
  let audit: AuditStub;
  let executor: ToolExecutorService;

  beforeEach(() => {
    registry = new ToolRegistryService();
    audit = auditStub();
    executor = new ToolExecutorService(registry, asAudit(audit));
  });

  it('audits a successful call against the session log id', async () => {
    registry.register(stubTool('public_thing', 'public'));
    const session = createVerifiedSession('s1', 'u1', 'p1');

    await executor.execute('public_thing', {}, session);

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionLogId: session.logId,
        userId: 'u1',
        entityType: 'VoiceToolCall',
        entityId: 'p1',
        action: 'public_thing',
        newValues: expect.objectContaining({ status: 'ok' }),
      })
    );
  });

  it('audits a blocked call so a refused attempt is on the record', async () => {
    const execute = jest.fn(async (): Promise<VoiceToolResult> => ({ status: 'ok' }));
    registry.register(stubTool('private_thing', 'verified', execute));
    const session = createAnonymousSession('s2');

    await executor.execute('private_thing', {}, session);

    // The block really happened: the tool body never ran.
    expect(execute).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionLogId: session.logId,
        userId: null,
        entityType: 'VoiceToolCall',
        action: 'private_thing',
        newValues: expect.objectContaining({
          status: 'failed',
          error: 'verification_required',
        }),
      })
    );
  });

  it('audits a call to a tool that does not exist', async () => {
    const session = createAnonymousSession('s3');

    await executor.execute('no_such_tool', {}, session);

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionLogId: session.logId,
        action: 'no_such_tool',
        newValues: expect.objectContaining({ status: 'failed', error: 'unknown_tool' }),
      })
    );
  });

  it('audits a tool that threw, with the outcome status and error code', async () => {
    registry.register(
      stubTool('exploding_thing', 'public', async () => {
        throw new Error('downstream exploded');
      })
    );
    const session = createVerifiedSession('s4', 'u4', 'p4');

    const result = await executor.execute('exploding_thing', {}, session);

    expect(result).toEqual({ status: 'failed', error: 'tool_error' });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionLogId: session.logId,
        action: 'exploding_thing',
        newValues: expect.objectContaining({ status: 'failed', error: 'tool_error' }),
      })
    );
  });

  it('never puts the bearer sessionId or the idempotency nonce in the record', async () => {
    registry.register(stubTool('public_thing', 'public'));
    registry.register(stubTool('private_thing', 'verified'));
    const verified = createVerifiedSession('verified-session-secret-value', 'u5', 'p5');
    const anonymous = createAnonymousSession('anonymous-session-secret-value');

    await executor.execute('public_thing', {}, verified);
    await executor.execute('private_thing', {}, anonymous);

    const payloads = auditPayloads(audit);
    expect(audit.log).toHaveBeenCalledTimes(2);
    expect(payloads).not.toContain(verified.sessionId);
    expect(payloads).not.toContain(anonymous.sessionId);
    expect(payloads).not.toContain(verified.idempotencyNonce);
    expect(payloads).not.toContain(anonymous.idempotencyNonce);

    // ...and the rows are still correlatable to their conversations.
    expect(payloads).toContain(verified.logId);
    expect(payloads).toContain(anonymous.logId);
  });

  it('does not dump raw tool input into the record', async () => {
    registry.register(stubTool('public_thing', 'public'));
    const session = createVerifiedSession('s6', 'u6', 'p6');

    await executor.execute(
      'public_thing',
      {
        // A model can be talked into putting anything at all in a tool argument.
        note: 'sk-live-not-a-real-key-0987654321',
        dateOfBirth: '1984-02-29',
        phone: '+1-555-0100',
      },
      session
    );

    const payloads = auditPayloads(audit);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(payloads).not.toContain('sk-live-not-a-real-key-0987654321');
    expect(payloads).not.toContain('1984-02-29');
    expect(payloads).not.toContain('+1-555-0100');
  });

  it('does not copy the tool result payload into the record', async () => {
    registry.register(
      stubTool('public_thing', 'public', async () => ({
        status: 'ok',
        patientName: 'Jane Q. Patient',
        balance: 1234.56,
      }))
    );
    const session = createVerifiedSession('s7', 'u7', 'p7');

    await executor.execute('public_thing', {}, session);

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(auditPayloads(audit)).not.toContain('Jane Q. Patient');
    expect(auditPayloads(audit)).not.toContain('1234.56');
  });

  it('audits an anonymous session under its sessionLogId with a null userId', async () => {
    registry.register(stubTool('public_thing', 'public'));
    const session = createAnonymousSession('s8');

    await executor.execute('public_thing', {}, session);

    const record = audit.log.mock.calls[0][0];
    expect(record.userId).toBeNull();
    expect(record.sessionLogId).toBe(session.logId);
    expect(typeof record.sessionLogId).toBe('string');
  });

  it('writes the audit only after the tool has finished, never inside its work', async () => {
    let toolFinished = false;
    let finishedWhenAudited: boolean | undefined;

    audit.log.mockImplementation(async () => {
      finishedWhenAudited = toolFinished;
    });

    registry.register(
      stubTool('public_thing', 'public', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        toolFinished = true;
        return { status: 'ok' };
      })
    );

    await executor.execute('public_thing', {}, createAnonymousSession('s9'));

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(finishedWhenAudited).toBe(true);
  });

  describe('when the audit write fails', () => {
    let auditThrew: boolean;

    beforeEach(() => {
      auditThrew = false;
      audit.log.mockImplementation(async () => {
        auditThrew = true;
        throw new Error('audit database down');
      });
    });

    it('returns the tool result unchanged', async () => {
      registry.register(
        stubTool('public_thing', 'public', async () => ({
          status: 'ok',
          slots: ['09:00', '10:00'],
        }))
      );

      const result = await executor.execute(
        'public_thing',
        {},
        createAnonymousSession('s10')
      );

      // The audit path was genuinely exercised and genuinely threw.
      expect(auditThrew).toBe(true);
      expect(result).toEqual({ status: 'ok', slots: ['09:00', '10:00'] });
    });

    it('does not turn a confirmed write into a failed one', async () => {
      registry.register(
        stubTool('book_thing', 'public', async () => ({
          status: 'confirmed',
          appointmentId: 'appt-1',
        }))
      );

      const result = await executor.execute(
        'book_thing',
        {},
        createVerifiedSession('s11', 'u11', 'p11')
      );

      expect(auditThrew).toBe(true);
      expect(result.status).toBe('confirmed');
      expect(result.appointmentId).toBe('appt-1');
    });

    it('keeps the session credentials out of the failure log', async () => {
      const messages: string[] = [];
      const spies = [
        jest.spyOn(Logger.prototype, 'error').mockImplementation(((...args: unknown[]) => {
          messages.push(args.map((arg) => String(arg)).join(' '));
        }) as never),
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(((...args: unknown[]) => {
          messages.push(args.map((arg) => String(arg)).join(' '));
        }) as never),
      ];

      registry.register(stubTool('public_thing', 'public'));
      const session = createVerifiedSession('s12-secret-session-id', 'u12', 'p12');

      try {
        await executor.execute('public_thing', {}, session);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }

      const joined = messages.join('\n');
      expect(auditThrew).toBe(true);
      // The failure was actually reported...
      expect(joined).toContain(session.logId);
      // ...without handing a log reader the credential.
      expect(joined).not.toContain(session.sessionId);
      expect(joined).not.toContain(session.idempotencyNonce);
    });
  });
});

describe('tool call auditing against Postgres', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let auditService: AuditService;
  const writtenIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
      providers: [AuditService],
    }).compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    auditService = moduleRef.get(AuditService);
  });

  afterAll(async () => {
    if (writtenIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { id: { in: writtenIds } } });
    }
    await moduleRef.close();
  });

  it('stores an anonymous tool call with no user and a session log id', async () => {
    const logId = newLogId();

    const created = await auditService.log({
      userId: null,
      sessionLogId: logId,
      entityType: 'VoiceToolCall',
      entityId: 'unknown',
      action: 'get_clinic_info',
      newValues: { status: 'ok' },
    });
    writtenIds.push(created.id);

    const found = await prisma.auditLog.findMany({ where: { sessionLogId: logId } });

    expect(found).toHaveLength(1);
    expect(found[0].userId).toBeNull();
    expect(found[0].action).toBe('get_clinic_info');
  });

  it('keeps the User relation intact for rows that do have a user', async () => {
    const withUser = await prisma.auditLog.findFirst({
      where: { userId: { not: null } },
      include: { user: true },
    });

    expect(withUser).not.toBeNull();
    expect(withUser?.userId).toEqual(expect.any(String));
    expect(withUser?.user?.id).toBe(withUser?.userId);
  });

  it('leaves a committed business write in place when the audit write fails', async () => {
    const registry = new ToolRegistryService();
    const throwingAudit: AuditStub = {
      log: jest.fn().mockRejectedValue(new Error('audit database down')),
    };
    const executor = new ToolExecutorService(registry, asAudit(throwingAudit));
    const subject = `audit-isolation-${newLogId()}`;

    registry.register(
      stubTool('book_thing', 'public', async () => {
        // A real write tool's shape: the business work commits in its own
        // transaction, which the audit write must sit outside of.
        const created = await prisma.$transaction(async (tx) => {
          return tx.notification.create({
            data: {
              type: 'test',
              channel: 'test',
              subject,
              content: 'business write that must survive an audit failure',
              status: 'pending',
            },
          });
        });
        return { status: 'confirmed', notificationId: created.id };
      })
    );

    const result = await executor.execute(
      'book_thing',
      {},
      createVerifiedSession('s13', 'u13', 'p13')
    );

    const surviving = await prisma.notification.findMany({ where: { subject } });
    await prisma.notification.deleteMany({ where: { subject } });

    expect(throwingAudit.log).toHaveBeenCalledTimes(1);
    await expect(throwingAudit.log.mock.results[0].value).rejects.toThrow(
      'audit database down'
    );
    expect(result.status).toBe('confirmed');
    expect(surviving).toHaveLength(1);
  });
});
