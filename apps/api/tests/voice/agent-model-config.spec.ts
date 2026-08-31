import { readFileSync, readdirSync, statSync } from 'fs';
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

  it('never reads the key itself — that is the SDK\'s job', () => {
    const agent = readFileSync(join(SRC, 'modules/voice/agent/claude.agent.ts'), 'utf8');

    // A key this code touched is a key it could log. It never touches one.
    expect(agent).not.toMatch(/ANTHROPIC_API_KEY/);
    expect(agent).not.toMatch(/apiKey/);
    expect(agent).toContain('new Anthropic()');
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
