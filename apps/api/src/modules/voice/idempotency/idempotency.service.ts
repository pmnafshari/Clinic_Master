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
   * The sessionId is client-supplied from POST /voice/text onwards, so plain
   * `${sessionId}:${turnIndex}:${toolName}` concatenation is not safe: a
   * sessionId containing ':' can flatten to the same string as a different
   * session/turn/tool triple, and a hit on a colliding key replays one
   * operation's result in answer to another.
   *
   * Each component is percent-encoded before joining, which escapes ':' (and
   * '%' itself), so the separator cannot occur inside a component and the
   * mapping from triple to key is injective. Plain identifiers are unaffected,
   * so keys stay readable in logs.
   *
   * This is the backstop, not the primary control: VoiceTextDto already refuses
   * any sessionId outside `[A-Za-z0-9_-]{1,64}`, so neither ':' nor '%' can
   * reach here in the first place.
   */
  keyFor(session: VoiceSession, toolName: string): string {
    return [String(session.sessionId), String(session.turnIndex), String(toolName)]
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
