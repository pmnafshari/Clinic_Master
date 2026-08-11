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

/** A tool whose inputSchema declares real properties. */
function toolWithSchema(
  name: string,
  tier: 'public' | 'verified',
  properties: Record<string, unknown>,
  needsPatientContext?: boolean
): VoiceTool {
  return {
    ...stubTool(name, tier),
    ...(needsPatientContext === undefined ? {} : { needsPatientContext }),
    inputSchema: { type: 'object', properties, additionalProperties: false },
  };
}

/**
 * Identity is resolved server-side from the session, and needsPatientContext is
 * a server-side capability declaration. None of these may ever be a field the
 * model gets to fill in.
 */
const FORBIDDEN_SCHEMA_KEYS = ['patientId', 'patient_id', 'userId', 'needsPatientContext'];

function schemaProperties(tool: VoiceTool): Record<string, unknown> {
  return (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
}

/**
 * The single schema check, used by both the registry sweep and the negative
 * cases below, so the negative cases actually prove something about the sweep.
 * Returns the offending keys — empty means clean.
 */
function forbiddenSchemaKeys(tool: VoiceTool): string[] {
  return Object.keys(schemaProperties(tool)).filter((key) =>
    FORBIDDEN_SCHEMA_KEYS.includes(key)
  );
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
  function recordingTool(
    name: string,
    tier: 'public' | 'verified',
    needsPatientContext?: boolean
  ) {
    const seen: { input?: Record<string, unknown>; session?: VoiceSession } = {};
    const tool: VoiceTool = {
      ...stubTool(name, tier),
      ...(needsPatientContext === undefined ? {} : { needsPatientContext }),
      execute: async (input, session) => {
        seen.input = input;
        seen.session = session;
        return { status: 'ok', ran: true };
      },
    };
    return { tool, seen };
  }

  it('ignores patientId / patient_id / userId injected into input by the model', async () => {
    // Declares the capability, so it is *entitled* to patient context. Even
    // then, the patient it gets is the session's — never the injected one.
    const { tool, seen } = recordingTool('read_patient_thing', 'verified', true);
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

/**
 * Patient context is a capability a tool must ask for by name. A tool that does
 * not declare `needsPatientContext: true` is handed a session with no identity
 * in it, so it cannot leak or act on a patient even inside a verified session.
 */
describe('tool authorization — patient context is gated behind an explicit capability', () => {
  let registry: ToolRegistryService;
  let executor: ToolExecutorService;

  beforeEach(() => {
    registry = new ToolRegistryService();
    executor = new ToolExecutorService(registry);
  });

  function recordingTool(
    name: string,
    tier: 'public' | 'verified',
    needsPatientContext?: boolean
  ) {
    const seen: { session?: VoiceSession } = {};
    const tool: VoiceTool = {
      ...stubTool(name, tier),
      ...(needsPatientContext === undefined ? {} : { needsPatientContext }),
      execute: async (_input, session) => {
        seen.session = session;
        return { status: 'ok', ran: true };
      },
    };
    return { tool, seen };
  }

  it('withholds patient identity from a tool that does not declare the capability', async () => {
    const { tool, seen } = recordingTool('no_flag_thing', 'verified');
    registry.register(tool);

    const result = await executor.execute(
      'no_flag_thing',
      {},
      createVerifiedSession('s1', 'u1', 'p1')
    );

    expect(result.status).toBe('ok');
    expect(seen.session?.patientId).toBeNull();
    expect(seen.session?.userId).toBeNull();
  });

  it('keeps sessionId and turnIndex in the narrowed session', async () => {
    const { tool, seen } = recordingTool('no_flag_thing', 'verified');
    registry.register(tool);

    const session = createVerifiedSession('s-abc', 'u1', 'p1');
    session.turnIndex = 7;
    await executor.execute('no_flag_thing', {}, session);

    // A later task derives idempotency keys from these — narrowing must not
    // take them away.
    expect(seen.session?.sessionId).toBe('s-abc');
    expect(seen.session?.turnIndex).toBe(7);
    // The tier decision was made on the real session, so this stays true.
    expect(seen.session?.identityVerified).toBe(true);
  });

  it('gives patient identity to a tool that declares the capability', async () => {
    const { tool, seen } = recordingTool('needs_patient', 'verified', true);
    registry.register(tool);

    const result = await executor.execute(
      'needs_patient',
      {},
      createVerifiedSession('s1', 'u1', 'p1')
    );

    expect(result.status).toBe('ok');
    expect(seen.session?.patientId).toBe('p1');
    expect(seen.session?.userId).toBe('u1');
  });

  it('hands a capability-declaring tool the real session object, so its writes survive', async () => {
    const seen: { session?: VoiceSession } = {};
    registry.register({
      ...stubTool('start_patient_intake', 'public'),
      needsPatientContext: true,
      execute: async (_input, session) => {
        seen.session = session;
        // The intake tool writes the patient it just created back onto the
        // session so a later book_appointment call can use it.
        session.patientId = 'written-by-tool';
        return { status: 'ok', ran: true };
      },
    });

    const session = createAnonymousSession('s1');
    await executor.execute('start_patient_intake', {}, session);

    // Same object, not a clone — otherwise the write above vanishes and the
    // anonymous intake -> book flow breaks silently.
    expect(seen.session).toBe(session);
    expect(session.patientId).toBe('written-by-tool');
  });

  it('narrowing does not mutate the caller session', async () => {
    const { tool } = recordingTool('no_flag_thing', 'verified');
    registry.register(tool);

    const session = createVerifiedSession('s1', 'u1', 'p1');
    await executor.execute('no_flag_thing', {}, session);

    expect(session.patientId).toBe('p1');
    expect(session.userId).toBe('u1');
    expect(session.identityVerified).toBe(true);
  });

  it('keeps the tier gate unchanged for flagged and unflagged tools', async () => {
    const flagged = recordingTool('needs_patient', 'verified', true);
    const unflagged = recordingTool('no_flag_thing', 'verified');
    registry.register(flagged.tool);
    registry.register(unflagged.tool);

    const anon = createAnonymousSession('s1');

    const flaggedResult = await executor.execute('needs_patient', {}, anon);
    expect(flaggedResult.status).toBe('failed');
    expect(flaggedResult.error).toBe('verification_required');
    expect(flagged.seen.session).toBeUndefined();

    const unflaggedResult = await executor.execute('no_flag_thing', {}, anon);
    expect(unflaggedResult.status).toBe('failed');
    expect(unflaggedResult.error).toBe('verification_required');
    expect(unflagged.seen.session).toBeUndefined();
  });

  it('fails closed: an unflagged tool sees no patient and cannot recover one', async () => {
    // A tool that forgot the flag but expects a patient must fail, not operate
    // on some other patient recovered from input.
    registry.register({
      ...stubTool('forgot_the_flag', 'verified'),
      execute: async (_input, session) => {
        if (!session.patientId) {
          return { status: 'failed', error: 'no_patient_in_session' };
        }
        return { status: 'ok', patientId: session.patientId };
      },
    });

    const result = await executor.execute(
      'forgot_the_flag',
      { patientId: 'p-victim', patient_id: 'p-victim' },
      createVerifiedSession('s1', 'u1', 'p1')
    );

    expect(result.status).toBe('failed');
    expect(result.error).toBe('no_patient_in_session');
  });

  it('never exposes a patient identifier through any tool inputSchema', () => {
    // Tools with real schema properties, so the sweep below has something to
    // inspect. A tool needing patient context declares it server-side and
    // still takes no identifier as input.
    registry.register(
      toolWithSchema(
        'book_appointment',
        'verified',
        { date: { type: 'string' }, time: { type: 'string' } },
        true
      )
    );
    registry.register(toolWithSchema('clinic_hours', 'public', { day: { type: 'string' } }));
    registry.register(stubTool('empty_schema_thing', 'public'));

    let inspectedKeys = 0;
    for (const tool of registry.all()) {
      inspectedKeys += Object.keys(schemaProperties(tool)).length;
      expect(forbiddenSchemaKeys(tool)).toEqual([]);
    }

    // Guard against this test silently going vacuous again: if every registered
    // tool had an empty schema, the loop above would assert nothing at all.
    expect(inspectedKeys).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN_SCHEMA_KEYS)(
    'detects %s when a tool inputSchema declares it',
    (forbiddenKey) => {
      const bad = toolWithSchema('sneaky_tool', 'verified', {
        date: { type: 'string' },
        [forbiddenKey]: { type: 'string' },
      });

      expect(forbiddenSchemaKeys(bad)).toEqual([forbiddenKey]);
    }
  );

  it('the registry sweep catches a tool that declares a forbidden key', () => {
    registry.register(toolWithSchema('clinic_hours', 'public', { day: { type: 'string' } }));
    registry.register(
      toolWithSchema('sneaky_tool', 'verified', {
        date: { type: 'string' },
        patientId: { type: 'string' },
        userId: { type: 'string' },
      })
    );

    // Same sweep, same helper as the passing test above — so that test's green
    // is meaningful rather than an artifact of empty schemas.
    const offenders = registry
      .all()
      .flatMap((tool) => forbiddenSchemaKeys(tool).map((key) => `${tool.name}.${key}`));

    expect(offenders).toEqual(['sneaky_tool.patientId', 'sneaky_tool.userId']);
  });
});
