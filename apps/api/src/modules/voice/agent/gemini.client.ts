import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicLike } from './claude.agent';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Gemini's wire shapes, narrowed to what this translation actually reads. */
interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  thoughtSignature?: string;
}

/**
 * A tool_use block carrying the signature Gemini issued with it.
 *
 * Gemini 3 rejects a replayed `functionCall` that arrives without its
 * `thoughtSignature`, so the value has to survive the round trip. Attaching it
 * to the block keeps it with the exact call it belongs to — the agent stores
 * response content verbatim in history and hands it straight back, so the
 * signature travels with its own call and nothing has to be tracked globally.
 */
type SignedToolUse = Anthropic.ToolUseBlock & { thoughtSignature?: string };
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  error?: { message?: string; status?: string };
}

type AnthropicContent = Anthropic.MessageParam['content'];

/**
 * Google's Gemini behind the interface the agent already speaks.
 *
 * The agent loop, ToolExecutorService, tier authorization, idempotency and
 * session handling are all untouched: this translates one request and one
 * response, and nothing above it learns which provider answered. That is the
 * point of `AnthropicLike` being a narrow seam rather than the whole SDK.
 *
 * Three shapes differ and each is mapped explicitly:
 *
 *  - **Messages.** Anthropic alternates `user`/`assistant` with content blocks;
 *    Gemini uses `contents` with roles `user`/`model` and `parts`.
 *  - **Tools.** Anthropic sends `tools: [{ name, input_schema }]` and answers
 *    with `tool_use` blocks; Gemini takes `functionDeclarations` and answers
 *    with `functionCall` parts.
 *  - **Tool results.** Anthropic sends `tool_result` blocks in a user message;
 *    Gemini expects `functionResponse` parts.
 *
 * Gemini's `functionCall` carries no call id, which Anthropic's loop needs to
 * pair a result with its call. Ids are synthesised per response and the
 * pairing is kept by name, which is sound here because the executor runs every
 * call in a response before the next request is built.
 */
export class GeminiClient implements AnthropicLike {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  readonly messages = {
    create: async (
      params: Anthropic.MessageCreateParamsNonStreaming
    ): Promise<Anthropic.Message> => {
      const body = {
        systemInstruction: this.systemInstruction(params.system),
        contents: this.contents(params.messages),
        tools: this.tools(params.tools),
        generationConfig: { maxOutputTokens: params.max_tokens },
      };

      const response = await this.fetchImpl(
        `${API_BASE}/${params.model}:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );

      const data = (await response.json()) as GeminiResponse;

      if (!response.ok) {
        // Names the status and nothing else. The provider's body carries the
        // key in some error shapes, and everything thrown here is logged.
        throw new Error(`Gemini request failed with status ${response.status}`);
      }

      return this.toAnthropicMessage(data, params.model);
    },
  };

  /** Anthropic's system blocks collapse to Gemini's single instruction. */
  private systemInstruction(system: Anthropic.MessageCreateParams['system']) {
    if (!system) return undefined;
    const text =
      typeof system === 'string'
        ? system
        : system.map((block) => ('text' in block ? block.text : '')).join('\n');
    return { parts: [{ text }] };
  }

  private tools(tools: Anthropic.MessageCreateParams['tools']) {
    if (!tools?.length) return undefined;

    const functionDeclarations = tools
      .filter((tool): tool is Anthropic.Tool => 'input_schema' in tool)
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        // Gemini rejects an empty `properties` object, and several tools here
        // deliberately take no arguments at all.
        parameters: this.parameters(tool.input_schema as Record<string, unknown>),
      }));

    return [{ functionDeclarations }];
  }

  private parameters(schema: Record<string, unknown>): Record<string, unknown> | undefined {
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (!properties || Object.keys(properties).length === 0) {
      return undefined;
    }
    // `additionalProperties` is not part of Gemini's schema dialect.
    return {
      type: 'object',
      properties,
      ...(schema.required ? { required: schema.required } : {}),
    };
  }

  private contents(messages: Anthropic.MessageParam[]) {
    return messages.map((message) => {
      const parts: GeminiPart[] | Array<Record<string, unknown>> = [];
      const content = message.content as AnthropicContent;

      if (typeof content === 'string') {
        parts.push({ text: content });
      } else {
        for (const block of content) {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'tool_use') {
            const signature = (block as SignedToolUse).thoughtSignature;
            parts.push({
              functionCall: { name: block.name, args: block.input as Record<string, unknown> },
              ...(signature ? { thoughtSignature: signature } : {}),
            });
          } else if (block.type === 'tool_result') {
            parts.push({
              functionResponse: {
                name: this.nameForCall(block.tool_use_id),
                // The executor's own JSON, handed back verbatim: the result the
                // model reasons about is the result the server produced.
                response: { result: block.content },
              },
            });
          }
        }
      }

      return { role: message.role === 'assistant' ? 'model' : 'user', parts };
    });
  }

  /** Ids are synthesised as `call_<n>_<name>`, so the name reads back out. */
  private nameForCall(toolUseId: string): string {
    const parts = toolUseId.split('_');
    return parts.slice(2).join('_') || toolUseId;
  }

  private toAnthropicMessage(data: GeminiResponse, model: string): Anthropic.Message {
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const content: Anthropic.ContentBlock[] = [];
    let calls = 0;

    for (const part of parts) {
      if (part.functionCall) {
        calls += 1;
        content.push({
          type: 'tool_use',
          id: `call_${calls}_${part.functionCall.name}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
          // Carried so the call can be replayed; see SignedToolUse.
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        } as Anthropic.ContentBlock);
      } else if (typeof part.text === 'string' && part.text.length > 0) {
        content.push({ type: 'text', text: part.text, citations: [] } as Anthropic.ContentBlock);
      }
    }

    const finish = data.candidates?.[0]?.finishReason;
    const stopReason: Anthropic.Message['stop_reason'] =
      calls > 0 ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';

    return {
      id: 'gemini',
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } as Anthropic.Message;
  }
}
