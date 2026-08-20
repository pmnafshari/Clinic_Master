import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { ToolRegistryService } from '../tools/tool-registry.service';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { VoiceSession } from '../session/voice-session';
import { VOICE_CONFIG } from '../voice.config';
import { SYSTEM_PROMPT } from './system-prompt';

/**
 * The slice of the Anthropic client this service uses. Narrow on purpose: a
 * test can supply a stand-in without a network, an API key, or a mocking
 * framework, and nothing in the loop can quietly reach for another endpoint.
 */
export interface AnthropicLike {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming
    ): Promise<Anthropic.Message>;
  };
}

/** Optional DI token. Nothing provides it in production. */
export const ANTHROPIC_CLIENT = Symbol('ANTHROPIC_CLIENT');

export interface AgentTurn {
  reply: string;
  toolCalls: string[];
  history: Anthropic.MessageParam[];
}

/** Bound on tool round-trips within a single turn. */
export const MAX_TOOL_ITERATIONS = 6;

/**
 * The one thing said when a turn cannot be completed truthfully: the iteration
 * cap, a truncated response, and an SDK failure all end here. Shared so no path
 * can drift into inventing a more reassuring sentence, and so nothing about the
 * internal failure — provider, status code, token counts — reaches the caller.
 */
export const FRONT_DESK_FALLBACK_REPLY =
  'I am having trouble with that. Let me put you through to the front desk.';

@Injectable()
export class ClaudeAgentService {
  private readonly logger = new Logger(ClaudeAgentService.name);
  private client: AnthropicLike | null;

  constructor(
    private registry: ToolRegistryService,
    private executor: ToolExecutorService,
    @Optional() @Inject(ANTHROPIC_CLIENT) client?: AnthropicLike
  ) {
    this.client = client ?? null;
  }

  /**
   * Constructed on first use rather than in the constructor: the SDK throws
   * when no API key is present, and the service is instantiated in contexts —
   * tests, a deployment with the flag off — that never make a call.
   */
  private getClient(): AnthropicLike {
    if (!this.client) {
      this.client = new Anthropic();
    }
    return this.client;
  }

  /** Tool schemas are derived from the registry so the two cannot drift. */
  buildToolSchemas(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    strict: boolean;
  }> {
    return this.registry.all().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      strict: true,
    }));
  }

  /**
   * `turnIndex` is owned by the server. It is incremented here, from the
   * session the server holds — never read from, or written by, anything the
   * client or the model sends.
   */
  async respond(
    session: VoiceSession,
    userText: string,
    history: Anthropic.MessageParam[]
  ): Promise<AgentTurn> {
    session.turnIndex += 1;
    return this.callModel(session, userText, history);
  }

  /** Separated so tests can stub the network call. */
  async callModel(
    session: VoiceSession,
    userText: string,
    history: Anthropic.MessageParam[]
  ): Promise<AgentTurn> {
    const messages: Anthropic.MessageParam[] = [
      ...history,
      { role: 'user', content: userText },
    ];
    const toolCalls: string[] = [];

    // Manual loop rather than the SDK's Tool Runner: the runner executes tool
    // functions itself, which would route around ToolExecutorService — the one
    // place tier authorization and session narrowing happen. Every tool_use
    // block below goes through executor.execute.
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      let response: Anthropic.Message;
      try {
        response = await this.getClient().messages.create({
          model: VOICE_CONFIG.model,
          max_tokens: VOICE_CONFIG.maxTokens,
          system: [
            {
              type: 'text',
              text: SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral' },
            },
          ],
          output_config: { effort: VOICE_CONFIG.effort },
          tools: this.buildToolSchemas() as Anthropic.ToolUnion[],
          messages,
        });
      } catch (error) {
        // An SDK error message carries the HTTP status and the provider's JSON
        // body — 'invalid x-api-key', a rate-limit body, 'prompt is too long:
        // N tokens'. This endpoint is anonymous, and the global exception
        // filter returns `exception.message` verbatim, so an uncaught throw
        // here would hand an unauthenticated caller the upstream provider's
        // identity and this process's internal state. The real error is logged
        // server-side; the caller gets the same sentence as any other failure.
        //
        // logId, never sessionId or idempotencyNonce: both are bearer values
        // and logs are readable by people who must not be able to resume a
        // call or address another session's idempotency namespace.
        this.logger.error(
          `Model call failed for session ${session.logId}`,
          error instanceof Error ? error.stack : String(error)
        );
        return {
          reply: FRONT_DESK_FALLBACK_REPLY,
          toolCalls,
          history: messages,
        };
      }

      // A refusal arrives on a successful HTTP 200 and can carry partial
      // content, so this is checked before `content` is read at all.
      if (response.stop_reason === 'refusal') {
        // logId, never sessionId: the sessionId is a bearer credential and
        // logs are readable by people who should not be able to resume calls.
        this.logger.warn(`Model refused a turn for session ${session.logId}`);
        return {
          reply:
            'I am sorry, I cannot help with that. Let me put you through to the clinic.',
          toolCalls,
          history: messages,
        };
      }

      /**
       * Truncation. When the budget runs out the API returns HTTP 200 with
       * `stop_reason: 'max_tokens'` and whatever it had produced so far —
       * commonly a partial or entirely absent `tool_use` block. Without this
       * branch the `toolUses.length === 0` path below reads the partial text
       * and returns it as a finished reply, so a booking turn cut off before it
       * called `book_appointment` is narrated to the caller as a completed
       * booking.
       *
       * Returning before the assistant message is appended also keeps history
       * well formed: a truncated `tool_use` retained without its `tool_result`
       * is a 400 on the next request.
       */
      if (response.stop_reason === 'max_tokens') {
        this.logger.warn(
          `Model response hit max_tokens for session ${session.logId}`
        );
        return {
          reply: FRONT_DESK_FALLBACK_REPLY,
          toolCalls,
          history: messages,
        };
      }

      messages.push({ role: 'assistant', content: response.content });

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );

      if (toolUses.length === 0) {
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join(' ')
          .trim();

        return { reply: text, toolCalls, history: messages };
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        toolCalls.push(toolUse.name);

        const result = await this.executor.execute(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
          session
        );

        results.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
          is_error: result.status === 'failed',
        });
      }

      messages.push({ role: 'user', content: results });
    }

    this.logger.warn(`Turn hit the iteration cap for session ${session.logId}`);
    return {
      reply: FRONT_DESK_FALLBACK_REPLY,
      toolCalls,
      history: messages,
    };
  }
}
