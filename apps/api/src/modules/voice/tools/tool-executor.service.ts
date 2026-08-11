import { Injectable, Logger } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';
import { VoiceToolResult } from './tool-definition.interface';
import { VoiceSession } from '../session/voice-session';

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(private registry: ToolRegistryService) {}

  /**
   * The single choke point for every tool call. Authorization happens here,
   * server-side — never in the system prompt, which a model can be talked out of.
   *
   * Failures are returned rather than thrown: the model needs to hear that the
   * call did not succeed so it can say so, instead of the turn dying.
   */
  async execute(
    toolName: string,
    input: Record<string, unknown>,
    session: VoiceSession
  ): Promise<VoiceToolResult> {
    const tool = this.registry.get(toolName);

    if (!tool) {
      return { status: 'failed', error: 'unknown_tool' };
    }

    if (tool.tier === 'verified' && !session.identityVerified) {
      this.logger.warn(
        `Blocked ${toolName} for unverified session ${session.sessionId}`
      );
      return { status: 'failed', error: 'verification_required' };
    }

    try {
      return await tool.execute(input, session);
    } catch (error) {
      this.logger.error(
        `Tool ${toolName} failed for session ${session.sessionId}`,
        error instanceof Error ? error.stack : String(error)
      );
      return { status: 'failed', error: 'tool_error' };
    }
  }
}
