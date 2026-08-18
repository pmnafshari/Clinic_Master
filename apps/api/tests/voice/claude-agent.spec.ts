import type Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import { SYSTEM_PROMPT } from '../../src/modules/voice/agent/system-prompt';
import {
  ClaudeAgentService,
  AnthropicLike,
  FRONT_DESK_FALLBACK_REPLY,
} from '../../src/modules/voice/agent/claude.agent';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { createAnonymousSession } from '../../src/modules/voice/session/voice-session';
import { VOICE_CONFIG } from '../../src/modules/voice/voice.config';

type PartialMessage = Partial<Anthropic.Message>;

/**
 * A stand-in for the Anthropic client. Every test in this file uses one, so no
 * test can reach the network and none needs an API key.
 */
function makeClient(script: PartialMessage[], repeatLast = false) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let index = 0;

  const client: AnthropicLike = {
    messages: {
      create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        calls.push(params);
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

  return { client, calls };
}

function textResponse(text: string): PartialMessage {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text, citations: null }] as Anthropic.ContentBlock[],
  };
}

function toolUseResponse(name: string, input: Record<string, unknown>, id = 'tu_1'): PartialMessage {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id, name, input }] as Anthropic.ContentBlock[],
  };
}


/**
 * The executor audits every tool call it handles. What that record contains —
 * and that it never carries the bearer sessionId — is covered in
 * tool-audit.spec.ts; here the audit service only has to exist.
 */
function stubAudit(): AuditService {
  return { log: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
}

describe('ClaudeAgentService', () => {
  let registry: ToolRegistryService;
  let executor: ToolExecutorService;

  beforeEach(() => {
    registry = new ToolRegistryService();
    executor = new ToolExecutorService(registry, stubAudit());
    registry.register({
      name: 'get_clinic_info',
      tier: 'public',
      description: 'clinic info',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ status: 'ok', hours: '8 to 6' }),
    });
  });

  it('forbids clinical advice in the system prompt', () => {
    expect(SYSTEM_PROMPT).toMatch(/clinical advice/i);
  });

  it('requires a confirmed status before reporting success', () => {
    expect(SYSTEM_PROMPT).toMatch(/confirmed/);
  });

  it('builds strict tool schemas from the registry', () => {
    const agent = new ClaudeAgentService(registry, executor);
    const schemas = agent.buildToolSchemas();

    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe('get_clinic_info');
    expect(schemas[0].strict).toBe(true);
    expect(schemas[0].input_schema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('increments the turn index on each exchange', async () => {
    const { client } = makeClient([textResponse('We are open eight to six.')], true);
    const agent = new ClaudeAgentService(registry, executor, client);
    const session = createAnonymousSession('s1');

    await agent.respond(session, 'What time do you open?', []);
    expect(session.turnIndex).toBe(1);

    await agent.respond(session, 'And on Saturday?', []);
    expect(session.turnIndex).toBe(2);
  });

  it('sends the system prompt, model and effort from the voice config', async () => {
    const { client, calls } = makeClient([textResponse('Hello.')]);
    const agent = new ClaudeAgentService(registry, executor, client);

    await agent.respond(createAnonymousSession('s1'), 'hi', []);

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(VOICE_CONFIG.model);
    // Wiring only: this says the agent forwards the configured budget, and it
    // cannot say whether the budget is a sane number — both sides come from
    // the same constant. The VALUE is pinned to a literal in voice-config.spec.
    expect(calls[0].max_tokens).toBe(VOICE_CONFIG.maxTokens);
    expect(calls[0].output_config?.effort).toBe(VOICE_CONFIG.effort);
    expect(JSON.stringify(calls[0].system)).toContain('automated assistant');
    expect(calls[0].tools?.map((tool) => (tool as { name: string }).name)).toEqual([
      'get_clinic_info',
    ]);
  });

  it('returns the assistant text when the model does not call a tool', async () => {
    const { client } = makeClient([textResponse('We are open eight to six.')]);
    const agent = new ClaudeAgentService(registry, executor, client);

    const turn = await agent.respond(createAnonymousSession('s1'), 'hours?', []);

    expect(turn.reply).toBe('We are open eight to six.');
    expect(turn.toolCalls).toEqual([]);
  });
});

/**
 * The agent loop is hand-written rather than delegated to the SDK's Tool Runner
 * precisely so that every tool call passes through ToolExecutorService, which is
 * where tier authorization lives. These tests are what would go red if someone
 * swapped in a runner that calls tools directly.
 */
describe('ClaudeAgentService — every tool call goes through the executor', () => {
  let registry: ToolRegistryService;
  let executor: ToolExecutorService;

  beforeEach(() => {
    registry = new ToolRegistryService();
    executor = new ToolExecutorService(registry, stubAudit());
  });

  it('dispatches a tool_use block through ToolExecutorService', async () => {
    const ran = jest.fn(async () => ({ status: 'ok' as const, hours: '8 to 6' }));
    registry.register({
      name: 'get_clinic_info',
      tier: 'public',
      description: 'clinic info',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: ran,
    });

    const execute = jest.spyOn(executor, 'execute');
    const { client } = makeClient([
      toolUseResponse('get_clinic_info', {}),
      textResponse('We are open eight to six.'),
    ]);
    const agent = new ClaudeAgentService(registry, executor, client);
    const session = createAnonymousSession('s1');

    const turn = await agent.respond(session, 'hours?', []);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('get_clinic_info', {}, session);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(turn.toolCalls).toEqual(['get_clinic_info']);
    expect(turn.reply).toBe('We are open eight to six.');
  });

  it('cannot bypass the tier gate: a verified tool never runs for an unverified session', async () => {
    const ran = jest.fn(async () => ({ status: 'ok' as const, balance: 120 }));
    registry.register({
      name: 'get_my_balance',
      tier: 'verified',
      description: 'balance',
      needsPatientContext: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: ran,
    });

    const { client, calls } = makeClient([
      toolUseResponse('get_my_balance', {}),
      textResponse('I need to confirm your identity first.'),
    ]);
    const agent = new ClaudeAgentService(registry, executor, client);

    const turn = await agent.respond(createAnonymousSession('s1'), 'what do I owe?', []);

    // The tool itself must never have run.
    expect(ran).not.toHaveBeenCalled();

    // And the model must have been told, so it can say so.
    const toolResults = JSON.stringify(calls[1].messages);
    expect(toolResults).toContain('verification_required');
    expect(turn.toolCalls).toEqual(['get_my_balance']);
  });

  it('reports an unknown tool as failed instead of throwing', async () => {
    const { client, calls } = makeClient([
      toolUseResponse('drop_database', {}),
      textResponse('Sorry, that did not work.'),
    ]);
    const agent = new ClaudeAgentService(registry, executor, client);

    const turn = await agent.respond(createAnonymousSession('s1'), 'do it', []);

    expect(JSON.stringify(calls[1].messages)).toContain('unknown_tool');
    expect(turn.reply).toBe('Sorry, that did not work.');
  });

  it('stops at the iteration cap rather than looping forever', async () => {
    registry.register({
      name: 'get_clinic_info',
      tier: 'public',
      description: 'clinic info',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ status: 'ok' as const }),
    });

    const { client, calls } = makeClient([toolUseResponse('get_clinic_info', {})], true);
    const agent = new ClaudeAgentService(registry, executor, client);

    const turn = await agent.respond(createAnonymousSession('s1'), 'hours?', []);

    expect(calls).toHaveLength(6);
    expect(turn.reply).toMatch(/front desk/i);
  });

  /**
   * A refusal arrives on a successful HTTP 200 and may carry partial content.
   * Code that reads `content` without checking `stop_reason` first would hand
   * that partial text back to the caller.
   */
  it('checks stop_reason === refusal before reading content', async () => {
    const { client } = makeClient([
      {
        stop_reason: 'refusal',
        content: [
          { type: 'text', text: 'Here is how you would', citations: null },
        ] as Anthropic.ContentBlock[],
      },
    ]);
    const agent = new ClaudeAgentService(registry, executor, client);

    const turn = await agent.respond(createAnonymousSession('s1'), 'something unsafe', []);

    expect(turn.reply).not.toContain('Here is how you would');
    expect(turn.reply).toMatch(/cannot help with that/i);
  });
});

/**
 * Two ways a turn can end without a real answer. Both used to reach the caller
 * as if they were one: truncation was narrated as a finished reply, and an SDK
 * error propagated out of the controller into the global exception filter,
 * which returns `exception.message` verbatim to an anonymous client.
 */
describe('ClaudeAgentService — a turn that cannot be completed truthfully', () => {
  let registry: ToolRegistryService;
  let executor: ToolExecutorService;

  beforeEach(() => {
    registry = new ToolRegistryService();
    executor = new ToolExecutorService(registry, stubAudit());
    registry.register({
      name: 'book_appointment',
      tier: 'public',
      description: 'book',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => ({ status: 'confirmed' as const, appointmentId: 'a1' }),
    });
  });

  /**
   * Running out of max_tokens is an HTTP 200 carrying whatever had been
   * produced so far. Reading only `stop_reason === 'refusal'` lets that partial
   * text fall through to the no-tool-calls return, so half a sentence about a
   * booking is handed back as the completed turn.
   */
  it('does not return truncated text as a finished answer', async () => {
    const { client } = makeClient([
      {
        stop_reason: 'max_tokens',
        content: [
          { type: 'text', text: 'Sure — I have booked you in for Tues', citations: null },
        ] as Anthropic.ContentBlock[],
      },
    ]);
    const agent = new ClaudeAgentService(registry, executor, client);

    const turn = await agent.respond(createAnonymousSession('s1'), 'book me Tuesday', []);

    expect(turn.reply).not.toContain('I have booked you in');
    expect(turn.reply).toBe(FRONT_DESK_FALLBACK_REPLY);
    expect(turn.reply).toMatch(/front desk/i);
  });

  /**
   * The dangerous shape: truncated before the tool_use block was complete. No
   * tool ran, so nothing is booked — and the partial text must not say it was.
   */
  it('does not run or narrate a tool call that was cut off mid-block', async () => {
    const ran = jest.spyOn(executor, 'execute');
    const { client } = makeClient([
      {
        stop_reason: 'max_tokens',
        content: [
          { type: 'text', text: 'Booking that now', citations: null },
        ] as Anthropic.ContentBlock[],
      },
    ]);
    const agent = new ClaudeAgentService(registry, executor, client);

    const turn = await agent.respond(createAnonymousSession('s1'), 'book me Tuesday', []);

    expect(ran).not.toHaveBeenCalled();
    expect(turn.toolCalls).toEqual([]);
    expect(turn.reply).toBe(FRONT_DESK_FALLBACK_REPLY);
  });

  /**
   * A truncated assistant turn must not be appended to the transcript: a
   * tool_use block retained without its matching tool_result is a 400 on the
   * very next request, which would wedge the conversation permanently.
   */
  it('keeps the truncated assistant turn out of the returned history', async () => {
    const { client } = makeClient([
      {
        stop_reason: 'max_tokens',
        content: [
          { type: 'tool_use', id: 'tu_partial', name: 'book_appointment', input: {} },
        ] as Anthropic.ContentBlock[],
      },
    ]);
    const agent = new ClaudeAgentService(registry, executor, client);

    const turn = await agent.respond(createAnonymousSession('s1'), 'book me Tuesday', []);

    expect(JSON.stringify(turn.history)).not.toContain('tu_partial');
    expect(turn.history.every((message) => message.role !== 'assistant')).toBe(true);
  });

  /**
   * An Anthropic APIError message carries the HTTP status and the provider's
   * JSON body. The route is anonymous and the global exception filter returns
   * `exception.message` as-is, so an uncaught throw here publishes the upstream
   * provider and this process's internal state to whoever asked.
   */
  it('returns the fallback reply when the SDK throws, without leaking the provider message', async () => {
    const leaky = new Error(
      '429 {"type":"error","error":{"type":"rate_limit_error",' +
        '"message":"prompt is too long: 214331 tokens > 200000 maximum"}}'
    );
    const client: AnthropicLike = {
      messages: {
        create: async () => {
          throw leaky;
        },
      },
    };
    const agent = new ClaudeAgentService(registry, executor, client);

    const turn = await agent.respond(createAnonymousSession('s1'), 'book me Tuesday', []);

    expect(turn.reply).toBe(FRONT_DESK_FALLBACK_REPLY);
    expect(turn.reply).not.toContain('429');
    expect(turn.reply).not.toContain('rate_limit_error');
    expect(turn.reply).not.toContain('prompt is too long');
    expect(turn.reply).not.toContain('200000');
  });

  it('does not throw the SDK error out of respond()', async () => {
    const client: AnthropicLike = {
      messages: {
        create: async () => {
          throw new Error('401 {"error":{"message":"invalid x-api-key"}}');
        },
      },
    };
    const agent = new ClaudeAgentService(registry, executor, client);

    await expect(
      agent.respond(createAnonymousSession('s1'), 'hours?', [])
    ).resolves.toMatchObject({ reply: FRONT_DESK_FALLBACK_REPLY });
  });

  /**
   * The failure is not silent — it is logged, with the non-secret logId. The
   * sessionId is a bearer credential and the idempotencyNonce namespaces this
   * session's writes; neither may appear in a log line.
   */
  it('logs the failure with logId, never the sessionId or the nonce', async () => {
    const client: AnthropicLike = {
      messages: {
        create: async () => {
          throw new Error('500 upstream exploded');
        },
      },
    };
    const agent = new ClaudeAgentService(registry, executor, client);
    const session = createAnonymousSession('sess-secret-bearer-value');

    const logged: string[] = [];
    const spy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(' '));
      });

    try {
      await agent.respond(session, 'hours?', []);
    } finally {
      spy.mockRestore();
    }

    const all = logged.join('\n');
    expect(all).toContain(session.logId);
    expect(all).not.toContain(session.sessionId);
    expect(all).not.toContain(session.idempotencyNonce);
  });
});
