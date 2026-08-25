import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { VoiceToolResult } from '../tools/tool-definition.interface';
import { VoiceSession } from '../session/voice-session';
import { Redis } from 'ioredis';
import { VOICE_REDIS } from '../session/redis.provider';

/**
 * How long a confirmed result stays replayable. It only has to outlive a voice
 * pipeline's retry window, not the conversation.
 */
export const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

const RESULT_PREFIX = 'voice:idem:';
const LEASE_PREFIX = 'voice:idem:lock:';

/**
 * Where a winner publishes whatever it produced, so callers already waiting on
 * the same key get that answer instead of running the operation again.
 *
 * Separate from the durable cache because it holds failures too: two callers
 * overlapping on one booking must not both execute it, whether it succeeds or
 * not. It is short-lived precisely so a failure is not replayed to anyone who
 * arrives later — a retry then is legitimate.
 */
const OUTCOME_PREFIX = 'voice:idem:outcome:';
const OUTCOME_TTL_SECONDS = 30;

/** A tool call that has not finished inside this has stopped being useful. */
const LEASE_TTL_SECONDS = 30;

/** How long a loser waits for the winner's result before retrying itself. */
const LEASE_WAIT_MS = 20_000;
const LEASE_POLL_MS = 50;

/**
 * A voice pipeline retries on timeout. Without this, one retry becomes a
 * second appointment or a second recorded payment.
 *
 * Backed by Redis so the guarantee holds across instances: a caller whose
 * retry lands on a different process must still not book twice.
 */
@Injectable()
export class IdempotencyService {
  /**
   * Executions currently running in THIS process, so two callers who arrive at
   * the same moment share one execution and one outcome — a rejection
   * included.
   *
   * This is request coalescing, not a cache and not a store. It holds only
   * active, unsettled promises: an entry is created when an execution starts
   * and removed the moment it settles, either way. Nothing survives settlement,
   * so no result, failure, session or credential is ever held here. Redis
   * remains the only shared source of coordination and the only place a
   * completed result lives.
   */
  private readonly inFlight = new Map<string, Promise<VoiceToolResult>>();

  constructor(@Inject(VOICE_REDIS) private readonly redis: Redis) {}

  /** How many results are currently replayable. Diagnostics only. */
  async completedSize(): Promise<number> {
    const keys = await this.redis.keys(`${RESULT_PREFIX}*`);
    // The lease keys share the prefix, so exclude them.
    return keys.filter((k) => !k.startsWith(LEASE_PREFIX)).length;
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
   * The tool input is in the key too, as a hash. A single assistant turn can
   * carry several `tool_use` blocks of the same tool — "book me Tuesday and
   * Thursday" is one turn with two `book_appointment` calls. Keyed on
   * nonce:turn:tool alone those two share a key, the second joins the first's
   * cache entry, and the agent narrates two appointments where one exists.
   * Hashing the input separates them while leaving the property this class is
   * for intact: a genuine retry replays byte-identical input, so it hashes to
   * the same value and still de-duplicates.
   *
   * Each component is still percent-encoded before joining, so ':' (and '%'
   * itself) cannot occur inside a component and the mapping from tuple to key
   * stays injective. That is now a backstop several times over: the nonce is
   * generated server-side from a CSPRNG and the digest is hex.
   */
  keyFor(
    session: VoiceSession,
    toolName: string,
    input: Record<string, unknown>
  ): string {
    // Key order is the order the model emitted, preserved through JSON.parse,
    // so a replayed request reproduces the same string. The hash is a namespace
    // separator, not a security boundary — a collision would merge two writes,
    // which is what SHA-256 makes unreachable.
    const inputHash = createHash('sha256')
      .update(JSON.stringify(input ?? {}))
      .digest('hex');

    return [
      String(session.idempotencyNonce),
      String(session.turnIndex),
      String(toolName),
      inputHash,
    ]
      .map((part) => encodeURIComponent(part))
      .join(':');
  }

  /**
   * Runs an operation once for a key, however many callers ask.
   *
   * Two things are true across every instance, not just this one:
   *
   *   - a confirmed result is replayed rather than re-executed, so a retry
   *     that spans a rotation or a reconnect does not book twice;
   *   - exactly one caller executes at a time. The winner takes a short lease;
   *     the losers wait for the result rather than running their own copy.
   *
   * A failure is never cached. Caching one would stop a legitimate retry from
   * ever succeeding, and the lease is released even when the operation throws
   * so the key does not become permanently unusable.
   */
  async runOnce(
    key: string,
    operation: () => Promise<VoiceToolResult>
  ): Promise<VoiceToolResult> {
    const resultKey = `${RESULT_PREFIX}${key}`;
    const leaseKey = `${LEASE_PREFIX}${key}`;
    const outcomeKey = `${OUTCOME_PREFIX}${key}`;

    const cached = await this.readResult(resultKey);
    if (cached) {
      return cached;
    }

    // A caller who arrives while this process is already running this key joins
    // that execution rather than starting a second one. They receive whatever
    // it produces, including a rejection.
    const running = this.inFlight.get(key);
    if (running) {
      return running;
    }

    const execution = this.executeOnce(key, resultKey, leaseKey, outcomeKey, operation);
    this.inFlight.set(key, execution);

    try {
      return await execution;
    } finally {
      // Removed on both paths. An entry left behind would turn coalescing into
      // a cache, and a failure left behind would block every later retry.
      this.inFlight.delete(key);
    }
  }

  /**
   * One execution, coordinated across instances by a Redis lease.
   *
   * The lease is what stops two processes running the same booking at once.
   * Within a process that never happens anyway — the in-flight map above
   * already coalesced them.
   */
  private async executeOnce(
    key: string,
    resultKey: string,
    leaseKey: string,
    outcomeKey: string,
    operation: () => Promise<VoiceToolResult>
  ): Promise<VoiceToolResult> {
    const deadline = Date.now() + LEASE_WAIT_MS;

    for (;;) {
      const won = await this.redis.set(leaseKey, '1', 'EX', LEASE_TTL_SECONDS, 'NX');

      if (won) {
        try {
          const result = await operation();
          const encoded = JSON.stringify(result);

          // Published for a caller on another instance already waiting on this
          // key, whatever the outcome — they must not run a second copy.
          await this.redis.set(outcomeKey, encoded, 'EX', OUTCOME_TTL_SECONDS);

          // Only a success is replayed to callers arriving later. Caching a
          // failure would stop a legitimate retry from ever succeeding.
          if (result.status === 'confirmed') {
            await this.redis.set(resultKey, encoded, 'EX', IDEMPOTENCY_TTL_MS / 1000);
          }

          return result;
        } finally {
          // Released even on a throw, so a retry is not blocked behind a lease
          // whose holder has already given up. Nothing about the failure is
          // written to Redis: a provider's own words do not belong in shared
          // state any more than they belong in a client response.
          await this.redis.del(leaseKey);
        }
      }

      // Another instance holds the lease. Wait for its result rather than
      // running a second copy of the same booking.
      await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));

      const settled = (await this.readResult(resultKey)) ?? (await this.readResult(outcomeKey));
      if (settled) {
        return settled;
      }

      if (Date.now() > deadline) {
        // The holder failed or died without producing a result. A failure is
        // not cached, so running it now is the correct retry.
        return operation();
      }
    }
  }

  private async readResult(resultKey: string): Promise<VoiceToolResult | undefined> {
    const raw = await this.redis.get(resultKey);
    return raw ? (JSON.parse(raw) as VoiceToolResult) : undefined;
  }
}
