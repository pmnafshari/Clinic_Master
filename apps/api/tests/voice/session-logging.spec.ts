import type Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';

import {
  ClaudeAgentService,
  AnthropicLike,
} from '../../src/modules/voice/agent/claude.agent';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import {
  createAnonymousSession,
  createVerifiedSession,
  VoiceSession,
} from '../../src/modules/voice/session/voice-session';

/**
 * A sessionId is a bearer credential: anyone holding one can resume the
 * conversation inside the session TTL, read back whatever intake collected
 * (name, phone number, date of birth) and inherit `patientId`, which in turn
 * unlocks the booking and cancellation tools.
 *
 * Logs are the wrong place for it. An aggregator, an on-call engineer, a vendor
 * with log-read access, or anything inside the retention window would each be
 * holding live credentials. The idempotencyNonce is equally sensitive: it
 * namespaces the write-deduplication cache.
 *
 * What the logs get instead is `logId` — a separate, non-secret correlation id.
 * Not a truncated sessionId: a prefix is still secret material, and it invites
 * someone later to log "just a few more characters".
 */
function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.message} ${arg.stack ?? ''}`;
  try {
    return `${String(arg)} ${JSON.stringify(arg)}`;
  } catch {
    return String(arg);
  }
}

function captureLogs() {
  const calls: unknown[][] = [];
  const record = (...args: unknown[]): void => {
    calls.push(args);
  };

  const spies = [
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(record as never),
    jest.spyOn(Logger.prototype, 'error').mockImplementation(record as never),
    jest.spyOn(Logger.prototype, 'log').mockImplementation(record as never),
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(record as never),
    jest.spyOn(Logger.prototype, 'verbose').mockImplementation(record as never),
  ];

  return {
    get lines(): string[] {
      return calls.map((args) => args.map(stringifyArg).join(' '));
    },
    /**
     * Just the first argument of each call — the message this codebase writes,
     * as distinct from context the framework is handed to pass through (an
     * exception stack, say, whose contents belong to whoever threw it).
     */
    get messages(): string[] {
      return calls.map((args) => stringifyArg(args[0]));
    },
    joined(): string {
      return this.lines.join('\n');
    },
    restore: () => spies.forEach((spy) => spy.mockRestore()),
  };
}

function fakeClient(script: Partial<Anthropic.Message>[], repeatLast = false): AnthropicLike {
  let index = 0;
  return {
    messages: {
      create: async () => {
        const step =
          index < script.length
            ? script[index]
            : repeatLast
              ? script[script.length - 1]
              : { stop_reason: 'end_turn' as const, content: [] };
        index += 1;
        return step as Anthropic.Message;
      },
    },
  };
}

const toolUse = {
  stop_reason: 'tool_use',
  content: [
    { type: 'tool_use', id: 'tu_1', name: 'get_clinic_info', input: {} },
  ] as Anthropic.ContentBlock[],
} as Partial<Anthropic.Message>;

/**
 * Asserts the secrets are absent AND that a log line was actually produced.
 * Without the second half a test would pass simply because nothing logged,
 * which would make it incapable of failing.
 */
function expectSafeLogging(
  capture: ReturnType<typeof captureLogs>,
  session: VoiceSession
): void {
  expect(capture.lines.length).toBeGreaterThan(0);

  const joined = capture.joined();
  expect(joined).not.toContain(session.sessionId);
  expect(joined).not.toContain(session.idempotencyNonce);

  // ...and the line is still correlatable.
  expect(typeof session.logId).toBe('string');
  expect(joined).toContain(session.logId);
}

describe('session identifiers never reach the logs', () => {
  let registry: ToolRegistryService;
  let executor: ToolExecutorService;
  let capture: ReturnType<typeof captureLogs>;

  beforeEach(() => {
    registry = new ToolRegistryService();
    executor = new ToolExecutorService(registry);
    capture = captureLogs();
  });

  afterEach(() => {
    capture.restore();
  });

  it('keeps them out of the refusal warning', async () => {
    const agent = new ClaudeAgentService(
      registry,
      executor,
      fakeClient([
        {
          stop_reason: 'refusal',
          content: [{ type: 'text', text: 'partial', citations: null }] as Anthropic.ContentBlock[],
        },
      ])
    );
    const session = createAnonymousSession();

    await agent.respond(session, 'something unsafe', []);

    expectSafeLogging(capture, session);
  });

  it('keeps them out of the iteration-cap warning', async () => {
    registry.register({
      name: 'get_clinic_info',
      tier: 'public',
      description: 'clinic info',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ status: 'ok' as const }),
    });

    const agent = new ClaudeAgentService(registry, executor, fakeClient([toolUse], true));
    const session = createAnonymousSession();

    await agent.respond(session, 'hours?', []);

    expectSafeLogging(capture, session);
  });

  it('keeps them out of the blocked-tool warning', async () => {
    registry.register({
      name: 'get_my_balance',
      tier: 'verified',
      description: 'balance',
      needsPatientContext: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ status: 'ok' as const }),
    });

    const session = createAnonymousSession();
    const result = await executor.execute('get_my_balance', {}, session);

    expect(result.error).toBe('verification_required');
    expectSafeLogging(capture, session);
  });

  it('keeps them out of the tool-failure error, stack included', async () => {
    registry.register({
      name: 'boom',
      tier: 'public',
      description: 'throws',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        throw new Error('kaboom');
      },
    });

    const session = createVerifiedSession('s-thrower', 'u1', 'p1');
    const result = await executor.execute('boom', {}, session);

    expect(result.error).toBe('tool_error');
    // The stack is logged too, so this covers the whole emitted record.
    expectSafeLogging(capture, session);
  });

  /**
   * Marks the boundary of what this module can guarantee. The executor logs the
   * exception stack verbatim, so a tool that puts a secret into its own error
   * message leaks it — that is the tool author's bug, not the executor's. What
   * the executor owns is the message it writes itself, and that must stay clean
   * no matter what the tool threw.
   */
  it('never adds the secrets itself, even when the tool throws them', async () => {
    const session = createVerifiedSession('s-thrower', 'u1', 'p1');

    registry.register({
      name: 'careless',
      tier: 'public',
      description: 'throws a secret',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        throw new Error(`leaked ${session.sessionId} and ${session.idempotencyNonce}`);
      },
    });

    await executor.execute('careless', {}, session);

    expect(capture.messages.length).toBeGreaterThan(0);
    const written = capture.messages.join('\n');
    expect(written).not.toContain(session.sessionId);
    expect(written).not.toContain(session.idempotencyNonce);
    expect(written).toContain(session.logId);
  });
});

describe('logId is a distinct, non-secret correlation id', () => {
  it('is present on an anonymous session and differs from both secrets', () => {
    const session = createAnonymousSession();

    expect(typeof session.logId).toBe('string');
    expect(session.logId.length).toBeGreaterThan(0);
    expect(session.logId).not.toBe(session.sessionId);
    expect(session.logId).not.toBe(session.idempotencyNonce);

    // Must not be a slice of either — a prefix is still secret material.
    expect(session.sessionId).not.toContain(session.logId);
    expect(session.idempotencyNonce).not.toContain(session.logId);
  });

  it('is present on a verified session and differs from both secrets', () => {
    const session = createVerifiedSession('s1', 'u1', 'p1');

    expect(typeof session.logId).toBe('string');
    expect(session.logId).not.toBe(session.sessionId);
    expect(session.logId).not.toBe(session.idempotencyNonce);
  });

  it('is unique per session', () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => createAnonymousSession().logId)
    );
    expect(ids.size).toBe(50);
  });

  it('survives the narrowing the executor applies to a tool session', async () => {
    const registry = new ToolRegistryService();
    const executor = new ToolExecutorService(registry);
    let seen: VoiceSession | undefined;

    registry.register({
      name: 'peek',
      tier: 'public',
      description: 'peek',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async (_input, session) => {
        seen = session;
        return { status: 'ok' as const };
      },
    });

    const session = createVerifiedSession('s1', 'u1', 'p1');
    await executor.execute('peek', {}, session);

    expect(seen?.logId).toBe(session.logId);
  });
});
