import { Injectable } from '@nestjs/common';
import { VoiceToolResult } from '../tools/tool-definition.interface';
import { VoiceSession } from '../session/voice-session';

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
  private readonly completed = new Map<string, VoiceToolResult>();

  /**
   * Work that has started but not finished. Checking `completed` and then
   * awaiting the operation is two steps, and a retry arriving in the gap
   * between them would find nothing cached and start a second write — which is
   * the timeout retry this class exists to absorb. Overlapping callers join the
   * promise already running instead.
   */
  private readonly inFlight = new Map<string, Promise<VoiceToolResult>>();

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
