/**
 * Phase 0 is text-only. The flag stays false until a phase is deliberately
 * switched on in an environment.
 *
 * The two environment-backed values are getters rather than plain properties,
 * which is load-bearing rather than stylistic. A module-level property is
 * evaluated when this file is first imported, and Nest resolves a root module's
 * imports *before* its decorator calls `ConfigModule.forRoot()` — so the value
 * was fixed before `.env` had been parsed, and a deployment that configured the
 * model or the flag in `.env` silently got the default instead. Reading at
 * access time removes the ordering question entirely.
 *
 * `VOICE_BROWSER_CONFIG` already worked this way; this brings the two into
 * line.
 */
export const VOICE_CONFIG = {
  get enabled(): boolean {
    return process.env.VOICE_AGENT_ENABLED === 'true';
  },
  /**
   * Overridable so the same agent can run against a gateway that fronts the
   * Anthropic Messages API, which requires vendor-prefixed model ids. The
   * default is the model everything else here was tuned against — the system
   * prompt, the adaptive-thinking decision below, and the token budget — so an
   * override changes the agent's behaviour and is deliberately explicit.
   *
   * An empty value reads as unset. A blank environment variable is a
   * configuration mistake, not a request for a model named "".
   */
  get model(): string {
    return process.env.VOICE_AGENT_MODEL || 'claude-opus-5';
  },
  // Thinking is deliberately left at its adaptive default. Disabling it on
  // Opus 5 can cause tool calls to be emitted as plain text, which completes
  // the turn without running the tool — a silent booking failure.
  effort: 'low' as const,
  /**
   * `max_tokens` is the budget for thinking AND the visible reply together, not
   * the reply alone. Thinking is on by default on Opus 5 and is deliberately not
   * disabled (see above), so a booking turn spends this budget on reasoning, ten
   * tool schemas' worth of arguments, and the sentence read back to the caller.
   * 2048 was low enough to truncate mid-turn, which the API reports as
   * `stop_reason: 'max_tokens'` — handled explicitly in claude.agent.ts rather
   * than narrated as a finished answer.
   */
  maxTokens: 8192,
};

/**
 * The feature flag as a dependency rather than a module-level read, so a test
 * can exercise both the enabled and the disabled endpoint without reaching into
 * `process.env` before an import. Production binds it to VOICE_CONFIG.
 */
export interface VoiceFeatureFlag {
  enabled: boolean;
}

export const VOICE_FEATURE_FLAG = Symbol('VOICE_FEATURE_FLAG');

export const CLINIC_INFO = {
  name: 'SmileFlow Dental',
  address: '124 Chestnut Street, Springfield',
  phone: '+1-555-0100',
  hours: 'Monday to Friday, 8am to 6pm. Closed weekends and public holidays.',
  parking: 'Free patient parking is available behind the building, entrance on Willow Lane.',
  prepInstructions:
    'Arrive ten minutes early. Bring a list of any medications you take. ' +
    'For a cleaning, eat beforehand and brush as normal.',
};

export const SERVICE_PRICING: Array<{ service: string; priceRange: string }> = [
  { service: 'Routine cleaning', priceRange: '$90 to $150' },
  { service: 'Dental examination', priceRange: '$60 to $110' },
  { service: 'Filling', priceRange: '$150 to $350' },
  { service: 'Root canal', priceRange: '$700 to $1,200' },
  { service: 'Crown', priceRange: '$900 to $1,800' },
  { service: 'Extraction', priceRange: '$180 to $450' },
];
