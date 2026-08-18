import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicLike } from '../../../src/modules/voice/agent/claude.agent';

export interface UsageTotals {
  totalTokens: number;
  calls: number;
}

/**
 * Wraps an AnthropicLike client and accumulates the *real* `response.usage`
 * returned by every call it makes.
 *
 * This is the actual cost control for the nightly run. It is a running
 * total built from what the API reports after each call actually happens —
 * not an estimate computed up front from the scenario count — so it tracks
 * whatever the model really did (including any retried tool round-trip
 * inside a single scenario).
 */
export class UsageTrackingClient implements AnthropicLike {
  private totalTokens = 0;
  private callCount = 0;

  constructor(private readonly inner: AnthropicLike) {}

  get usage(): UsageTotals {
    return { totalTokens: this.totalTokens, calls: this.callCount };
  }

  messages = {
    create: async (
      params: Anthropic.MessageCreateParamsNonStreaming
    ): Promise<Anthropic.Message> => {
      const response = await this.inner.messages.create(params);
      this.callCount += 1;
      this.totalTokens +=
        response.usage.input_tokens +
        response.usage.output_tokens +
        (response.usage.cache_creation_input_tokens ?? 0) +
        (response.usage.cache_read_input_tokens ?? 0);
      return response;
    },
  };
}
