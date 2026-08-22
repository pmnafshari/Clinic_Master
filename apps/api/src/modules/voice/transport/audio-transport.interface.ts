import { VoiceErrorCode } from './error-codes';
import { ServerFrame } from './frames';

/**
 * The seam between the agent and whatever is carrying audio.
 *
 * BrowserWebSocketTransport implements this for the browser. A telephony
 * transport would implement the same interface, which is what lets a new
 * carrier arrive without touching the agent, the tools, or the security
 * layers.
 *
 * It carries audio frames and control events. It never carries identity: who
 * the caller is, and what they may do, is decided server-side from the stored
 * session and nowhere else.
 */
export interface AudioTransport {
  send(frame: ServerFrame): void;
  sendAudio?(chunk: Buffer): void;
  close(code: VoiceErrorCode): void;
  /** Registered cleanup, run once when the connection ends for any reason. */
  onTeardown(fn: () => void | Promise<void>): void;
}
