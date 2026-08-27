import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PhoneLookupService } from '../../src/modules/voice/otp/phone-lookup.service';
import { RequestVerificationCodeTool } from '../../src/modules/voice/tools/request-verification-code.tool';
import { SubmitVerificationCodeTool } from '../../src/modules/voice/tools/submit-verification-code.tool';
import { OtpService } from '../../src/modules/voice/otp/otp.service';
import { OTP_VERIFIED_TTL_MS, OTP_MAX_ATTEMPTS } from '../../src/modules/voice/otp/otp.constants';
import { SmsSender } from '../../src/modules/voice/otp/sms-sender.interface';
import { isVerificationActive } from '../../src/modules/voice/session/verification';
import {
  privilegeChanged,
  snapshotPrivilege,
} from '../../src/modules/voice/session/privilege-change';
import { createAnonymousSession, VoiceSession } from '../../src/modules/voice/session/voice-session';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { VoiceTool } from '../../src/modules/voice/tools/tool-definition.interface';
import { testRedis } from './redis-test-util';

const CALLER = '+15551234567';
const PATIENT = 'patient-owner';

class RecordingSender implements SmsSender {
  readonly sent: Array<{ to: string; message: string }> = [];
  async send(to: string, message: string): Promise<void> {
    this.sent.push({ to, message });
  }
  get lastCode(): string {
    return /(\d{6})/.exec(this.sent[this.sent.length - 1].message)![1];
  }
}

/** A Prisma stand-in whose patient table is exactly the rows a test names. */
function prismaWith(rows: Array<{ id: string; phone: string }>): PrismaService {
  return {
    patient: {
      findMany: async ({ where }: { where: { phone: string } }) =>
        rows.filter((r) => r.phone === where.phone).map((r) => ({ id: r.id })),
    },
  } as unknown as PrismaService;
}

describe('phone lookup is exact and fails closed', () => {
  it('resolves a single exact E.164 match', async () => {
    const lookup = new PhoneLookupService(prismaWith([{ id: PATIENT, phone: CALLER }]));

    expect(await lookup.eligiblePatient(CALLER)).toBe(PATIENT);
  });

  it('is ineligible when nothing matches', async () => {
    const lookup = new PhoneLookupService(prismaWith([]));

    expect(await lookup.eligiblePatient(CALLER)).toBeUndefined();
  });

  it('is ineligible when the number belongs to more than one patient', async () => {
    const lookup = new PhoneLookupService(
      prismaWith([
        { id: 'patient-a', phone: CALLER },
        { id: 'patient-b', phone: CALLER },
      ])
    );

    // Shared household numbers are ordinary. Proving control of one must not
    // open another family member's records.
    expect(await lookup.eligiblePatient(CALLER)).toBeUndefined();
  });

  it('never selects the first patient from an ambiguous result', async () => {
    const lookup = new PhoneLookupService(
      prismaWith([
        { id: 'patient-a', phone: CALLER },
        { id: 'patient-b', phone: CALLER },
        { id: 'patient-c', phone: CALLER },
      ])
    );

    const resolved = await lookup.eligiblePatient(CALLER);
    expect(resolved).toBeUndefined();
    expect(resolved).not.toBe('patient-a');
  });

  it('returns the identical value for no match and for many', async () => {
    const none = await new PhoneLookupService(prismaWith([])).eligiblePatient(CALLER);
    const many = await new PhoneLookupService(
      prismaWith([
        { id: 'a', phone: CALLER },
        { id: 'b', phone: CALLER },
      ])
    ).eligiblePatient(CALLER);

    // One value, not two shapes that happen to be falsy.
    expect(none).toEqual(many);
  });

  describe('legacy values cannot be reached by transformation', () => {
    /**
     * Every row below is a real format from this repository's data. None is
     * E.164, and none may become reachable by quietly widening the match — a
     * phone match is an authentication decision, and a fuzzy one is not a
     * lesser version of authentication.
     */
    const legacy = [
      { id: 'p-hyphen-short', phone: '555-0101' },
      { id: 'p-hyphen-long', phone: '555-1234567' },
      { id: 'p-bare-ten', phone: '5551234567' },
      { id: 'p-spaces', phone: '+1 555 123 4567' },
      { id: 'p-parens', phone: '(555) 123-4567' },
      { id: 'p-no-plus', phone: '15551234567' },
    ];

    it.each(legacy)('does not match $phone against an E.164 caller', async ({ phone }) => {
      const lookup = new PhoneLookupService(prismaWith([{ id: 'p', phone }]));

      expect(await lookup.eligiblePatient(CALLER)).toBeUndefined();
    });

    it('queries for the caller string verbatim and nothing else', async () => {
      const queried: string[] = [];
      const prisma = {
        patient: {
          findMany: async ({ where }: { where: { phone: string } }) => {
            queried.push(where.phone);
            return [];
          },
        },
      } as unknown as PrismaService;

      await new PhoneLookupService(prisma).eligiblePatient(CALLER);

      // One equality query. No `in:` candidate list, no `contains`, no
      // `endsWith` — those are the shapes a widened match would need.
      expect(queried).toEqual([CALLER]);
    });
  });
});

describe('request_verification_code', () => {
  let redis: Redis;
  let sender: RecordingSender;
  let otp: OtpService;
  let session: VoiceSession;
  let n = 0;

  beforeAll(() => { redis = testRedis(); });

  beforeEach(async () => {
    process.env.OTP_HMAC_SECRET = 'test-otp-secret';
    await redis.flushdb();
    sender = new RecordingSender();
    otp = new OtpService(redis, sender);
    n += 1;
    session = createAnonymousSession(`s-req-${n}`);
  });

  function tool(rows: Array<{ id: string; phone: string }>): RequestVerificationCodeTool {
    return new RequestVerificationCodeTool(otp, new PhoneLookupService(prismaWith(rows)));
  }

  describe('the tool contract', () => {
    it('exposes no phone number field, and no fields at all', () => {
      const schema = tool([]).inputSchema as {
        properties?: Record<string, unknown>;
        additionalProperties?: boolean;
      };

      // A prompt injection has no parameter to attack because the schema does
      // not expose one.
      expect(schema.properties ?? {}).toEqual({});
      expect(schema.additionalProperties).toBe(false);
      expect(JSON.stringify(schema)).not.toMatch(/phone/i);
    });

    it('is public tier and asks for patient context', () => {
      const t = tool([]);
      // Public: an anonymous caller must be able to reach it at all.
      expect(t.tier).toBe('public');
      // It reads the session id and nothing else, so it is handed the narrowed
      // session like any tool that has no business knowing who the patient is.
      expect((t as VoiceTool).needsPatientContext).toBeUndefined();
    });

    it('ignores a phone number the model tries to supply', async () => {
      await otp.rememberCaller(session.sessionId, CALLER);
      const t = tool([{ id: PATIENT, phone: CALLER }]);

      await t.execute(
        { phone: '+19995551234', phoneNumber: '+19995551234', to: '+19995551234' },
        session
      );

      // The number texted is the one the transport recorded, never the one the
      // model named.
      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0].to).toBe(CALLER);
    });
  });

  it('sends a code to an eligible caller', async () => {
    await otp.rememberCaller(session.sessionId, CALLER);

    const result = await tool([{ id: PATIENT, phone: CALLER }]).execute({}, session);

    expect(result.status).toBe('ok');
    expect(sender.sent).toHaveLength(1);
  });

  it('sends nothing and says nothing specific when no patient matches', async () => {
    await otp.rememberCaller(session.sessionId, CALLER);

    const result = await tool([]).execute({}, session);

    expect(sender.sent).toHaveLength(0);
    expect(result.status).toBe('ok');
  });

  it('gives a byte-identical answer for no match and for many', async () => {
    await otp.rememberCaller(session.sessionId, CALLER);
    const none = await tool([]).execute({}, session);

    await redis.flushdb();
    await otp.rememberCaller(session.sessionId, CALLER);
    const many = await tool([
      { id: 'a', phone: CALLER },
      { id: 'b', phone: CALLER },
    ]).execute({}, session);

    expect(none).toEqual(many);
    expect(sender.sent).toHaveLength(0);
  });

  it('leaks no patient id, phone number, count or reason in the result', async () => {
    await otp.rememberCaller(session.sessionId, CALLER);

    for (const rows of [
      [] as Array<{ id: string; phone: string }>,
      [{ id: 'patient-a', phone: CALLER }, { id: 'patient-b', phone: CALLER }],
    ]) {
      await redis.flushdb();
      await otp.rememberCaller(session.sessionId, CALLER);
      const text = JSON.stringify(await tool(rows).execute({}, session));

      expect(text).not.toContain('patient-a');
      expect(text).not.toContain(CALLER);
      expect(text).not.toContain('5551234567');
      expect(text).not.toMatch(/ambiguous|multiple|duplicate|count|no_match|unmatched/i);
    }
  });

  it('is unavailable on a session with no caller record, such as a browser', async () => {
    const result = await tool([{ id: PATIENT, phone: CALLER }]).execute({}, session);

    expect(result.status).toBe('failed');
    expect(sender.sent).toHaveLength(0);
  });

  it('sends nothing when the cooldown refuses', async () => {
    await otp.rememberCaller(session.sessionId, CALLER);
    const t = tool([{ id: PATIENT, phone: CALLER }]);

    await t.execute({}, session);
    await t.execute({}, session);

    expect(sender.sent).toHaveLength(1);
  });

  it('fails closed when the OTP backend is unavailable', async () => {
    const down = () => Promise.reject(new Error('closed'));
    const offline = new OtpService(
      { eval: down, set: down, get: down, del: down } as unknown as Redis,
      sender
    );
    const t = new RequestVerificationCodeTool(
      offline,
      new PhoneLookupService(prismaWith([{ id: PATIENT, phone: CALLER }]))
    );

    expect((await t.execute({}, session)).status).toBe('failed');
    expect(sender.sent).toHaveLength(0);
  });
});

describe('submit_verification_code', () => {
  let redis: Redis;
  let sender: RecordingSender;
  let otp: OtpService;
  let session: VoiceSession;
  let n = 0;

  beforeAll(() => { redis = testRedis(); });

  beforeEach(async () => {
    process.env.OTP_HMAC_SECRET = 'test-otp-secret';
    await redis.flushdb();
    sender = new RecordingSender();
    otp = new OtpService(redis, sender);
    n += 1;
    session = createAnonymousSession(`s-sub-${n}`);
    await otp.rememberCaller(session.sessionId, CALLER);
  });

  const submit = () => new SubmitVerificationCodeTool(otp);
  const request = () =>
    new RequestVerificationCodeTool(
      otp,
      new PhoneLookupService(prismaWith([{ id: PATIENT, phone: CALLER }]))
    );

  it('accepts only a code, and no identity fields', () => {
    const schema = submit().inputSchema as { properties: Record<string, unknown> };

    expect(Object.keys(schema.properties)).toEqual(['code']);
    expect(JSON.stringify(schema)).not.toMatch(/phone|patient|user/i);
  });

  it('promotes the session on a correct code, with a finite deadline', async () => {
    await request().execute({}, session);
    const before = snapshotPrivilege(session);

    const result = await submit().execute({ code: sender.lastCode }, session);

    expect(result.status).toBe('ok');
    expect(session.identityVerified).toBe(true);
    expect(session.patientId).toBe(PATIENT);
    expect(typeof session.verifiedUntil).toBe('number');
    expect(session.verifiedUntil).toBeGreaterThan(Date.now());
    expect(session.verifiedUntil).toBeLessThanOrEqual(Date.now() + OTP_VERIFIED_TTL_MS);
    expect(isVerificationActive(session)).toBe(true);
    // The turn runner rotates on this; the tool must not do it itself.
    expect(privilegeChanged(before, session)).toBe(true);
  });

  it.each([
    ['a wrong code', async (code: string) => (code === '000000' ? '111111' : '000000')],
  ])('does not promote on %s', async (_label, pick) => {
    await request().execute({}, session);
    const result = await submit().execute({ code: await pick(sender.lastCode) }, session);

    expect(result.status).toBe('failed');
    expect(session.identityVerified).toBe(false);
    expect(session.verifiedUntil).toBeNull();
    expect(isVerificationActive(session)).toBe(false);
  });

  it('does not promote on an expired challenge', async () => {
    await request().execute({}, session);
    const code = sender.lastCode;
    await redis.pexpire(`voice:otp:code:${session.sessionId}`, 1);
    await new Promise((r) => setTimeout(r, 30));

    expect((await submit().execute({ code }, session)).status).toBe('failed');
    expect(isVerificationActive(session)).toBe(false);
  });

  it('does not promote once the session is locked out', async () => {
    await request().execute({}, session);
    const code = sender.lastCode;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) {
      await submit().execute({ code: wrong }, session);
    }

    expect((await submit().execute({ code }, session)).status).toBe('failed');
    expect(isVerificationActive(session)).toBe(false);
  });

  it('does not promote when no code was ever requested', async () => {
    expect((await submit().execute({ code: '123456' }, session)).status).toBe('failed');
    expect(isVerificationActive(session)).toBe(false);
  });

  it('rejects anything that is not exactly six digits before touching Redis', async () => {
    await request().execute({}, session);
    const evalSpy = jest.spyOn(redis, 'eval');

    try {
      for (const bad of ['12345', '1234567', '12345a', '', '  123456  ']) {
        expect((await submit().execute({ code: bad }, session)).status).toBe('failed');
      }
      expect(evalSpy).not.toHaveBeenCalled();
    } finally {
      evalSpy.mockRestore();
    }
  });

  it('treats re-verification after expiry as a fresh privilege gain', async () => {
    await request().execute({}, session);
    await submit().execute({ code: sender.lastCode }, session);

    // Let the grant lapse, then verify again on the same session.
    session.verifiedUntil = Date.now() - 1;
    const before = snapshotPrivilege(session);
    expect(before.verificationActive).toBe(false);

    await redis.del(`voice:otp:cooldown:${session.sessionId}`);
    await request().execute({}, session);
    await submit().execute({ code: sender.lastCode }, session);

    // Raw flag was true on both sides; only the effective comparison sees this.
    expect(privilegeChanged(before, session)).toBe(true);
  });
});

describe('a Tier 2 tool follows effective verification end to end', () => {
  let redis: Redis;
  let sender: RecordingSender;
  let otp: OtpService;
  let executor: ToolExecutorService;
  let session: VoiceSession;

  const tier2: VoiceTool = {
    name: 'private_thing',
    tier: 'verified',
    description: 'stub',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ status: 'ok' }),
  };

  beforeEach(async () => {
    process.env.OTP_HMAC_SECRET = 'test-otp-secret';
    redis = testRedis();
    await redis.flushdb();
    sender = new RecordingSender();
    otp = new OtpService(redis, sender);
    session = createAnonymousSession('s-e2e');
    await otp.rememberCaller(session.sessionId, CALLER);

    const registry = new ToolRegistryService();
    registry.register(tier2);
    executor = new ToolExecutorService(registry, {
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditService);
  });

  it('is refused before verification, allowed after, and refused again once it lapses', async () => {
    expect((await executor.execute('private_thing', {}, session)).error).toBe(
      'verification_required'
    );

    await new RequestVerificationCodeTool(
      otp,
      new PhoneLookupService(prismaWith([{ id: PATIENT, phone: CALLER }]))
    ).execute({}, session);
    await new SubmitVerificationCodeTool(otp).execute({ code: sender.lastCode }, session);

    expect((await executor.execute('private_thing', {}, session)).status).toBe('ok');

    // Same open session, deadline passed. No reconnection, no timer.
    session.verifiedUntil = Date.now() - 1;
    expect(session.identityVerified).toBe(true);
    expect((await executor.execute('private_thing', {}, session)).error).toBe(
      'verification_required'
    );
  });
});

describe('log hygiene across the whole phone flow', () => {
  it('writes no code, phone number or patient id to any log line', async () => {
    process.env.OTP_HMAC_SECRET = 'test-otp-secret';
    const redis = testRedis();
    await redis.flushdb();
    const sender = new RecordingSender();
    const otp = new OtpService(redis, sender);
    const session = createAnonymousSession('s-logs');
    await otp.rememberCaller(session.sessionId, CALLER);

    const lines: string[] = [];
    const capture = (m: unknown) => { lines.push(String(m)); };
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(capture)
    );

    try {
      const lookup = new PhoneLookupService(prismaWith([{ id: PATIENT, phone: CALLER }]));
      await new RequestVerificationCodeTool(otp, lookup).execute({}, session);
      const code = sender.lastCode;
      await new SubmitVerificationCodeTool(otp).execute({ code: '000000' }, session);
      await new SubmitVerificationCodeTool(otp).execute({ code }, session);

      // Ambiguity must not appear either: which patients share a number is
      // linkage information, whoever is reading the log.
      await new RequestVerificationCodeTool(
        otp,
        new PhoneLookupService(prismaWith([
          { id: 'patient-a', phone: CALLER },
          { id: 'patient-b', phone: CALLER },
        ]))
      ).execute({}, session);

      const all = lines.join('\n');
      expect(all).not.toContain(code);
      expect(all).not.toContain(CALLER);
      expect(all).not.toContain('5551234567');
      expect(all).not.toContain(PATIENT);
      expect(all).not.toContain('patient-a');
      expect(all).not.toMatch(/ambiguous|multiple patients/i);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
