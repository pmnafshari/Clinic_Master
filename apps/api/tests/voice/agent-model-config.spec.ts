import { readFileSync, readdirSync, statSync } from 'fs';
import {
  VOICE_CONFIG,
  VoiceFeatureFlag,
} from '../../src/modules/voice/voice.config';
import { join } from 'path';

const SRC = join(__dirname, '../../src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return entry.endsWith('.ts') ? [full] : [];
  });
}

/** Re-imports voice.config with the current environment applied. */
async function loadConfig(): Promise<{ model: string }> {
  jest.resetModules();
  const mod: typeof import('../../src/modules/voice/voice.config') = await import(
    '../../src/modules/voice/voice.config'
  );
  return mod.VOICE_CONFIG;
}

describe('the agent model is configurable', () => {
  const original = process.env.VOICE_AGENT_MODEL;

  afterEach(() => {
    if (original === undefined) delete process.env.VOICE_AGENT_MODEL;
    else process.env.VOICE_AGENT_MODEL = original;
  });

  it('defaults to the model this system was tuned against', async () => {
    delete process.env.VOICE_AGENT_MODEL;

    // Pinned as a literal. The prompt, the thinking default and the token
    // budget were all chosen against this model; a silent change to another is
    // a change to the agent's behaviour.
    expect((await loadConfig()).model).toBe('claude-opus-5');
  });

  it('treats an empty value as unset rather than as a model name', async () => {
    process.env.VOICE_AGENT_MODEL = '';

    expect((await loadConfig()).model).toBe('claude-opus-5');
  });

  it('uses an explicitly configured model', async () => {
    process.env.VOICE_AGENT_MODEL = 'anthropic/claude-sonnet-4.5';

    // A gateway that fronts the same API needs vendor-prefixed ids, which is
    // the whole reason this is configurable.
    expect((await loadConfig()).model).toBe('anthropic/claude-sonnet-4.5');
  });
});

describe('voice configuration is read when it is used, not when it is imported', () => {
  const model = process.env.VOICE_AGENT_MODEL;
  const enabled = process.env.VOICE_AGENT_ENABLED;

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('VOICE_AGENT_MODEL', model);
    restore('VOICE_AGENT_ENABLED', enabled);
  });

  /**
   * The bug this pins.
   *
   * `VOICE_CONFIG` is imported at the top of this file, so its module body ran
   * before any of these assignments. Nest has the same ordering: a root
   * module's imports resolve before its decorator calls
   * `ConfigModule.forRoot()`, so a value read into a plain property at import
   * time is fixed before `.env` is ever parsed — and a deployment that
   * configured the model in `.env` silently got the default instead.
   */
  it('sees a model set after the module was imported', () => {
    process.env.VOICE_AGENT_MODEL = 'anthropic/claude-sonnet-4.5';

    expect(VOICE_CONFIG.model).toBe('anthropic/claude-sonnet-4.5');
  });

  it('sees the flag set after the module was imported', () => {
    process.env.VOICE_AGENT_ENABLED = 'true';

    expect(VOICE_CONFIG.enabled).toBe(true);
  });

  it('follows a value that changes between reads', () => {
    process.env.VOICE_AGENT_MODEL = 'openrouter/free';
    expect(VOICE_CONFIG.model).toBe('openrouter/free');

    delete process.env.VOICE_AGENT_MODEL;
    expect(VOICE_CONFIG.model).toBe('claude-opus-5');
  });

  it('keeps the flag default-deny for anything but the exact string', () => {
    for (const value of ['TRUE', '1', 'yes', 'false', '']) {
      process.env.VOICE_AGENT_ENABLED = value;
      expect(VOICE_CONFIG.enabled).toBe(false);
    }
    delete process.env.VOICE_AGENT_ENABLED;
    expect(VOICE_CONFIG.enabled).toBe(false);
  });

  it('leaves the constants alone — they never came from the environment', () => {
    // Named here so a future edit cannot quietly make either configurable:
    // both were tuned against the default model.
    expect(VOICE_CONFIG.maxTokens).toBe(8192);
    expect(VOICE_CONFIG.effort).toBe('low');
  });

  it('still satisfies the feature-flag contract it is injected under', () => {
    process.env.VOICE_AGENT_ENABLED = 'true';
    // voice.module binds VOICE_CONFIG itself as VOICE_FEATURE_FLAG, so the
    // object must keep behaving like a plain { enabled: boolean }.
    const flag: VoiceFeatureFlag = VOICE_CONFIG;

    expect(flag.enabled).toBe(true);
  });
});

describe('provider credentials stay out of the repository', () => {
  it('names no API key and no gateway host in source', () => {
    for (const file of tsFiles(SRC)) {
      const source = readFileSync(file, 'utf8');

      // The SDK reads its key and base URL from the environment. Nothing here
      // may carry either, and no gateway host may be pinned in code.
      expect(source).not.toMatch(/sk-or-v1-/);
      expect(source).not.toMatch(/openrouter\.ai/);
      expect(source).not.toMatch(/ANTHROPIC_API_KEY\s*=\s*['"]/);
    }
  });

  it('never handles a credential in the agent itself', () => {
    const agent = readFileSync(join(SRC, 'modules/voice/agent/claude.agent.ts'), 'utf8');

    // A key this code touched is a key it could log. The agent constructs no
    // client and names no credential; both belong to the provider below.
    expect(agent).not.toMatch(/ANTHROPIC_API_KEY/);
    expect(agent).not.toMatch(/Gemini_API_Key/i);
    expect(agent).not.toMatch(/apiKey/);
    expect(agent).not.toMatch(/new Anthropic\(/);
    expect(agent).toContain('createModelClient()');
  });

  it('builds every model client in one place, from configuration', () => {
    const provider = readFileSync(
      join(SRC, 'modules/voice/agent/model-client.provider.ts'),
      'utf8'
    );

    // Selection is explicit rather than inferred from whichever key happens to
    // be set, so a deployment with both cannot silently change provider.
    expect(provider).toContain('VOICE_AGENT_PROVIDER');
    // A missing key fails loudly instead of falling back to another provider.
    expect(provider).toMatch(/throw new Error\('Gemini_API_Key is not configured'\)/);

    // And no key is logged or echoed anywhere in it.
    expect(provider).not.toMatch(/console\.|logger\./);
  });

  it('hardcodes no model id anywhere but the documented default', () => {
    const config = readFileSync(join(SRC, 'modules/voice/voice.config.ts'), 'utf8');
    expect(config).toContain('VOICE_AGENT_MODEL');

    for (const file of tsFiles(SRC)) {
      if (file.endsWith('voice.config.ts')) continue;
      const source = readFileSync(file, 'utf8');
      // No vendor-prefixed gateway id may leak into the codebase.
      expect(source).not.toMatch(/['"]anthropic\/claude/);
    }
  });
});
