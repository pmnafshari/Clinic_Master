import { WebSocket } from 'ws';
import { AudioTransport } from './audio-transport.interface';
import { VoiceErrorCode } from './error-codes';
import { ServerFrame } from './frames';

/**
 * One live Twilio Media Stream, behind the AudioTransport contract.
 *
 * Deliberately thin, like its browser counterpart: every decision — validation,
 * authorization, rate limits, rotation, teardown ordering — already lives in
 * VoiceGateway and the services beneath it. This class moves bytes.
 *
 * It differs from the browser transport in one way, and the asymmetry is
 * intentional. **Control frames go nowhere.** A phone caller has no UI to
 * render `session.ready`, `session.rotated` or `reply.text`, and the Media
 * Streams protocol rejects events it does not define, so serialising one onto
 * this socket would be both a protocol violation and a needless disclosure of
 * session detail down a wire that cannot use it. They are dropped.
 *
 * Barge-in stays out of scope. Twilio's `clear` event is the mechanism a later
 * phase would use to flush queued playback; nothing here sends one.
 */
export class TwilioMediaStreamTransport implements AudioTransport {
  private readonly teardowns: Array<() => void | Promise<void>> = [];
  private torn = false;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private streamSid: string = ''
  ) {}

  /**
   * Twilio only names the stream in its `start` event, so the transport is
   * built at admission and learns its stream id a moment later.
   */
  bindStream(streamSid: string): void {
    this.streamSid = streamSid;
  }

  /**
   * Stops accepting writes without closing the socket.
   *
   * Called first thing when a call ends, before anything is awaited. A reply
   * already being synthesised keeps producing chunks for a moment after the
   * caller hangs up, and every one of them must land nowhere.
   */
  silence(): void {
    this.closed = true;
  }

  /**
   * Accepts every frame and transmits none.
   *
   * Not a no-op by accident — the gateway sends these unconditionally, and the
   * phone channel simply has nowhere to put them.
   */
  send(_frame: ServerFrame): void {
    void _frame;
  }

  sendAudio(chunk: Buffer): void {
    if (!this.writable()) {
      return;
    }

    this.socket.send(
      JSON.stringify({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: chunk.toString('base64') },
      })
    );
  }

  /**
   * Ends the call. The code is not transmitted: there is no client to read it,
   * and Twilio treats the socket closing as the end of the stream.
   */
  close(_code: VoiceErrorCode): void {
    this.closed = true;
    this.socket.close(1000, '');
  }

  onTeardown(fn: () => void | Promise<void>): void {
    this.teardowns.push(fn);
  }

  /**
   * Runs registered cleanup once.
   *
   * A socket can raise both 'close' and 'error', Twilio sends an explicit
   * 'stop', and a duration cap can close it from this side — so this is called
   * more than once in practice.
   */
  async runTeardown(): Promise<void> {
    if (this.torn) {
      return;
    }
    this.torn = true;
    for (const fn of this.teardowns) {
      await fn();
    }
  }

  /**
   * Checked before every write, and it tracks our own close as well as the
   * socket's state: a caller who hung up must stop hearing audio immediately,
   * not once the socket finishes closing.
   */
  private writable(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN;
  }
}
