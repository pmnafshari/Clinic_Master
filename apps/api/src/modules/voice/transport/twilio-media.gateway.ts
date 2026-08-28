import { Inject, Logger, Optional } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import type { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { OtpService } from '../otp/otp.service';
import { VoiceTicketService } from '../session/voice-ticket.service';
import { PHONE_AUDIO_FORMAT } from '../speech/audio-format';
import {
  VOICE_PHONE_CONFIG,
  VOICE_PHONE_FLAG,
  VoicePhoneFlag,
} from '../voice-phone.config';
import { TwilioMediaStreamTransport } from './twilio-media-stream.transport';
import { VoiceGateway } from './voice.gateway';

export const PHONE_WS_PATH = '/voice/phone';

/** Per-socket protocol state. A stream is either started or it is not. */
interface StreamState {
  started: boolean;
  stopped: boolean;
  transport?: TwilioMediaStreamTransport;
}

/**
 * Where a phone call's audio arrives.
 *
 * The bridge and nothing else: Twilio's events become calls on the transport
 * stack that already exists. Validation, authorization, rate limiting, rotation
 * and cleanup all stay where they are.
 *
 * Two things make this path different from the browser's, and both are
 * deliberate.
 *
 * **A ticket is required, not optional.** The browser socket treats a bad
 * ticket as "carry on anonymously", because an anonymous widget session is a
 * legitimate product. There is no equivalent here: Twilio does not sign the
 * WebSocket handshake, so the ticket minted by the signed webhook is the only
 * thing separating a real call from someone who found the URL. No ticket, no
 * socket.
 *
 * **Nothing in a frame is ever identity.** The caller's number, the patient,
 * the session — all of it comes from server-side state established by the
 * webhook. Twilio custom parameters can put anything in a `start` event and
 * none of it is read.
 */
@WebSocketGateway({ path: PHONE_WS_PATH })
export class TwilioMediaGateway implements OnGatewayConnection {
  private readonly logger = new Logger('VoicePhone');
  private readonly streams = new WeakMap<WebSocket, StreamState>();

  /**
   * The work currently in flight, so a test can wait for admission and frame
   * handling deterministically rather than racing the event loop.
   */
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly gateway: VoiceGateway,
    private readonly tickets: VoiceTicketService,
    private readonly otp: OtpService,
    @Optional()
    @Inject(VOICE_PHONE_FLAG)
    private readonly flag: VoicePhoneFlag = VOICE_PHONE_CONFIG
  ) {}

  handleConnection(socket: WebSocket, request?: IncomingMessage): void {
    const state: StreamState = { started: false, stopped: false };
    this.streams.set(socket, state);

    this.track(this.admit(socket, state, request));

    socket.on('message', (data: Buffer) => {
      this.track(this.dispatch(socket, state, data));
    });
    socket.on('close', () => {
      this.track(this.end(socket, state));
    });
    socket.on('error', () => {
      this.track(this.end(socket, state));
    });
  }

  /** The transport bound to a socket. Exposed so a test can push a late chunk. */
  transportFor(socket: WebSocket): TwilioMediaStreamTransport | undefined {
    return this.streams.get(socket)?.transport;
  }

  /** Awaits whatever this gateway is currently doing. */
  async admissionSettled(): Promise<void> {
    // Two rounds: handling a frame can schedule more work.
    await this.inFlight;
    await this.inFlight;
  }

  private track(work: Promise<unknown>): void {
    this.inFlight = this.inFlight.then(() => work).catch(() => undefined);
  }

  /**
   * Redeems the ticket before a single frame is read.
   *
   * The flag is checked first so a disabled deployment does not spend a ticket
   * refusing a call it was never going to take.
   */
  private async admit(
    socket: WebSocket,
    state: StreamState,
    request?: IncomingMessage
  ): Promise<void> {
    if (!this.flag.phoneEnabled) {
      socket.close(1013);
      return;
    }

    const ticket = this.ticketFrom(request);
    // consume() already fails closed on an unknown, expired, spent or
    // malformed ticket, and on the store being unreachable.
    const callSid = ticket ? await this.tickets.consume(ticket) : undefined;

    if (!callSid) {
      // No anonymous phone mode. Nothing was admitted, so nothing is torn down.
      socket.close(1008);
      return;
    }

    state.transport = new TwilioMediaStreamTransport(socket, '');
  }

  private ticketFrom(request?: IncomingMessage): string | undefined {
    if (!request?.url) {
      return undefined;
    }
    const value = new URL(request.url, 'http://placeholder').searchParams.get('ticket');
    return value && value.length > 0 ? value : undefined;
  }

  private async dispatch(socket: WebSocket, state: StreamState, data: Buffer): Promise<void> {
    const transport = state.transport;
    if (!transport || state.stopped) {
      // Not admitted, or already finished. Either way there is nothing this
      // frame can legitimately do.
      return;
    }

    const event = this.parse(data);
    if (!event) {
      return;
    }

    switch (event.event) {
      case 'start':
        await this.start(state, event);
        return;
      case 'media':
        await this.media(state, event);
        return;
      case 'stop':
        await this.end(socket, state);
        return;
      default:
        // 'connected', 'mark', 'dtmf' and anything Twilio adds later. Not
        // errors, and deliberately not audio.
        return;
    }
  }

  /** JSON or nothing. A frame that will not parse is dropped, never guessed at. */
  private parse(data: Buffer): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(data.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return undefined;
      }
      const event = (parsed as { event?: unknown }).event;
      return typeof event === 'string' ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  private async start(state: StreamState, event: Record<string, unknown>): Promise<void> {
    if (state.started) {
      // A second start would open a second session on one call.
      return;
    }

    const start = event.start;
    if (typeof start !== 'object' || start === null) {
      return;
    }

    const streamSid = (start as { streamSid?: unknown }).streamSid;
    if (typeof streamSid !== 'string' || streamSid.length === 0) {
      return;
    }

    state.started = true;
    state.transport!.bindStream(streamSid);

    /**
     * The phone channel's codec, chosen here and passed through the speech
     * factories. Nothing below this knows what Twilio is; it receives a format.
     */
    this.gateway.bindAudioFormat(state.transport!, PHONE_AUDIO_FORMAT);
    await this.gateway.handleFrame(state.transport!, { type: 'session.start' });
  }

  private async media(state: StreamState, event: Record<string, unknown>): Promise<void> {
    if (!state.started) {
      // Audio before a session exists is not audio for anyone.
      return;
    }

    const media = event.media;
    if (typeof media !== 'object' || media === null) {
      return;
    }

    const payload = (media as { payload?: unknown }).payload;
    if (typeof payload !== 'string' || payload.length === 0) {
      return;
    }

    const chunk = Buffer.from(payload, 'base64');
    // Base64 decoding never throws — it silently drops what it cannot read — so
    // the round trip is what actually catches a malformed payload.
    if (chunk.length === 0 || chunk.toString('base64').replace(/=+$/, '') !== payload.replace(/=+$/, '')) {
      return;
    }

    await this.gateway.handleAudio(state.transport!, chunk);
  }

  /**
   * Ends the call once, whichever of stop, close or error arrives first.
   *
   * Order matters and is the Phase 1 lesson: the transport stops accepting
   * writes before anything is awaited, so a reply already being synthesised
   * cannot keep pushing audio at a socket that is going away.
   */
  private async end(socket: WebSocket, state: StreamState): Promise<void> {
    if (state.stopped) {
      return;
    }
    state.stopped = true;

    const transport = state.transport;
    if (!transport) {
      return;
    }

    // Before any await, and this ordering is the Phase 1 lesson: a teardown
    // that awaited first left audio flowing at a socket that was going away.
    transport.silence();

    const sessionId = this.gateway.sessionIdFor(transport);
    await transport.runTeardown();
    socket.close(1000);

    if (sessionId) {
      // By key, never by scan: a KEYS sweep would be O(keyspace) and would put
      // every other live call's state in reach of one hang-up.
      await this.otp.forgetCall(sessionId);
    }
  }
}
