import type Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { VOICE_REDIS } from './redis.provider';
import { newOpaqueId, VoiceSession } from './voice-session';

/** A quiet conversation is dropped well before a real caller would return. */
export const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

/**
 * Kept for the startup warning and for callers that still reference it. Redis
 * bounds the namespace by TTL rather than by count, so nothing enforces this
 * as a hard ceiling any more.
 */
export const MAX_ACTIVE_SESSIONS = 1000;

const KEY_PREFIX = 'voice:session:';
const key = (sessionId: string): string => `${KEY_PREFIX}${sessionId}`;

export interface Conversation {
  session: VoiceSession;
  history: Anthropic.MessageParam[];
}

/**
 * The single home for conversation state, shared by every API instance.
 *
 * Every method is asynchronous because Redis is. The interface was synchronous
 * while the backing store was an in-process map; there is no synchronous Redis
 * client, and a memory cache in front of one would let a caller's second turn
 * land on an instance that has never heard of them — the exact failure this
 * store exists to remove. See the design doc, section 2.9.
 */
@Injectable()
export class VoiceSessionStore {
  constructor(@Inject(VOICE_REDIS) private readonly redis: Redis) {}

  async get(sessionId: string): Promise<Conversation | undefined> {
    const raw = await this.redis.get(key(sessionId));
    if (!raw) {
      return undefined;
    }
    const conversation = JSON.parse(raw) as Conversation;

    /**
     * Records written before `verifiedUntil` existed parse with the key
     * absent. Normalizing here means authorization sees one shape whatever
     * wrote the record.
     *
     * `null` is the correct value rather than merely a safe one: before this
     * field existed, the browser constructor was the only thing that could set
     * the flag, so every such record is a browser session and has no deadline.
     * An in-flight caller is not logged out by the deploy.
     */
    conversation.session.verifiedUntil = conversation.session.verifiedUntil ?? null;

    return conversation;
  }

  /**
   * Writes the conversation and refreshes its lifetime.
   *
   * Called on every turn, so an active caller is not dropped mid-booking while
   * a quiet one ages out.
   */
  async set(sessionId: string, conversation: Conversation): Promise<void> {
    await this.redis.set(key(sessionId), JSON.stringify(conversation), 'EX', SESSION_TTL_SECONDS);
  }

  async delete(sessionId: string): Promise<void> {
    await this.redis.del(key(sessionId));
  }

  /**
   * Moves a conversation to a new key.
   *
   * `RENAME` and nothing else: it is atomic, it moves the value, it removes the
   * source key by definition, and it carries the remaining TTL across. A
   * `SET` + `DEL` pair would restart the clock and open a window where the
   * conversation is reachable under both ids or neither.
   */
  async rekey(oldId: string, newId: string): Promise<boolean> {
    try {
      await this.redis.rename(key(oldId), key(newId));
      return true;
    } catch {
      // RENAME on a missing key is an error, not a silent no-op.
      return false;
    }
  }

  /**
   * Issues a fresh credential for an existing conversation and invalidates the
   * old one immediately.
   *
   * Only `sessionId` changes. `idempotencyNonce`, `turnIndex` and `logId` are
   * carried across deliberately: idempotency keys are derived from the nonce
   * and the turn index, so regenerating either would open a fresh replay
   * namespace and let a retry that spans a rotation execute a write twice.
   */
  async rotate(oldId: string): Promise<string | undefined> {
    const conversation = await this.get(oldId);
    if (!conversation) {
      return undefined;
    }

    const newId = newOpaqueId();
    conversation.session.sessionId = newId;

    const moved = await this.rekey(oldId, newId);
    if (!moved) {
      return undefined;
    }

    // The record now lives under the new key but still names the old id inside.
    // Rewrite it in place, preserving whatever lifetime RENAME carried over.
    const remaining = await this.redis.ttl(key(newId));
    if (remaining > 0) {
      await this.redis.set(key(newId), JSON.stringify(conversation), 'EX', remaining);
    } else {
      await this.redis.set(key(newId), JSON.stringify(conversation), 'EX', SESSION_TTL_SECONDS);
    }

    return newId;
  }

  /** How many conversations are currently held. Diagnostics only. */
  async count(): Promise<number> {
    const keys = await this.redis.keys(`${KEY_PREFIX}*`);
    return keys.length;
  }
}
