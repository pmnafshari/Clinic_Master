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
      const response = await this.getClient().messages.create({
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

      // A refusal arrives on a successful HTTP 200 and can carry partial
      // content, so this is checked before `content` is read at all.
      if (response.stop_reason === 'refusal') {
        this.logger.warn(`Model refused a turn for session ${session.sessionId}`);
        return {
          reply:
            'I am sorry, I cannot help with that. Let me put you through to the clinic.',
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

    this.logger.warn(`Turn hit the iteration cap for session ${session.sessionId}`);
    return {
      reply: 'I am having trouble with that. Let me put you through to the front desk.',
      toolCalls,
      history: messages,
    };
  }
}
