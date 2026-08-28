import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { TwilioMediaGateway } from '../../src/modules/voice/transport/twilio-media.gateway';
import { VoiceTicketService } from '../../src/modules/voice/session/voice-ticket.service';
import { OtpService } from '../../src/modules/voice/otp/otp.service';
import { PHONE_AUDIO_FORMAT } from '../../src/modules/voice/speech/audio-format';
import { VOICE_PHONE_CONFIG } from '../../src/modules/voice/voice-phone.config';
import { AudioTransport } from '../../src/modules/voice/transport/audio-transport.interface';
import { testRedis } from './redis-test-util';

const CALL_SID = 'CA0123456789abcdef0123456789abcdef';
const STREAM_SID = 'MZ0123456789abcdef0123456789abcdef';
const CALLER = '+15551234567';
const PHONE_SESSION = 'phone-session-1';

/** Records what the gateway was asked to do, without a real VoiceGateway. */
function fakeVoiceGateway() {
  const calls: Array<{ kind: string; value?: unknown }> = [];
  return {
    calls,
    bindAudioFormat: (_t: AudioTransport, format: unknown) => {
      calls.push({ kind: 'format', value: format });
    },
    handleFrame: async (_t: AudioTransport, raw: unknown) => {
      calls.push({ kind: 'frame', value: raw });
    },
    handleAudio: async (_t: AudioTransport, chunk: Buffer) => {
      calls.push({ kind: 'audio', value: chunk });
    },
    sessionIdFor: () => PHONE_SESSION,
  };
}

function fakeSocket() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let readyState: number = WebSocket.OPEN;
  const sent: string[] = [];
  return {
    sent,
    closes: [] as number[],
    handlers,
    emit(event: string, ...args: unknown[]) { handlers.get(event)?.(...args); },
    socket: {
      get readyState(): number { return readyState; },
      on(event: string, fn: (...args: unknown[]) => void) { handlers.set(event, fn); return this; },
      send(p: string) { sent.push(String(p)); },
      close(code: number) { readyState = WebSocket.CLOSED as number; (this as never as { c: number[] }); closesRef.push(code); },
    } as unknown as WebSocket,
  };
  }
const closesRef: number[] = [];

function request(ticket?: string): IncomingMessage {
  return { url: ticket === undefined ? '/voice/phone' : `/voice/phone?ticket=${ticket}` } as IncomingMessage;
}

const frame = (o: unknown) => Buffer.from(JSON.stringify(o));
const startFrame = () =>
  frame({ event: 'start', streamSid: STREAM_SID, start: { streamSid: STREAM_SID, callSid: CALL_SID } });
const mediaFrame = (bytes: Buffer) =>
  frame({ event: 'media', streamSid: STREAM_SID, media: { payload: bytes.toString('base64') } });

describe('the Twilio media socket', () => {
  let redis: Redis;
  let tickets: VoiceTicketService;
  let otp: OtpService;
  let voice: ReturnType<typeof fakeVoiceGateway>;
  let gateway: TwilioMediaGateway;

  beforeAll(() => {
    redis = testRedis();
    tickets = new VoiceTicketService(redis);
    otp = new OtpService(redis, { send: async () => undefined });
  });

  let forgets: string[];

  beforeEach(async () => {
    await redis.flushdb();
    forgets = [];
    jest.spyOn(otp, 'forgetCall').mockImplementation(async (id: string) => {
      forgets.push(id);
      await OtpService.prototype.forgetCall.call(otp, id);
    });
    process.env.VOICE_PHONE_ENABLED = 'true';
    process.env.OTP_HMAC_SECRET = 'test-otp-secret';
    closesRef.length = 0;
    voice = fakeVoiceGateway();
    gateway = new TwilioMediaGateway(
      voice as never,
      tickets,
      otp,
      VOICE_PHONE_CONFIG
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    delete process.env.VOICE_PHONE_ENABLED;
  });

  /** Connects and waits for ticket redemption to settle. */
  async function connect(ticket?: string) {
    const f = fakeSocket();
    gateway.handleConnection(f.socket, request(ticket));
    await gateway.admissionSettled();
    return f;
  }

  describe('admission', () => {
    it('admits a socket presenting a valid ticket', async () => {
      const ticket = await tickets.issue(CALL_SID);
      const f = await connect(ticket);

      expect(closesRef).toEqual([]);
      f.emit('message', startFrame(), false);
      await gateway.admissionSettled();
      expect(voice.calls.some((c) => c.kind === 'frame')).toBe(true);
    });

    it.each([
      ['no ticket at all', undefined],
      ['an unknown ticket', 'z'.repeat(43)],
      ['a malformed ticket', 'not-a-ticket'],
      ['an empty ticket', ''],
    ])('closes a socket presenting %s', async (_label, ticket) => {
      const f = await connect(ticket as string | undefined);

      // Unlike the browser, an unticketed phone socket is not a caller — it is
      // someone who found the URL. There is no anonymous phone mode.
      expect(closesRef.length).toBe(1);
      f.emit('message', startFrame(), false);
      await gateway.admissionSettled();
      expect(voice.calls.filter((c) => c.kind === 'frame')).toEqual([]);
    });

    it('closes a socket presenting an expired ticket', async () => {
      const ticket = await tickets.issue(CALL_SID);
      await redis.pexpire(`voice:ticket:${ticket}`, 1);
      await new Promise((r) => setTimeout(r, 30));

      await connect(ticket);

      expect(closesRef.length).toBe(1);
    });

    it('closes a second socket reusing an already-consumed ticket', async () => {
      const ticket = await tickets.issue(CALL_SID);

      await connect(ticket);
      expect(closesRef).toEqual([]);

      await connect(ticket);
      expect(closesRef.length).toBe(1);
    });

    it('refuses every connection when the phone channel is off', async () => {
      delete process.env.VOICE_PHONE_ENABLED;
      const ticket = await tickets.issue(CALL_SID);

      await connect(ticket);

      expect(closesRef.length).toBe(1);
      // The ticket must not be spent by a refusal.
      expect(await tickets.consume(ticket)).toBe(CALL_SID);
    });

    it('closes when the ticket store is unreachable', async () => {
      const down = () => Promise.reject(new Error('closed'));
      const offline = new TwilioMediaGateway(
        voice as never,
        new VoiceTicketService({ getdel: down, set: down } as unknown as Redis),
        otp,
        VOICE_PHONE_CONFIG
      );
      const f = fakeSocket();
      offline.handleConnection(f.socket, request('a'.repeat(43)));
      await offline.admissionSettled();

      expect(closesRef.length).toBe(1);
    });

    it('records the caller number server-side from the ticket, never from a frame', async () => {
      const ticket = await tickets.issue(CALL_SID);
      const f = await connect(ticket);

      f.emit('message', frame({
        event: 'start',
        streamSid: STREAM_SID,
        start: { streamSid: STREAM_SID, callSid: CALL_SID, customParameters: { From: CALLER } },
      }), false);
      await gateway.admissionSettled();

      // Nothing in a frame may become identity. The caller record comes from
      // the webhook's server-side state, not from anything Twilio streams.
      const stored = await otp.callerFor(PHONE_SESSION);
      expect(stored).toBeUndefined();
    });
  });

  describe('the media stream protocol', () => {
    let f: Awaited<ReturnType<typeof connect>>;

    beforeEach(async () => {
      f = await connect(await tickets.issue(CALL_SID));
      voice.calls.length = 0;
    });

    const audio = () => voice.calls.filter((c) => c.kind === 'audio');
    const frames = () => voice.calls.filter((c) => c.kind === 'frame');

    it('opens the session on start and selects the phone audio format', async () => {
      f.emit('message', startFrame(), false);
      await gateway.admissionSettled();

      expect(voice.calls.find((c) => c.kind === 'format')?.value).toBe(PHONE_AUDIO_FORMAT);
      expect(frames()).toHaveLength(1);
    });

    it('forwards decoded audio after start', async () => {
      f.emit('message', startFrame(), false);
      const bytes = Buffer.from([0x7f, 0xff, 0x00, 0x40]);
      f.emit('message', mediaFrame(bytes), false);
      await gateway.admissionSettled();

      expect(audio()).toHaveLength(1);
      expect(audio()[0].value).toEqual(bytes);
    });

    it('forwards several media frames in order', async () => {
      f.emit('message', startFrame(), false);
      for (const n of [1, 2, 3]) f.emit('message', mediaFrame(Buffer.from([n])), false);
      await gateway.admissionSettled();

      expect(audio().map((c) => (c.value as Buffer)[0])).toEqual([1, 2, 3]);
    });

    it('ignores media that arrives before start', async () => {
      f.emit('message', mediaFrame(Buffer.from([1])), false);
      await gateway.admissionSettled();

      // No session exists yet; treating this as audio would create one from a
      // frame rather than from an admitted call.
      expect(audio()).toEqual([]);
      expect(frames()).toEqual([]);
    });

    it('ignores a duplicate start', async () => {
      f.emit('message', startFrame(), false);
      f.emit('message', startFrame(), false);
      await gateway.admissionSettled();

      expect(frames()).toHaveLength(1);
    });

    it('drops media after stop', async () => {
      f.emit('message', startFrame(), false);
      f.emit('message', frame({ event: 'stop', streamSid: STREAM_SID }), false);
      f.emit('message', mediaFrame(Buffer.from([9])), false);
      await gateway.admissionSettled();

      expect(audio()).toEqual([]);
    });

    it('writes no audio to the socket once the call has stopped', async () => {
      f.emit('message', startFrame(), false);
      await gateway.admissionSettled();
      f.emit('message', frame({ event: 'stop' }), false);
      await gateway.admissionSettled();

      // Reach past the gateway and push audio the way a late TTS chunk would.
      const transport = gateway.transportFor(f.socket)!;
      transport.sendAudio(Buffer.from([1, 2, 3]));

      expect(f.sent).toEqual([]);
    });

    it('does not open a session for an unknown event carrying a start payload', async () => {
      voice.calls.length = 0;
      f.emit('message', frame({
        event: 'whatever',
        start: { streamSid: STREAM_SID, callSid: CALL_SID },
      }), false);
      await gateway.admissionSettled();

      // An event this code does not know is not a start, however well shaped
      // its payload happens to be.
      expect(frames()).toEqual([]);
    });

    it('tears down once across a duplicate stop', async () => {
      f.emit('message', startFrame(), false);
      f.emit('message', frame({ event: 'stop' }), false);
      f.emit('message', frame({ event: 'stop' }), false);
      await gateway.admissionSettled();

      expect(forgets).toHaveLength(1);
    });

    it('tears down on close with no stop', async () => {
      f.emit('message', startFrame(), false);
      f.emit('close');
      await gateway.admissionSettled();

      expect(forgets).toHaveLength(1);
    });

    it('tears down once when close and error both fire', async () => {
      f.emit('message', startFrame(), false);
      f.emit('close');
      f.emit('error', new Error('socket blew up'));
      await gateway.admissionSettled();

      expect(forgets).toHaveLength(1);
    });

    it.each([
      ['a non-JSON frame', Buffer.from('not json at all')],
      ['an empty frame', Buffer.from('')],
      ['a JSON array', Buffer.from('[1,2,3]')],
      ['a JSON string', Buffer.from('"hello"')],
      ['a frame with no event', Buffer.from('{"streamSid":"MZ1"}')],
      ['an unknown event', Buffer.from('{"event":"whatever"}')],
    ])('survives %s without treating it as audio', async (_label, payload) => {
      f.emit('message', startFrame(), false);
      voice.calls.length = 0;
      f.emit('message', payload, false);
      await gateway.admissionSettled();

      expect(audio()).toEqual([]);
      expect(closesRef).toEqual([]);
    });

    it.each([
      ['invalid base64', 'not base64 !!!'],
      ['an empty payload', ''],
      ['a missing payload', undefined],
    ])('does not forward media with %s', async (_label, payload) => {
      f.emit('message', startFrame(), false);
      voice.calls.length = 0;
      f.emit('message', frame({ event: 'media', media: payload === undefined ? {} : { payload } }), false);
      await gateway.admissionSettled();

      // Decoding garbage into a buffer and calling it caller audio is how a
      // malformed frame becomes a transcript.
      expect(audio()).toEqual([]);
    });

    it('ignores a malformed start payload', async () => {
      f.emit('message', frame({ event: 'start' }), false);
      f.emit('message', frame({ event: 'start', start: 'nonsense' }), false);
      await gateway.admissionSettled();

      expect(frames()).toEqual([]);
    });

    it('ignores the connected event without opening a session', async () => {
      f.emit('message', frame({ event: 'connected', protocol: 'Call', version: '1.0.0' }), false);
      await gateway.admissionSettled();

      expect(frames()).toEqual([]);
      expect(closesRef).toEqual([]);
    });
  });

  describe('cleanup when the call ends', () => {
    it('removes this call\'s OTP state and touches no other session', async () => {
      const ticket = await tickets.issue(CALL_SID);
      const f = await connect(ticket);
      f.emit('message', startFrame(), false);
      await gateway.admissionSettled();

      const sessionId = PHONE_SESSION;
      await otp.rememberCaller(sessionId, CALLER);
      await otp.rememberCaller('someone-else', '+15559999999');

      f.emit('message', frame({ event: 'stop' }), false);
      await gateway.admissionSettled();

      expect(await otp.callerFor(sessionId)).toBeUndefined();
      // A neighbouring call must survive: cleanup is by key, never by scan.
      expect(await otp.callerFor('someone-else')).toBe('+15559999999');
    });

    it('never scans the keyspace to find what to delete', async () => {
      const keys = jest.spyOn(redis, 'keys');
      const scan = jest.spyOn(redis, 'scan');

      try {
        const f = await connect(await tickets.issue(CALL_SID));
        f.emit('message', startFrame(), false);
        f.emit('message', frame({ event: 'stop' }), false);
        await gateway.admissionSettled();

        expect(keys).not.toHaveBeenCalled();
        expect(scan).not.toHaveBeenCalled();
      } finally {
        keys.mockRestore();
        scan.mockRestore();
      }
    });
  });

  it('logs no ticket, payload, call id or phone number', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((m: unknown) => { lines.push(String(m)); })
    );

    try {
      const ticket = await tickets.issue(CALL_SID);
      const f = await connect(ticket);
      const payload = Buffer.from('caller-audio').toString('base64');
      f.emit('message', startFrame(), false);
      f.emit('message', frame({ event: 'media', media: { payload } }), false);
      f.emit('message', Buffer.from('garbage'), false);
      f.emit('message', frame({ event: 'stop' }), false);
      await gateway.admissionSettled();
      const refused = 'z'.repeat(43);
      await connect(refused);

      const all = lines.join('\n');
      expect(all).not.toContain(ticket);
      // A refused ticket is still a credential someone presented. Logging it
      // hands a log reader a value to replay if it was merely early, and marks
      // which probes got close.
      expect(all).not.toContain(refused);
      expect(all).not.toContain(payload);
      expect(all).not.toContain(CALL_SID);
      expect(all).not.toContain(CALLER);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
