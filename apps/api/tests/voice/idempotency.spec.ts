import {
  IdempotencyService,
  IDEMPOTENCY_TTL_MS,
} from '../../src/modules/voice/idempotency/idempotency.service';
import { createVerifiedSession } from '../../src/modules/voice/session/voice-session';
import { VoiceToolResult } from '../../src/modules/voice/tools/tool-definition.interface';
import { redisTestProvider, testRedis } from './redis-test-util';

const sharedRedis = testRedis();

// This worker's database is shared across the file. A key left by an earlier
// test would replay into a later one and the operation would never run — the
// failure looks like a passing idempotency check and is not one.
beforeEach(async () => {
  await sharedRedis.flushdb();
});
import { createHash } from 'crypto';

/** One representative tool input, so key comparisons vary only where intended. */
const INPUT = { startTime: '2026-09-01T09:00:00.000Z', endTime: '2026-09-01T09:30:00.000Z' };

function hashOf(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

describe('IdempotencyService', () => {
  let service: IdempotencyService;

  beforeEach(() => {
    service = new IdempotencyService(sharedRedis);
  });

  it('builds a key from the session nonce, turn, tool name and input hash', () => {
    const session = createVerifiedSession('s1', 'u1', 'p1');
    session.turnIndex = 3;
    expect(service.keyFor(session, 'book_appointment', INPUT)).toBe(
      `${session.idempotencyNonce}:3:book_appointment:${hashOf(INPUT)}`
    );
  });

  /**
   * The property the input hash exists for. A single assistant turn can emit
   * two `book_appointment` blocks — "Tuesday and Thursday" — at the same
   * turnIndex, with the same tool name and the same session. Without the input
   * in the key those two are one key, the second joins the first's cache entry,
   * and one appointment is narrated as two.
   */
  it('gives two different inputs to the same tool in the same turn different keys', () => {
    const session = createVerifiedSession('s1', 'u1', 'p1');
    session.turnIndex = 3;

    const tuesday = { startTime: '2026-09-01T09:00:00.000Z' };
    const thursday = { startTime: '2026-09-03T09:00:00.000Z' };

    expect(service.keyFor(session, 'book_appointment', tuesday)).not.toBe(
      service.keyFor(session, 'book_appointment', thursday)
    );
  });

  /**
   * The other half, which the fix above must not break: a pipeline retry
   * replays byte-identical input, so it must still land on the same key.
   */
  it('gives an identical input the same key, so a retry still de-duplicates', () => {
    const session = createVerifiedSession('s1', 'u1', 'p1');
    session.turnIndex = 3;

    expect(service.keyFor(session, 'book_appointment', { ...INPUT })).toBe(
      service.keyFor(session, 'book_appointment', { ...INPUT })
    );
  });

  /**
   * The sessionId is deliberately absent from the key. It repeats across the
   * lifetime of a caller, and a session recreated after eviction would
   * regenerate an identical key and replay a `confirmed` result for a write
   * that never ran.
   */
  it('does not derive the key from the sessionId', () => {
    const session = createVerifiedSession('s1', 'u1', 'p1');
    expect(service.keyFor(session, 'book_appointment', INPUT)).not.toContain('s1');
  });

  it('runs the operation once and replays the result', async () => {
    const operation = jest
      .fn<Promise<VoiceToolResult>, []>()
      .mockResolvedValue({ status: 'confirmed', appointmentId: 'a1' });

    const first = await service.runOnce('k1', operation);
    const second = await service.runOnce('k1', operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(second.appointmentId).toBe('a1');
  });

  it('does not cache failures, so a retry can genuinely retry', async () => {
    const operation = jest
      .fn<Promise<VoiceToolResult>, []>()
      .mockResolvedValueOnce({ status: 'failed', error: 'transient' })
      .mockResolvedValueOnce({ status: 'confirmed', appointmentId: 'a2' });

    const first = await service.runOnce('k2', operation);
    const second = await service.runOnce('k2', operation);

    expect(first.status).toBe('failed');
    expect(second.status).toBe('confirmed');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('keys different tools in the same turn separately', async () => {
    const session = createVerifiedSession('s1', 'u1', 'p1');
    expect(service.keyFor(session, 'book_appointment', INPUT)).not.toBe(
      service.keyFor(session, 'cancel_appointment', INPUT)
    );
  });
});

/**
 * What must never happen: two operations that are not the same operation
 * sharing a key, so that a cache hit replays one result in answer to another.
 *
 * The sessionId cannot be what namespaces the cache. It repeats — a caller
 * evicted from the bounded session store and returning gets a new session whose
 * turnIndex restarts at 0, so a sessionId-derived key regenerates byte for byte
 * and collides with the evicted session's entries. The nonce is fresh per
 * session, which is what makes that collision impossible.
 *
 * Percent-encoding each component remains as a backstop against a separator
 * appearing inside one.
 */
describe('IdempotencyService.keyFor — namespace isolation', () => {
  let service: IdempotencyService;

  beforeEach(() => {
    service = new IdempotencyService(sharedRedis);
  });

  /** The construction being replaced, kept here to show what it does wrong. */
  function naiveKey(namespace: string, turnIndex: unknown, toolName: string): string {
    return `${namespace}:${turnIndex}:${toolName}`;
  }

  /**
   * The strongest form of the property: two sessions sharing a byte-identical,
   * hostile sessionId at the same turn still get different keys, because the
   * sessionId is not what namespaces them.
   */
  it('gives two sessions with the same sessionId different keys', () => {
    const a = createVerifiedSession('s:1:book_appointment', 'u1', 'p1');
    const b = createVerifiedSession('s:1:book_appointment', 'u2', 'p2');
    a.turnIndex = 2;
    b.turnIndex = 2;

    expect(a.sessionId).toBe(b.sessionId);
    expect(service.keyFor(a, 'book_appointment', INPUT)).not.toBe(
      service.keyFor(b, 'book_appointment', INPUT)
    );
  });

  it('keeps the four components separable', () => {
    const session = createVerifiedSession('s1', 'u1', 'p1');
    session.turnIndex = 2;

    const parts = service.keyFor(session, 'cancel_appointment', INPUT).split(':');

    expect(parts).toHaveLength(4);
    expect(parts.map(decodeURIComponent)).toEqual([
      session.idempotencyNonce,
      '2',
      'cancel_appointment',
      hashOf(INPUT),
    ]);
  });

  /**
   * The percent-encoding backstop, exercised directly. A server-generated nonce
   * is base64url and contains nothing that needs escaping, so this pins the
   * behaviour against a future change of nonce source rather than against
   * anything reachable today.
   */
  it('escapes a separator inside a component, so components cannot bleed', () => {
    const a = createVerifiedSession('s1', 'u1', 'p1');
    const b = createVerifiedSession('s2', 'u2', 'p2');
    a.idempotencyNonce = 'n:9';
    a.turnIndex = 2;
    b.idempotencyNonce = 'n';
    (b as unknown as { turnIndex: unknown }).turnIndex = '9:2';

    // Naive concatenation flattens these two distinct triples onto one string.
    expect(naiveKey('n:9', 2, 'book_appointment')).toBe(naiveKey('n', '9:2', 'book_appointment'));

    expect(service.keyFor(a, 'book_appointment', INPUT)).not.toBe(
      service.keyFor(b, 'book_appointment', INPUT)
    );
  });

  it('escapes percent signs too, so the escape itself is unambiguous', () => {
    const literal = createVerifiedSession('s1', 'u1', 'p1');
    const colon = createVerifiedSession('s2', 'u2', 'p2');
    literal.idempotencyNonce = 'a%3Ab';
    colon.idempotencyNonce = 'a:b';

    // Escaping that did not also escape '%' would map these onto the same key.
    expect(service.keyFor(literal, 'book_appointment', INPUT)).not.toBe(
      service.keyFor(colon, 'book_appointment', INPUT)
    );
  });

  it('does not replay one session’s confirmed result for another session', async () => {
    const a = createVerifiedSession('sess', 'u1', 'p1');
    const b = createVerifiedSession('sess', 'u2', 'p2');
    a.turnIndex = 2;
    b.turnIndex = 2;

    const bookedForA: VoiceToolResult = { status: 'confirmed', appointmentId: 'appt-for-a' };
    const bookedForB: VoiceToolResult = { status: 'confirmed', appointmentId: 'appt-for-b' };

    await service.runOnce(service.keyFor(a, 'book_appointment', INPUT), async () => bookedForA);
    const forB = await service.runOnce(
      service.keyFor(b, 'book_appointment', INPUT),
      async () => bookedForB
    );

    expect(forB.appointmentId).toBe('appt-for-b');
  });
});

/**
 * Checking a cache and then awaiting the work is two steps with a gap between
 * them. A retry issued before the first attempt resolves finds nothing cached
 * and starts a second write — which is exactly the timeout-retry this class
 * exists to absorb.
 *
 * Every test here starts BOTH calls before releasing either operation, so the
 * overlap is real. A stray `await` between the two calls would turn these into
 * sequential tests that prove nothing; the gate below makes that mistake hang
 * rather than pass, and each test additionally asserts that nothing has settled
 * at the moment the second caller arrives.
 */
describe('IdempotencyService.runOnce — concurrent callers', () => {
  let service: IdempotencyService;

  beforeEach(() => {
    service = new IdempotencyService(sharedRedis);
  });

  /**
   * An operation that does not resolve until explicitly released, and that
   * returns a DISTINCT result per invocation — so "both callers got the same
   * result" is a real claim about de-duplication rather than an artifact of
   * handing back one shared promise.
   */
  function gatedOperation(status: 'confirmed' | 'failed') {
    const releases: Array<() => void> = [];
    let invocations = 0;

    const operation = jest.fn(() => {
      const n = (invocations += 1);
      return new Promise<VoiceToolResult>((resolve) => {
        releases.push(() => resolve({ status, attempt: n }));
      });
    });

    /** Resolves once the operation has actually started, however long the
     *  store took to admit the caller. */
    const started = async (): Promise<void> => {
      for (let i = 0; i < 200 && invocations === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    return {
      operation,
      started,
      releaseAll: () => releases.forEach((release) => release()),
    };
  }

  it('runs the operation once when two callers overlap on the same key', async () => {
    const { operation, started, releaseAll } = gatedOperation('confirmed');

    let settled = 0;
    const first = service.runOnce('k', operation).then((r) => ((settled += 1), r));
    const second = service.runOnce('k', operation).then((r) => ((settled += 1), r));

    // Proves the two calls genuinely overlap: neither has produced a result at
    // the point the second caller was admitted.
    await started();
    expect(settled).toBe(0);

    releaseAll();
    const [a, b] = await Promise.all([first, second]);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a.attempt).toBe(1);
  });

  it('caches the confirmed result once, so a later caller still replays it', async () => {
    const { operation, started, releaseAll } = gatedOperation('confirmed');

    const first = service.runOnce('k', operation);
    const second = service.runOnce('k', operation);
    // The lease is a Redis round trip, so the operation is not invoked within
    // a microtask; releasing before it starts would leave it unresolved.
    await started();
    releaseAll();
    await Promise.all([first, second]);

    const later = await service.runOnce('k', operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(later.attempt).toBe(1);
  });

  it('does not cache a failed result reached concurrently, so a retry still retries', async () => {
    const { operation, started, releaseAll } = gatedOperation('failed');

    let settled = 0;
    const first = service.runOnce('k', operation).then((r) => ((settled += 1), r));
    const second = service.runOnce('k', operation).then((r) => ((settled += 1), r));

    await started();
    expect(settled).toBe(0);

    releaseAll();
    const [a, b] = await Promise.all([first, second]);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(a.status).toBe('failed');
    expect(b.status).toBe('failed');

    // The de-duplication must not leave the key occupied. A third, later call
    // has to genuinely re-invoke the operation.
    const retry = jest
      .fn<Promise<VoiceToolResult>, []>()
      .mockResolvedValue({ status: 'confirmed', appointmentId: 'a1' });
    const third = await service.runOnce('k', retry);

    expect(retry).toHaveBeenCalledTimes(1);
    expect(third.status).toBe('confirmed');
  });

  it('frees the key when the operation throws, rather than wedging it forever', async () => {
    const boom = jest.fn<Promise<VoiceToolResult>, []>().mockRejectedValue(new Error('boom'));

    await expect(service.runOnce('k', boom)).rejects.toThrow('boom');

    const after = jest
      .fn<Promise<VoiceToolResult>, []>()
      .mockResolvedValue({ status: 'confirmed', appointmentId: 'a1' });
    const result = await service.runOnce('k', after);

    expect(after).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('confirmed');
  });

  it('frees the key when two overlapping callers both hit a throw', async () => {
    const releases: Array<() => void> = [];
    const boom = jest.fn(
      () =>
        new Promise<VoiceToolResult>((_resolve, reject) => {
          releases.push(() => reject(new Error('boom')));
        })
    );

    const first = service.runOnce('k', boom);
    const second = service.runOnce('k', boom);
    // Both callers must observe the rejection; neither may be left dangling.
    const settled = Promise.allSettled([first, second]);
    // Wait until the throwing operation has actually been entered.
    for (let i = 0; i < 200 && boom.mock.calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    releases.forEach((release) => release());

    expect((await settled).map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(boom).toHaveBeenCalledTimes(1);

    const after = jest
      .fn<Promise<VoiceToolResult>, []>()
      .mockResolvedValue({ status: 'confirmed', appointmentId: 'a1' });
    await service.runOnce('k', after);

    expect(after).toHaveBeenCalledTimes(1);
  });

  it('keeps different keys independent while both are in flight', async () => {
    const { operation, started, releaseAll } = gatedOperation('confirmed');

    const a = service.runOnce('k1', operation);
    const b = service.runOnce('k2', operation);
    await started();
    releaseAll();
    const [ra, rb] = await Promise.all([a, b]);

    expect(operation).toHaveBeenCalledTimes(2);
    expect(ra.attempt).not.toBe(rb.attempt);
  });
});

/**
 * `completed` is keyed partly by a client-supplied sessionId. Left unevicted it
 * is a remote memory-exhaustion vector: a caller who varies the sessionId grows
 * the map without bound. Eviction is lazy (checked on access and on write)
 * rather than timer-driven, so nothing keeps the Node process or a Jest worker
 * alive. `inFlight` is self-limiting — entries are always removed in a `finally`
 * — and needs no bound.
 *
 * The clock is injected so these tests are deterministic and so that the
 * "expired" case is genuinely reached rather than merely assumed.
 */
describe('IdempotencyService — bounded completed cache', () => {
  /** A hand-cranked clock. Nothing here depends on wall time or fake timers. */
  function clockAt(start = 1_000_000) {
    let current = start;
    return {
      now: () => current,
      advance: (ms: number) => {
        current += ms;
      },
    };
  }

  function confirmed(id: string) {
    return jest
      .fn<Promise<VoiceToolResult>, []>()
      .mockResolvedValue({ status: 'confirmed', appointmentId: id });
  }

  it('exposes a finite TTL', () => {
    expect(IDEMPOTENCY_TTL_MS).toBeGreaterThan(0);
    expect(Number.isFinite(IDEMPOTENCY_TTL_MS)).toBe(true);
  });

  /**
   * The control for the expiry test below. If the entry were never written in
   * the first place, "expired" would pass vacuously.
   */
  it('replays a confirmed result while it is still inside the TTL', async () => {
    const service = new IdempotencyService(sharedRedis);

    const first = confirmed('a1');
    await service.runOnce('ttl-live', first);

    const second = confirmed('a2');
    const replay = await service.runOnce('ttl-live', second);

    expect(second).not.toHaveBeenCalled();
    expect(replay.appointmentId).toBe('a1');
  });

  it('stops replaying once the entry has expired', async () => {
    const redis = testRedis();
    const service = new IdempotencyService(redis);

    await service.runOnce('ttl-expiring', confirmed('a1'));
    // Redis owns expiry now, so the entry is aged rather than the clock moved.
    await redis.pexpire('voice:idem:ttl-expiring', 30);
    await new Promise((r) => setTimeout(r, 120));

    const second = confirmed('a2');
    const result = await service.runOnce('ttl-expiring', second);

    expect(second).toHaveBeenCalledTimes(1);
    expect(result.appointmentId).toBe('a2');
  });

  /**
   * Replaces three tests that asserted BoundedTtlMap's in-process entry-count
   * eviction. That implementation no longer exists: the cache moved to Redis so
   * instances can share it, and Redis bounds memory by configuration rather
   * than by counting entries.
   *
   * The guarantee those tests protected — a caller who varies the key cannot
   * grow the store without bound — still has to hold, so it is asserted here
   * against the mechanism that now provides it.
   */
  describe('the keyspace is bounded by Redis configuration, not left to grow', () => {
    it('gives every cached result a finite lifetime', async () => {
      const redis = testRedis();
      const service = new IdempotencyService(redis);

      await service.runOnce('bounded-1', confirmed('a1'));

      const ttl = await redis.ttl('voice:idem:bounded-1');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(IDEMPOTENCY_TTL_MS / 1000);
    });

    it('leaves no key without an expiry for an attacker to accumulate', async () => {
      const redis = testRedis();
      const service = new IdempotencyService(redis);

      for (let i = 0; i < 25; i += 1) {
        await service.runOnce(`attacker-${i}`, confirmed(`a${i}`));
      }

      const keys = await redis.keys('voice:idem:attacker-*');
      expect(keys).toHaveLength(25);
      // A key with no TTL would sit in Redis until it was evicted or the
      // server restarted, which is exactly the unbounded growth the old
      // entry-count cap existed to prevent.
      for (const key of keys) {
        expect(await redis.ttl(key)).toBeGreaterThan(0);
      }
    });

    it('runs against a Redis configured to evict rather than refuse writes', async () => {
      const redis = testRedis();
      const [, policy] = await redis.config('GET', 'maxmemory-policy') as [string, string];
      const [, maxmemory] = await redis.config('GET', 'maxmemory') as [string, string];

      // `noeviction` would turn memory pressure into refused writes, taking
      // voice down for every instance at once. volatile-lru evicts the oldest
      // expiring key instead — and every key this service writes has a TTL.
      expect(policy).toBe('volatile-lru');
      expect(Number(maxmemory)).toBeGreaterThan(0);
    });
  });

  it('replays without any injected clock, because Redis owns expiry', async () => {
    const service = new IdempotencyService(sharedRedis);

    const operation = confirmed('a1');
    await service.runOnce('no-clock', operation);
    await service.runOnce('no-clock', operation);

    expect(operation).toHaveBeenCalledTimes(1);
  });
});
