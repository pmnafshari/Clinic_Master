import { WebSocket } from 'ws';
import { AudioTransport } from './audio-transport.interface';
import { VoiceErrorCode } from './error-codes';
import { ServerFrame } from './frames';

/**
 * One live browser socket, behind the AudioTransport contract.
 *
 * Deliberately thin. Every decision — validation, authorization, rate limits,
 * rotation, teardown ordering — already lives in VoiceGateway and the services
 * beneath it. This class only moves bytes: control frames go down as JSON,
 * audio goes down as binary, and cleanup runs once when the socket ends.
 *
 * Nothing here inspects a frame, and nothing here knows what a session is.
 */
export class BrowserWebSocketTransport implements AudioTransport {
  private readonly teardowns: Array<() => void | Promise<void>> = [];
  private torn = false;

  constructor(private readonly socket: WebSocket) {}

  send(frame: ServerFrame): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  sendAudio(chunk: Buffer): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(chunk, { binary: true });
    }
  }

  close(code: VoiceErrorCode): void {
    // The code has already been sent as a frame where the caller wanted the
    // client to see it; the close itself carries no detail.
    this.socket.close(1000, code);
  }

  onTeardown(fn: () => void | Promise<void>): void {
    this.teardowns.push(fn);
  }

  /**
   * Runs registered cleanup once.
   *
   * A socket can raise both 'close' and 'error', and a duration cap can close
   * it from this side, so this is called more than once in practice. The
   * gateway's own release is idempotent, but running the list twice would
   * still double-count anything a later task registers here.
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
}
