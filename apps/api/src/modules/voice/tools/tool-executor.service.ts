import { Injectable, Logger } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';
import { VoiceToolResult } from './tool-definition.interface';
import { VoiceSession } from '../session/voice-session';
import { isVerificationActive } from '../session/verification';
import { AuditService } from '../../audit/audit.service';

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    private registry: ToolRegistryService,
    private audit: AuditService
  ) {}

  /**
   * The single choke point for every tool call. Authorization happens here,
   * server-side — never in the system prompt, which a model can be talked out of.
   *
   * Failures are returned rather than thrown: the model needs to hear that the
   * call did not succeed so it can say so, instead of the turn dying.
   *
   * Every call is audited on the way out, including the ones this method
   * refused — see `record`.
   */
  async execute(
    toolName: string,
    input: Record<string, unknown>,
    session: VoiceSession
  ): Promise<VoiceToolResult> {
    const result = await this.dispatch(toolName, input, session);
    await this.record(toolName, session, result);
    return result;
  }

  private async dispatch(
    toolName: string,
    input: Record<string, unknown>,
    session: VoiceSession
  ): Promise<VoiceToolResult> {
    const tool = this.registry.get(toolName);

    if (!tool) {
      return { status: 'failed', error: 'unknown_tool' };
    }

    if (tool.tier === 'verified' && !isVerificationActive(session)) {
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

  /**
   * Writes the audit row for one tool call.
   *
   * Blocked and failed calls are audited exactly like successful ones — a
   * refused attempt is precisely what an investigation into a disputed booking
   * needs to see, so the early-return paths above run through here too.
   *
   * Three properties this method has to hold:
   *
   * - It runs after `dispatch` has fully settled, so it is outside whatever
   *   transaction a write tool opened. An audit failure cannot roll a booking
   *   back, and a booking's transaction cannot roll the audit row back.
   * - A failure here is logged and swallowed. Auditing is an observer, never a
   *   participant: a business operation that succeeded must not be reported to
   *   the caller as failed because the audit insert fell over afterwards.
   * - Only the outcome is recorded. Never the raw tool input and never the
   *   result payload — a model can be talked into putting anything at all
   *   (an API key, a date of birth, a phone number) into a tool argument, and
   *   results carry patient data by design. Never `sessionId` or
   *   `idempotencyNonce` either: those are bearer credentials, and
   *   `sessionLogId` correlates the conversation without being one.
   */
  private async record(
    toolName: string,
    session: VoiceSession,
    result: VoiceToolResult
  ): Promise<void> {
    try {
      await this.audit.log({
        userId: session.userId,
        sessionLogId: session.logId,
        entityType: 'VoiceToolCall',
        entityId: session.patientId ?? 'unknown',
        action: toolName,
        newValues: {
          status: result.status,
          error: typeof result.error === 'string' ? result.error : null,
          turnIndex: session.turnIndex,
          /**
           * Raw and effective, plus the deadline that separates them.
           *
           * The raw flag alone would let the record contradict the decision it
           * describes: an expired phone session is refused by the gate above
           * while `identityVerified` is still true, and an audit trail saying
           * "verified" next to "verification_required" is worse than useless
           * to whoever reads it later.
           */
          identityVerified: session.identityVerified,
          verificationActive: isVerificationActive(session),
          verifiedUntil: session.verifiedUntil ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        `Could not audit ${toolName} for session ${session.logId}`,
        error instanceof Error ? error.stack : String(error)
      );
    }
  }
}
