import { Injectable, Logger } from '@nestjs/common';
import { ClaudeAgentService } from '../agent/claude.agent';
import { privilegeChanged, snapshotPrivilege } from '../session/privilege-change';
import { Conversation, VoiceSessionStore } from '../session/voice-session.store';
import { trimHistory } from '../voice.controller';
import { AudioTransport } from './audio-transport.interface';

/** What one turn produced, for the gateway to deliver. */
export interface TurnOutcome {
  sessionId: string;
  reply: string;
}

/**
 * The only place a transport dispatches a turn to the agent.
 *
 * Speech turns are routed through this same method rather than adding a second
 * path — two dispatch sites would mean rotation, history trimming and audit
 * correlation each have two places to go wrong.
 */
@Injectable()
export class VoiceTurnRunner {
  private readonly logger = new Logger(VoiceTurnRunner.name);

  constructor(
    private readonly agent: ClaudeAgentService,
    private readonly sessions: VoiceSessionStore
  ) {}

  async runTurn(
    transport: AudioTransport,
    conversation: Conversation,
    text: string
  ): Promise<TurnOutcome> {
    transport.send({ type: 'agent.thinking' });

    const before = snapshotPrivilege(conversation.session);

    const turn = await this.agent.respond(
      conversation.session,
      text,
      trimHistory(conversation.history)
    );
    conversation.history = turn.history;

    const previousId = conversation.session.sessionId;
    this.sessions.set(previousId, conversation);

    let sessionId = previousId;
    if (privilegeChanged(before, conversation.session)) {
      const rotated = this.sessions.rotate(previousId);
      if (rotated) {
        sessionId = rotated;
        // logId, never sessionId: the id is a bearer credential and this line
        // would otherwise put a live one in the log stream.
        this.logger.log(`Rotated session credential for ${conversation.session.logId}`);
      }
    }

    return { sessionId, reply: turn.reply };
  }
}
