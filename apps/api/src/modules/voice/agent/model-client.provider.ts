import Anthropic from '@anthropic-ai/sdk';
import { AnthropicLike } from './claude.agent';
import { GeminiClient } from './gemini.client';

/**
 * Chooses the model transport from configuration.
 *
 * Selection is by an explicit variable rather than inferred from which key
 * happens to be present: a deployment that has both should get the one it
 * asked for, and a missing key should fail loudly rather than silently
 * changing provider.
 *
 * Everything above this returns the same `AnthropicLike` shape, so the agent
 * loop, tool executor, tier authorization and idempotency are identical
 * whichever provider answers.
 */
export function createModelClient(): AnthropicLike {
  const provider = process.env.VOICE_AGENT_PROVIDER ?? 'anthropic';

  if (provider === 'gemini') {
    // Named exactly as it appears in the environment. Read here and nowhere
    // else, so no other code path can log it.
    const key = process.env.Gemini_API_Key ?? process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error('Gemini_API_Key is not configured');
    }
    return new GeminiClient(key);
  }

  // The SDK reads its own key and base URL from the environment, which is why
  // no credential is handled here.
  return new Anthropic();
}
