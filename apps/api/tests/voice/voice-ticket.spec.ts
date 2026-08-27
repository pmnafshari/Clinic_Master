import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  VoiceTicketService,
  TICKET_TTL_MS,
  TICKET_KEY_PREFIX,
} from '../../src/modules/voice/session/voice-ticket.service';
import { testRedis } from './redis-test-util';

/**
 * A service instance with its own connection.
 *
 * Every cross-instance test below builds two of these. One instance sharing a
 * single connection would prove nothing: the defect this task fixes is state
 * living inside a process, and a single-instance test cannot tell shared
 * storage from process-local storage.
 */
function serviceOn(redis: Redis): VoiceTicketService {
  return new VoiceTicketService(redis);
}

describe('voice auth tickets', () => {
  let redis: Redis;
  let service: VoiceTicketService;

  beforeAll(() => {
    redis = testRedis();
    service = serviceOn(redis);
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  it('pins the lifetime to a literal', () => {
    expect(TICKET_TTL_MS).toBe(60000);
  });

  it('issues an opaque ticket with session-grade entropy', async () => {
    const ticket = await service.issue('user-1');
    expect(ticket).toHaveLength(43);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('carries no identity in the ticket itself', async () => {
    const ticket = await service.issue('user-1');
    // The ticket is a random key into server-side storage. Anything derivable
    // from it would be identity travelling to the browser.
    expect(ticket).not.toContain('user-1');
    expect(Buffer.from(ticket, 'base64url').toString('utf8')).not.toContain('user-1');
  });

  it('stores the userId as a value, never inside the key', async () => {
    const ticket = await service.issue('user-1');
    const keys = await redis.keys('*');

    expect(keys).toEqual([`${TICKET_KEY_PREFIX}${ticket}`]);
    // A userId in a key name leaks through SCAN output, slowlog and exporters.
    expect(keys[0]).not.toContain('user-1');
  });

  it('redeems once and never again', async () => {
    const ticket = await service.issue('user-1');

    expect(await service.consume(ticket)).toBe('user-1');
    expect(await service.consume(ticket)).toBeUndefined();
    expect(await service.consume(ticket)).toBeUndefined();
  });

  it('fails closed on an unknown or malformed ticket', async () => {
    for (const bad of ['', 'not-a-ticket', '../../etc/passwd', 'x'.repeat(5000)]) {
      expect(await service.consume(bad)).toBeUndefined();
    }
  });

  it('never turns a malformed ticket into a Redis lookup', async () => {
    // Anything this shape was never issued, so asking Redis about it buys
    // nothing and lets a caller choose the size of the key the server looks
    // up. Returning undefined is not enough on its own — the point is that the
    // command is never sent.
    const getdel = jest.spyOn(redis, 'getdel');

    try {
      for (const bad of ['', 'not-a-ticket', '../../etc/passwd', 'x'.repeat(5000)]) {
        expect(await service.consume(bad)).toBeUndefined();
      }
      expect(getdel).not.toHaveBeenCalled();

      // A well-formed one still reaches Redis, so the guard cannot pass by
      // refusing everything.
      const ticket = await service.issue('user-1');
      expect(await service.consume(ticket)).toBe('user-1');
      expect(getdel).toHaveBeenCalledTimes(1);
    } finally {
      getdel.mockRestore();
    }
  });

  it('keeps two users\' tickets separate', async () => {
    const a = await service.issue('user-a');
    const b = await service.issue('user-b');

    expect(await service.consume(a)).toBe('user-a');
    expect(await service.consume(b)).toBe('user-b');
  });

  describe('lifetime', () => {
    it('gives every ticket a finite TTL', async () => {
      const ticket = await service.issue('user-1');
      const ttl = await redis.pttl(`${TICKET_KEY_PREFIX}${ticket}`);

      // -1 is "no expiry" and is the failure this asserts against: a ticket
      // without a TTL is a permanent credential in a store that never sweeps.
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(TICKET_TTL_MS);
    });

    it('fails closed once the ticket has expired', async () => {
      const ticket = await service.issue('user-1');
      await redis.pexpire(`${TICKET_KEY_PREFIX}${ticket}`, 1);
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(await service.consume(ticket)).toBeUndefined();
    });
  });

  describe('across instances', () => {
    it('redeems on a second instance a ticket the first issued', async () => {
      const instanceA = serviceOn(redis);
      const instanceB = serviceOn(testRedis());

      const ticket = await instanceA.issue('user-1');

      // The whole point of the migration: A and B share no memory.
      expect(await instanceB.consume(ticket)).toBe('user-1');
    });

    it('lets only one instance redeem a ticket', async () => {
      const instanceA = serviceOn(redis);
      const instanceB = serviceOn(testRedis());

      const ticket = await instanceA.issue('user-1');

      expect(await instanceB.consume(ticket)).toBe('user-1');
      expect(await instanceA.consume(ticket)).toBeUndefined();
    });
  });

  describe('concurrency', () => {
    it('lets exactly one of two racing redemptions win', async () => {
      const ticket = await service.issue('user-1');
      const other = serviceOn(testRedis());

      const results = await Promise.all([service.consume(ticket), other.consume(ticket)]);
      const winners = results.filter((r) => r === 'user-1');

      // Read-then-delete would let both through. GETDEL is one command.
      expect(winners).toHaveLength(1);
      expect(results.filter((r) => r === undefined)).toHaveLength(1);
    });

    it('lets exactly one of ten racing redemptions win', async () => {
      const ticket = await service.issue('user-1');
      const racers = Array.from({ length: 10 }, () => serviceOn(testRedis()));

      const results = await Promise.all(racers.map((r) => r.consume(ticket)));

      expect(results.filter((r) => r === 'user-1')).toHaveLength(1);
    });
  });

  describe('resource bounds', () => {
    /**
     * The second half of the defect this task fixes.
     *
     * The in-process map capped how MANY tickets could exist and evicted the
     * oldest to stay under it, so a burst of logins could silently discard a
     * live, unexpired credential before its holder redeemed it. A count is the
     * wrong bound for a TTL-scoped value; expiry is the right one.
     */
    it('keeps every unexpired ticket redeemable past the old 1000 cap', async () => {
      const issued: Array<[string, string]> = [];
      for (let i = 0; i < 2000; i += 1) {
        issued.push([await service.issue(`user-${i}`), `user-${i}`]);
      }

      // The first ones issued are exactly the ones the old cap threw away.
      for (const [ticket, userId] of [issued[0], issued[1], issued[999], issued[1999]]) {
        expect(await service.consume(ticket)).toBe(userId);
      }
    });
  });

  describe('when Redis is unreachable', () => {
    let dead: Redis;

    /**
     * A client whose commands reject, rather than a socket pointed at a closed
     * port. An unreachable real client is the more faithful shape, but it holds
     * a connect timeout that outlives the suite and force-exits the Jest
     * worker. What is under test here is this service's own behaviour when a
     * command fails — that it grants nothing and does not throw. When ioredis
     * decides a server is unreachable is ioredis's concern, configured by
     * `maxRetriesPerRequest` in redis.provider.ts.
     */
    beforeAll(() => {
      const down = () => Promise.reject(new Error('connection is closed'));
      dead = { getdel: down, set: down } as unknown as Redis;
    });

    it('grants nothing rather than throwing', async () => {
      const offline = serviceOn(dead);

      await expect(offline.consume('a'.repeat(43))).resolves.toBeUndefined();
    });

    it('refuses to issue a ticket it cannot store', async () => {
      const offline = serviceOn(dead);

      // Returning a ticket that was never stored would hand the browser a
      // credential guaranteed to fail, and the failure would look like an
      // expired session rather than an outage.
      await expect(offline.issue('user-1')).rejects.toBeDefined();
    });
  });

  it('never writes the ticket to a log line', async () => {
    const lines: string[] = [];
    const capture = (message: unknown) => {
      lines.push(String(message));
    };
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(capture)
    );

    try {
      const ticket = await service.issue('user-1');
      await service.consume(ticket);
      await service.consume(ticket);

      expect(lines.some((line) => line.includes(ticket))).toBe(false);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
