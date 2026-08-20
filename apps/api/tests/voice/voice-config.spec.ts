import { VOICE_CONFIG, CLINIC_INFO, SERVICE_PRICING } from '../../src/modules/voice/voice.config';

describe('voice config', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(VOICE_CONFIG.enabled).toBe(false);
  });

  it('uses Claude Opus 5 at low effort', () => {
    expect(VOICE_CONFIG.model).toBe('claude-opus-5');
    expect(VOICE_CONFIG.effort).toBe('low');
  });

  /**
   * The literal is deliberate, and it is the only assertion in the repo that can
   * catch a bad value.
   *
   * The agent test asserts `calls[0].max_tokens === VOICE_CONFIG.maxTokens`,
   * which compares the production value against itself: it proves the number is
   * forwarded and says nothing about whether the number is usable. Setting
   * maxTokens to 128 left the entire suite green.
   *
   * The number has to be big enough for three things sharing one budget:
   * adaptive thinking (on by default on Opus 5 and deliberately not disabled),
   * the arguments for ten tool schemas, and the sentence read back to the
   * caller. When it is not, the API returns `stop_reason: 'max_tokens'` with a
   * half-finished turn — which claude.agent.ts now refuses to narrate, but the
   * caller still loses the turn. If this assertion is failing because the budget
   * was tuned on purpose, change the literal; do not delete it.
   */
  it('budgets max_tokens for thinking, tool arguments and the reply together', () => {
    expect(VOICE_CONFIG.maxTokens).toBe(8192);
  });

  it('exposes clinic facts for the public tools', () => {
    expect(CLINIC_INFO.hours).toBeDefined();
    expect(CLINIC_INFO.address).toBeDefined();
  });

  it('exposes published price ranges', () => {
    expect(SERVICE_PRICING.length).toBeGreaterThan(0);
    expect(SERVICE_PRICING[0]).toHaveProperty('service');
    expect(SERVICE_PRICING[0]).toHaveProperty('priceRange');
  });
});
