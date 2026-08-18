import type Anthropic from '@anthropic-ai/sdk';
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Optional,
  Post,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ClaudeAgentService } from './agent/claude.agent';
import { createAnonymousSession, VoiceSession } from './session/voice-session';

import { VoiceTextDto } from './dto/voice-text.dto';
import { VOICE_CONFIG, VOICE_FEATURE_FLAG, VoiceFeatureFlag } from './voice.config';
import { BoundedTtlMap, Clock, VOICE_CLOCK } from './util/bounded-ttl-map';

/** A quiet conversation is dropped well before a real caller would return. */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/** Hard ceiling on concurrently tracked conversations. */
export const MAX_ACTIVE_SESSIONS = 1000;

/**
 * How many complete user turns of transcript are resent to the model.
 *
 * Every turn resends the whole history, so cost is quadratic in turn count and
 * an unbounded transcript eventually exceeds the context window — a 400 that
 * ends the conversation permanently, since the stored history that caused it is
 * resent on every retry. BoundedTtlMap caps how MANY conversations are held,
 * not how large any one of them gets.
 *
 * Twelve turns is chosen against the job: an intake-then-book conversation runs
 * roughly eight to ten turns, so a caller can complete one and still refer back
 * to a name or a date they gave at the start. Beyond that the early turns are
 * small talk the model does not need. Each retained turn also drags its tool
 * traffic along, so twelve turns is a good deal more than twelve messages.
 */
export const MAX_HISTORY_TURNS = 12;

/** True when a user message is a batch of tool_results rather than speech. */
function isToolResultMessage(message: Anthropic.MessageParam): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === 'tool_result')
  );
}

/**
 * Keeps the last `maxTurns` user turns and everything that followed each.
 *
 * Cutting at an arbitrary index is not safe: an assistant `tool_use` block whose
 * matching `tool_result` was trimmed away — or a `tool_result` whose `tool_use`
 * was — is a 400 from the API, not a degraded reply. So the only cut points
 * considered are the messages that START a user turn: role 'user' carrying
 * speech rather than tool_results. Slicing at one of those keeps every tool_use
 * paired with its tool_result, because a turn's tool traffic sits entirely
 * between two such messages.
 */
export function trimHistory(
  history: Anthropic.MessageParam[],
  maxTurns: number = MAX_HISTORY_TURNS
): Anthropic.MessageParam[] {
  const turnStarts: number[] = [];
  history.forEach((message, index) => {
    if (message.role === 'user' && !isToolResultMessage(message)) {
      turnStarts.push(index);
    }
  });

  if (turnStarts.length <= maxTurns) {
    return history;
  }

  return history.slice(turnStarts[turnStarts.length - maxTurns]);
}

interface Conversation {
  session: VoiceSession;
  history: Anthropic.MessageParam[];
}

@ApiTags('voice')
@Controller('voice')
export class VoiceController {
  /**
   * Phase 0 keeps sessions in memory. Browser and phone phases move this to
   * Redis.
   *
   * Bounded because the key is a client-supplied sessionId: an unevicted Map
   * here lets a caller who varies the sessionId grow the process without limit.
   */
  private readonly sessions: BoundedTtlMap<Conversation>;

  constructor(
    private agent: ClaudeAgentService,
    @Optional()
    @Inject(VOICE_FEATURE_FLAG)
    private readonly flag: VoiceFeatureFlag = VOICE_CONFIG,
    @Optional() @Inject(VOICE_CLOCK) clock?: Clock
  ) {
    this.sessions = new BoundedTtlMap<Conversation>(
      MAX_ACTIVE_SESSIONS,
      SESSION_TTL_MS,
      clock ?? (() => Date.now())
    );
  }

  /**
   * Tighter than the global 100/min/IP, because a request here is not cheap:
   * one turn can drive up to MAX_TOOL_ITERATIONS calls to a frontier model, so
   * the global limit permits several hundred paid model calls a minute from a
   * single anonymous IP. Ten turns a minute is more than a person speaking to a
   * receptionist will ever need and takes the worst case down with it.
   */
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('text')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a text turn to the voice agent (Phase 0, no audio)' })
  @ApiResponse({ status: 200, description: 'The agent reply for this turn' })
  @ApiResponse({ status: 400, description: 'Invalid or unrecognised request body' })
  @ApiResponse({ status: 404, description: 'The voice agent is not enabled' })
  async text(@Body() dto: VoiceTextDto): Promise<{
    sessionId: string;
    reply: string;
    toolCalls: string[];
    verified: boolean;
    turnIndex: number;
  }> {
    // The feature flag is enforced here rather than by omitting the route, so
    // a disabled deployment returns a clean 404 instead of a routing surprise.
    if (!this.flag.enabled) {
      throw new NotFoundException('Voice agent is not enabled');
    }

    /**
     * A conversation is resumed only when the supplied id matches one this
     * server issued and still holds. A sessionId is an unauthenticated bearer of
     * conversation state: adopting an id the server never issued would let
     * anyone join a stranger's conversation by guessing, replaying their
     * history — the name, phone number and date of birth intake collected —
     * back into the model, and inheriting their patientId.
     *
     * So an unrecognised id is not adopted, and it is not an error either: it
     * quietly starts a fresh conversation. Rejecting it would turn this endpoint
     * into an oracle that answers "does this session exist?" one guess at a
     * time, which is the same enumeration attack with extra steps.
     *
     * Ids are 256 CSPRNG bits, so guessing a live one is not a practical
     * attack rather than merely an inconvenient one.
     */
    const resumed = dto.sessionId ? this.sessions.get(dto.sessionId) : undefined;
    const conversation: Conversation = resumed ?? {
      session: createAnonymousSession(),
      history: [],
    };

    /**
     * Nothing below reads a field of `dto` other than `sessionId` and
     * `message`. `userId`, `patientId`, `identityVerified`, `turnIndex` and the
     * idempotency nonce all originate server-side — from createAnonymousSession
     * or from the stored session — so no request body can set or override them.
     */
    const turn = await this.agent.respond(
      conversation.session,
      dto.message,
      trimHistory(conversation.history)
    );
    conversation.history = turn.history;

    // Keyed by the server's own id, never the client's. Re-set on every turn:
    // refreshes the TTL and marks the conversation as recently used, so an
    // active caller is not evicted ahead of a quiet one.
    this.sessions.set(conversation.session.sessionId, conversation);

    return {
      // Always returned, so the caller knows which id is authoritative — on
      // first contact, and after an unrecognised id started a new conversation.
      sessionId: conversation.session.sessionId,
      reply: turn.reply,
      toolCalls: turn.toolCalls,
      verified: conversation.session.identityVerified,
      turnIndex: conversation.session.turnIndex,
    };
  }
}
