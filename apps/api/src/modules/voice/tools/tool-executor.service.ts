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
      // logId, never sessionId: the sessionId is a bearer credential, and a
      // log reader must not be able to resume the conversation it names.
      this.logger.warn(`Blocked ${toolName} for unverified session ${session.logId}`);
      return { status: 'failed', error: 'verification_required' };
    }

    /**
     * Patient identity is a capability a tool must ask for. The tier decision
     * above used the real session; only what the tool *receives* is narrowed.
     *
     * A tool that declares the capability gets the real session object, not a
     * copy — intake writes `session.patientId` back so the next tool call in
     * the turn can use it, and a clone would swallow that write. Everything
     * else gets a projection that keeps `idempotencyNonce`, `turnIndex` and
     * `logId` (write tools derive their idempotency key from the first two, and
     * log against the third) but carries no identity. There is no fallback that
     * recovers identity: a tool that forgot the flag sees null and fails,
     * rather than acting on the wrong patient.
     */
    const sessionForTool: VoiceSession = tool.needsPatientContext
      ? session
      : { ...session, userId: null, patientId: null };

    try {
      return await tool.execute(input, sessionForTool);
    } catch (error) {
      this.logger.error(
        `Tool ${toolName} failed for session ${session.logId}`,
        error instanceof Error ? error.stack : String(error)
      );
      return { status: 'failed', error: 'tool_error' };
    }
  }
}
