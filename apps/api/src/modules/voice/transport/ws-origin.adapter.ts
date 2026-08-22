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
  req: { socket: { remoteAddress?: string } };
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
      verifyClient: (info: VerifyInfo) => {
        if (!isOriginAllowed(info.origin)) {
          return false;
        }
        return this.underIpLimit(info.req?.socket?.remoteAddress ?? 'unknown');
      },
    });
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
