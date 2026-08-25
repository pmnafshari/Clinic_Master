import { Redis } from 'ioredis';
import type Anthropic from '@anthropic-ai/sdk';

import { VoiceSessionStore, Conversation } from '../../src/modules/voice/session/voice-session.store';
import { createAnonymousSession } from '../../src/modules/voice/session/voice-session';
import { IdempotencyService } from '../../src/modules/voice/idempotency/idempotency.service';
import { VoiceToolResult } from '../../src/modules/voice/tools/tool-definition.interface';

const URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * Two stores over two connections stand in for two API instances. That is the
 * whole point of the migration: a caller's second turn may land anywhere.
 */
function connect(): Redis {
  return new Redis(URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
}

function conversation(text: string): Conversation {
  const history: Anthropic.MessageParam[] = [{ role: 'user', content: text }];
  return { session: createAnonymousSession(), history };
}

const confirmed: VoiceToolResult = { status: 'confirmed', appointmentId: 'a1' } as VoiceToolResult;

describe('sessions are visible across instances', () => {
  let a: Redis;
  let b: Redis;
  let instanceA: VoiceSessionStore;
  let instanceB: VoiceSessionStore;

  beforeAll(async () => {
    a = connect();
    b = connect();
    await a.connect();
    await b.connect();
  });

  afterAll(async () => {
    await a.quit();
    await b.quit();
  });

  beforeEach(async () => {
    await a.flushdb();
    instanceA = new VoiceSessionStore(a);
    instanceB = new VoiceSessionStore(b);
  });

  it('lets a second instance read a session the first one created', async () => {
    const c = conversation('what are your hours?');
    await instanceA.set(c.session.sessionId, c);

    const seen = await instanceB.get(c.session.sessionId);

    expect(seen).toBeDefined();
    expect(seen!.session.sessionId).toBe(c.session.sessionId);
    expect(seen!.history).toEqual(c.history);
  });

  it('carries the whole session record, not just the id', async () => {
    const c = conversation('my name is Dana');
    c.session.turnIndex = 3;
    c.session.patientId = 'patient-1';
    c.session.identityVerified = true;
    c.session.userId = 'user-1';
    await instanceA.set(c.session.sessionId, c);

    const seen = ((await instanceB.get(c.session.sessionId)))!;

    expect(seen.session.idempotencyNonce).toBe(c.session.idempotencyNonce);
    expect(seen.session.logId).toBe(c.session.logId);
    expect(seen.session.turnIndex).toBe(3);
    expect(seen.session.patientId).toBe('patient-1');
    expect(seen.session.identityVerified).toBe(true);
    expect(seen.session.userId).toBe('user-1');
  });

  it('returns undefined for an id no instance ever issued', async () => {
    expect(await instanceB.get('never-issued')).toBeUndefined();
  });

  it('makes a delete on one instance visible to the other', async () => {
    const c = conversation('hello');
    await instanceA.set(c.session.sessionId, c);
    await instanceA.delete(c.session.sessionId);

    expect(await instanceB.get(c.session.sessionId)).toBeUndefined();
  });
});

describe('rotation across instances uses RENAME and preserves the namespace', () => {
  let a: Redis;
  let b: Redis;
  let instanceA: VoiceSessionStore;
  let instanceB: VoiceSessionStore;

  beforeAll(async () => {
    a = connect(); b = connect();
    await a.connect(); await b.connect();
  });
  afterAll(async () => { await a.quit(); await b.quit(); });
  beforeEach(async () => {
    await a.flushdb();
    instanceA = new VoiceSessionStore(a);
    instanceB = new VoiceSessionStore(b);
  });

  it('rotates on one instance and the other sees only the new id', async () => {
    const c = conversation('my name is Dana');
    const oldId = c.session.sessionId;
    await instanceA.set(oldId, c);

    const newId = await instanceA.rotate(oldId);

    expect(newId).toBeDefined();
    expect(newId).not.toBe(oldId);
    // The old credential is dead everywhere, not just where it rotated.
    expect(await instanceB.get(oldId)).toBeUndefined();
    expect(await instanceB.get(newId!)).toBeDefined();
  });

  it('carries the replay namespace and turn counter across the rotation', async () => {
    const c = conversation('my name is Dana');
    c.session.turnIndex = 4;
    const nonce = c.session.idempotencyNonce;
    const logId = c.session.logId;
    await instanceA.set(c.session.sessionId, c);

    const newId = (await instanceA.rotate(c.session.sessionId))!;
    const after = ((await instanceB.get(newId)))!;

    // If rotation regenerated either, a retry spanning it would run a write twice.
    expect(after.session.idempotencyNonce).toBe(nonce);
    expect(after.session.turnIndex).toBe(4);
    expect(after.session.logId).toBe(logId);
    expect(after.session.sessionId).toBe(newId);
  });

  it('preserves the remaining TTL rather than restarting it', async () => {
    const c = conversation('hello');
    await instanceA.set(c.session.sessionId, c);
    // Age the key so a restarted TTL would be obvious.
    await a.expire(`voice:session:${c.session.sessionId}`, 100);

    const newId = (await instanceA.rotate(c.session.sessionId))!;
    const ttl = await b.ttl(`voice:session:${newId}`);

    // RENAME moves the TTL with the value; SET+DEL would have reset it to 1800.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(100);
  });

  it('returns undefined when rotating an id no instance holds', async () => {
    expect(await instanceA.rotate('never-issued')).toBeUndefined();
    expect(await instanceA.count()).toBe(0);
  });
});

describe('sessions expire', () => {
  let a: Redis;
  let store: VoiceSessionStore;

  beforeAll(async () => { a = connect(); await a.connect(); });
  afterAll(async () => { await a.quit(); });
  beforeEach(async () => { await a.flushdb(); store = new VoiceSessionStore(a); });

  it('sets a TTL so an abandoned conversation cleans itself up', async () => {
    const c = conversation('hello');
    await store.set(c.session.sessionId, c);

    const ttl = await a.ttl(`voice:session:${c.session.sessionId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1800);
  });

  it('refreshes the TTL on each turn, so an active caller is not dropped', async () => {
    const c = conversation('hello');
    await store.set(c.session.sessionId, c);
    await a.expire(`voice:session:${c.session.sessionId}`, 10);

    await store.set(c.session.sessionId, c);

    expect(await a.ttl(`voice:session:${c.session.sessionId}`)).toBeGreaterThan(100);
  });

  it('is gone once the key expires', async () => {
    const c = conversation('hello');
    await store.set(c.session.sessionId, c);
    await a.pexpire(`voice:session:${c.session.sessionId}`, 30);
    await new Promise((r) => setTimeout(r, 120));

    expect(await store.get(c.session.sessionId)).toBeUndefined();
  });
});

describe('idempotency is shared across instances', () => {
  let a: Redis;
  let b: Redis;
  let instanceA: IdempotencyService;
  let instanceB: IdempotencyService;

  beforeAll(async () => { a = connect(); b = connect(); await a.connect(); await b.connect(); });
  afterAll(async () => { await a.quit(); await b.quit(); });
  beforeEach(async () => {
    await a.flushdb();
    instanceA = new IdempotencyService(a);
    instanceB = new IdempotencyService(b);
  });

  it('replays a confirmed result to the other instance instead of re-running', async () => {
    const operation = jest.fn().mockResolvedValue(confirmed);

    const first = await instanceA.runOnce('k1', operation);
    const second = await instanceB.runOnce('k1', operation);

    expect(first).toEqual(confirmed);
    expect(second).toEqual(confirmed);
    // The booking ran once, on one instance.
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, so a retry can still succeed', async () => {
    const failed: VoiceToolResult = { status: 'failed', error: 'upstream' } as VoiceToolResult;
    const operation = jest.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(confirmed);

    expect(await instanceA.runOnce('k2', operation)).toEqual(failed);
    expect(await instanceB.runOnce('k2', operation)).toEqual(confirmed);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('lets exactly one of two concurrent instances execute the write', async () => {
    let running = 0;
    let overlapped = false;
    const operation = jest.fn(async () => {
      running += 1;
      if (running > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 120));
      running -= 1;
      return confirmed;
    });

    // Both instances take the same booking at the same moment.
    const [x, y] = await Promise.all([
      instanceA.runOnce('k3', operation),
      instanceB.runOnce('k3', operation),
    ]);

    expect(x).toEqual(confirmed);
    expect(y).toEqual(confirmed);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(overlapped).toBe(false);
  });

  it('keeps different keys independent', async () => {
    const operation = jest.fn().mockResolvedValue(confirmed);
    await Promise.all([
      instanceA.runOnce('k4', operation),
      instanceB.runOnce('k5', operation),
    ]);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('expires a cached result so the namespace does not grow forever', async () => {
    const operation = jest.fn().mockResolvedValue(confirmed);
    await instanceA.runOnce('k6', operation);

    const ttl = await a.ttl('voice:idem:k6');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);
  });

  it('releases the lease when the operation throws, so a retry is not blocked', async () => {
    const boom = jest.fn().mockRejectedValue(new Error('provider down'));
    await expect(instanceA.runOnce('k7', boom)).rejects.toThrow('provider down');

    // A stuck lease here would make the key permanently unusable.
    const recovered = jest.fn().mockResolvedValue(confirmed);
    expect(await instanceB.runOnce('k7', recovered)).toEqual(confirmed);
  });
});
