import type Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from '../../src/modules/voice/agent/system-prompt';
import {
  ClaudeAgentService,
  AnthropicLike,
} from '../../src/modules/voice/agent/claude.agent';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
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

describe('ClaudeAgentService', () => {
  let registry: ToolRegistryService;
  let executor: ToolExecutorService;

  beforeEach(() => {
    registry = new ToolRegistryService();
    executor = new ToolExecutorService(registry);
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
    executor = new ToolExecutorService(registry);
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
