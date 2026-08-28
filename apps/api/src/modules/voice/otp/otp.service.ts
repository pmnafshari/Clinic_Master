import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomInt } from 'crypto';
import { Redis } from 'ioredis';
import { VOICE_REDIS } from '../session/redis.provider';
import {
  OTP_CALLER_TTL_MS,
  OTP_CODE_DIGITS,
  OTP_CODE_TTL_MS,
  OTP_LOCK_MS,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_REQUESTS_PER_PHONE_PER_HOUR,
  OTP_REQUEST_WINDOW_MS,
  OTP_RESEND_COOLDOWN_MS,
} from './otp.constants';
import { SMS_SENDER, SmsSender } from './sms-sender.interface';

export type OtpRequestOutcome =
  | { status: 'sent' }
  | { status: 'cooldown' }
  | { status: 'capped' }
  | { status: 'unavailable' };

export type OtpSubmitOutcome =
  | { status: 'verified'; patientId: string }
  | { status: 'wrong' }
  | { status: 'expired' }
  | { status: 'locked' }
  | { status: 'unavailable' };

const callerKey = (sessionId: string): string => `voice:otp:caller:${sessionId}`;
const codeKey = (sessionId: string): string => `voice:otp:code:${sessionId}`;
const attemptsKey = (sessionId: string): string => `voice:otp:attempts:${sessionId}`;
const lockKey = (sessionId: string): string => `voice:otp:lock:${sessionId}`;
const cooldownKey = (sessionId: string): string => `voice:otp:cooldown:${sessionId}`;

/**
 * Claims the resend cooldown and the per-number hourly budget together.
 *
 * Ordering matters and is not incidental: the cooldown is taken with SET NX
 * *before* the counter moves, so a caller who is refused for asking too soon
 * does not spend an hour's allowance doing it.
 *
 * Two simultaneous requests cannot both pass, because only one SET NX succeeds.
 */
const REQUEST_SCRIPT = `
if redis.call('SET', KEYS[1], '1', 'PX', ARGV[1], 'NX') == false then
  return {'cooldown'}
end
local n = redis.call('INCR', KEYS[2])
if n == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
if n > tonumber(ARGV[2]) then return {'capped'} end
return {'ok'}
`;

/**
 * Reads the challenge, compares, and either consumes it or counts the failure —
 * with no window between the steps.
 *
 * The same sequence written as ordinary commands has two holes. Two concurrent
 * submissions of the same correct code would both read it before either
 * deleted it, and both would verify. Worse, a burst of concurrent wrong guesses
 * would each read the attempt count before any of them wrote it back, so the
 * cap could be beaten by submitting in parallel rather than in sequence. One
 * script evaluated server-side closes both, and keeps closing them when a
 * second instance is added.
 *
 * The comparison is hash against hash. A timing difference there reveals
 * something about the stored HMAC, not about the code, and inverting SHA-256 is
 * not the cheap path in; the attempt cap is what actually bounds guessing.
 */
const SUBMIT_SCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1 then return {'locked'} end
local rec = redis.call('GET', KEYS[1])
if not rec then return {'expired'} end
local ok, parsed = pcall(cjson.decode, rec)
if not ok or type(parsed) ~= 'table' or not parsed.codeHash then
  redis.call('DEL', KEYS[1], KEYS[2])
  return {'expired'}
end
if parsed.codeHash == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2])
  return {'ok', parsed.patientId}
end
local n = redis.call('INCR', KEYS[2])
if n == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
if n >= tonumber(ARGV[2]) then
  redis.call('SET', KEYS[3], '1', 'PX', ARGV[4])
  redis.call('DEL', KEYS[1], KEYS[2])
  return {'locked'}
end
return {'wrong'}
`;

/**
 * One-time codes for callers who arrive with no way to prove who they are.
 *
 * Every piece of state lives in Redis, keyed by session, and none of it touches
 * VoiceSession — the caller's phone number in particular, which therefore never
 * reaches a frame, a log line, or the model.
 *
 * Two things are hashed and for different reasons. The code is stored as an
 * HMAC because a MONITOR session, an RDB snapshot or a memory dump would
 * otherwise hand over live codes. The phone number is hashed into a *key name*
 * because key names leak through SCAN output, slowlog entries and monitoring
 * exporters, none of which are treated as sensitive; the number kept as a value
 * under the caller key is not exposed that way.
 *
 * Everything fails closed. Redis unreachable, a script error, a malformed
 * record or a missing secret all end as `unavailable` and leave the session
 * exactly as unverified as it was. There is no mode in which a code verifies
 * while its rate limiting is unavailable.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger('VoiceOtp');

  constructor(
    @Inject(VOICE_REDIS) private readonly redis: Redis,
    @Inject(SMS_SENDER) private readonly sms: SmsSender
  ) {}

  /** Records the number a call arrived from. Never read from a frame. */
  async rememberCaller(sessionId: string, phoneE164: string): Promise<void> {
    await this.redis.set(callerKey(sessionId), phoneE164, 'PX', OTP_CALLER_TTL_MS);
  }

  async callerFor(sessionId: string): Promise<string | undefined> {
    try {
      return (await this.redis.get(callerKey(sessionId))) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Removes everything this call left behind.
   *
   * Named keys only. A KEYS or SCAN sweep would be O(keyspace) and would put
   * every other live call's state within reach of one hang-up. TTLs remain as a
   * backstop for calls that end without ever reaching here.
   */
  async forgetCall(sessionId: string): Promise<void> {
    try {
      await this.redis.del(
        callerKey(sessionId),
        codeKey(sessionId),
        attemptsKey(sessionId),
        cooldownKey(sessionId),
        lockKey(sessionId)
      );
    } catch {
      // The TTLs already bound every one of these; a failed cleanup costs
      // nothing but a little memory for a few minutes.
      this.logger.warn('otp.cleanup failed');
    }
  }

  /** The key a number is counted under. Exposed so tests can assert its shape. */
  async phoneKeyFor(phoneE164: string): Promise<string> {
    return `voice:otp:req:${this.hmac(phoneE164)}`;
  }

  /**
   * Issues a code for a number already resolved to exactly one patient.
   *
   * The number is a parameter rather than something this reads from a tool
   * argument: the caller record is the only source, and nothing the model says
   * can reach it.
   */
  async requestCode(
    sessionId: string,
    phoneE164: string,
    patientId: string
  ): Promise<OtpRequestOutcome> {
    if (!this.secret()) {
      return { status: 'unavailable' };
    }

    try {
      const gate = (await this.redis.eval(
        REQUEST_SCRIPT,
        2,
        cooldownKey(sessionId),
        await this.phoneKeyFor(phoneE164),
        String(OTP_RESEND_COOLDOWN_MS),
        String(OTP_MAX_REQUESTS_PER_PHONE_PER_HOUR),
        String(OTP_REQUEST_WINDOW_MS)
      )) as string[];

      if (gate[0] === 'cooldown') return { status: 'cooldown' };
      if (gate[0] !== 'ok') return { status: 'capped' };

      const code = this.newCode();
      await this.redis.set(
        codeKey(sessionId),
        JSON.stringify({ codeHash: this.hmac(code), patientId }),
        'PX',
        OTP_CODE_TTL_MS
      );
      // A fresh challenge starts from zero guesses.
      await this.redis.del(attemptsKey(sessionId));

      await this.sms.send(phoneE164, `Your verification code is ${code}.`);
      return { status: 'sent' };
    } catch (error) {
      // Names nothing. The provider's words, the number and the code are all
      // things this must never put in a log line.
      this.logger.warn('otp.request failed');
      void error;
      return { status: 'unavailable' };
    }
  }

  async submitCode(sessionId: string, code: string): Promise<OtpSubmitOutcome> {
    if (!this.secret()) {
      return { status: 'unavailable' };
    }

    try {
      const result = (await this.redis.eval(
        SUBMIT_SCRIPT,
        3,
        codeKey(sessionId),
        attemptsKey(sessionId),
        lockKey(sessionId),
        this.hmac(code),
        String(OTP_MAX_ATTEMPTS),
        String(OTP_CODE_TTL_MS),
        String(OTP_LOCK_MS)
      )) as string[];

      switch (result[0]) {
        case 'ok':
          return { status: 'verified', patientId: result[1] };
        case 'wrong':
          return { status: 'wrong' };
        case 'locked':
          return { status: 'locked' };
        default:
          return { status: 'expired' };
      }
    } catch {
      this.logger.warn('otp.submit failed');
      return { status: 'unavailable' };
    }
  }

  /**
   * Uniform across the digit range, unlike `Math.random()` scaled into it, and
   * from the platform CSPRNG rather than a predictable generator.
   */
  private newCode(): string {
    const ceiling = 10 ** OTP_CODE_DIGITS;
    return String(randomInt(0, ceiling)).padStart(OTP_CODE_DIGITS, '0');
  }

  private hmac(value: string): string {
    return createHmac('sha256', this.secret()).update(value).digest('hex');
  }

  /**
   * Read at use time, never cached. Absent means every operation reports
   * unavailable rather than falling back to a constant — a predictable hash key
   * would make stored codes forgeable by anyone who read the source.
   */
  private secret(): string {
    return process.env.OTP_HMAC_SECRET ?? '';
  }
}
