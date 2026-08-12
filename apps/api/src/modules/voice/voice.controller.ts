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
     * The session is created from the sessionId and nothing else. `userId`,
     * `patientId`, `identityVerified` and `turnIndex` come from
     * createAnonymousSession or from the server's own stored session — there is
     * no path by which a request body can set or override any of them, and no
     * field of `dto` other than `sessionId` and `message` is ever read.
     */
    const conversation: Conversation = this.sessions.get(dto.sessionId) ?? {
      session: createAnonymousSession(dto.sessionId),
      history: [],
    };

    const turn = await this.agent.respond(
      conversation.session,
      dto.message,
      conversation.history
    );
    conversation.history = turn.history;

    // Re-set on every turn: refreshes the TTL and marks the conversation as
    // recently used, so an active caller is not evicted ahead of a quiet one.
    this.sessions.set(dto.sessionId, conversation);

    return {
      reply: turn.reply,
      toolCalls: turn.toolCalls,
      verified: conversation.session.identityVerified,
      turnIndex: conversation.session.turnIndex,
    };
  }
}
