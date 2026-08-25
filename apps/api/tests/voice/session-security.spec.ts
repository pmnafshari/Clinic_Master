import type Anthropic from '@anthropic-ai/sdk';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';

import {
  VoiceController,
  MAX_ACTIVE_SESSIONS,
} from '../../src/modules/voice/voice.controller';
import { VoiceSessionStore } from '../../src/modules/voice/session/voice-session.store';
import { VoiceTicketService } from '../../src/modules/voice/session/voice-ticket.service';
import { VoiceTextDto } from '../../src/modules/voice/dto/voice-text.dto';
import {
  ClaudeAgentService,
  ANTHROPIC_CLIENT,
  AnthropicLike,
} from '../../src/modules/voice/agent/claude.agent';
import { createAnonymousSession } from '../../src/modules/voice/session/voice-session';
import { ToolRegistryService } from '../../src/modules/voice/tools/tool-registry.service';
import { ToolExecutorService } from '../../src/modules/voice/tools/tool-executor.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { IdempotencyService } from '../../src/modules/voice/idempotency/idempotency.service';
import { VoiceToolResult } from '../../src/modules/voice/tools/tool-definition.interface';
import { VOICE_FEATURE_FLAG } from '../../src/modules/voice/voice.config';
import { redisTestProvider, testRedis } from './redis-test-util';

/**
 * Every model call the agent makes, so a test can inspect what conversation
 * history was actually sent — which is how "did this caller inherit someone
 * else's conversation?" is answered without trusting the response body.
 */
interface Harness {
  app: INestApplication;
  controller: VoiceController;
  idempotency: IdempotencyService;
  modelCalls: Anthropic.MessageCreateParamsNonStreaming[];
  bookOperation: jest.Mock<Promise<VoiceToolResult>, []>;
  keysUsed: string[];
  store: VoiceSessionStore;
}

function lastUserText(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const last = params.messages[params.messages.length - 1];
  return typeof last?.content === 'string' ? last.content : '';
}

async function buildHarness(): Promise<Harness> {
  const modelCalls: Anthropic.MessageCreateParamsNonStreaming[] = [];

  /**
   * A stand-in Anthropic client. It asks for the booking tool when the caller
   * says "book" and otherwise answers in plain text, so filler traffic never
   * touches the idempotency store.
   */
  const client: AnthropicLike = {
    messages: {
      create: async (params) => {
        modelCalls.push(params);
        const wantsBooking = lastUserText(params).includes('book');
        return (
          wantsBooking
            ? {
                stop_reason: 'tool_use',
                content: [
                  { type: 'tool_use', id: 'tu_1', name: 'book_appointment', input: {} },
                ],
              }
            : {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'Understood.', citations: null }],
              }
        ) as unknown as Anthropic.Message;
      },
    },
  };

  const moduleRef: TestingModule = await Test.createTestingModule({
    controllers: [VoiceController],
    providers: [
      redisTestProvider(),
      VoiceSessionStore,
      VoiceTicketService,
      ToolRegistryService,
      ToolExecutorService,
      ClaudeAgentService,
      IdempotencyService,
      // The executor audits every call; what it writes is tool-audit.spec.ts's
      // subject, and this module deliberately stays away from Postgres.
      { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
      { provide: ANTHROPIC_CLIENT, useValue: client },
      { provide: VOICE_FEATURE_FLAG, useValue: { enabled: true } },
    ],
  }).compile();

  const idempotency = moduleRef.get(IdempotencyService);
  const registry = moduleRef.get(ToolRegistryService);

  const bookOperation = jest
    .fn<Promise<VoiceToolResult>, []>()
    .mockResolvedValue({ status: 'confirmed', appointmentId: 'appt-1' });
  const keysUsed: string[] = [];

  // Stands in for the real write tools, which guard themselves exactly this way.
  registry.register({
    name: 'book_appointment',
    tier: 'public',
    description: 'book an appointment',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async (_input, session) => {
      const key = idempotency.keyFor(session, 'book_appointment', _input);
      keysUsed.push(key);
      return idempotency.runOnce(key, bookOperation);
    },
  });

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })
  );
  await app.init();

  return {
    app,
    store: app.get(VoiceSessionStore),
    controller: moduleRef.get(VoiceController),
    idempotency,
    modelCalls,
    bookOperation,
    keysUsed,
  };
}

function post(app: INestApplication, body: Record<string, unknown>) {
  return request(app.getHttpServer()).post('/api/voice/text').send(body);
}

/**
 * CRITICAL 1 — a sessionId is a bearer of conversation state. If the client
 * chooses it, or if the server adopts an id it never issued, then guessing an id
 * joins a stranger's live conversation: their history replays into the model,
 * and whatever intake collected from them (name, phone, date of birth) can be
 * read straight back out.
 */
describe('session ids are server-issued and unguessable', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('issues a session id on first contact, with no id supplied by the client', async () => {
    const response = await post(harness.app, { message: 'hello' }).expect(200);

    expect(typeof response.body.sessionId).toBe('string');
    expect(response.body.turnIndex).toBe(1);
  });

  it('never adopts a client-supplied session id', async () => {
    const response = await post(harness.app, {
      sessionId: 'sess-chosen-by-client',
      message: 'hello',
    }).expect(200);

    expect(response.body.sessionId).toBeDefined();
    expect(response.body.sessionId).not.toBe('sess-chosen-by-client');
  });

  it('issues ids with enough entropy that they cannot be enumerated', async () => {
    const issued = new Set<string>();

    for (let i = 0; i < 25; i += 1) {
      const response = await post(harness.app, { message: 'hello' }).expect(200);
      issued.add(response.body.sessionId);
      // A short or low-entropy id ("1", "sess-4") is the whole vulnerability.
      expect(String(response.body.sessionId).length).toBeGreaterThanOrEqual(22);
      expect(String(response.body.sessionId)).toMatch(/^[A-Za-z0-9_-]+$/);
    }

    expect(issued.size).toBe(25);
  });

  it('resumes a conversation only under the id the server issued', async () => {
    const first = await post(harness.app, { sessionId: 'sess-seed', message: 'hello' }).expect(
      200
    );
    const issued = first.body.sessionId;

    const second = await post(harness.app, { sessionId: issued, message: 'again' }).expect(200);

    expect(second.body.sessionId).toBe(issued);
    expect(second.body.turnIndex).toBe(2);
  });

  /** The attack, end to end. */
  it('does not hand a guessed session id another caller\'s conversation', async () => {
    /**
     * The id the attacker can actually produce: a short, structured guess. It
     * is also the id the victim's client sent on first contact, which under the
     * pre-fix design became the key their conversation was stored under — so
     * this setup exercises the vulnerability rather than working around it.
     */
    const guessableId = 'sess-victim';

    const victimFirst = await post(harness.app, {
      sessionId: guessableId,
      message: 'my phone number is five five five oh one nine nine',
    }).expect(200);

    // The victim continues under whichever id is authoritative for them.
    const victimSessionId = victimFirst.body.sessionId ?? guessableId;
    await post(harness.app, {
      sessionId: victimSessionId,
      message: 'and my date of birth is the third of March',
    }).expect(200);

    const callsBeforeAttack = harness.modelCalls.length;

    // A different caller guesses.
    const attacker = await post(harness.app, {
      sessionId: guessableId,
      message: 'what is my phone number',
    }).expect(200);

    // The attacker gets a fresh conversation, not the victim's.
    expect(attacker.body.turnIndex).toBe(1);
    expect(attacker.body.sessionId).toBeDefined();
    expect(attacker.body.sessionId).not.toBe(victimSessionId);
    expect(attacker.body.sessionId).not.toBe(guessableId);

    // And nothing the victim said was replayed into the model on their behalf.
    const attackerCalls = harness.modelCalls.slice(callsBeforeAttack);
    expect(attackerCalls.length).toBeGreaterThan(0);
    const sentToModel = JSON.stringify(attackerCalls);
    expect(sentToModel).not.toContain('five five five');
    expect(sentToModel).not.toContain('third of March');
  });

  it('does not reveal which session ids exist', async () => {
    const real = await post(harness.app, { sessionId: 'sess-seed', message: 'hello' }).expect(200);

    // A known-good id and a fabricated one must be indistinguishable from
    // outside: both answer 200, so the endpoint is not an existence oracle.
    await post(harness.app, { sessionId: real.body.sessionId, message: 'hi' }).expect(200);
    await post(harness.app, { sessionId: 'definitely-not-a-real-session', message: 'hi' }).expect(
      200
    );
  });

  it('keeps two enumerating callers isolated from each other', async () => {
    const first = await post(harness.app, { sessionId: 'guess-0001', message: 'hello' }).expect(
      200
    );
    const second = await post(harness.app, { sessionId: 'guess-0001', message: 'hello' }).expect(
      200
    );

    expect(first.body.sessionId).not.toBe(second.body.sessionId);
    expect(second.body.turnIndex).toBe(1);
  });
});

/**
 * CRITICAL 2 — session eviction versus the idempotency cache.
 *
 * The session store's size cap can evict a live caller. Under the original
 * design their next turn recreated a session under the same id with turnIndex
 * back at 0, while `completed` still held `sessionId:turnIndex:tool` from before
 * the eviction. runOnce then replayed a stale `confirmed` and the tool never
 * ran — the agent tells a patient a booking is confirmed that was never made.
 *
 * Binding the key to a per-session nonce instead of the sessionId closes it: a
 * recreated session gets a fresh nonce, so it cannot address the old namespace.
 */
describe('an evicted session cannot replay a stale confirmed write', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  /**
   * Fills the session store past its cap using the controller directly. Each
   * call creates one session whichever way ids are issued, so this drives the
   * SIZE-CAP eviction path specifically — not the TTL path, which would also
   * expire the idempotency entry and make the assertions below pass for the
   * wrong reason.
   */
  /**
   * Makes a live session disappear, the way one does in production.
   *
   * This used to flood the store past MAX_ACTIVE_SESSIONS to force count-based
   * eviction. That mechanism no longer exists: the store moved to Redis so
   * instances can share it, and Redis bounds the keyspace by TTL and by its
   * configured memory policy rather than by counting entries.
   *
   * The property under test is unchanged and is not about *why* the session
   * went away — it is that a caller returning with an id the server no longer
   * holds gets a fresh session, and that the fresh session cannot replay the
   * old one's idempotency namespace. Expiring the key directly reproduces that
   * exactly, and does it in one operation rather than a thousand.
   */
  async function makeSessionDisappear(sessionId: string): Promise<void> {
    await harness.store.delete(sessionId);
  }

  /**
   * A literal, for the same reason voice-config.spec pins maxTokens and
   * voice-endpoint.spec pins MAX_HISTORY_TURNS. The
   * number is a deliberate capacity choice; if it changes on purpose, change
   * this literal too rather than deleting it.
   */
  it('keeps a deliberate session capacity', () => {
    expect(MAX_ACTIVE_SESSIONS).toBe(1000);
  });

  it('re-executes the write instead of replaying the pre-eviction result', async () => {
    // Seeded with an explicit id so the setup also succeeds against the pre-fix
    // implementation, which required one.
    const first = await post(harness.app, {
      sessionId: 'sess-caller',
      message: 'please book me in',
    }).expect(200);
    const sessionId = first.body.sessionId ?? 'sess-caller';

    expect(harness.bookOperation).toHaveBeenCalledTimes(1);
    expect(harness.keysUsed).toHaveLength(1);
    const keyBeforeEviction = harness.keysUsed[0];

    await makeSessionDisappear(sessionId);

    // The caller comes back with the id they were given.
    const afterEviction = await post(harness.app, {
      sessionId,
      message: 'please book me in',
    }).expect(200);

    // Guard 1: the session really was evicted. A surviving session would be on
    // turn 2, so without this the test could pass having evicted nothing.
    expect(afterEviction.body.turnIndex).toBe(1);

    // Guard 2: the pre-eviction entry is still cached, so any re-execution below
    // is caused by the key namespace changing — not by the entry having quietly
    // expired. This is what stops the test passing for the wrong reason.
    const probe = jest
      .fn<Promise<VoiceToolResult>, []>()
      .mockResolvedValue({ status: 'confirmed', appointmentId: 'probe' });
    const replayed = await harness.idempotency.runOnce(keyBeforeEviction, probe);
    expect(probe).not.toHaveBeenCalled();
    expect(replayed.appointmentId).toBe('appt-1');

    // The claim: the booking actually happened a second time.
    expect(harness.keysUsed).toHaveLength(2);
    expect(harness.keysUsed[1]).not.toBe(keyBeforeEviction);
    expect(harness.bookOperation).toHaveBeenCalledTimes(2);
  });

  it('still de-duplicates a retry within one live session', async () => {
    const first = await post(harness.app, {
      sessionId: 'sess-retry',
      message: 'please book me in',
    }).expect(200);
    const sessionId = first.body.sessionId ?? 'sess-retry';

    expect(harness.bookOperation).toHaveBeenCalledTimes(1);

    // The same turn's key must still collapse a repeat — the nonce change must
    // not have turned idempotency off.
    const key = harness.keysUsed[0];
    const retry = jest
      .fn<Promise<VoiceToolResult>, []>()
      .mockResolvedValue({ status: 'confirmed', appointmentId: 'second' });
    const replay = await harness.idempotency.runOnce(key, retry);

    expect(retry).not.toHaveBeenCalled();
    expect(replay.appointmentId).toBe('appt-1');
    expect(sessionId).toBeDefined();
  });

  /**
   * The nonce is defence in depth, and this is the test that isolates it.
   *
   * At the endpoint, an evicted caller is already safe for a second reason:
   * they are issued a brand new sessionId, so a sessionId-derived key would
   * differ anyway. That makes the endpoint test above pass even with the key
   * derivation reverted — it proves the outcome, not the mechanism.
   *
   * So this drives the collision directly: the same sessionId, the same
   * turnIndex, a different session object — exactly what eviction and
   * recreation produce, and exactly what a future session store keyed on
   * something stable (a phone number, in the phone phase) would produce on
   * every call.
   */
  it('will not collide even if two sessions ever share a sessionId', async () => {
    const before = createAnonymousSession('sess-stable');
    const after = createAnonymousSession('sess-stable');
    before.turnIndex = 1;
    after.turnIndex = 1;

    const input = { startTime: '2026-09-01T09:00:00.000Z' };
    const keyBefore = harness.idempotency.keyFor(before, 'book_appointment', input);
    const keyAfter = harness.idempotency.keyFor(after, 'book_appointment', input);

    expect(before.sessionId).toBe(after.sessionId);
    expect(before.turnIndex).toBe(after.turnIndex);
    expect(keyAfter).not.toBe(keyBefore);

    // And the consequence that matters: the write runs again rather than
    // replaying the earlier session's confirmation.
    const original = jest
      .fn<Promise<VoiceToolResult>, []>()
      .mockResolvedValue({ status: 'confirmed', appointmentId: 'appt-before' });
    const recreated = jest
      .fn<Promise<VoiceToolResult>, []>()
      .mockResolvedValue({ status: 'confirmed', appointmentId: 'appt-after' });

    await harness.idempotency.runOnce(keyBefore, original);
    const result = await harness.idempotency.runOnce(keyAfter, recreated);

    expect(recreated).toHaveBeenCalledTimes(1);
    expect(result.appointmentId).toBe('appt-after');
  });

  it('gives every session its own idempotency namespace', async () => {
    await post(harness.app, { sessionId: 'sess-one', message: 'please book me in' }).expect(200);
    await post(harness.app, { sessionId: 'sess-two', message: 'please book me in' }).expect(200);

    expect(harness.keysUsed).toHaveLength(2);
    expect(harness.keysUsed[0]).not.toBe(harness.keysUsed[1]);
    expect(harness.bookOperation).toHaveBeenCalledTimes(2);
  });
});
