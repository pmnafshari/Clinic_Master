import type Anthropic from '@anthropic-ai/sdk';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';

import { VoiceGateway } from '../../src/modules/voice/transport/voice.gateway';
import { VoiceTurnRunner } from '../../src/modules/voice/transport/voice-turn-runner';
import { AudioTransport } from '../../src/modules/voice/transport/audio-transport.interface';
import { ServerFrame } from '../../src/modules/voice/transport/frames';
import { VoiceErrorCode } from '../../src/modules/voice/transport/error-codes';
import { VoiceSessionStore } from '../../src/modules/voice/session/voice-session.store';
import { VoiceSession } from '../../src/modules/voice/session/voice-session';
import {
  ClaudeAgentService,
  ANTHROPIC_CLIENT,
  AnthropicLike,
} from '../../src/modules/voice/agent/claude.agent';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { IdempotencyService } from '../../src/modules/voice/idempotency/idempotency.service';
import { ToolTier } from '../../src/modules/voice/tools/tool-definition.interface';

/**
 * Fixtures are duplicated rather than shared with voice-gateway.spec.ts on
 * purpose: a shared harness drifts, and each spec should be readable alone.
 */
class FakeTransport implements AudioTransport {
  readonly sent: ServerFrame[] = [];
  readonly audioFrames: Buffer[] = [];
  closedWith: VoiceErrorCode | null = null;

  send(frame: ServerFrame): void {
    this.sent.push(frame);
  }
  sendAudio(chunk: Buffer): void {
    this.audioFrames.push(chunk);
  }
  close(code: VoiceErrorCode): void {
    this.closedWith = code;
  }
  onTeardown(): void {
    /* not exercised here */
  }
  typesSent(): string[] {
    return this.sent.map((f) => f.type);
  }
}

class FakeIntakeTool {
  name = 'start_patient_intake';
  description = 'collect caller details';
  tier: ToolTier = 'public';
  needsPatientContext = true;
  inputSchema = { type: 'object' as const, properties: {}, required: [] as string[] };

  async execute(_input: Record<string, unknown>, session: VoiceSession) {
    session.patientId = 'patient-1';
    return { status: 'confirmed' as const, patientId: 'patient-1' };
  }
}

async function buildGatewayWithIntake() {
  const client: AnthropicLike = {
    messages: {
      create: async (params) => {
        const last = params.messages[params.messages.length - 1];
        const text = typeof last?.content === 'string' ? last.content : '';
        if (text.includes('my name is')) {
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'start_patient_intake', input: {} }],
          } as unknown as Anthropic.Message;
        }
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Thanks, you are booked in.', citations: null }],
        } as unknown as Anthropic.Message;
      },
    },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      VoiceGateway,
      VoiceTurnRunner,
      VoiceSessionStore,
      ToolRegistryService,
      ToolExecutorService,
      ClaudeAgentService,
      IdempotencyService,
      { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      { provide: ANTHROPIC_CLIENT, useValue: client },
    ],
  }).compile();

  moduleRef.get(ToolRegistryService).register(new FakeIntakeTool() as never);

  return {
    gateway: moduleRef.get(VoiceGateway),
    store: moduleRef.get(VoiceSessionStore),
  };
}

function readyId(t: FakeTransport): string {
  return (t.sent[0] as { type: 'session.ready'; sessionId: string }).sessionId;
}

function rotatedFrames(t: FakeTransport) {
  return t.sent.filter((f) => f.type === 'session.rotated') as Array<{
    type: 'session.rotated';
    sessionId: string;
  }>;
}

describe('session rotation over the websocket', () => {
  it('emits exactly one session.rotated, before turn.complete', async () => {
    const { gateway } = await buildGatewayWithIntake();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    const originalId = readyId(transport);

    await gateway.handleFrame(transport, { type: 'turn.text', text: 'my name is Dana' });

    const rotated = rotatedFrames(transport);
    expect(rotated).toHaveLength(1);
    expect(rotated[0].sessionId).not.toBe(originalId);
    expect(rotated[0].sessionId).toHaveLength(43);

    const types = transport.typesSent();
    expect(types.indexOf('session.rotated')).toBeLessThan(types.indexOf('turn.complete'));
  });

  it('does not emit session.rotated on an ordinary turn', async () => {
    const { gateway } = await buildGatewayWithIntake();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'what are your hours?' });

    expect(transport.typesSent()).not.toContain('session.rotated');
  });

  // The transport communicates a decision it did not make. The authority is the
  // store: whatever it rotated to is exactly what goes on the wire.
  it('emits exactly the authoritative id the store rotated to', async () => {
    const { gateway, store } = await buildGatewayWithIntake();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'my name is Dana' });

    const announced = rotatedFrames(transport)[0].sessionId;
    const authoritative = store.get(announced);

    expect(authoritative).toBeDefined();
    expect(authoritative!.session.sessionId).toBe(announced);
  });

  it('accepts the new id and refuses the old one on a later frame', async () => {
    const { gateway, store } = await buildGatewayWithIntake();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    const originalId = readyId(transport);
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'my name is Dana' });
    const newId = rotatedFrames(transport)[0].sessionId;

    expect(store.get(originalId)).toBeUndefined();
    expect(store.get(newId)).toBeDefined();

    // A socket presenting the dead id gets a fresh session, not an error.
    const other = new FakeTransport();
    await gateway.handleFrame(other, { type: 'session.start', sessionId: originalId });
    const resumed = readyId(other);
    expect(resumed).not.toBe(originalId);
    expect(resumed).not.toBe(newId);
    expect(other.closedWith).toBeNull();
  });

  it('never emits the old session id again after rotation', async () => {
    const { gateway } = await buildGatewayWithIntake();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    const originalId = readyId(transport);

    await gateway.handleFrame(transport, { type: 'turn.text', text: 'my name is Dana' });
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'what are your hours?' });

    const afterRotation = JSON.stringify(transport.sent.slice(1));
    expect(afterRotation).not.toContain(originalId);
  });

  // The frame is a credential handover and nothing else. Server-side session
  // internals must not ride along on it.
  it('carries the new id and nothing else', async () => {
    const { gateway, store } = await buildGatewayWithIntake();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'my name is Dana' });

    const frame = rotatedFrames(transport)[0];
    expect(Object.keys(frame).sort()).toEqual(['sessionId', 'type']);

    const session = store.get(frame.sessionId)!.session;
    const serialised = JSON.stringify(frame);
    expect(serialised).not.toContain(session.idempotencyNonce);
    expect(serialised).not.toContain(session.logId);
    expect(serialised).not.toContain('patient-1');
    expect(serialised).not.toMatch(/patientId|userId|identityVerified|turnIndex|tier/);
  });

  it('never puts either session id in a log line', async () => {
    const logs: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((m) => {
      logs.push(String(m));
    });

    const { gateway } = await buildGatewayWithIntake();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    const originalId = readyId(transport);
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'my name is Dana' });
    const newId = rotatedFrames(transport)[0].sessionId;

    const joined = logs.join('\n');
    expect(joined).not.toContain(originalId);
    expect(joined).not.toContain(newId);
    expect(joined).toMatch(/Rotated session credential for [0-9a-f]{16}/);

    spy.mockRestore();
  });
});
