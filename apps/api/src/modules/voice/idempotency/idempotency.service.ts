import { Inject, Injectable, Optional } from '@nestjs/common';
import { VoiceToolResult } from '../tools/tool-definition.interface';
import { VoiceSession } from '../session/voice-session';
import { BoundedTtlMap, Clock, VOICE_CLOCK } from '../util/bounded-ttl-map';

/**
 * How long a confirmed result stays replayable. It only has to outlive a voice
 * pipeline's retry window, not the conversation.
 */
export const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

/** Hard ceiling on cached results, independent of the TTL. */
export const IDEMPOTENCY_MAX_ENTRIES = 5000;

/**
 * A voice pipeline retries on timeout. Without this, one retry becomes a
 * second appointment or a second recorded payment.
 *
 * In-memory is correct for Phase 0 (single process, session-scoped keys).
 * The browser and phone phases move this to Redis, which is already in the
 * stack — the interface does not change.
 */
@Injectable()
export class IdempotencyService {
  /**
   * Bounded on both axes. The key derives from a client-supplied sessionId, so
   * an unevicted map here is a remote memory-exhaustion vector: a caller who
   * varies the sessionId grows it forever. Eviction is lazy rather than
   * timer-driven — see BoundedTtlMap.
   */
  private readonly completed: BoundedTtlMap<VoiceToolResult>;

  /**
   * Work that has started but not finished. Checking `completed` and then
   * awaiting the operation is two steps, and a retry arriving in the gap
   * between them would find nothing cached and start a second write — which is
   * the timeout retry this class exists to absorb. Overlapping callers join the
   * promise already running instead.
   *
   * This one needs no bound: an entry is removed in a `finally` as soon as its
   * operation settles, so its size is the number of tool calls in flight.
   */
  private readonly inFlight = new Map<string, Promise<VoiceToolResult>>();

  constructor(@Optional() @Inject(VOICE_CLOCK) now?: Clock) {
    this.completed = new BoundedTtlMap<VoiceToolResult>(
      IDEMPOTENCY_MAX_ENTRIES,
      IDEMPOTENCY_TTL_MS,
      now ?? (() => Date.now())
    );
  }

  /** Exposed so the eviction bound is observable from a test. */
  completedSize(): number {
    return this.completed.size;
  }

  /**
   * Keyed on the session's nonce rather than its id.
   *
   * `sessionId` cannot namespace this cache. Session storage is bounded, so a
   * live conversation can be evicted by size pressure; when that caller returns,
   * a new session is created and `turnIndex` restarts at 0. A key built from
   * `sessionId` + `turnIndex` would regenerate byte-for-byte, hit the entry the
   * evicted session left behind, and replay a `confirmed` result for a write
   * that never executed — the agent reporting a booking that does not exist.
   * The nonce is fresh per session, so a recreated session simply cannot
   * address the old namespace.
   *
   * `turnIndex` stays in the key: de-duplicating a pipeline's retry *within* one
   * turn is the entire point of this class, and dropping it would collapse two
   * legitimate bookings in one conversation into one.
   *
   * Each component is still percent-encoded before joining, so ':' (and '%'
   * itself) cannot occur inside a component and the mapping from triple to key
   * stays injective. That is now a backstop twice over: the nonce is generated
   * server-side from a CSPRNG and contains no character that needs escaping.
   */
  keyFor(session: VoiceSession, toolName: string): string {
    return [String(session.idempotencyNonce), String(session.turnIndex), String(toolName)]
      .map((part) => encodeURIComponent(part))
      .join(':');
  }

  async runOnce(
    key: string,
    operation: () => Promise<VoiceToolResult>
  ): Promise<VoiceToolResult> {
    const previous = this.completed.get(key);
    if (previous) {
      return previous;
    }

    const active = this.inFlight.get(key);
    if (active) {
      return active;
    }

    const pending = (async () => {
      const result = await operation();

      // Only successful writes are replayed. Caching a failure would prevent a
      // legitimate retry from ever succeeding. This runs before the promise
      // settles, so no caller can observe the key as neither in flight nor
      // completed.
      if (result.status === 'confirmed') {
        this.completed.set(key, result);
      }

      return result;
    })();

    this.inFlight.set(key, pending);

    try {
      return await pending;
    } finally {
      // Always released — on success, on a 'failed' result, and on a throw.
      // Leaving the entry behind would wedge the key: every later retry would
      // join a promise that has already rejected and never run again.
      this.inFlight.delete(key);
    }
  }
}
