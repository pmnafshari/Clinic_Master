/** Injected so eviction can be tested deterministically, without fake timers. */
export type Clock = () => number;

/** DI token for overriding the clock. Nothing provides it in production. */
export const VOICE_CLOCK = Symbol('VOICE_CLOCK');

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * A Map with a finite lifetime and a finite size.
 *
 * Everything the voice module caches in memory is keyed, directly or
 * indirectly, by a client-supplied sessionId. An unevicted Map behind such a key
 * is a remote memory-exhaustion vector: a caller who varies the sessionId grows
 * it without bound.
 *
 * Eviction is lazy — expired entries are dropped when they are read, and a bulk
 * sweep runs on write. There is deliberately no interval: a bare `setInterval`
 * keeps the Node process and Jest workers alive, and an `unref`'d one still
 * costs a timer per instance for a job that a write already has to do.
 *
 * The TTL is a constant, and the clock never goes backwards, so insertion order
 * is also expiry order — which is what lets the sweep stop at the first live
 * entry instead of scanning the whole map, and what makes "evict the oldest"
 * a single `keys().next()`.
 */
export class BoundedTtlMap<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: Clock = () => Date.now()
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);

    if (!entry) {
      return undefined;
    }

    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key: string, value: V): void {
    // Delete first so a re-write moves the key to the tail: a session that is
    // still being used is not evicted ahead of one that has gone quiet.
    this.entries.delete(key);
    this.sweepExpired();

    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }

    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  /**
   * Removes a key outright. Rotation needs this: an old sessionId must stop
   * working the moment a new one is issued, not when its TTL happens to run
   * out — an expiring credential is still a live credential.
   */
  delete(key: string): void {
    this.entries.delete(key);
  }

  private sweepExpired(): void {
    const now = this.now();

    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) {
        break;
      }
      this.entries.delete(key);
    }
  }
}
