import type Anthropic from '@anthropic-ai/sdk';
import { Test } from '@nestjs/testing';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import { VoiceGateway } from '../../src/modules/voice/transport/voice.gateway';
import { VoiceTurnRunner } from '../../src/modules/voice/transport/voice-turn-runner';
import { TransportMetricsService } from '../../src/modules/voice/transport/transport-metrics.service';
import { AudioTransport } from '../../src/modules/voice/transport/audio-transport.interface';
import { ServerFrame } from '../../src/modules/voice/transport/frames';
import { VoiceErrorCode } from '../../src/modules/voice/transport/error-codes';
import { VoiceSessionStore } from '../../src/modules/voice/session/voice-session.store';
import {
  ClaudeAgentService,
  ANTHROPIC_CLIENT,
  AnthropicLike,
} from '../../src/modules/voice/agent/claude.agent';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { IdempotencyService } from '../../src/modules/voice/idempotency/idempotency.service';

export class FakeTransport implements AudioTransport {
  readonly sent: ServerFrame[] = [];
  readonly audioFrames: Buffer[] = [];
  closedWith: VoiceErrorCode | null = null;
  private teardowns: Array<() => void | Promise<void>> = [];

  send(frame: ServerFrame): void {
    this.sent.push(frame);
  }

  sendAudio(chunk: Buffer): void {
    this.audioFrames.push(chunk);
  }

  close(code: VoiceErrorCode): void {
    this.closedWith = code;
  }

  onTeardown(fn: () => void | Promise<void>): void {
    this.teardowns.push(fn);
  }

  async fireTeardown(): Promise<void> {
    for (const fn of this.teardowns) {
      await fn();
    }
  }

  typesSent(): string[] {
    return this.sent.map((f) => f.type);
  }
}

const REPLY = 'We are open eight to six.';

async function buildGateway() {
  const agentCalls: string[] = [];
  const client: AnthropicLike = {
    messages: {
      create: async (params) => {
        const last = params.messages[params.messages.length - 1];
        agentCalls.push(typeof last?.content === 'string' ? last.content : '');
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: REPLY, citations: null }],
        } as unknown as Anthropic.Message;
      },
    },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      VoiceGateway,
      VoiceTurnRunner,
      TransportMetricsService,
      VoiceSessionStore,
      ToolRegistryService,
      ToolExecutorService,
      ClaudeAgentService,
      IdempotencyService,
      { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      { provide: ANTHROPIC_CLIENT, useValue: client },
      // Deliberately no TEXT_TO_SPEECH provider: T5 binds one, T2 must work
      // without it. See the "no TTS provider bound" block below.
    ],
  }).compile();

  return {
    gateway: moduleRef.get(VoiceGateway),
    store: moduleRef.get(VoiceSessionStore),
    agentCalls,
  };
}

function readyId(t: FakeTransport): string {
  return (t.sent[0] as { type: 'session.ready'; sessionId: string }).sessionId;
}

describe('voice gateway', () => {
  it('issues a session id on session.start and announces it', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });

    expect(transport.typesSent()).toEqual(['session.ready']);
    expect(readyId(transport)).toHaveLength(43);
  });

  it('drives a complete turn through turn.text with no speech provider', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'what are your hours?' });

    expect(transport.typesSent()).toEqual([
      'session.ready',
      'agent.thinking',
      'reply.text',
      'error',
      'turn.complete',
    ]);
  });

  it('starts a fresh session for an id the server never issued', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start', sessionId: 'never-issued' });

    expect(readyId(transport)).not.toBe('never-issued');
    expect(transport.closedWith).toBeNull();
  });

  it('rejects a malformed frame without touching session state', async () => {
    const { gateway, store } = await buildGateway();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    const id = readyId(transport);
    const before = store.get(id);

    await gateway.handleFrame(transport, {
      type: 'turn.text',
      text: 'hi',
      patientId: 'patient-9',
    });

    expect(transport.sent.at(-1)).toEqual({ type: 'error', code: 'bad_frame' });
    const after = store.get(id);
    expect(after?.session.patientId).toBeNull();
    expect(after?.session.identityVerified).toBe(false);
    expect(after).toBe(before);
  });

  it('does not reach the agent at all for a rejected frame', async () => {
    const { gateway, agentCalls } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    await gateway.handleFrame(transport, { type: 'turn.text', text: 'hi', userId: 'u1' });

    expect(agentCalls).toHaveLength(0);
  });

  it('reports session_expired for a turn on a socket that never started a session', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'turn.text', text: 'hello?' });

    expect(transport.sent).toContainEqual({ type: 'error', code: 'session_expired' });
  });
});

// ---------------------------------------------------------------------------
// The turn reaches the real agent through the approved path, and every tool
// call still goes through ToolExecutorService.
// ---------------------------------------------------------------------------

describe('turn.text reaches the approved agent path', () => {
  it('invokes ClaudeAgentService with the server-held session', async () => {
    const { gateway, store, agentCalls } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    const id = readyId(transport);

    await gateway.handleFrame(transport, { type: 'turn.text', text: 'what are your hours?' });

    expect(agentCalls).toEqual(['what are your hours?']);
    // The agent advanced the server-side turn counter — proof the turn went
    // through respond(), not around it.
    expect(store.get(id)?.session.turnIndex).toBe(1);
  });

  it('routes tool calls through ToolExecutorService, never around it', async () => {
    // A tool_use reply drives the executor. The executor is the only component
    // that writes an audit row, so an audit write is proof the call went
    // through the authorization choke point rather than being dispatched
    // directly by the transport.
    const auditLog = jest.fn().mockResolvedValue(undefined);
    const client: AnthropicLike = {
      messages: {
        create: async (params) => {
          const alreadyCalled = params.messages.some(
            (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')
          );
          if (alreadyCalled) {
            return {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: REPLY, citations: null }],
            } as unknown as Anthropic.Message;
          }
          return {
            stop_reason: 'tool_use',
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'get_my_balance', input: {} },
            ],
          } as unknown as Anthropic.Message;
        },
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VoiceGateway,
        VoiceTurnRunner,
        TransportMetricsService,
        VoiceSessionStore,
        ToolRegistryService,
        ToolExecutorService,
        ClaudeAgentService,
        IdempotencyService,
        { provide: AuditService, useValue: { log: auditLog } },
        { provide: ANTHROPIC_CLIENT, useValue: client },
      ],
    }).compile();

    const gateway = moduleRef.get(VoiceGateway);
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'what do I owe?' });

    // An anonymous session cannot reach a verified tool. The executor blocked
    // it AND audited the blocked attempt — both are its job, and neither would
    // happen if the transport had dispatched the tool itself.
    expect(auditLog).toHaveBeenCalled();
    const audited = auditLog.mock.calls[0][0];
    expect(audited.action).toBe('get_my_balance');
    expect(audited.newValues).toMatchObject({ status: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// Optional TTS injection must not become a silent production failure path.
// ---------------------------------------------------------------------------

describe('delivering a reply with no TTS provider bound', () => {
  it('boots and resolves the gateway with no TEXT_TO_SPEECH provider', async () => {
    const { gateway } = await buildGateway();
    expect(gateway).toBeDefined();
  });

  it('sends the reply as text and reports tts_unavailable', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    await gateway.handleFrame(transport, { type: 'turn.text', text: 'what are your hours?' });

    expect(transport.sent).toContainEqual({ type: 'error', code: 'tts_unavailable' });
    expect(transport.sent).toContainEqual({ type: 'reply.text', text: REPLY });
  });

  it('does not pretend audio was generated', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    await gateway.handleFrame(transport, { type: 'turn.text', text: 'hours?' });

    expect(transport.audioFrames).toHaveLength(0);
    expect(transport.typesSent()).not.toContain('audio.frame');
  });

  it('never reports a missing provider as a successful synthesis', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    const mode = await gateway.deliverReply(transport, REPLY);

    expect(mode).toBe('text');
    expect(mode).not.toBe('audio');
  });

  it('has exactly one place that emits tts_unavailable', () => {
    const root = join(__dirname, '../../src');
    const files = execSync(`grep -rl "tts_unavailable" ${root} || true`)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);

    // error-codes.ts declares the code; the gateway is the only emitter.
    expect(files.map((f) => f.split('/').pop()).sort()).toEqual([
      'error-codes.ts',
      'voice.gateway.ts',
    ]);

    const gateway = readFileSync(join(root, 'modules/voice/transport/voice.gateway.ts'), 'utf8');
    expect(gateway.match(/'tts_unavailable'/g) ?? []).toHaveLength(1);
  });
});
