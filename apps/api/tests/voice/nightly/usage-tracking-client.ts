import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicLike } from '../../../src/modules/voice/agent/claude.agent';

export interface UsageTotals {
  totalTokens: number;
  calls: number;
}

/**
 * Thrown the moment a response pushes the accumulated total past the
 * budget. A single scenario's tool loop can make up to MAX_TOOL_ITERATIONS
 * (6) calls before ClaudeAgentService.respond even returns, so the cap
 * cannot wait for a scenario to finish — it has to trip inside the client,
 * on the call that actually crosses the line, before any further call can
 * happen.
 */
export class BudgetExceededError extends Error {
  constructor(
    public readonly totalTokens: number,
    public readonly budget: number
  ) {
    super(`token budget exceeded mid-call: used ${totalTokens}, budget is ${budget}`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Wraps an AnthropicLike client and accumulates the *real* `response.usage`
 * returned by every call it makes.
 *
 * This is the actual cost control for the nightly run. It is a running
 * total built from what the API reports after each call actually happens —
 * not an estimate computed up front from the scenario count — so it tracks
 * whatever the model really did, including every call inside a single
 * scenario's tool round-trip.
 *
 * When constructed with a `budget`, the check happens here, per call, not
 * only at scenario boundaries: as soon as one call's usage pushes the
 * running total over budget, `create` throws BudgetExceededError instead of
 * returning, so nothing calls the API again. The caller (run-scenarios.ts)
 * still re-checks the total after every scenario as a backstop, in case
 * this per-call enforcement is ever bypassed by a future refactor.
 */
export class UsageTrackingClient implements AnthropicLike {
  private totalTokens = 0;
  private callCount = 0;

  constructor(
    private readonly inner: AnthropicLike,
    private readonly budget?: number
  ) {}

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

      if (this.budget !== undefined && this.totalTokens > this.budget) {
        throw new BudgetExceededError(this.totalTokens, this.budget);
      }

      return response;
    },
  };
}
