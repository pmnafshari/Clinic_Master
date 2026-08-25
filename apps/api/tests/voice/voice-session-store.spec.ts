import type Anthropic from '@anthropic-ai/sdk';
import {
  VoiceSessionStore,
  Conversation,
} from '../../src/modules/voice/session/voice-session.store';
import { createAnonymousSession } from '../../src/modules/voice/session/voice-session';
import { redisTestProvider, testRedis } from './redis-test-util';

function conversation(text: string): Conversation {
  const history: Anthropic.MessageParam[] = [{ role: 'user', content: text }];
  return { session: createAnonymousSession(), history };
}

describe('VoiceSessionStore', () => {
  const redis = testRedis();

  // The worker's database is shared across this file, so counts and key
  // sweeps need a clean slate per test.
  beforeEach(async () => {
    await redis.flushdb();
  });

  it('stores and retrieves a conversation by session id', async () => {
    const store = new VoiceSessionStore(redis);
    const c = conversation('hello');

    await store.set(c.session.sessionId, c);

    expect(await store.get(c.session.sessionId)).toEqual(c);
  });

  it('returns undefined for an id it never issued', async () => {
    const store = new VoiceSessionStore(redis);
    expect(await store.get('not-an-id')).toBeUndefined();
  });

  it('rotate issues a new id, frees the old one, and keeps one entry', async () => {
    const store = new VoiceSessionStore(redis);
    const c = conversation('hello');
    const oldId = c.session.sessionId;
    await store.set(oldId, c);

    const newId = await store.rotate(oldId);

    expect(newId).toBeDefined();
    expect(newId).not.toBe(oldId);
    expect(await store.get(oldId)).toBeUndefined();
    // Everything but the credential is carried across unchanged; the id is
    // the one field rotation is supposed to replace. The caller's own object
    // still names the old id — the store rotates its copy, which is why
    // callers take the new id from the return value.
    const moved = (await store.get(newId as string))!;
    expect(moved.history).toEqual(c.history);
    expect(moved.session).toEqual({ ...c.session, sessionId: newId });
    expect(await store.count()).toBe(1);
  });

  it('rotate leaves the persisted record naming its own new id', async () => {
    const store = new VoiceSessionStore(redis);
    const c = conversation('hello');
    await store.set(c.session.sessionId, c);

    const newId = await store.rotate(c.session.sessionId);

    // The store round-trips through Redis, so it rotates its own copy — the
    // caller's object still names the old id. What must hold is that the
    // record now in Redis knows the new one; callers take it from the return
    // value, which is why the HTTP endpoint returns that rather than re-reading
    // the object it passed in.
    const persisted = await store.get(newId!);
    expect(persisted!.session.sessionId).toBe(newId);
  });

  it('rotation carries the replay namespace, turn counter, log id and history across', async () => {
    const store = new VoiceSessionStore(redis);
    const c = conversation('my name is Dana');
    c.session.turnIndex = 3;
    c.session.patientId = 'patient-1';
    await store.set(c.session.sessionId, c);
    const before = {
      nonce: c.session.idempotencyNonce,
      turnIndex: c.session.turnIndex,
      logId: c.session.logId,
      patientId: c.session.patientId,
      history: c.history,
    };

    const newId = await store.rotate(c.session.sessionId) as string;
    const after = await store.get(newId) as Conversation;

    expect(after.session.idempotencyNonce).toBe(before.nonce);
    expect(after.session.turnIndex).toBe(before.turnIndex);
    expect(after.session.logId).toBe(before.logId);
    expect(after.session.patientId).toBe(before.patientId);
    expect(after.history).toEqual(before.history);
  });

  it('rotate returns undefined for an unknown id and creates nothing', async () => {
    const store = new VoiceSessionStore(redis);

    expect(await store.rotate('never-issued')).toBeUndefined();
    expect(await store.count()).toBe(0);
  });

  it('issues rotated ids with the same entropy as the original', async () => {
    const store = new VoiceSessionStore(redis);
    const c = conversation('hello');
    await store.set(c.session.sessionId, c);

    const newId = await store.rotate(c.session.sessionId) as string;

    // 32 bytes base64url with no padding is exactly 43 characters.
    expect(newId).toHaveLength(43);
    expect(newId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
