import { Inject, Logger, Optional } from '@nestjs/common';
import {
  OnGatewayConnection,
  WebSocketGateway,
} from '@nestjs/websockets';
import { WebSocket } from 'ws';
import {
  VOICE_BROWSER_CONFIG,
  VOICE_BROWSER_FLAG,
  VoiceBrowserFlag,
} from '../voice-browser.config';
import { BrowserWebSocketTransport } from './browser-websocket.transport';
import { VoiceGateway } from './voice.gateway';

/**
 * The browser's entry point.
 *
 * This is the bridge and nothing else: it turns socket events into calls on
 * the transport stack that already exists. A text message is a control frame,
 * a binary message is caller audio, and a close is a teardown. Validation,
 * authorization, rate limiting, rotation and cleanup all stay where they are.
 *
 * Origin and per-IP checks run earlier still, in WsOriginAdapter's
 * verifyClient, so a disallowed page never completes the upgrade.
 */
@WebSocketGateway({ path: '/voice' })
export class VoiceSocketGateway implements OnGatewayConnection {
  private readonly logger = new Logger(VoiceSocketGateway.name);

  constructor(
    private readonly gateway: VoiceGateway,
    @Optional()
    @Inject(VOICE_BROWSER_FLAG)
    private readonly flag: VoiceBrowserFlag = VOICE_BROWSER_CONFIG
  ) {}

  handleConnection(socket: WebSocket): void {
    /**
     * Default-deny. A deployment that has not switched browser voice on closes
     * the socket immediately rather than serving it: the public surface should
     * not be reachable by accident, and an absent variable is not consent.
     */
    if (!this.flag.browserEnabled) {
      socket.close(1013, 'unavailable');
      return;
    }

    const transport = new BrowserWebSocketTransport(socket);

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      void this.dispatch(transport, data, isBinary);
    });

    socket.on('close', () => {
      void transport.runTeardown();
    });

    socket.on('error', () => {
      // The socket's own error carries nothing the caller needs, and the
      // connection is finished either way.
      void transport.runTeardown();
    });
  }

  /**
   * Binary is audio; text is a control frame. Both go to the handlers that
   * already own them — this method adds no behaviour of its own beyond
   * deciding which of the two a message is.
   */
  private async dispatch(
    transport: BrowserWebSocketTransport,
    data: Buffer,
    isBinary: boolean
  ): Promise<void> {
    if (isBinary) {
      await this.gateway.handleAudio(transport, data);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data.toString());
    } catch {
      // Unparseable text never reaches the frame validator, which expects an
      // object. It is refused the same way any malformed frame is.
      payload = null;
    }

    await this.gateway.handleFrame(transport, payload);
  }
}
