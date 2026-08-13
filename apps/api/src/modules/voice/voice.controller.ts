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
import { ClaudeAgentService } from './agent/claude.agent';
import { createAnonymousSession, VoiceSession } from './session/voice-session';

import { VoiceTextDto } from './dto/voice-text.dto';
import { VOICE_CONFIG, VOICE_FEATURE_FLAG, VoiceFeatureFlag } from './voice.config';
import { BoundedTtlMap, Clock, VOICE_CLOCK } from './util/bounded-ttl-map';

/** A quiet conversation is dropped well before a real caller would return. */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/** Hard ceiling on concurrently tracked conversations. */
export const MAX_ACTIVE_SESSIONS = 1000;

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
      conversation.history
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
