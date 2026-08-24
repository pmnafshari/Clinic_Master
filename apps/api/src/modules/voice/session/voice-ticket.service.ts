import { Inject, Injectable, Optional } from '@nestjs/common';
import { newOpaqueId } from './voice-session';
import { BoundedTtlMap, Clock, VOICE_CLOCK } from '../util/bounded-ttl-map';

/**
 * Short, because the browser fetches a ticket and opens the socket in the same
 * user gesture. A minute is generous for that and leaves almost no window for
 * a leaked ticket to be useful.
 */
export const TICKET_TTL_MS = 60 * 1000;

/** Hard ceiling on outstanding tickets, mirroring the session cap. */
export const MAX_PENDING_TICKETS = 1000;

/**
 * Hands an authenticated caller a one-time key for opening a voice socket.
 *
 * A browser cannot set headers on a WebSocket, so the JWT cannot travel on the
 * handshake. Putting it in the query string instead would write a long-lived
 * credential into every access log — the exact thing the session id is kept out
 * of. A ticket is the alternative: random, server-side, single-use, and worth
 * nothing a minute later or a second time.
 *
 * The ticket itself carries no information. It is a random key into a map the
 * server holds; the userId lives on this side and never travels.
 */
@Injectable()
export class VoiceTicketService {
  private readonly tickets: BoundedTtlMap<string>;

  constructor(@Optional() @Inject(VOICE_CLOCK) clock?: Clock) {
    this.tickets = new BoundedTtlMap<string>(
      MAX_PENDING_TICKETS,
      TICKET_TTL_MS,
      clock ?? (() => Date.now())
    );
  }

  /** Issues a ticket for an already-authenticated user. */
  issue(userId: string): string {
    const ticket = newOpaqueId();
    this.tickets.set(ticket, userId);
    return ticket;
  }

  /**
   * Redeems a ticket, returning the userId it was issued for.
   *
   * Reads and deletes in one synchronous operation, so a second redemption —
   * whether a replay or a race between two sockets — finds nothing. Node runs
   * this without interleaving, which is what makes "single use" true rather
   * than merely intended.
   */
  consume(ticket: string): string | undefined {
    const userId = this.tickets.get(ticket);
    if (userId === undefined) {
      return undefined;
    }
    this.tickets.delete(ticket);
    return userId;
  }

  get pending(): number {
    return this.tickets.size;
  }
}
