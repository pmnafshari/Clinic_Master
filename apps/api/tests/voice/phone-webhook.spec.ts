import { Logger, ValidationPipe } from '@nestjs/common';
import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Request } from 'express';
import { Redis } from 'ioredis';
import { PhoneWebhookController } from '../../src/modules/voice/transport/phone-webhook.controller';
import { VOICE_PHONE_CONFIG } from '../../src/modules/voice/voice-phone.config';
import { VoiceTicketService } from '../../src/modules/voice/session/voice-ticket.service';
import { testRedis } from './redis-test-util';

const TOKEN = 'synthetic-auth-token-not-a-real-credential';
const WEBHOOK_URL = 'https://clinic.example.com/voice/phone/incoming';
const CALL_SID = 'CA0123456789abcdef0123456789abcdef';
const FROM = '+15551234567';

/** Exactly Twilio's documented algorithm, computed here rather than trusted. */
function sign(url: string, params: Record<string, string>, token = TOKEN): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

/** What Twilio actually posts: far more fields than this route reads. */
function twilioBody(over: Record<string, string> = {}): Record<string, string> {
  return {
    AccountSid: 'AC00000000000000000000000000000000',
    CallSid: CALL_SID,
    From: FROM,
    To: '+15550000000',
    CallStatus: 'ringing',
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
    ...over,
  };
}

function request(body: Record<string, string>, signature?: string): Request {
  const headers: Record<string, string> = {};
  if (signature !== undefined) headers['x-twilio-signature'] = signature;
  return {
    body,
    headers,
    // Present so a mutation that reaches for the request's own host has
    // something attacker-shaped to find.
    get: (name: string) => (name.toLowerCase() === 'host' ? 'evil.example.com' : undefined),
    originalUrl: '/voice/phone/incoming',
    protocol: 'https',
  } as unknown as Request;
}

describe('the Twilio inbound voice webhook', () => {
  let redis: Redis;
  let tickets: VoiceTicketService;
  let controller: PhoneWebhookController;

  beforeAll(() => {
    redis = testRedis();
    tickets = new VoiceTicketService(redis);
  });

  beforeEach(async () => {
    await redis.flushdb();
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    process.env.TWILIO_VOICE_WEBHOOK_URL = WEBHOOK_URL;
    process.env.VOICE_PHONE_ENABLED = 'true';
    controller = new PhoneWebhookController(tickets, VOICE_PHONE_CONFIG);
  });

  afterAll(() => {
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_VOICE_WEBHOOK_URL;
    delete process.env.VOICE_PHONE_ENABLED;
  });

  async function post(body: Record<string, string>, signature?: string) {
    const sent: { type?: string; status?: number; body?: string } = {};
    const res = {
      type(value: string) { sent.type = value; return this; },
      status(code: number) { sent.status = code; return this; },
      send(payload: string) { sent.body = payload; return this; },
    };
    await controller.incoming(request(body, signature), res as never);
    return sent;
  }

  describe('signature validation', () => {
    it('accepts a correctly signed request', async () => {
      const body = twilioBody();
      const result = await post(body, sign(WEBHOOK_URL, body));

      expect(result.status).toBeUndefined();
      expect(result.body).toContain('<Stream');
    });

    it('refuses a wrong signature', async () => {
      const body = twilioBody();
      const result = await post(body, sign(WEBHOOK_URL, body, 'a-different-token'));

      expect(result.status).toBe(403);
      expect(result.body).not.toContain('<Stream');
    });

    it('refuses a missing signature header', async () => {
      const result = await post(twilioBody());

      expect(result.status).toBe(403);
      expect(result.body).not.toContain('<Stream');
    });

    it('refuses an empty signature', async () => {
      const result = await post(twilioBody(), '');

      expect(result.status).toBe(403);
    });

    it.each(['not-base64!!', '=', 'AAAA', 'x'.repeat(5000)])(
      'refuses the malformed signature %#',
      async (signature) => {
        expect((await post(twilioBody(), signature)).status).toBe(403);
      }
    );

    it('refuses a signature computed over a different URL', async () => {
      const body = twilioBody();
      // What an attacker gets by pointing the HMAC at a host they control.
      const result = await post(body, sign('https://evil.example.com/voice/phone/incoming', body));

      expect(result.status).toBe(403);
    });

    it('validates against the configured URL, never the request host', async () => {
      const body = twilioBody();
      const signed = sign(WEBHOOK_URL, body);

      // The request advertises evil.example.com; only the configured URL verifies.
      expect((await post(body, signed)).body).toContain('<Stream');

      process.env.TWILIO_VOICE_WEBHOOK_URL = 'https://other.example.com/voice/phone/incoming';
      expect((await post(body, signed)).status).toBe(403);
    });

    it('refuses a tampered CallSid', async () => {
      const body = twilioBody();
      const signed = sign(WEBHOOK_URL, body);

      const result = await post({ ...body, CallSid: 'CAffffffffffffffffffffffffffffffff' }, signed);
      expect(result.status).toBe(403);
    });

    it('refuses a tampered From', async () => {
      const body = twilioBody();
      const signed = sign(WEBHOOK_URL, body);

      const result = await post({ ...body, From: '+19995551234' }, signed);
      expect(result.status).toBe(403);
    });

    it('covers every posted parameter, including ones this route never reads', async () => {
      const body = twilioBody();
      const signed = sign(WEBHOOK_URL, body);

      // Adding an unread field invalidates the signature. That is why the body
      // must reach validation complete and unstripped.
      expect((await post({ ...body, CallerCity: 'Springfield' }, signed)).status).toBe(403);

      // Signed with the field present, it verifies — proving the extra field is
      // part of what is validated rather than ignored.
      const wider = twilioBody({ CallerCity: 'Springfield' });
      expect((await post(wider, sign(WEBHOOK_URL, wider))).body).toContain('<Stream');
    });

    it('refuses when no auth token is configured', async () => {
      const body = twilioBody();
      const signed = sign(WEBHOOK_URL, body);
      delete process.env.TWILIO_AUTH_TOKEN;

      expect((await post(body, signed)).status).toBe(403);
    });

    it('refuses when no webhook URL is configured', async () => {
      const body = twilioBody();
      const signed = sign(WEBHOOK_URL, body);
      delete process.env.TWILIO_VOICE_WEBHOOK_URL;

      expect((await post(body, signed)).status).toBe(403);
    });
  });

  describe('the request pipeline is not allowed to strip the body', () => {
    it('leaves the global ValidationPipe configuration untouched', () => {
      const main = readFileSync(join(__dirname, '../../src/main.ts'), 'utf8');

      // The webhook reads req.body directly so it never meets this pipe. If
      // someone relaxes the global settings to make a DTO work here, the whole
      // application's input hardening goes with it.
      expect(main).toContain('whitelist: true');
      expect(main).toContain('forbidNonWhitelisted: true');
    });

    it('would lose every Twilio field if a whitelisting pipe were applied', async () => {
      class Dto {}
      const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false });

      const stripped = await pipe.transform(twilioBody(), { type: 'body', metatype: Dto });

      // Pinning the reason the route takes @Req(): a whitelisting pipe empties
      // the body, and a signature validated against {} can never match.
      expect(stripped).toEqual({});
    });

    it('does not declare a body DTO on the route', () => {
      const source = readFileSync(
        join(__dirname, '../../src/modules/voice/transport/phone-webhook.controller.ts'),
        'utf8'
      );

      expect(source).not.toMatch(/@Body\(/);
      expect(source).toMatch(/@Req\(/);
    });
  });

  describe('the TwiML response', () => {
    it('is XML carrying a stream URL with a ticket', async () => {
      const body = twilioBody();
      const result = await post(body, sign(WEBHOOK_URL, body));

      expect(result.type).toBe('text/xml');
      expect(result.body).toContain('<Response>');
      expect(result.body).toContain('<Connect>');
      expect(result.body).toMatch(/wss:\/\/clinic\.example\.com\/voice\/phone\?ticket=[A-Za-z0-9_-]{43}/);
    });

    it('is only produced after the signature verifies', async () => {
      const result = await post(twilioBody(), 'wrong');

      expect(result.body).not.toContain('<Connect>');
      expect(result.body).not.toContain('ticket=');
    });
  });

  describe('the ticket', () => {
    function ticketFrom(xml: string): string {
      return /ticket=([A-Za-z0-9_-]+)/.exec(xml)![1];
    }

    it('carries the CallSid as its subject, not a patient identity', async () => {
      const body = twilioBody();
      const result = await post(body, sign(WEBHOOK_URL, body));

      // The stored value is Twilio's call identifier. It is deliberately not a
      // Patient.userId, and cannot become one.
      expect(await tickets.consume(ticketFrom(result.body!))).toBe(CALL_SID);
    });

    it('ignores any identity field the body carries, however well signed', async () => {
      // Twilio custom parameters, or anything that can post a valid signature,
      // can put extra fields in this body. None of them may decide who the
      // call is: the subject comes from CallSid and nothing else.
      const body = twilioBody({
        PatientId: 'patient-owner',
        patientId: 'patient-owner',
        userId: 'user-owner',
        UserId: 'user-owner',
        Subject: 'patient-owner',
      });
      const result = await post(body, sign(WEBHOOK_URL, body));

      const subject = await tickets.consume(ticketFrom(result.body!));
      expect(subject).toBe(CALL_SID);
      expect(subject).not.toBe('patient-owner');
      expect(subject).not.toBe('user-owner');
    });

    it('is single use', async () => {
      const body = twilioBody();
      const ticket = ticketFrom((await post(body, sign(WEBHOOK_URL, body)))!.body!);

      expect(await tickets.consume(ticket)).toBe(CALL_SID);
      expect(await tickets.consume(ticket)).toBeUndefined();
    });

    it('carries the ticket lifetime the shared service already enforces', async () => {
      const body = twilioBody();
      const ticket = ticketFrom((await post(body, sign(WEBHOOK_URL, body)))!.body!);

      const ttl = await redis.pttl(`voice:ticket:${ticket}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    });

    it('mints a distinct ticket per call', async () => {
      const a = twilioBody();
      const b = twilioBody({ CallSid: 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });

      const first = ticketFrom((await post(a, sign(WEBHOOK_URL, a)))!.body!);
      const second = ticketFrom((await post(b, sign(WEBHOOK_URL, b)))!.body!);

      expect(first).not.toBe(second);
    });

    it('refuses a CallSid that is not Twilio-shaped, however well signed', async () => {
      for (const sid of ['', 'CA123', 'x'.repeat(5000), '../../etc/passwd', 'CA' + 'z'.repeat(32)]) {
        const body = twilioBody({ CallSid: sid });
        const result = await post(body, sign(WEBHOOK_URL, body));

        // A signed request is still not licence to write an arbitrary value
        // into shared storage.
        expect(result.status).toBe(403);
        expect(await redis.keys('voice:ticket:*')).toEqual([]);
      }
    });
  });

  describe('VOICE_PHONE_ENABLED', () => {
    it('rejects the call when the flag is not set', async () => {
      delete process.env.VOICE_PHONE_ENABLED;
      const body = twilioBody();

      const result = await post(body, sign(WEBHOOK_URL, body));

      expect(result.type).toBe('text/xml');
      expect(result.body).toContain('<Reject');
      expect(result.body).not.toContain('<Connect>');
      expect(await redis.keys('voice:ticket:*')).toEqual([]);
    });

    it.each(['false', 'TRUE', '1', 'yes', ''])('treats %p as off', async (value) => {
      process.env.VOICE_PHONE_ENABLED = value;
      const body = twilioBody();

      const result = await post(body, sign(WEBHOOK_URL, body));

      // Only the exact string enables it. An absent or approximate value is
      // not consent, matching the browser flag.
      expect(result.body).toContain('<Reject');
    });

    it('still refuses an unsigned request when the flag is on', async () => {
      expect((await post(twilioBody())).status).toBe(403);
    });
  });

  describe('failure containment', () => {
    it('says nothing in a rejection beyond the refusal itself', async () => {
      const result = await post(twilioBody(), 'wrong');

      const text = String(result.body ?? '');
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(FROM);
      expect(text).not.toContain(CALL_SID);
      expect(text).not.toContain(WEBHOOK_URL);
      expect(text).not.toMatch(/signature/i);
    });

    it('fails closed when the ticket store is unreachable', async () => {
      const down = () => Promise.reject(new Error('connection is closed'));
      const offline = new PhoneWebhookController(
        new VoiceTicketService({ set: down, getdel: down } as unknown as Redis),
        VOICE_PHONE_CONFIG
      );
      const body = twilioBody();
      const sent: { status?: number; body?: string; type?: string } = {};
      const res = {
        type(v: string) { sent.type = v; return this; },
        status(c: number) { sent.status = c; return this; },
        send(p: string) { sent.body = p; return this; },
      };

      await offline.incoming(request(body, sign(WEBHOOK_URL, body)), res as never);

      // No stream URL, because there is no ticket to put in one.
      expect(sent.body).not.toContain('<Connect>');
      expect(sent.body).toContain('<Reject');
    });

    it('writes no signature, token, phone number or call id to a log line', async () => {
      const lines: string[] = [];
      const capture = (m: unknown) => { lines.push(String(m)); };
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(capture)
      );

      try {
        const body = twilioBody();
        const signed = sign(WEBHOOK_URL, body);
        const result = await post(body, signed);
        await post(body, 'a-forged-signature-value');
        delete process.env.VOICE_PHONE_ENABLED;
        await post(body, signed);

        const all = lines.join('\n');
        expect(all).not.toContain(TOKEN);
        expect(all).not.toContain(signed);
        expect(all).not.toContain('a-forged-signature-value');
        expect(all).not.toContain(FROM);
        expect(all).not.toContain('5551234567');
        expect(all).not.toContain(CALL_SID);
        expect(all).not.toContain(/ticket=([A-Za-z0-9_-]+)/.exec(result.body!)![1]);
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });
  });
});
