import type Anthropic from '@anthropic-ai/sdk';
import {
  VoiceSessionStore,
  Conversation,
} from '../../src/modules/voice/session/voice-session.store';
import { createAnonymousSession } from '../../src/modules/voice/session/voice-session';

function conversation(text: string): Conversation {
  const history: Anthropic.MessageParam[] = [{ role: 'user', content: text }];
  return { session: createAnonymousSession(), history };
}

describe('VoiceSessionStore', () => {
  it('stores and retrieves a conversation by session id', () => {
    const store = new VoiceSessionStore();
    const c = conversation('hello');

    store.set(c.session.sessionId, c);

    expect(store.get(c.session.sessionId)).toBe(c);
  });

  it('returns undefined for an id it never issued', () => {
    const store = new VoiceSessionStore();
    expect(store.get('not-an-id')).toBeUndefined();
  });

  it('rotate issues a new id, frees the old one, and keeps one entry', () => {
    const store = new VoiceSessionStore();
    const c = conversation('hello');
    const oldId = c.session.sessionId;
    store.set(oldId, c);

    const newId = store.rotate(oldId);

    expect(newId).toBeDefined();
    expect(newId).not.toBe(oldId);
    expect(store.get(oldId)).toBeUndefined();
    expect(store.get(newId as string)).toBe(c);
    expect(store.size).toBe(1);
  });

  it('rotate updates the session record so it knows its own new id', () => {
    const store = new VoiceSessionStore();
    const c = conversation('hello');
    store.set(c.session.sessionId, c);

    const newId = store.rotate(c.session.sessionId);

    expect(c.session.sessionId).toBe(newId);
  });

  it('rotation carries the replay namespace, turn counter, log id and history across', () => {
    const store = new VoiceSessionStore();
    const c = conversation('my name is Dana');
    c.session.turnIndex = 3;
    c.session.patientId = 'patient-1';
    store.set(c.session.sessionId, c);
    const before = {
      nonce: c.session.idempotencyNonce,
      turnIndex: c.session.turnIndex,
      logId: c.session.logId,
      patientId: c.session.patientId,
      history: c.history,
    };

    const newId = store.rotate(c.session.sessionId) as string;
    const after = store.get(newId) as Conversation;

    expect(after.session.idempotencyNonce).toBe(before.nonce);
    expect(after.session.turnIndex).toBe(before.turnIndex);
    expect(after.session.logId).toBe(before.logId);
    expect(after.session.patientId).toBe(before.patientId);
    expect(after.history).toBe(before.history);
  });

  it('rotate returns undefined for an unknown id and creates nothing', () => {
    const store = new VoiceSessionStore();

    expect(store.rotate('never-issued')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('issues rotated ids with the same entropy as the original', () => {
    const store = new VoiceSessionStore();
    const c = conversation('hello');
    store.set(c.session.sessionId, c);

    const newId = store.rotate(c.session.sessionId) as string;

    // 32 bytes base64url with no padding is exactly 43 characters.
    expect(newId).toHaveLength(43);
    expect(newId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
