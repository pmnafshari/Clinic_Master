import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  TwilioSmsSender,
  TwilioLike,
} from '../../src/modules/voice/otp/twilio-sms.sender';
import { LoggingSmsSender } from '../../src/modules/voice/otp/sms-sender.interface';
import { selectSmsSender } from '../../src/modules/voice/otp/sms-sender.provider';
import { OtpService } from '../../src/modules/voice/otp/otp.service';
import { testRedis } from './redis-test-util';

const SID = 'AC00000000000000000000000000000000';
const TOKEN = 'synthetic-auth-token-not-a-real-credential';
const FROM = '+15550000000';
const TO = '+15551234567';

/** Records what would have gone to Twilio. Nothing leaves the process. */
function fakeTwilio() {
  const created: Array<{ to: string; from: string; body: string }> = [];
  const seen: Array<{ sid: string; token: string }> = [];
  const factory = (sid: string, token: string): TwilioLike => {
    seen.push({ sid, token });
    return {
      messages: {
        create: async (opts: { to: string; from: string; body: string }) => {
          created.push(opts);
          return { sid: 'SM123' };
        },
      },
    };
  };
  return { factory, created, seen };
}

function failingTwilio(message: string) {
  return (): TwilioLike => ({
    messages: {
      create: async () => {
        throw new Error(message);
      },
    },
  });
}

function withTwilioEnv() {
  process.env.SMS_PROVIDER = 'twilio';
  process.env.TWILIO_ACCOUNT_SID = SID;
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  process.env.TWILIO_PHONE_NUMBER = FROM;
}

function clearSmsEnv() {
  delete process.env.SMS_PROVIDER;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_PHONE_NUMBER;
}

describe('provider selection', () => {
  beforeEach(clearSmsEnv);
  afterAll(clearSmsEnv);

  it('selects Twilio only when it is asked for by name', () => {
    withTwilioEnv();
    expect(selectSmsSender()).toBeInstanceOf(TwilioSmsSender);
  });

  it('selects the non-delivery sender when told to log', () => {
    process.env.SMS_PROVIDER = 'logging';
    expect(selectSmsSender()).toBeInstanceOf(LoggingSmsSender);
  });

  it('selects the non-delivery sender when nothing is configured', () => {
    // Absent configuration must never mean "start texting people".
    expect(selectSmsSender()).toBeInstanceOf(LoggingSmsSender);
  });

  it('fails closed on a provider it does not recognise', async () => {
    for (const value of ['mock', 'sns', 'TWILIO ', 'twilio-sandbox', '']) {
      process.env.SMS_PROVIDER = value;
      const sender = selectSmsSender();

      // Not Twilio, and not a silent no-op either: an unrecognised provider is
      // a misconfiguration, and pretending to deliver hides it.
      expect(sender).not.toBeInstanceOf(TwilioSmsSender);
      await expect(sender.send(TO, 'code 123456')).rejects.toBeDefined();
    }
  });

  it('never selects Twilio by accident when the value is only similar', () => {
    process.env.SMS_PROVIDER = 'twilioo';
    expect(selectSmsSender()).not.toBeInstanceOf(TwilioSmsSender);
  });
});

describe('the Twilio sender', () => {
  beforeEach(withTwilioEnv);
  afterAll(clearSmsEnv);

  it('sends the body to the recipient from the configured number', async () => {
    const twilio = fakeTwilio();
    await new TwilioSmsSender(twilio.factory).send(TO, 'Your verification code is 123456.');

    expect(twilio.created).toEqual([
      { to: TO, from: FROM, body: 'Your verification code is 123456.' },
    ]);
  });

  it('builds its client from the configured credentials', async () => {
    const twilio = fakeTwilio();
    await new TwilioSmsSender(twilio.factory).send(TO, 'hello');

    expect(twilio.seen).toEqual([{ sid: SID, token: TOKEN }]);
  });

  it('reads the sender number from configuration rather than a constant', async () => {
    const twilio = fakeTwilio();
    process.env.TWILIO_PHONE_NUMBER = '+15559999999';
    await new TwilioSmsSender(twilio.factory).send(TO, 'hello');

    expect(twilio.created[0].from).toBe('+15559999999');
  });

  describe('missing credentials', () => {
    it.each(['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'])(
      'refuses to send without %s',
      async (variable) => {
        const twilio = fakeTwilio();
        delete process.env[variable];

        await expect(new TwilioSmsSender(twilio.factory).send(TO, 'hello')).rejects.toThrow(
          new RegExp(variable)
        );
        expect(twilio.created).toHaveLength(0);
      }
    );

    it('names only the variable, never a value', async () => {
      delete process.env.TWILIO_AUTH_TOKEN;
      const sender = new TwilioSmsSender(fakeTwilio().factory);

      const error = await sender.send(TO, 'hello').catch((e: Error) => e);
      expect(String(error)).not.toContain(SID);
      expect(String(error)).not.toContain(TO);
    });
  });

  describe('provider failure', () => {
    it('reports failure without repeating what the provider said', async () => {
      const sender = new TwilioSmsSender(
        failingTwilio('Authenticate: account SID ACxyz is not authorized, token bad')
      );

      const error = await sender.send(TO, 'Your verification code is 123456.').catch((e: Error) => e);

      expect(error).toBeInstanceOf(Error);
      const text = String(error);
      expect(text).not.toContain('Authenticate');
      expect(text).not.toContain('ACxyz');
      expect(text).not.toContain('token bad');
      expect(text).not.toContain(TO);
      expect(text).not.toContain('123456');
    });

    it('throws rather than reporting a send that did not happen', async () => {
      const sender = new TwilioSmsSender(failingTwilio('boom'));

      await expect(sender.send(TO, 'hello')).rejects.toBeDefined();
    });
  });

  describe('logging', () => {
    it('writes no code, no recipient and no credential to any log line', async () => {
      const lines: string[] = [];
      const capture = (m: unknown) => { lines.push(String(m)); };
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(capture)
      );

      try {
        await new TwilioSmsSender(fakeTwilio().factory).send(TO, 'Your verification code is 123456.');
        await new TwilioSmsSender(failingTwilio('provider exploded')).send(TO, 'code 654321')
          .catch(() => undefined);

        const all = lines.join('\n');
        expect(all).not.toContain('123456');
        expect(all).not.toContain('654321');
        expect(all).not.toContain(TO);
        expect(all).not.toContain('5551234567');
        expect(all).not.toContain(SID);
        expect(all).not.toContain(TOKEN);
        expect(all).not.toContain('provider exploded');
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });
  });
});

describe('the OTP service still decides whether anything is sent', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = testRedis();
  });

  beforeEach(async () => {
    process.env.OTP_HMAC_SECRET = 'test-otp-secret';
    withTwilioEnv();
    await redis.flushdb();
  });

  afterAll(clearSmsEnv);

  it('sends through the abstraction on the first request', async () => {
    const twilio = fakeTwilio();
    const otp = new OtpService(redis, new TwilioSmsSender(twilio.factory));

    expect((await otp.requestCode('s1', TO, 'p1')).status).toBe('sent');
    expect(twilio.created).toHaveLength(1);
    expect(twilio.created[0].to).toBe(TO);
  });

  it('sends nothing when the cooldown refuses the request', async () => {
    const twilio = fakeTwilio();
    const otp = new OtpService(redis, new TwilioSmsSender(twilio.factory));

    await otp.requestCode('s1', TO, 'p1');
    expect((await otp.requestCode('s1', TO, 'p1')).status).toBe('cooldown');

    // The sender must not be reachable around the rate limiter.
    expect(twilio.created).toHaveLength(1);
  });

  it('turns a provider failure into unavailable rather than a false success', async () => {
    const otp = new OtpService(redis, new TwilioSmsSender(failingTwilio('provider down')));

    expect((await otp.requestCode('s1', TO, 'p1')).status).toBe('unavailable');
  });
});
