import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { VOICE_REDIS } from './redis.provider';
import { newOpaqueId } from './voice-session';

/**
 * Short, because the browser fetches a ticket and opens the socket in the same
 * user gesture. A minute is generous for that and leaves almost no window for
 * a leaked ticket to be useful.
 */
export const TICKET_TTL_MS = 60 * 1000;

export const TICKET_KEY_PREFIX = 'voice:ticket:';

/** The exact shape `newOpaqueId` produces: 256 bits, base64url, unpadded. */
const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const key = (ticket: string): string => `${TICKET_KEY_PREFIX}${ticket}`;

/**
 * Hands an authenticated caller a one-time key for opening a voice socket.
 *
 * A browser cannot set headers on a WebSocket, so the JWT cannot travel on the
 * handshake. Putting it in the query string instead would write a long-lived
 * credential into every access log — the exact thing the session id is kept out
 * of. A ticket is the alternative: random, server-side, single-use, and worth
 * nothing a minute later or a second time.
 *
 * The ticket itself carries no information. It is a random key into storage the
 * server owns; the userId lives on this side, as a value, and never travels.
 *
 * **Backed by Redis rather than by an in-process map, and that is a fix rather
 * than a preference.** A ticket is issued over HTTP and redeemed on a separate
 * WebSocket upgrade. Behind more than one instance those are two different
 * connections that routinely land on two different processes, so a map made the
 * redemption fail whenever the load balancer did not happen to send them to the
 * same place — silently, leaving the socket anonymous. The old map also capped
 * how many tickets could exist at once and evicted the oldest to stay under it,
 * which could discard a live credential before its holder used it. Redis fixes
 * both: one store every instance can reach, bounded by expiry rather than by a
 * count.
 */
@Injectable()
export class VoiceTicketService {
  constructor(@Inject(VOICE_REDIS) private readonly redis: Redis) {}

  /**
   * Issues a ticket for an already-authenticated user.
   *
   * Throws if the ticket cannot be stored. Returning one anyway would hand the
   * browser a credential guaranteed to fail, and the failure would surface a
   * minute later as an unexplained anonymous session rather than as the outage
   * it is.
   */
  async issue(userId: string): Promise<string> {
    const ticket = newOpaqueId();
    await this.redis.set(key(ticket), userId, 'PX', TICKET_TTL_MS);
    return ticket;
  }

  /**
   * Redeems a ticket, returning the userId it was issued for.
   *
   * `GETDEL` reads and deletes in one command, which is what makes "single use"
   * true rather than merely intended: a `GET` followed by a `DEL` leaves a
   * window in which a replay — or a second socket racing the first — reads the
   * same ticket before either deletes it. That window does not exist here, and
   * it does not reopen when a second instance is added.
   *
   * Fails closed on everything: an unknown ticket, an expired one, one already
   * spent, a malformed one, and Redis being unreachable all return `undefined`.
   * The caller treats that as "no identity", which leaves a browser socket
   * anonymous and closes a phone socket.
   */
  async consume(ticket: string): Promise<string | undefined> {
    // Checked before Redis is touched: an unbounded string would otherwise
    // become an unbounded key lookup, and nothing this shape was ever issued.
    if (!TICKET_SHAPE.test(ticket)) {
      return undefined;
    }

    try {
      return (await this.redis.getdel(key(ticket))) ?? undefined;
    } catch {
      // Deliberately silent. The ticket is a bearer credential and the error
      // would name the key it was looking for.
      return undefined;
    }
  }
}
