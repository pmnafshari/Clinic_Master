import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { OtpService } from '../../src/modules/voice/otp/otp.service';
import {
  OTP_MAX_ATTEMPTS,
  OTP_MAX_REQUESTS_PER_PHONE_PER_HOUR,
  OTP_CODE_DIGITS,
} from '../../src/modules/voice/otp/otp.constants';
import { SmsSender } from '../../src/modules/voice/otp/sms-sender.interface';
import { testRedis } from './redis-test-util';

const PHONE = '+15551234567';
const PATIENT = 'patient-1';
const SECRET = 'test-otp-secret';

/** Captures what would have been texted, so a test can read the code back. */
class RecordingSender implements SmsSender {
  readonly sent: Array<{ to: string; message: string }> = [];
  async send(to: string, message: string): Promise<void> {
    this.sent.push({ to, message });
  }
  get lastCode(): string {
    const body = this.sent[this.sent.length - 1].message;
    return /(\d{6})/.exec(body)![1];
  }
}

function serviceOn(redis: Redis, sender: SmsSender): OtpService {
  return new OtpService(redis, sender);
}

describe('OTP verification', () => {
  let redis: Redis;
  let sender: RecordingSender;
  let otp: OtpService;
  let session: string;
  let counter = 0;

  beforeAll(() => {
    redis = testRedis();
  });

  beforeEach(async () => {
    process.env.OTP_HMAC_SECRET = SECRET;
    await redis.flushdb();
    sender = new RecordingSender();
    otp = serviceOn(redis, sender);
    counter += 1;
    session = `sess-${counter}`;
  });

  async function request(): Promise<string> {
    const outcome = await otp.requestCode(session, PHONE, PATIENT);
    expect(outcome.status).toBe('sent');
    return sender.lastCode;
  }

  describe('the happy path', () => {
    it('sends a six-digit code to the number it was given', async () => {
      await request();

      expect(sender.sent).toHaveLength(1);
      expect(sender.sent[0].to).toBe(PHONE);
      expect(sender.lastCode).toMatch(new RegExp(`^\\d{${OTP_CODE_DIGITS}}$`));
    });

    it('verifies a correct code and returns the patient it was issued for', async () => {
      const code = await request();

      expect(await otp.submitCode(session, code)).toEqual({
        status: 'verified',
        patientId: PATIENT,
      });
    });

    it('consumes the code, so a replay finds nothing', async () => {
      const code = await request();

      expect((await otp.submitCode(session, code)).status).toBe('verified');
      // Not 'wrong': the challenge is gone entirely.
      expect((await otp.submitCode(session, code)).status).toBe('expired');
    });
  });

  describe('wrong codes', () => {
    it('reports a wrong code without consuming the challenge', async () => {
      const code = await request();
      const wrong = code === '000000' ? '111111' : '000000';

      expect((await otp.submitCode(session, wrong)).status).toBe('wrong');
      // The real code still works: a wrong guess must not destroy the challenge.
      expect((await otp.submitCode(session, code)).status).toBe('verified');
    });

    it('locks the session after the attempt cap and stops accepting the real code', async () => {
      const code = await request();
      const wrong = code === '000000' ? '111111' : '000000';

      for (let i = 1; i < OTP_MAX_ATTEMPTS; i += 1) {
        expect((await otp.submitCode(session, wrong)).status).toBe('wrong');
      }
      expect((await otp.submitCode(session, wrong)).status).toBe('locked');

      // Locked means locked: the correct code no longer helps.
      expect((await otp.submitCode(session, code)).status).toBe('locked');
    });
  });

  describe('expiry', () => {
    it('reports an expired challenge once its lifetime runs out', async () => {
      const code = await request();
      await redis.pexpire(`voice:otp:code:${session}`, 1);
      await new Promise((r) => setTimeout(r, 30));

      expect((await otp.submitCode(session, code)).status).toBe('expired');
    });

    it('returns to a requestable state once the lock lapses', async () => {
      const code = await request();
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) await otp.submitCode(session, wrong);

      expect((await otp.submitCode(session, wrong)).status).toBe('locked');

      await redis.pexpire(`voice:otp:lock:${session}`, 1);
      await redis.del(`voice:otp:cooldown:${session}`);
      await new Promise((r) => setTimeout(r, 30));

      expect((await otp.requestCode(session, PHONE, PATIENT)).status).toBe('sent');
    });
  });

  describe('rate limiting', () => {
    it('refuses a resend inside the cooldown', async () => {
      await request();

      expect((await otp.requestCode(session, PHONE, PATIENT)).status).toBe('cooldown');
      expect(sender.sent).toHaveLength(1);
    });

    it('caps requests per number per hour across different sessions', async () => {
      for (let i = 0; i < OTP_MAX_REQUESTS_PER_PHONE_PER_HOUR; i += 1) {
        expect((await otp.requestCode(`s-cap-${i}`, PHONE, PATIENT)).status).toBe('sent');
      }

      // A fresh session dodges the per-session cooldown but not the per-number cap.
      expect((await otp.requestCode('s-cap-over', PHONE, PATIENT)).status).toBe('capped');
    });

    it('does not spend hourly budget on a request the cooldown already refused', async () => {
      await request();
      // Same session, inside the cooldown, four times.
      for (let i = 0; i < 4; i += 1) {
        expect((await otp.requestCode(session, PHONE, PATIENT)).status).toBe('cooldown');
      }

      const count = Number(await redis.get(await otp.phoneKeyFor(PHONE)));
      // One request was sent; the four refused ones must not have counted.
      expect(count).toBe(1);
    });

    it('never sends a message for a refused request', async () => {
      await request();
      await otp.requestCode(session, PHONE, PATIENT);

      expect(sender.sent).toHaveLength(1);
    });
  });

  describe('what Redis actually holds', () => {
    it('stores no raw code anywhere', async () => {
      const code = await request();

      const keys = await redis.keys('*');
      const values = await Promise.all(keys.map((k) => redis.get(k)));

      expect(keys.join('|')).not.toContain(code);
      expect(values.join('|')).not.toContain(code);
    });

    it('puts no raw phone number in a key name', async () => {
      await request();

      const keys = await redis.keys('*');
      for (const key of keys) {
        expect(key).not.toContain(PHONE);
        expect(key).not.toContain('5551234567');
      }
    });

    it('identifies a number by HMAC, not by the number', async () => {
      const key = await otp.phoneKeyFor(PHONE);

      expect(key).toMatch(/^voice:otp:req:[0-9a-f]{64}$/);
      expect(key).not.toContain('5551234567');
    });

    it('gives every key it writes a finite lifetime', async () => {
      await request();
      await otp.submitCode(session, '000000');

      const keys = await redis.keys('*');
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(await redis.pttl(key)).toBeGreaterThan(0);
      }
    });
  });

  describe('atomicity', () => {
    /**
     * The concurrency tests below can only ever make a race *likely*; whether
     * two awaits interleave is up to the scheduler, and a non-atomic
     * implementation passes them whenever it happens not to lose. These two
     * assert the property directly instead: the whole decision is one script,
     * evaluated server-side, so there is no window for anything to interleave
     * into.
     */
    it('decides a submission in a single server-side script', async () => {
      await request();
      const spies = {
        eval: jest.spyOn(redis, 'eval'),
        get: jest.spyOn(redis, 'get'),
        del: jest.spyOn(redis, 'del'),
        incr: jest.spyOn(redis, 'incr'),
        exists: jest.spyOn(redis, 'exists'),
        set: jest.spyOn(redis, 'set'),
      };

      try {
        await otp.submitCode(session, '000000');

        expect(spies.eval).toHaveBeenCalledTimes(1);
        // Read-compare-write split across ordinary commands is exactly what
        // lets a burst of guesses beat the attempt cap.
        for (const name of ['get', 'del', 'incr', 'exists', 'set'] as const) {
          expect(spies[name]).not.toHaveBeenCalled();
        }
      } finally {
        Object.values(spies).forEach((spy) => spy.mockRestore());
      }
    });

    it('claims the cooldown and the hourly budget in a single script', async () => {
      const evalSpy = jest.spyOn(redis, 'eval');
      const incr = jest.spyOn(redis, 'incr');

      try {
        await otp.requestCode(session, PHONE, PATIENT);

        // One script for the gate. The challenge write that follows is a
        // separate, ordinary command and is not part of the decision.
        expect(evalSpy).toHaveBeenCalledTimes(1);
        expect(incr).not.toHaveBeenCalled();
      } finally {
        evalSpy.mockRestore();
        incr.mockRestore();
      }
    });
  });

  describe('concurrency', () => {
    it('lets only one of two simultaneous correct submissions consume the code', async () => {
      const code = await request();
      const other = serviceOn(testRedis(), sender);

      const results = await Promise.all([
        otp.submitCode(session, code),
        other.submitCode(session, code),
      ]);

      expect(results.filter((r) => r.status === 'verified')).toHaveLength(1);
    });

    it('holds the attempt cap under a burst of simultaneous wrong guesses', async () => {
      await request();
      const racers = Array.from({ length: OTP_MAX_ATTEMPTS * 4 }, () =>
        serviceOn(testRedis(), sender)
      );

      const results = await Promise.all(racers.map((r) => r.submitCode(session, '000000')));
      const wrong = results.filter((r) => r.status === 'wrong').length;

      // A read-compare-write in TypeScript would let every racer read the same
      // count before any of them wrote, and all of them would come back 'wrong'.
      expect(wrong).toBeLessThan(OTP_MAX_ATTEMPTS);
      expect(results.some((r) => r.status === 'locked')).toBe(true);
    });

    it('lets only one of two simultaneous requests through the cooldown', async () => {
      const other = serviceOn(testRedis(), sender);

      const results = await Promise.all([
        otp.requestCode(session, PHONE, PATIENT),
        other.requestCode(session, PHONE, PATIENT),
      ]);

      expect(results.filter((r) => r.status === 'sent')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'cooldown')).toHaveLength(1);
    });
  });

  describe('across instances', () => {
    it('submits on one instance a code requested on another', async () => {
      const code = await request();
      const other = serviceOn(testRedis(), sender);

      expect((await other.submitCode(session, code)).status).toBe('verified');
    });

    it('counts attempts made against different instances toward one cap', async () => {
      await request();
      const a = serviceOn(testRedis(), sender);
      const b = serviceOn(testRedis(), sender);

      for (let i = 1; i < OTP_MAX_ATTEMPTS; i += 1) {
        const service = i % 2 === 0 ? a : b;
        expect((await service.submitCode(session, '000000')).status).toBe('wrong');
      }

      expect((await a.submitCode(session, '000000')).status).toBe('locked');
    });
  });

  describe('the caller record', () => {
    it('remembers the number a call arrived from and reads it back', async () => {
      await otp.rememberCaller(session, PHONE);

      expect(await otp.callerFor(session)).toBe(PHONE);
      expect(await redis.pttl(`voice:otp:caller:${session}`)).toBeGreaterThan(0);
    });

    it('has nothing for a session that never called in', async () => {
      expect(await otp.callerFor('never-called')).toBeUndefined();
    });
  });

  describe('when Redis is unreachable', () => {
    let dead: Redis;

    beforeAll(() => {
      const down = () => Promise.reject(new Error('connection is closed'));
      dead = { eval: down, set: down, get: down, del: down } as unknown as Redis;
    });

    it('refuses to issue a code', async () => {
      const offline = serviceOn(dead, sender);

      expect((await offline.requestCode(session, PHONE, PATIENT)).status).toBe('unavailable');
      // Nothing may be sent when the rate limit could not be claimed.
      expect(sender.sent).toHaveLength(0);
    });

    it('refuses to verify a code', async () => {
      const offline = serviceOn(dead, sender);

      expect((await offline.submitCode(session, '123456')).status).toBe('unavailable');
    });

    it('has no caller record to fall back on', async () => {
      const offline = serviceOn(dead, sender);

      expect(await offline.callerFor(session)).toBeUndefined();
    });
  });

  describe('without a configured secret', () => {
    beforeEach(() => {
      delete process.env.OTP_HMAC_SECRET;
    });

    it('refuses to issue a code rather than hashing with a default', async () => {
      expect((await otp.requestCode(session, PHONE, PATIENT)).status).toBe('unavailable');
      expect(sender.sent).toHaveLength(0);
    });

    it('refuses to verify a code', async () => {
      expect((await otp.submitCode(session, '123456')).status).toBe('unavailable');
    });
  });

  it('never writes the code, the number, or either hash to a log line', async () => {
    const lines: string[] = [];
    const capture = (m: unknown) => { lines.push(String(m)); };
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(capture)
    );

    try {
      const code = await request();
      await otp.submitCode(session, '000000');
      await otp.submitCode(session, code);
      await otp.requestCode(session, PHONE, PATIENT);

      const all = lines.join('\n');
      expect(all).not.toContain(code);
      expect(all).not.toContain(PHONE);
      expect(all).not.toContain('5551234567');
      expect(all).not.toContain(await otp.phoneKeyFor(PHONE));
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
