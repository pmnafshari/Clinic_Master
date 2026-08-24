import type Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { BoundedTtlMap, Clock, VOICE_CLOCK } from '../util/bounded-ttl-map';
import { newOpaqueId, VoiceSession } from './voice-session';

/** A quiet conversation is dropped well before a real caller would return. */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/** Hard ceiling on concurrently tracked conversations. */
export const MAX_ACTIVE_SESSIONS = 1000;

export interface Conversation {
  session: VoiceSession;
  history: Anthropic.MessageParam[];
}

/**
 * The single home for conversation state.
 *
 * This used to be a private field on VoiceController. It moved out because
 * Phase 1 adds a second transport: a WebSocket gateway cannot reach a
 * controller's private map, and two stores would mean a caller's second turn
 * could land in a map that has never heard of their session.
 *
 * Keeping it behind one class is also what makes the Redis swap a one-file
 * change if the process ever needs to scale horizontally.
 */
@Injectable()
export class VoiceSessionStore {
  private readonly conversations: BoundedTtlMap<Conversation>;

  constructor(@Optional() @Inject(VOICE_CLOCK) clock?: Clock) {
    this.conversations = new BoundedTtlMap<Conversation>(
      MAX_ACTIVE_SESSIONS,
      SESSION_TTL_MS,
      clock ?? (() => Date.now())
    );
  }

  get size(): number {
    return this.conversations.size;
  }

  get(sessionId: string): Conversation | undefined {
    return this.conversations.get(sessionId);
  }

  set(sessionId: string, conversation: Conversation): void {
    this.conversations.set(sessionId, conversation);
  }

  delete(sessionId: string): void {
    this.conversations.delete(sessionId);
  }

  /**
   * Moves a conversation to a new key. The write lands before the delete, so
   * there is no instant where the conversation is reachable under neither id.
   * Node runs this synchronously, which is what makes it atomic here.
   */
  rekey(oldId: string, newId: string): boolean {
    const conversation = this.conversations.get(oldId);
    if (!conversation) {
      return false;
    }

    this.conversations.set(newId, conversation);
    this.conversations.delete(oldId);
    return true;
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
  rotate(oldId: string): string | undefined {
    const conversation = this.conversations.get(oldId);
    if (!conversation) {
      return undefined;
    }

    const newId = newOpaqueId();
    conversation.session.sessionId = newId;
    this.rekey(oldId, newId);
    return newId;
  }
}
