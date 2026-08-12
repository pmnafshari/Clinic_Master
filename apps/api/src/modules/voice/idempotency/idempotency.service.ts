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

  keyFor(session: VoiceSession, toolName: string): string {
    return `${session.sessionId}:${session.turnIndex}:${toolName}`;
  }

  async runOnce(
    key: string,
    operation: () => Promise<VoiceToolResult>
  ): Promise<VoiceToolResult> {
    const previous = this.completed.get(key);
    if (previous) {
      return previous;
    }

    const result = await operation();

    // Only successful writes are replayed. Caching a failure would prevent a
    // legitimate retry from ever succeeding.
    if (result.status === 'confirmed') {
      this.completed.set(key, result);
    }

    return result;
  }
}
