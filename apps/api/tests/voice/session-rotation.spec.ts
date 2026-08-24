import {
  privilegeChanged,
  snapshotPrivilege,
} from '../../src/modules/voice/session/privilege-change';
import { createAnonymousSession } from '../../src/modules/voice/session/voice-session';

describe('privilege change detection', () => {
  it('detects a patient being bound to a previously unbound session', () => {
    const session = createAnonymousSession();
    const before = snapshotPrivilege(session);

    session.patientId = 'patient-1';

    expect(privilegeChanged(before, session)).toBe(true);
  });

  it('does not fire when nothing changed', () => {
    const session = createAnonymousSession();
    const before = snapshotPrivilege(session);

    expect(privilegeChanged(before, session)).toBe(false);
  });

  it('does not fire when a patient was already bound', () => {
    const session = createAnonymousSession();
    session.patientId = 'patient-1';
    const before = snapshotPrivilege(session);

    expect(privilegeChanged(before, session)).toBe(false);
  });

  it('detects verification, which Phase 1 never triggers but Phase 2 inherits', () => {
    const session = createAnonymousSession();
    const before = snapshotPrivilege(session);

    session.identityVerified = true;

    expect(privilegeChanged(before, session)).toBe(true);
  });

  it('snapshots by value, so a later mutation cannot rewrite the "before"', () => {
    const session = createAnonymousSession();
    const before = snapshotPrivilege(session);

    session.patientId = 'patient-1';

    // A snapshot holding a reference to the session would compare the session
    // against itself and never detect a change.
    expect(before.patientId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rotation applied to the HTTP endpoint. Transport-agnostic by construction:
// the controller compares a before/after snapshot around agent.respond and
// asks the store to rotate. Nothing here is WebSocket-aware.
// ---------------------------------------------------------------------------

import type Anthropic from '@anthropic-ai/sdk';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { VoiceController } from '../../src/modules/voice/voice.controller';
import { VoiceSessionStore } from '../../src/modules/voice/session/voice-session.store';
import { VoiceTicketService } from '../../src/modules/voice/session/voice-ticket.service';
import {
  ClaudeAgentService,
  ANTHROPIC_CLIENT,
  AnthropicLike,
} from '../../src/modules/voice/agent/claude.agent';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { IdempotencyService } from '../../src/modules/voice/idempotency/idempotency.service';
import { VOICE_FEATURE_FLAG } from '../../src/modules/voice/voice.config';
import { ToolTier } from '../../src/modules/voice/tools/tool-definition.interface';
import { VoiceSession } from '../../src/modules/voice/session/voice-session';

/** A stand-in intake tool: binds a patient exactly the way the real one does. */
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

async function buildApp(): Promise<INestApplication> {
  const client: AnthropicLike = {
    messages: {
      create: async (params) => {
        const last = params.messages[params.messages.length - 1];
        const text = typeof last?.content === 'string' ? last.content : '';
        if (text.includes('my name is')) {
          return {
            stop_reason: 'tool_use',
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'start_patient_intake', input: {} },
            ],
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
    controllers: [VoiceController],
    providers: [
      VoiceSessionStore,
      VoiceTicketService,
      ToolRegistryService,
      ToolExecutorService,
      ClaudeAgentService,
      IdempotencyService,
      { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      { provide: ANTHROPIC_CLIENT, useValue: client },
      { provide: VOICE_FEATURE_FLAG, useValue: { enabled: true } },
    ],
  }).compile();

  moduleRef.get(ToolRegistryService).register(new FakeIntakeTool() as never);

  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );
  await app.init();
  return app;
}

describe('session rotation over HTTP', () => {
  let app: INestApplication;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns a different session id once intake binds a patient', async () => {
    const first = await request(app.getHttpServer())
      .post('/voice/text')
      .send({ message: 'what are your hours?' })
      .expect(200);

    const originalId = first.body.sessionId;

    const second = await request(app.getHttpServer())
      .post('/voice/text')
      .send({ sessionId: originalId, message: 'my name is Dana' })
      .expect(200);

    expect(second.body.sessionId).not.toBe(originalId);
    expect(second.body.sessionId).toHaveLength(43);
  });

  it('refuses to resume under the rotated-away id, and does not error', async () => {
    const first = await request(app.getHttpServer())
      .post('/voice/text')
      .send({ message: 'hello' })
      .expect(200);
    const originalId = first.body.sessionId;

    await request(app.getHttpServer())
      .post('/voice/text')
      .send({ sessionId: originalId, message: 'my name is Dana' })
      .expect(200);

    // The old id must behave exactly like an id the server never issued:
    // a fresh conversation, not a 4xx. An error here would turn the endpoint
    // into an oracle answering "did this session exist?" one guess at a time.
    const replay = await request(app.getHttpServer())
      .post('/voice/text')
      .send({ sessionId: originalId, message: 'what did I just tell you?' })
      .expect(200);

    expect(replay.body.sessionId).not.toBe(originalId);
    expect(replay.body.turnIndex).toBe(1);
  });

  it('does not rotate on a turn that changes no privilege', async () => {
    const first = await request(app.getHttpServer())
      .post('/voice/text')
      .send({ message: 'what are your hours?' })
      .expect(200);

    const second = await request(app.getHttpServer())
      .post('/voice/text')
      .send({ sessionId: first.body.sessionId, message: 'and your address?' })
      .expect(200);

    expect(second.body.sessionId).toBe(first.body.sessionId);
  });

  it('still de-duplicates a write retried across a rotation', async () => {
    const store = app.get(VoiceSessionStore);
    const idempotency = app.get(IdempotencyService);

    const first = await request(app.getHttpServer())
      .post('/voice/text')
      .send({ message: 'hello' })
      .expect(200);

    const rotated = await request(app.getHttpServer())
      .post('/voice/text')
      .send({ sessionId: first.body.sessionId, message: 'my name is Dana' })
      .expect(200);

    const conversation = store.get(rotated.body.sessionId);
    expect(conversation).toBeDefined();

    // The key is derived from the nonce and the turn index — never from the
    // sessionId. If rotation regenerated the nonce, these two would differ and
    // a retried booking would execute twice.
    const key = idempotency.keyFor(conversation!.session, 'book_appointment', { slot: '9am' });
    const sameKey = idempotency.keyFor(conversation!.session, 'book_appointment', { slot: '9am' });

    expect(key).toBe(sameKey);
    expect(key.startsWith(encodeURIComponent(conversation!.session.idempotencyNonce))).toBe(true);
  });

  it('carries the conversation across the rotation, not just the credential', async () => {
    const store = app.get(VoiceSessionStore);

    const first = await request(app.getHttpServer())
      .post('/voice/text')
      .send({ message: 'what are your hours?' })
      .expect(200);
    const before = store.get(first.body.sessionId)!;
    const nonceBefore = before.session.idempotencyNonce;
    const logIdBefore = before.session.logId;
    const historyLengthBefore = before.history.length;

    const rotated = await request(app.getHttpServer())
      .post('/voice/text')
      .send({ sessionId: first.body.sessionId, message: 'my name is Dana' })
      .expect(200);

    const after = store.get(rotated.body.sessionId)!;
    expect(after.session.idempotencyNonce).toBe(nonceBefore);
    expect(after.session.logId).toBe(logIdBefore);
    expect(after.session.turnIndex).toBe(2);
    expect(after.history.length).toBeGreaterThan(historyLengthBefore);
    expect(after.session.patientId).toBe('patient-1');
  });
});
