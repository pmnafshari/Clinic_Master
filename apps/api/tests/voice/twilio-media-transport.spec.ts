import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { TwilioMediaStreamTransport } from '../../src/modules/voice/transport/twilio-media-stream.transport';
import { ServerFrame } from '../../src/modules/voice/transport/frames';

const STREAM_SID = 'MZ0123456789abcdef0123456789abcdef';

/** A socket that records what was written without opening anything. */
function fakeSocket() {
  const sent: string[] = [];
  let readyState: number = WebSocket.OPEN;
  return {
    sent,
    closed: [] as Array<{ code: number; reason: string }>,
    socket: {
      get readyState(): number { return readyState; },
      send: (payload: string) => { sent.push(String(payload)); },
      close(code: number, reason: string) {
        readyState = WebSocket.CLOSED as number;
        this.closedCalls.push({ code, reason });
      },
      closedCalls: [] as Array<{ code: number; reason: string }>,
    } as unknown as WebSocket & { closedCalls: Array<{ code: number; reason: string }> },
    shut() { readyState = WebSocket.CLOSED as number; },
  };
}

const CONTROL_FRAMES: ServerFrame[] = [
  { type: 'session.ready', sessionId: 'abc' },
  { type: 'session.rotated', sessionId: 'def' },
  { type: 'reply.text', text: 'hello there' },
  { type: 'agent.thinking' },
  { type: 'turn.complete' },
  { type: 'stt.partial', text: 'book me a' },
  { type: 'error', code: 'rate_limited' },
];

describe('the Twilio media stream transport', () => {
  it('sends no control frame to Twilio, ever', () => {
    const f = fakeSocket();
    const transport = new TwilioMediaStreamTransport(f.socket, STREAM_SID);

    for (const frame of CONTROL_FRAMES) {
      transport.send(frame);
    }

    // A phone caller has no UI to render these, and the Media Streams protocol
    // rejects events it does not define. Serialising one onto this socket would
    // be a protocol violation as well as a leak of session detail.
    expect(f.sent).toEqual([]);
  });

  it('wraps audio as a media event carrying base64 payload', () => {
    const f = fakeSocket();
    const transport = new TwilioMediaStreamTransport(f.socket, STREAM_SID);

    transport.sendAudio(Buffer.from([0xff, 0x7f, 0x00]));

    expect(f.sent).toHaveLength(1);
    expect(JSON.parse(f.sent[0])).toEqual({
      event: 'media',
      streamSid: STREAM_SID,
      media: { payload: Buffer.from([0xff, 0x7f, 0x00]).toString('base64') },
    });
  });

  it('writes nothing once the socket is no longer open', () => {
    const f = fakeSocket();
    const transport = new TwilioMediaStreamTransport(f.socket, STREAM_SID);
    f.shut();

    transport.sendAudio(Buffer.from([1, 2, 3]));

    expect(f.sent).toEqual([]);
  });

  it('writes nothing after close(), so a closing call goes quiet immediately', () => {
    const f = fakeSocket();
    const transport = new TwilioMediaStreamTransport(f.socket, STREAM_SID);

    transport.close('rate_limited');
    transport.sendAudio(Buffer.from([1, 2, 3]));

    expect(f.sent).toEqual([]);
  });

  it('goes quiet the moment it is silenced, while the socket is still open', () => {
    const f = fakeSocket();
    const transport = new TwilioMediaStreamTransport(f.socket, STREAM_SID);

    transport.silence();

    // The socket is still OPEN here. This is the Phase 1 lesson in miniature:
    // a reply already being synthesised keeps producing chunks after the caller
    // hangs up, and every one of them must land nowhere — before the socket has
    // finished closing, not after.
    expect(f.socket.readyState).toBe(WebSocket.OPEN);
    transport.sendAudio(Buffer.from([1, 2, 3]));
    expect(f.sent).toEqual([]);
  });

  it('stays silent for every later chunk, not just the first', () => {
    const f = fakeSocket();
    const transport = new TwilioMediaStreamTransport(f.socket, STREAM_SID);

    transport.silence();
    for (const n of [1, 2, 3, 4]) transport.sendAudio(Buffer.from([n]));

    expect(f.sent).toEqual([]);
  });

  it('does not transmit the close code — there is no client to read it', () => {
    const f = fakeSocket();
    const transport = new TwilioMediaStreamTransport(f.socket, STREAM_SID);

    transport.close('session_expired');

    expect(f.sent).toEqual([]);
    expect(f.socket.closedCalls[0].reason).not.toContain('session_expired');
  });

  it('runs teardown exactly once across repeated calls', async () => {
    const f = fakeSocket();
    const transport = new TwilioMediaStreamTransport(f.socket, STREAM_SID);
    const ran: string[] = [];
    transport.onTeardown(() => { ran.push('a'); });
    transport.onTeardown(async () => { ran.push('b'); });

    await transport.runTeardown();
    await transport.runTeardown();

    // A socket can raise both close and error, and a duration cap can close it
    // from this side, so this genuinely happens more than once.
    expect(ran).toEqual(['a', 'b']);
  });

  it('never logs a media payload', () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation((m: unknown) => { lines.push(String(m)); })
    );

    try {
      const f = fakeSocket();
      const transport = new TwilioMediaStreamTransport(f.socket, STREAM_SID);
      const audio = Buffer.from('sensitive-caller-audio-bytes');
      transport.sendAudio(audio);
      transport.send({ type: 'reply.text', text: 'a patient balance of £420' });

      const all = lines.join('\n');
      expect(all).not.toContain(audio.toString('base64'));
      expect(all).not.toContain('sensitive-caller-audio');
      expect(all).not.toContain('£420');
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
