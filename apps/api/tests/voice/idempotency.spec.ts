import {
  IdempotencyService,
  IDEMPOTENCY_MAX_ENTRIES,
  IDEMPOTENCY_TTL_MS,
} from '../../src/modules/voice/idempotency/idempotency.service';
import { createVerifiedSession } from '../../src/modules/voice/session/voice-session';
import { VoiceToolResult } from '../../src/modules/voice/tools/tool-definition.interface';
import { createHash } from 'crypto';

/** One representative tool input, so key comparisons vary only where intended. */
const INPUT = { startTime: '2026-09-01T09:00:00.000Z', endTime: '2026-09-01T09:30:00.000Z' };

function hashOf(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

describe('IdempotencyService', () => {
  let service: IdempotencyService;

  beforeEach(() => {
    service = new IdempotencyService();
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
    service = new IdempotencyService();
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
    service = new IdempotencyService();
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

    return { operation, releaseAll: () => releases.forEach((release) => release()) };
  }

  it('runs the operation once when two callers overlap on the same key', async () => {
    const { operation, releaseAll } = gatedOperation('confirmed');

    let settled = 0;
    const first = service.runOnce('k', operation).then((r) => ((settled += 1), r));
    const second = service.runOnce('k', operation).then((r) => ((settled += 1), r));

    // Proves the two calls genuinely overlap: neither has produced a result at
    // the point the second caller was admitted.
    await Promise.resolve();
    expect(settled).toBe(0);

    releaseAll();
    const [a, b] = await Promise.all([first, second]);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a.attempt).toBe(1);
  });

  it('caches the confirmed result once, so a later caller still replays it', async () => {
    const { operation, releaseAll } = gatedOperation('confirmed');

    const first = service.runOnce('k', operation);
    const second = service.runOnce('k', operation);
    releaseAll();
    await Promise.all([first, second]);

    const later = await service.runOnce('k', operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(later.attempt).toBe(1);
  });

  it('does not cache a failed result reached concurrently, so a retry still retries', async () => {
    const { operation, releaseAll } = gatedOperation('failed');

    let settled = 0;
    const first = service.runOnce('k', operation).then((r) => ((settled += 1), r));
    const second = service.runOnce('k', operation).then((r) => ((settled += 1), r));

    await Promise.resolve();
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
    const { operation, releaseAll } = gatedOperation('confirmed');

    const a = service.runOnce('k1', operation);
    const b = service.runOnce('k2', operation);
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

  it('exposes a finite TTL and size cap', () => {
    expect(IDEMPOTENCY_TTL_MS).toBeGreaterThan(0);
    expect(Number.isFinite(IDEMPOTENCY_TTL_MS)).toBe(true);
    expect(IDEMPOTENCY_MAX_ENTRIES).toBeGreaterThan(0);
    expect(Number.isFinite(IDEMPOTENCY_MAX_ENTRIES)).toBe(true);
  });

  /**
   * The control for the expiry test below. If the entry were never written in
   * the first place, this goes red — so "expired" cannot pass vacuously.
   */
  it('replays a confirmed result while it is still inside the TTL', async () => {
    const clock = clockAt();
    const service = new IdempotencyService(clock.now);

    const first = confirmed('a1');
    await service.runOnce('k', first);

    clock.advance(IDEMPOTENCY_TTL_MS - 1);

    const second = confirmed('a2');
    const replay = await service.runOnce('k', second);

    expect(second).not.toHaveBeenCalled();
    expect(replay.appointmentId).toBe('a1');
    expect(service.completedSize()).toBe(1);
  });

  it('stops replaying — and drops the entry — once the TTL has passed', async () => {
    const clock = clockAt();
    const service = new IdempotencyService(clock.now);

    await service.runOnce('k', confirmed('a1'));
    expect(service.completedSize()).toBe(1);

    clock.advance(IDEMPOTENCY_TTL_MS);

    const second = confirmed('a2');
    const result = await service.runOnce('k', second);

    expect(second).toHaveBeenCalledTimes(1);
    expect(result.appointmentId).toBe('a2');
  });

  it('reclaims expired entries rather than accumulating them', async () => {
    const clock = clockAt();
    const service = new IdempotencyService(clock.now);

    for (let i = 0; i < 50; i += 1) {
      await service.runOnce(`k${i}`, confirmed(`a${i}`));
    }
    expect(service.completedSize()).toBe(50);

    clock.advance(IDEMPOTENCY_TTL_MS);
    await service.runOnce('later', confirmed('later'));

    // The 50 expired entries are gone; only the fresh one remains.
    expect(service.completedSize()).toBe(1);
  });

  it('never exceeds the size cap, even with a fresh key every call', async () => {
    const clock = clockAt();
    const service = new IdempotencyService(clock.now);

    for (let i = 0; i < IDEMPOTENCY_MAX_ENTRIES + 250; i += 1) {
      await service.runOnce(`attacker-${i}`, confirmed(`a${i}`));
    }

    expect(service.completedSize()).toBeLessThanOrEqual(IDEMPOTENCY_MAX_ENTRIES);
  });

  it('evicts the oldest entry first when the cap is reached', async () => {
    const clock = clockAt();
    const service = new IdempotencyService(clock.now);

    await service.runOnce('oldest', confirmed('oldest'));
    for (let i = 0; i < IDEMPOTENCY_MAX_ENTRIES; i += 1) {
      await service.runOnce(`filler-${i}`, confirmed(`f${i}`));
    }

    const reRun = confirmed('re-run');
    await service.runOnce('oldest', reRun);
    expect(reRun).toHaveBeenCalledTimes(1);

    // The most recent write is still cached — eviction is oldest-first, not
    // a wholesale flush.
    const newest = confirmed('newest');
    await service.runOnce(`filler-${IDEMPOTENCY_MAX_ENTRIES - 1}`, newest);
    expect(newest).not.toHaveBeenCalled();
  });

  it('defaults to the real clock when none is injected', async () => {
    const service = new IdempotencyService();

    const operation = confirmed('a1');
    await service.runOnce('k', operation);
    await service.runOnce('k', operation);

    expect(operation).toHaveBeenCalledTimes(1);
  });
});
