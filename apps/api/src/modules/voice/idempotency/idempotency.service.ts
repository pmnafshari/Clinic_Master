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

/**
 * Where a turn records that it has already committed a write.
 *
 * Distinct from the result cache above, which is keyed on the tool input and so
 * only ever recognises a byte-identical retry. This one is keyed on the turn,
 * because the turn — not the argument list — is the unit of caller consent.
 */
const COMMIT_PREFIX = 'voice:idem:committed:';

/**
 * Held only while the write is running. A process that dies mid-write frees the
 * turn this quickly rather than wedging it for the full result TTL; a write
 * that succeeds replaces this with the settled record below.
 */
const COMMIT_RESERVATION_TTL_SECONDS = 30;

/** Compare-and-delete: release the reservation only if it is still ours. */
const RELEASE_IF_MINE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

/** Compare-and-set: promote our reservation to the settled record. */
const SETTLE_IF_MINE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3])
end
return 0`;

/**
 * What a tool must supply to have its turn closed by a successful write.
 *
 * `nextStep` is the tool's own words: the agent is told to treat a failure
 * carrying one as out-of-order rather than impossible, so the refusal has to
 * say what would make sense to do instead.
 */
export interface TurnCommit {
  scope: string;
  nextStep: string;
}

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
   * The tool input is in the key too, as a hash, and this is where this key
   * stops. It answers one question only: is this the same call again? A genuine
   * retry replays byte-identical input, hashes to the same value, and replays
   * its result rather than writing twice.
   *
   * It deliberately does NOT decide whether a *different* call is allowed. A
   * single assistant turn can carry several `tool_use` blocks of the same tool,
   * and one of them booking Tuesday while another books Thursday is two keys
   * here, correctly — collapsing them would hand the second caller the first
   * appointment's id under a 'confirmed' status, and the agent would narrate
   * two appointments where one exists.
   *
   * Whether that second write may happen at all is a separate question with a
   * separate answer, one turn wide rather than one argument list wide: see
   * `scopeFor`. Keeping the two apart is what lets a second booking be refused
   * honestly instead of being disguised as the first one succeeding.
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
   * The span within which a tool may commit at most one write: this session,
   * this turn, this tool.
   *
   * Deliberately free of the tool input, which is exactly what `keyFor` adds.
   * A model that is unsure between two offered times can emit two `tool_use`
   * blocks in one assistant turn; hashed on their input those are two keys and
   * both write. They are one turn, and the caller said yes once, so they are
   * one write. The tool name stays in the scope so registering a patient does
   * not also close the turn for the booking that follows it.
   */
  scopeFor(session: VoiceSession, toolName: string): string {
    return [
      String(session.idempotencyNonce),
      String(session.turnIndex),
      String(toolName),
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
    operation: () => Promise<VoiceToolResult>,
    commit?: TurnCommit
  ): Promise<VoiceToolResult> {
    const resultKey = `${RESULT_PREFIX}${key}`;
    const leaseKey = `${LEASE_PREFIX}${key}`;
    const outcomeKey = `${OUTCOME_PREFIX}${key}`;

    // A byte-identical retry is a resend, not a second write, and must replay
    // its own confirmed result rather than be refused as though the caller had
    // asked for something new. Reading the cache first is the cheap way there;
    // it is not the only thing holding that property, since a retry that gets
    // past here still matches its own reservation in `claimTurn` below and is
    // let through. Both paths are kept: the ordering saves a round trip on
    // every replay, the key check is what covers the concurrent case where
    // there is no cached result to find yet.
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

    if (commit) {
      const refused = await this.claimTurn(commit, key);
      if (refused) {
        return refused;
      }
    }

    const execution = this.executeOnce(key, resultKey, leaseKey, outcomeKey, operation);
    this.inFlight.set(key, execution);

    try {
      const result = await execution;
      if (commit) {
        // A failure must leave the turn open: the slot was taken and the agent
        // is expected to offer another, in this same turn.
        await (result.status === 'confirmed'
          ? this.settleTurn(commit, key, result)
          : this.releaseTurn(commit, key));
      }
      return result;
    } catch (error) {
      // Released on the throw path too, or a write that blew up would hold the
      // turn shut until the reservation expired.
      if (commit) {
        await this.releaseTurn(commit, key);
      }
      throw error;
    } finally {
      // Removed on both paths. An entry left behind would turn coalescing into
      // a cache, and a failure left behind would block every later retry.
      this.inFlight.delete(key);
    }
  }

  /**
   * Takes the turn for this write, or refuses because another already has it.
   *
   * The reservation carries the key that made it, so a caller on another
   * instance running the *same* key — a retry that crossed instances — is let
   * through to the lease machinery below rather than refused. Only a genuinely
   * different write is turned away.
   */
  private async claimTurn(
    commit: TurnCommit,
    key: string
  ): Promise<VoiceToolResult | undefined> {
    const commitKey = `${COMMIT_PREFIX}${commit.scope}`;
    const reservation = JSON.stringify({ key, result: null });

    const won = await this.redis.set(
      commitKey,
      reservation,
      'EX',
      COMMIT_RESERVATION_TTL_SECONDS,
      'NX'
    );
    if (won) {
      return undefined;
    }

    const raw = await this.redis.get(commitKey);
    if (!raw) {
      // Expired between the SET and the GET. Nothing holds the turn.
      return undefined;
    }

    const held = JSON.parse(raw) as { key: string; result: VoiceToolResult | null };
    if (held.key === key) {
      return undefined;
    }

    return this.refuseTurn(held.result, commit.nextStep);
  }

  /** Promotes our reservation to the settled record, for the rest of the turn. */
  private async settleTurn(
    commit: TurnCommit,
    key: string,
    result: VoiceToolResult
  ): Promise<void> {
    await this.redis.eval(
      SETTLE_IF_MINE,
      1,
      `${COMMIT_PREFIX}${commit.scope}`,
      JSON.stringify({ key, result: null }),
      JSON.stringify({ key, result }),
      String(IDEMPOTENCY_TTL_MS / 1000)
    );
  }

  /** Compare-and-delete, so a slow write cannot release a successor's claim. */
  private async releaseTurn(commit: TurnCommit, key: string): Promise<void> {
    await this.redis.eval(
      RELEASE_IF_MINE,
      1,
      `${COMMIT_PREFIX}${commit.scope}`,
      JSON.stringify({ key, result: null })
    );
  }

  /**
   * The refusal handed back to a second write in the same turn.
   *
   * It carries what was actually committed — the appointment id and time, or
   * whatever else the settled result named — because the agent has to be able
   * to tell the caller what they have. The one thing it never carries is the
   * committed `status`: this call did not succeed, and a result that says
   * "confirmed" is how a caller ends up being told about a booking that was
   * never made for them.
   */
  private refuseTurn(
    committed: VoiceToolResult | null,
    nextStep: string
  ): VoiceToolResult {
    // Everything the committed write named, minus the two fields that would
    // misreport this call: its 'confirmed' status, and a stale nextStep.
    const details = Object.fromEntries(
      Object.entries(committed ?? {}).filter(
        ([field]) => field !== 'status' && field !== 'nextStep'
      )
    );

    return {
      ...details,
      status: 'failed',
      error: 'already_committed_this_turn',
      nextStep,
    };
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
