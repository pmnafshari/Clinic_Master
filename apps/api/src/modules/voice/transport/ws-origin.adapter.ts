import { INestApplicationContext } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { isOriginAllowed } from '../../../common/config/allowed-origins';
import {
  WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE,
  WS_MAX_FRAME_BYTES,
  WS_RATE_WINDOW_MS,
} from './transport-limits';

interface VerifyInfo {
  origin: string;
  req: { url?: string; socket: { remoteAddress?: string } };
}

/**
 * Exactly this path, and nothing that merely resembles it.
 *
 * The comparison is against the parsed pathname rather than the raw URL, so a
 * query string still matches and `/voice/phoney` or `/voice/phone/extra` does
 * not. A loose match here would be a way to ask for the phone path's rules
 * while connecting from a browser.
 */
const PHONE_PATH = '/voice/phone';

function isPhonePath(url?: string): boolean {
  if (!url) {
    return false;
  }
  try {
    return new URL(url, 'ws://placeholder').pathname === PHONE_PATH;
  } catch {
    return false;
  }
}

/**
 * Rejects a handshake before the upgrade completes.
 *
 * This is why the transport is raw `ws` rather than Socket.IO: `verifyClient`
 * runs during the HTTP upgrade, so a disallowed Origin never becomes a
 * WebSocket at all. A check after the upgrade would mean an unauthorised page
 * had already opened a socket into the process.
 *
 * `maxPayload` is handed to the `ws` server rather than enforced in a frame
 * handler: the server drops an oversize frame before it is buffered, so there
 * is no application code path to bypass.
 */
export class WsOriginAdapter extends WsAdapter {
  private readonly recentByIp = new Map<string, number[]>();

  constructor(app: INestApplicationContext) {
    super(app);
  }

  create(port: number, options?: Record<string, unknown>): unknown {
    return super.create(port, {
      ...options,
      maxPayload: WS_MAX_FRAME_BYTES,
      verifyClient: (info: VerifyInfo) => this.admit(info),
    });
  }

  /**
   * Two channels, two admission rules, branched explicitly.
   *
   * The browser path is untouched: an exact-match Origin allowlist where an
   * absent Origin is a rejection, plus a per-IP connection cap.
   *
   * The phone path skips both, and for different reasons. Origin is skipped
   * because the check exists to stop a browser page hijacking a socket, and
   * there is no browser here — Twilio sends no Origin at all, so applying the
   * browser rule would reject every real call. The per-IP cap is skipped
   * because every Twilio media stream arrives from a small set of egress
   * addresses, so one shared budget would start refusing a busy clinic's calls.
   *
   * Neither is a relaxation of the browser rule. What replaces them is
   * stricter: the phone socket must present a single-use ticket minted by the
   * signed webhook, and TwilioMediaGateway closes it if it cannot.
   */
  private admit(info: VerifyInfo): boolean {
    if (isPhonePath(info.req?.url)) {
      return true;
    }

    if (!isOriginAllowed(info.origin)) {
      return false;
    }
    return this.underIpLimit(info.req?.socket?.remoteAddress ?? 'unknown');
  }

  /** Per-IP cap on new connections, measured over a sliding window. */
  underIpLimit(ip: string): boolean {
    const now = Date.now();
    const recent = (this.recentByIp.get(ip) ?? []).filter((t) => now - t < WS_RATE_WINDOW_MS);

    if (recent.length >= WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE) {
      this.recentByIp.set(ip, recent);
      return false;
    }

    recent.push(now);
    this.recentByIp.set(ip, recent);
    return true;
  }
}
