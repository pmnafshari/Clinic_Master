import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { VoiceTool } from '../../src/modules/voice/tools/tool-definition.interface';
import {
  createAnonymousSession,
  createVerifiedSession,
  VoiceSession,
} from '../../src/modules/voice/session/voice-session';

function stubTool(name: string, tier: 'public' | 'verified'): VoiceTool {
  return {
    name,
    tier,
    description: `stub ${name}`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ status: 'ok', ran: true }),
  };
}

describe('tool authorization', () => {
  let registry: ToolRegistryService;
  let executor: ToolExecutorService;

  beforeEach(() => {
    registry = new ToolRegistryService();
    executor = new ToolExecutorService(registry);
  });

  it('runs a public tool for an anonymous session', async () => {
    registry.register(stubTool('public_thing', 'public'));
    const result = await executor.execute('public_thing', {}, createAnonymousSession('s1'));
    expect(result.status).toBe('ok');
    expect(result.ran).toBe(true);
  });

  it('refuses a verified tool for an anonymous session', async () => {
    registry.register(stubTool('private_thing', 'verified'));
    const result = await executor.execute('private_thing', {}, createAnonymousSession('s1'));
    expect(result.status).toBe('failed');
    expect(result.error).toBe('verification_required');
    expect(result.ran).toBeUndefined();
  });

  it('runs a verified tool for a verified session', async () => {
    registry.register(stubTool('private_thing', 'verified'));
    const result = await executor.execute(
      'private_thing',
      {},
      createVerifiedSession('s1', 'u1', 'p1')
    );
    expect(result.status).toBe('ok');
  });

  it('fails closed on an unknown tool', async () => {
    const result = await executor.execute('no_such_tool', {}, createVerifiedSession('s1', 'u1', 'p1'));
    expect(result.status).toBe('failed');
    expect(result.error).toBe('unknown_tool');
  });

  it('reports a tool error as failed rather than throwing', async () => {
    registry.register({
      ...stubTool('boom', 'public'),
      execute: async () => {
        throw new Error('kaboom');
      },
    });
    const result = await executor.execute('boom', {}, createAnonymousSession('s1'));
    expect(result.status).toBe('failed');
  });
});

/**
 * Prompt-injection style negative cases. Everything below assumes the model is
 * hostile and fully controls `input`. Nothing in `input` may influence who the
 * session is, or whether the call is allowed.
 */
describe('tool authorization — model-controlled input cannot influence identity or tier', () => {
  let registry: ToolRegistryService;
  let executor: ToolExecutorService;

  beforeEach(() => {
    registry = new ToolRegistryService();
    executor = new ToolExecutorService(registry);
  });

  /** Captures exactly what the executor handed the tool. */
  function recordingTool(name: string, tier: 'public' | 'verified') {
    const seen: { input?: Record<string, unknown>; session?: VoiceSession } = {};
    const tool: VoiceTool = {
      ...stubTool(name, tier),
      execute: async (input, session) => {
        seen.input = input;
        seen.session = session;
        return { status: 'ok', ran: true };
      },
    };
    return { tool, seen };
  }

  it('ignores patientId / patient_id / userId injected into input by the model', async () => {
    const { tool, seen } = recordingTool('read_patient_thing', 'verified');
    registry.register(tool);

    const session = createVerifiedSession('s1', 'u1', 'p1');
    const injected = {
      patientId: 'p-victim',
      patient_id: 'p-victim',
      userId: 'u-victim',
      identityVerified: true,
    };

    const result = await executor.execute('read_patient_thing', injected, session);

    // Authorization outcome is unchanged by the injected keys.
    expect(result.status).toBe('ok');

    // The tool received the server-side session object itself, untouched.
    expect(seen.session).toBe(session);
    expect(seen.session?.patientId).toBe('p1');
    expect(seen.session?.userId).toBe('u1');
    expect(seen.session?.sessionId).toBe('s1');

    // Model input stays structurally separate: it is a distinct argument and
    // its keys never merge into the session.
    expect(seen.input).not.toBe(seen.session);
    expect(seen.input).toEqual(injected);
    expect(seen.session).toEqual(createVerifiedSession('s1', 'u1', 'p1'));
  });

  it('still blocks a verified tool when input claims identityVerified / tier', async () => {
    registry.register(stubTool('private_thing', 'verified'));

    const result = await executor.execute(
      'private_thing',
      { identityVerified: true, tier: 'public' },
      createAnonymousSession('s1')
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('verification_required');
    expect(result.ran).toBeUndefined();
  });

  it('does not invoke the tool at all when the call is blocked', async () => {
    const execute = jest.fn(async () => ({ status: 'ok' as const, ran: true }));
    registry.register({ ...stubTool('private_thing', 'verified'), execute });

    const result = await executor.execute(
      'private_thing',
      { patientId: 'p-victim' },
      createAnonymousSession('s1')
    );

    expect(result.error).toBe('verification_required');
    expect(execute).not.toHaveBeenCalled();
  });

  it('never mutates the session it is given, on blocked or allowed calls', async () => {
    registry.register(stubTool('private_thing', 'verified'));
    registry.register(stubTool('public_thing', 'public'));

    const anon = createAnonymousSession('s1');
    const anonBefore = JSON.stringify(anon);
    await executor.execute('private_thing', { identityVerified: true }, anon);
    expect(JSON.stringify(anon)).toBe(anonBefore);
    expect(anon.identityVerified).toBe(false);

    const verified = createVerifiedSession('s2', 'u1', 'p1');
    const verifiedBefore = JSON.stringify(verified);
    await executor.execute('private_thing', { patientId: 'p-victim' }, verified);
    expect(JSON.stringify(verified)).toBe(verifiedBefore);

    const publicBefore = JSON.stringify(anon);
    await executor.execute('public_thing', { patientId: 'p-victim' }, anon);
    expect(JSON.stringify(anon)).toBe(publicBefore);
  });

  it('gives a public tool on an anonymous session no patient identity to leak', async () => {
    const { tool, seen } = recordingTool('public_thing', 'public');
    registry.register(tool);

    const result = await executor.execute(
      'public_thing',
      { patientId: 'p-victim', patient_id: 'p-victim', userId: 'u-victim' },
      createAnonymousSession('s1')
    );

    expect(result.status).toBe('ok');
    // The only identity a public tool can act on is the session's, and an
    // anonymous session has none. Model input cannot supply one.
    expect(seen.session?.patientId).toBeNull();
    expect(seen.session?.userId).toBeNull();
    expect(seen.session?.identityVerified).toBe(false);
  });

  it('enumerates the registry: every registered tool declares a known tier', () => {
    registry.register(stubTool('public_thing', 'public'));
    registry.register(stubTool('private_thing', 'verified'));

    for (const tool of registry.all()) {
      expect(['public', 'verified']).toContain(tool.tier);
    }
    expect(registry.verifiedTools().map((tool) => tool.name)).toEqual(['private_thing']);
  });
});
