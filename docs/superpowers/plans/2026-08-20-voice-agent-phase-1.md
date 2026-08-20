# Voice Agent Phase 1 — Browser Voice (Tier 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a voice widget on a new public page so an anonymous caller can ask about the clinic, give their details, and book an appointment by speaking — without changing the Phase 0 agent, tools, authorization gate, or audit trail.

**Architecture:** A WebSocket transport sits *above* the Phase 0 agent and reaches it through the same entry point the text endpoint uses, `ClaudeAgentService.respond(session, userText, history)`. Deepgram (speech-to-text) and ElevenLabs (text-to-speech) sit behind narrow interfaces so every test runs with fakes and no network. Session state moves out of `VoiceController` into an injectable `VoiceSessionStore` that both transports share, which is what makes session-id rotation possible on both.

**Tech Stack:** NestJS 10, `@nestjs/websockets` + `@nestjs/platform-ws` over `ws`, Next.js 14 App Router, `class-validator` for frame validation, Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-08-19-voice-agent-phase-1-design.md` (commit `7dfaedf`)

## Global Constraints

- **Never modify** `claude.agent.ts`, `tool-executor.service.ts`, `tool-registry.service.ts`, `idempotency.service.ts`, or any `*.tool.ts`. If a task seems to require it, **stop and report** — that is a spec contradiction, not a judgment call.
- **The entire Phase 0 suite (374 tests) must stay green after every task, with no Phase 0 test edited.** The one exception is `voice.controller.ts`'s own tests in T0, which change only because the controller's constructor gains a dependency.
- `sessionId` is a bearer credential: **never** log it, never put it in an error, never persist it, never truncate it "just for logs". `logId` is the only session identifier allowed in observability output.
- `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY` are server-side only. Never sent to the browser, never in a page, never minted into a client token.
- Phase 1 never sets `identityVerified`. It stays `false` for every session's whole life.
- Nest packages pin to `^10` — latest is `11.x`, whose peers demand `@nestjs/common ^11`; this repo is on `10.3`.
- Every new constant gets a **literal-pinned** test: assert against a written-out value, never against the constant that defines it. Phase 0 shipped a test comparing `VOICE_CONFIG.maxTokens` to itself and it hid a real bug.
- Every security control gets a **mutation check**: break the control, prove the test goes red, restore.
- API tests live in `apps/api/tests/voice/*.spec.ts`. Web tests live in `apps/web/tests/**/*.test.tsx`.
- Run `npm run test --workspace=@smileflow/api` and `npm run lint` before every commit.

### Task order

Task IDs are the spec's. They are presented here in **dependency order**, which differs from the spec's listing in exactly one place: **T7 is presented before T6**, because T6 depends on T7. No task has been reordered relative to its dependencies, merged, split, or rescoped.

```
T0 ── T1a ── T2 ─┬─ T1b
                 ├─ T3 ── T7 ─┐
                 ├─ T4 ───────┼─ T6
                 ├─ T5 ───────┘
                 └─ T8
       T3+T4+T5 ── T9
             all ── T10
```

### Four boundaries settled before planning

These were open questions at spec approval. They are resolved here without changing architecture or dependencies:

1. **Turn dispatch converges.** T2 creates `VoiceTurnRunner.runTurn(connection, text)`. T4 calls it from `speech_final`; it does **not** write a second dispatch path.
2. **Teardown splits cleanly.** T2 creates the `onTeardown(fn)` registry and calls it. T3 owns the *triggers* (disconnect, duration caps, rate limits). T5 registers TTS `cancel()` into it. Nobody writes a second teardown path.
3. **Provider env reads belong to the task that needs them.** T4 reads `DEEPGRAM_API_KEY`, T5 reads `ELEVENLABS_API_KEY`. T10 adds the `.env.example` placeholders.
4. **Error codes are declared once, hardened later.** T2 creates `error-codes.ts` with all eight codes so T3 emits real ones instead of inventing strings. T7 owns the mapping layer and the leak-proof tests.

---

## File Structure

**API — new files**

| File | Responsibility |
|---|---|
| `src/modules/voice/session/voice-session.store.ts` | Injectable session store; get/set/delete/rekey/rotate |
| `src/modules/voice/transport/audio-transport.interface.ts` | The `AudioTransport` seam Phase 3 also implements |
| `src/modules/voice/transport/frames.ts` | Frame DTOs + validation; the wire protocol |
| `src/modules/voice/transport/error-codes.ts` | The eight enumerated client-facing codes |
| `src/modules/voice/transport/voice-turn-runner.ts` | The single agent-dispatch path |
| `src/modules/voice/transport/voice.gateway.ts` | `BrowserWebSocketTransport` — the WebSocket gateway |
| `src/modules/voice/transport/ws-origin.adapter.ts` | `WsAdapter` subclass doing origin + per-IP checks at upgrade |
| `src/modules/voice/transport/transport-limits.ts` | `WS_MAX_*` constants |
| `src/modules/voice/transport/transport-metrics.service.ts` | Connection/turn/latency metrics on `logId` |
| `src/modules/voice/speech/speech-to-text.interface.ts` | `SpeechToText` + fake |
| `src/modules/voice/speech/deepgram-stt.service.ts` | Deepgram behind the interface |
| `src/modules/voice/speech/text-to-speech.interface.ts` | `TextToSpeech` + fake |
| `src/modules/voice/speech/sentence-chunker.ts` | Sentence splitting for streaming TTS |
| `src/modules/voice/speech/elevenlabs-tts.service.ts` | ElevenLabs behind the interface |
| `src/common/config/allowed-origins.ts` | One allowlist for HTTP CORS and WS |

**API — modified**

| File | Change | Task |
|---|---|---|
| `src/modules/voice/util/bounded-ttl-map.ts` | add `delete(key)` | T0 |
| `src/modules/voice/voice.controller.ts` | session map moves out; rotation applied | T0, T1a |
| `src/modules/voice/voice.module.ts` | provide/export store; register gateway and speech services | T0, T2, T4, T5 |
| `src/main.ts` | shared origin helper; WebSocket adapter | T2, T3 |
| `src/modules/voice/voice.config.ts` | `browserEnabled` flag | T10 |

**Web — new**

| File | Responsibility |
|---|---|
| `src/app/(public)/layout.tsx` | Public shell — no staff/portal nav |
| `src/app/(public)/voice/page.tsx` | The public voice page |
| `src/components/voice/voice-widget.tsx` | Mic button, states, disclosure |
| `src/components/voice/use-voice-socket.ts` | Socket + capture + playback hook |
| `public/voice-capture-worklet.js` | `AudioWorklet` downsampler to 16 kHz PCM |

---

### Task T0: `VoiceSessionStore` extraction

**Objective:** Move conversation state out of `VoiceController`'s private field into an injectable store both transports can share, and give it the `delete`/`rekey` operations rotation needs. `BoundedTtlMap` currently exposes only `size`/`get`/`set` — there is no way to remove a key, so rotation is not expressible today.

**Dependencies:** None.

**Files:**
- Modify: `apps/api/src/modules/voice/util/bounded-ttl-map.ts`
- Create: `apps/api/src/modules/voice/session/voice-session.store.ts`
- Modify: `apps/api/src/modules/voice/voice.controller.ts:81-110,155-177`
- Modify: `apps/api/src/modules/voice/voice.module.ts`
- Test: `apps/api/tests/voice/bounded-ttl-map.spec.ts` (create)
- Test: `apps/api/tests/voice/voice-session-store.spec.ts` (create)

**Interfaces:**
- Consumes: `BoundedTtlMap`, `VoiceSession`, `newOpaqueId` (all Phase 0).
- Produces:
  - `BoundedTtlMap.delete(key: string): void`
  - `interface Conversation { session: VoiceSession; history: Anthropic.MessageParam[] }` — **exported** from the store module (it was a private interface in the controller)
  - `class VoiceSessionStore` with `get(id): Conversation | undefined`, `set(id, c): void`, `delete(id): void`, `rekey(oldId, newId): boolean`, `rotate(oldId): string | undefined`, `readonly size: number`

- [ ] **Step 1: Write the failing `delete` test**

Create `apps/api/tests/voice/bounded-ttl-map.spec.ts`:

```ts
import { BoundedTtlMap } from '../../src/modules/voice/util/bounded-ttl-map';

describe('BoundedTtlMap.delete', () => {
  it('removes only the named key', () => {
    const map = new BoundedTtlMap<string>(10, 60_000, () => 1_000);
    map.set('a', 'alpha');
    map.set('b', 'beta');

    map.delete('a');

    // Literal pins: 1 and undefined are written out, never derived from the map.
    expect(map.size).toBe(1);
    expect(map.get('a')).toBeUndefined();
    expect(map.get('b')).toBe('beta');
  });

  it('is a no-op for a key that is not present', () => {
    const map = new BoundedTtlMap<string>(10, 60_000, () => 1_000);
    map.set('a', 'alpha');

    expect(() => map.delete('missing')).not.toThrow();
    expect(map.size).toBe(1);
    expect(map.get('a')).toBe('alpha');
  });

  it('frees the slot it occupied, so the cap is not silently consumed', () => {
    const map = new BoundedTtlMap<string>(2, 60_000, () => 1_000);
    map.set('a', 'alpha');
    map.delete('a');
    map.set('b', 'beta');
    map.set('c', 'gamma');

    expect(map.size).toBe(2);
    expect(map.get('b')).toBe('beta');
    expect(map.get('c')).toBe('gamma');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test --workspace=@smileflow/api -- bounded-ttl-map`
Expected: FAIL — `map.delete is not a function`.

- [ ] **Step 3: Add `delete` to `BoundedTtlMap`**

In `bounded-ttl-map.ts`, directly after `set(...)` (line 73):

```ts
  /**
   * Removes a key outright. Rotation needs this: an old sessionId must stop
   * working the moment a new one is issued, not when its TTL happens to run
   * out — an expiring credential is still a live credential.
   */
  delete(key: string): void {
    this.entries.delete(key);
  }
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm run test --workspace=@smileflow/api -- bounded-ttl-map`
Expected: PASS, 3 tests.

- [ ] **Step 5: Mutation check — prove the test can fail**

Temporarily change the body to `// this.entries.delete(key);`. Run the test.
Expected: FAIL on all three. **Restore the line** and re-run to confirm green before continuing.

- [ ] **Step 6: Write the failing store test**

Create `apps/api/tests/voice/voice-session-store.spec.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import { VoiceSessionStore, Conversation } from '../../src/modules/voice/session/voice-session.store';
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
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npm run test --workspace=@smileflow/api -- voice-session-store`
Expected: FAIL — cannot find `voice-session.store`.

- [ ] **Step 8: Implement the store**

Create `apps/api/src/modules/voice/session/voice-session.store.ts`:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { BoundedTtlMap, Clock, VOICE_CLOCK } from '../util/bounded-ttl-map';
import { newOpaqueId, VoiceSession } from './voice-session';

/** A quiet conversation is dropped well before a real caller would return. */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/** Hard ceiling on concurrently tracked conversations. */
export const MAX_ACTIVE_SESSIONS = 1000;

export interface Conversation {
  session: VoiceSession;
  history: Anthropic.MessageParam[];
}

/**
 * The single home for conversation state.
 *
 * This used to be a private field on VoiceController. It moved out because
 * Phase 1 adds a second transport: a WebSocket gateway cannot reach a
 * controller's private map, and two stores would mean a caller's second turn
 * could land in a process-local map that has never heard of their session.
 *
 * Keeping it behind one class is also what makes the Phase 2 Redis swap a
 * one-file change — see the design doc, section 2.9.
 */
@Injectable()
export class VoiceSessionStore {
  private readonly conversations: BoundedTtlMap<Conversation>;

  constructor(@Optional() @Inject(VOICE_CLOCK) clock?: Clock) {
    this.conversations = new BoundedTtlMap<Conversation>(
      MAX_ACTIVE_SESSIONS,
      SESSION_TTL_MS,
      clock ?? (() => Date.now())
    );
  }

  get size(): number {
    return this.conversations.size;
  }

  get(sessionId: string): Conversation | undefined {
    return this.conversations.get(sessionId);
  }

  set(sessionId: string, conversation: Conversation): void {
    this.conversations.set(sessionId, conversation);
  }

  delete(sessionId: string): void {
    this.conversations.delete(sessionId);
  }

  /**
   * Moves a conversation to a new key. The write lands before the delete, so
   * there is no instant where the conversation is reachable under neither id.
   * Node runs this synchronously, which is what makes it atomic here; the
   * Redis equivalent is a single RENAME (design doc 2.9).
   */
  rekey(oldId: string, newId: string): boolean {
    const conversation = this.conversations.get(oldId);
    if (!conversation) {
      return false;
    }

    this.conversations.set(newId, conversation);
    this.conversations.delete(oldId);
    return true;
  }

  /**
   * Issues a fresh credential for an existing conversation and invalidates the
   * old one immediately.
   *
   * Only `sessionId` changes. `idempotencyNonce`, `turnIndex` and `logId` are
   * carried across deliberately: idempotency keys are derived from the nonce
   * and the turn index, so regenerating either would open a fresh replay
   * namespace and let a retry that spans a rotation execute a write twice.
   */
  rotate(oldId: string): string | undefined {
    const conversation = this.conversations.get(oldId);
    if (!conversation) {
      return undefined;
    }

    const newId = newOpaqueId();
    conversation.session.sessionId = newId;
    this.rekey(oldId, newId);
    return newId;
  }
}
```

- [ ] **Step 9: Run and watch it pass**

Run: `npm run test --workspace=@smileflow/api -- voice-session-store`
Expected: PASS, 7 tests.

- [ ] **Step 10: Migrate `VoiceController` onto the store**

In `voice.controller.ts`: delete the local `interface Conversation` (lines 81-84) and the `SESSION_TTL_MS` / `MAX_ACTIVE_SESSIONS` constants (lines 22-25), re-exporting them so Phase 0 tests that import them from here keep working:

```ts
import { Conversation, VoiceSessionStore } from './session/voice-session.store';

export { SESSION_TTL_MS, MAX_ACTIVE_SESSIONS } from './session/voice-session.store';
```

Replace the constructor and the private field (lines 96-110) with:

```ts
  constructor(
    private agent: ClaudeAgentService,
    private sessions: VoiceSessionStore,
    @Optional()
    @Inject(VOICE_FEATURE_FLAG)
    private readonly flag: VoiceFeatureFlag = VOICE_CONFIG
  ) {}
```

Delete the now-unused `BoundedTtlMap` / `Clock` / `VOICE_CLOCK` import. The body of `text()` is unchanged — `this.sessions.get(...)` and `this.sessions.set(...)` keep the same signatures.

- [ ] **Step 11: Register the store in the module**

In `voice.module.ts`, add `VoiceSessionStore` to `providers`, and add it to `exports` so the gateway can inject it in T2:

```ts
import { VoiceSessionStore } from './session/voice-session.store';
// providers: [..., VoiceSessionStore],
// exports: [ToolRegistryService, ToolExecutorService, VoiceSessionStore],
```

- [ ] **Step 12: Update the two Phase 0 harnesses that construct the controller directly**

`voice-endpoint.spec.ts` and `session-security.spec.ts` build a `TestingModule` listing providers explicitly. Add `VoiceSessionStore` to both provider arrays. This is the **only** Phase 0 test change permitted in this plan, and it is a constructor-dependency addition, not a changed assertion.

- [ ] **Step 13: Run the whole suite**

Run: `npm run test --workspace=@smileflow/api`
Expected: PASS — 384 tests (374 Phase 0 + 10 new). Zero Phase 0 assertions modified.

- [ ] **Step 14: Typecheck, lint, commit**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json
cd ../.. && npm run lint
git add apps/api/src/modules/voice apps/api/tests/voice
git commit -m "refactor(voice): extract VoiceSessionStore and add map deletion"
```

**Acceptance criteria:**
- `BoundedTtlMap.delete` removes one key, leaves others, no-ops on absent keys, frees the capacity slot.
- `VoiceSessionStore.rotate` issues a 43-char base64url id, invalidates the old, keeps `size` at 1.
- Rotation preserves `idempotencyNonce`, `turnIndex`, `logId`, `patientId`, and the history array identity.
- Full Phase 0 suite green with no assertion edited.

**Security checks:**
- `rotate` uses `newOpaqueId()` (256 CSPRNG bits) — never a counter, timestamp, or derived value.
- No `sessionId` appears in any log line added by this task (none should be added at all).
- The old id is *deleted*, not left to expire.

**Mutation/negative tests:**
- `delete` body commented out → all three `delete` tests fail (Step 5, mandatory).
- Additionally: change `rotate` to skip `this.rekey(...)` → the "frees the old one" test must fail.

**Rollback conditions:** Roll back if any Phase 0 test fails for a reason other than a missing `VoiceSessionStore` provider, or if `size` accounting changes for existing callers.

---

### Task T1a: Transport-agnostic session rotation

**Objective:** Rotate the session id when a conversation gains a `patientId`, closing the session-fixation hole Phase 0 recorded as a prerequisite for browser voice. It applies to the HTTP endpoint immediately, because that endpoint stays live for the whole phase.

**Dependencies:** T0.

**Files:**
- Create: `apps/api/src/modules/voice/session/privilege-change.ts`
- Modify: `apps/api/src/modules/voice/voice.controller.ts` (the `text()` body)
- Test: `apps/api/tests/voice/session-rotation.spec.ts` (create)

**Interfaces:**
- Consumes: `VoiceSessionStore.rotate`, `Conversation` (T0).
- Produces: `privilegeChanged(before: PrivilegeSnapshot, after: VoiceSession): boolean`, `snapshotPrivilege(session: VoiceSession): PrivilegeSnapshot`.

- [ ] **Step 1: Write the failing predicate test**

Create `apps/api/tests/voice/session-rotation.spec.ts`:

```ts
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
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run test --workspace=@smileflow/api -- session-rotation`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the predicate**

Create `apps/api/src/modules/voice/session/privilege-change.ts`:

```ts
import { VoiceSession } from './voice-session';

export interface PrivilegeSnapshot {
  patientId: string | null;
  identityVerified: boolean;
}

export function snapshotPrivilege(session: VoiceSession): PrivilegeSnapshot {
  return {
    patientId: session.patientId,
    identityVerified: session.identityVerified,
  };
}

/**
 * True when the session can now do something it could not do before.
 *
 * `start_patient_intake` binding a patientId is the only trigger reachable in
 * Phase 1 — it holds the sole `session.patientId =` assignment in the codebase.
 * The identityVerified arm cannot fire in Phase 1 (nothing sets it, and a test
 * pins that); it is here so Phase 2 inherits the behaviour rather than
 * rediscovering that verification is also a privilege change.
 */
export function privilegeChanged(
  before: PrivilegeSnapshot,
  after: VoiceSession
): boolean {
  const gainedPatient = before.patientId === null && after.patientId !== null;
  const gainedVerification = !before.identityVerified && after.identityVerified;
  return gainedPatient || gainedVerification;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm run test --workspace=@smileflow/api -- session-rotation`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing HTTP rotation test**

Append to `session-rotation.spec.ts`. Build the harness the way `session-security.spec.ts` does — a fake Anthropic client that calls `start_patient_intake` when the caller says "my name is":

```ts
import type Anthropic from '@anthropic-ai/sdk';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { VoiceController } from '../../src/modules/voice/voice.controller';
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
import { VOICE_FEATURE_FLAG } from '../../src/modules/voice/voice.config';
import { ToolTier } from '../../src/modules/voice/tools/tool-definition.interface';

/** A stand-in intake tool: binds a patient exactly the way the real one does. */
class FakeIntakeTool {
  name = 'start_patient_intake';
  description = 'collect caller details';
  tier: ToolTier = 'public';
  needsPatientContext = true;
  inputSchema = { type: 'object' as const, properties: {}, required: [] };

  async execute(_input: Record<string, unknown>, session: { patientId: string | null }) {
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
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
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
});
```

- [ ] **Step 6: Run and watch it fail**

Run: `npm run test --workspace=@smileflow/api -- session-rotation`
Expected: FAIL — "returns a different session id" fails, because the id is stable today.

- [ ] **Step 7: Apply rotation in the controller**

In `voice.controller.ts`, inside `text()`, wrap the agent call. Replace lines 167-177 with:

```ts
    // Snapshot before the turn: patientId is bound deep inside a tool, so the
    // only place the change is observable without teaching the agent or the
    // executor about the session store is on either side of this call.
    const before = snapshotPrivilege(conversation.session);

    const turn = await this.agent.respond(
      conversation.session,
      dto.message,
      trimHistory(conversation.history)
    );
    conversation.history = turn.history;

    const previousId = conversation.session.sessionId;
    this.sessions.set(previousId, conversation);

    if (privilegeChanged(before, conversation.session)) {
      // The session can now act for a specific patient, so the credential the
      // caller has been using — which an attacker may have planted before the
      // conversation started — is replaced and the old one destroyed.
      this.sessions.rotate(previousId);
    }
```

Add the import:

```ts
import { privilegeChanged, snapshotPrivilege } from './session/privilege-change';
```

The `return` block already sends `conversation.session.sessionId`, which `rotate` has updated in place — so the endpoint returns the new authoritative id with no change to the response shape.

- [ ] **Step 8: Run and watch it pass**

Run: `npm run test --workspace=@smileflow/api -- session-rotation`
Expected: PASS, 7 tests.

- [ ] **Step 9: Prove idempotency survives the rotation**

Add to `session-rotation.spec.ts`:

```ts
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
```

Run: `npm run test --workspace=@smileflow/api -- session-rotation`
Expected: PASS, 8 tests.

- [ ] **Step 10: Mutation check**

Change `rotate` in the store to mint a fresh nonce as well:
`conversation.session.idempotencyNonce = newOpaqueId();`
Run the suite. Expected: the "carries the replay namespace" test (T0) fails.
**Restore**, re-run, confirm green.

- [ ] **Step 11: Full suite, typecheck, lint, commit**

```bash
npm run test --workspace=@smileflow/api
cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../..
npm run lint
git add apps/api/src/modules/voice apps/api/tests/voice
git commit -m "fix(voice): rotate the session id when a patient is bound"
```

**Acceptance criteria:**
- An HTTP turn that binds a patient returns a **different**, 43-character `sessionId`.
- The old id no longer resumes and returns **200 with a fresh conversation**, never a 4xx.
- A non-privilege turn does not rotate.
- A key computed after rotation matches one computed before, for the same operation.

**Security checks:**
- Old credential is deleted, not expired.
- Unknown/rotated-away ids stay non-revealing — anti-enumeration behaviour identical to Phase 0.
- Neither the old nor the new id is written to any log.
- `ClaudeAgentService`, `ToolExecutorService` and `IdempotencyService` are untouched — `git diff` must show no changes to those three files.

**Mutation/negative tests:**
- Regenerate the nonce during rotation → T0's preservation test goes red (Step 10, mandatory).
- Remove the `privilegeChanged` guard so it rotates every turn → the "does not rotate on a turn that changes no privilege" test goes red.

**Rollback conditions:** Roll back if the rotated-away id returns anything other than 200, or if any Phase 0 idempotency test changes behaviour.

---

### Task T2: `AudioTransport`, gateway skeleton, and the frame protocol

**Objective:** Stand up the WebSocket gateway with a validated wire protocol and a single agent-dispatch path, proving the transport cannot reach tools. No speech provider is involved: the `turn.text` frame drives a complete turn, which is the network-free integration path every later task uses.

**Dependencies:** T1a.

**Files:**
- Create: `apps/api/src/modules/voice/transport/audio-transport.interface.ts`
- Create: `apps/api/src/modules/voice/transport/error-codes.ts`
- Create: `apps/api/src/modules/voice/transport/frames.ts`
- Create: `apps/api/src/modules/voice/transport/voice-turn-runner.ts`
- Create: `apps/api/src/modules/voice/transport/voice.gateway.ts`
- Modify: `apps/api/src/modules/voice/voice.module.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/package.json`
- Test: `apps/api/tests/voice/frames.spec.ts` (create)
- Test: `apps/api/tests/voice/voice-gateway.spec.ts` (create)
- Test: `apps/api/tests/voice/transport-isolation.spec.ts` (create)

**Interfaces:**
- Consumes: `VoiceSessionStore`, `Conversation` (T0); `privilegeChanged`, `snapshotPrivilege` (T1a); `ClaudeAgentService.respond`, `trimHistory` (Phase 0).
- Produces:
  - `type VoiceErrorCode` — the eight codes
  - `parseClientFrame(raw: unknown): ParsedFrame` returning `{ ok: true; frame: ClientFrame } | { ok: false; code: 'bad_frame' }`
  - `interface AudioTransport { send(frame: ServerFrame): void; close(code: VoiceErrorCode): void; onTeardown(fn: () => void | Promise<void>): void }`
  - `class VoiceTurnRunner` with `runTurn(transport: AudioTransport, conversation: Conversation, text: string): Promise<void>` — **the only place a turn is dispatched**
  - `class VoiceGateway`

- [ ] **Step 1: Install the WebSocket packages**

```bash
npm install --workspace=@smileflow/api \
  @nestjs/websockets@^10 @nestjs/platform-ws@^10 ws@^8 && \
npm install --workspace=@smileflow/api --save-dev @types/ws@^8
```

Confirm `@nestjs/websockets` resolves to `10.x`, not `11.x`: `npm ls @nestjs/websockets`. If it resolved to 11, uninstall and re-pin — 11 demands `@nestjs/common ^11` and this repo is on 10.3.

- [ ] **Step 2: Write the failing frame-validation test**

Create `apps/api/tests/voice/frames.spec.ts`:

```ts
import { parseClientFrame } from '../../src/modules/voice/transport/frames';

describe('client frame validation', () => {
  it('accepts a session.start with no session id', () => {
    const result = parseClientFrame({ type: 'session.start' });
    expect(result.ok).toBe(true);
  });

  it('accepts a session.start resuming a known id', () => {
    const result = parseClientFrame({ type: 'session.start', sessionId: 'abc' });
    expect(result.ok).toBe(true);
  });

  it('accepts a turn.text frame', () => {
    const result = parseClientFrame({ type: 'turn.text', text: 'what are your hours?' });
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown frame type', () => {
    const result = parseClientFrame({ type: 'admin.escalate' });
    expect(result).toEqual({ ok: false, code: 'bad_frame' });
  });

  it('rejects a frame that is not an object', () => {
    expect(parseClientFrame('turn.text')).toEqual({ ok: false, code: 'bad_frame' });
    expect(parseClientFrame(null)).toEqual({ ok: false, code: 'bad_frame' });
  });

  // The wire protocol mirrors the HTTP endpoint's forbidNonWhitelisted: an
  // unexpected field is a refused frame, not a stripped one. Stripping hides
  // the fact that a client tried.
  it('rejects an unknown field rather than ignoring it', () => {
    const result = parseClientFrame({ type: 'turn.text', text: 'hi', locale: 'en' });
    expect(result).toEqual({ ok: false, code: 'bad_frame' });
  });

  it.each([
    'patientId',
    'patient_id',
    'userId',
    'user_id',
    'identityVerified',
    'identity_verified',
    'turnIndex',
    'idempotencyNonce',
    'logId',
    'tier',
  ])('rejects a frame carrying the identity field %s', (field) => {
    const result = parseClientFrame({ type: 'turn.text', text: 'hi', [field]: 'x' });
    expect(result).toEqual({ ok: false, code: 'bad_frame' });
  });

  it('rejects a non-string text on turn.text', () => {
    expect(parseClientFrame({ type: 'turn.text', text: 42 })).toEqual({
      ok: false,
      code: 'bad_frame',
    });
  });

  it('rejects text beyond the length cap', () => {
    const result = parseClientFrame({ type: 'turn.text', text: 'a'.repeat(4001) });
    expect(result).toEqual({ ok: false, code: 'bad_frame' });
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `npm run test --workspace=@smileflow/api -- frames`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the error codes and the frame parser**

Create `apps/api/src/modules/voice/transport/error-codes.ts`:

```ts
/**
 * Everything the browser is ever told about a failure.
 *
 * Enumerated deliberately: an Anthropic, Deepgram or ElevenLabs SDK error
 * carries provider identity and internal state, and the global HTTP filter
 * still returns exception.message verbatim. Nothing on this path forwards a
 * provider string. T7 owns the mapping and proves the leak is closed; the
 * codes live here so the security controls in T3 emit real values rather than
 * inventing strings that later have to be reconciled.
 */
export type VoiceErrorCode =
  | 'stt_unavailable'
  | 'agent_unavailable'
  | 'tts_unavailable'
  | 'rate_limited'
  | 'session_expired'
  | 'session_conflict'
  | 'bad_frame'
  | 'internal';

export const VOICE_ERROR_CODES: readonly VoiceErrorCode[] = [
  'stt_unavailable',
  'agent_unavailable',
  'tts_unavailable',
  'rate_limited',
  'session_expired',
  'session_conflict',
  'bad_frame',
  'internal',
];
```

Create `apps/api/src/modules/voice/transport/frames.ts`:

```ts
import { VoiceErrorCode } from './error-codes';

/** Caps a single spoken turn's transcript. Literal-pinned in frames.spec.ts. */
export const MAX_TURN_TEXT_LENGTH = 4000;

export type ClientFrame =
  | { type: 'session.start'; sessionId?: string }
  | { type: 'turn.text'; text: string }
  | { type: 'audio.end' };

export type ServerFrame =
  | { type: 'session.ready'; sessionId: string }
  | { type: 'session.rotated'; sessionId: string }
  | { type: 'stt.partial'; text: string }
  | { type: 'agent.thinking' }
  | { type: 'turn.complete' }
  | { type: 'error'; code: VoiceErrorCode };

export type ParsedFrame =
  | { ok: true; frame: ClientFrame }
  | { ok: false; code: 'bad_frame' };

/**
 * Fields a client must never be able to assert. The HTTP endpoint is protected
 * from these by the global ValidationPipe's forbidNonWhitelisted — but that
 * pipe is HTTP-only and a WebSocket gateway does not inherit it, so the same
 * property is enforced explicitly here.
 *
 * Listed rather than inferred so that adding a session field cannot silently
 * open a hole: the allowed-key lists below are exhaustive, and anything not on
 * them is refused regardless of this list. This is the belt to that braces.
 */
const FORBIDDEN_KEYS = new Set([
  'patientId',
  'patient_id',
  'userId',
  'user_id',
  'identityVerified',
  'identity_verified',
  'turnIndex',
  'turn_index',
  'idempotencyNonce',
  'idempotency_nonce',
  'logId',
  'log_id',
  'tier',
]);

const ALLOWED_KEYS: Record<string, readonly string[]> = {
  'session.start': ['type', 'sessionId'],
  'turn.text': ['type', 'text'],
  'audio.end': ['type'],
};

const reject: ParsedFrame = { ok: false, code: 'bad_frame' };

export function parseClientFrame(raw: unknown): ParsedFrame {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return reject;
  }

  const candidate = raw as Record<string, unknown>;
  const type = candidate.type;

  if (typeof type !== 'string' || !(type in ALLOWED_KEYS)) {
    return reject;
  }

  const allowed = ALLOWED_KEYS[type];
  for (const key of Object.keys(candidate)) {
    if (FORBIDDEN_KEYS.has(key) || !allowed.includes(key)) {
      return reject;
    }
  }

  if (type === 'session.start') {
    const { sessionId } = candidate;
    if (sessionId !== undefined && typeof sessionId !== 'string') {
      return reject;
    }
    return { ok: true, frame: { type, sessionId: sessionId as string | undefined } };
  }

  if (type === 'turn.text') {
    const { text } = candidate;
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TURN_TEXT_LENGTH) {
      return reject;
    }
    return { ok: true, frame: { type, text } };
  }

  return { ok: true, frame: { type: 'audio.end' } };
}
```

- [ ] **Step 5: Run and watch it pass**

Run: `npm run test --workspace=@smileflow/api -- frames`
Expected: PASS, 18 tests (the `it.each` expands to 10).

- [ ] **Step 6: Write the failing transport + gateway test**

Create `apps/api/tests/voice/voice-gateway.spec.ts`. Drive the gateway directly rather than over a real socket — the transport is an interface, so a fake implementation exercises the full path with no network:

```ts
import type Anthropic from '@anthropic-ai/sdk';
import { Test } from '@nestjs/testing';
import { VoiceGateway } from '../../src/modules/voice/transport/voice.gateway';
import { VoiceTurnRunner } from '../../src/modules/voice/transport/voice-turn-runner';
import { AudioTransport } from '../../src/modules/voice/transport/audio-transport.interface';
import { ServerFrame } from '../../src/modules/voice/transport/frames';
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

class FakeTransport implements AudioTransport {
  readonly sent: ServerFrame[] = [];
  closedWith: string | null = null;
  private teardowns: Array<() => void | Promise<void>> = [];

  send(frame: ServerFrame): void {
    this.sent.push(frame);
  }

  close(code: string): void {
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

async function buildGateway() {
  const client: AnthropicLike = {
    messages: {
      create: async () =>
        ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'We are open eight to six.', citations: null }],
        }) as unknown as Anthropic.Message,
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

  return {
    gateway: moduleRef.get(VoiceGateway),
    store: moduleRef.get(VoiceSessionStore),
  };
}

describe('voice gateway', () => {
  it('issues a session id on session.start and announces it', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });

    expect(transport.typesSent()).toEqual(['session.ready']);
    const ready = transport.sent[0] as { type: 'session.ready'; sessionId: string };
    expect(ready.sessionId).toHaveLength(43);
  });

  it('drives a complete turn through turn.text with no speech provider', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'what are your hours?' });

    expect(transport.typesSent()).toEqual([
      'session.ready',
      'agent.thinking',
      'turn.complete',
    ]);
  });

  it('starts a fresh session for an id the server never issued', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start', sessionId: 'never-issued' });

    const ready = transport.sent[0] as { type: 'session.ready'; sessionId: string };
    expect(ready.sessionId).not.toBe('never-issued');
    expect(transport.closedWith).toBeNull();
  });

  it('rejects a malformed frame without touching session state', async () => {
    const { gateway, store } = await buildGateway();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    const ready = transport.sent[0] as { type: 'session.ready'; sessionId: string };
    const before = store.get(ready.sessionId);

    await gateway.handleFrame(transport, {
      type: 'turn.text',
      text: 'hi',
      patientId: 'patient-9',
    });

    expect(transport.sent.at(-1)).toEqual({ type: 'error', code: 'bad_frame' });
    const after = store.get(ready.sessionId);
    expect(after?.session.patientId).toBeNull();
    expect(after?.session.identityVerified).toBe(false);
    expect(after).toBe(before);
  });
});
```

- [ ] **Step 7: Run and watch it fail**

Run: `npm run test --workspace=@smileflow/api -- voice-gateway`
Expected: FAIL — modules not found.

- [ ] **Step 8: Implement the transport interface**

Create `apps/api/src/modules/voice/transport/audio-transport.interface.ts`:

```ts
import { VoiceErrorCode } from './error-codes';
import { ServerFrame } from './frames';

/**
 * The seam between the agent and whatever is carrying audio.
 *
 * BrowserWebSocketTransport implements this in Phase 1. Phase 3's
 * TwilioMediaStreamTransport implements the same interface, which is what lets
 * telephony arrive without touching the agent, the tools, or the security
 * layers.
 *
 * It carries audio frames and control events. It never carries identity: who
 * the caller is, and what they may do, is decided server-side from the stored
 * session and nowhere else.
 */
export interface AudioTransport {
  send(frame: ServerFrame): void;
  sendAudio?(chunk: Buffer): void;
  close(code: VoiceErrorCode): void;
  /** Registered cleanup, run once when the connection ends for any reason. */
  onTeardown(fn: () => void | Promise<void>): void;
}
```

- [ ] **Step 9: Implement the single turn-dispatch path**

Create `apps/api/src/modules/voice/transport/voice-turn-runner.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ClaudeAgentService } from '../agent/claude.agent';
import { privilegeChanged, snapshotPrivilege } from '../session/privilege-change';
import { Conversation, VoiceSessionStore } from '../session/voice-session.store';
import { trimHistory } from '../voice.controller';
import { AudioTransport } from './audio-transport.interface';

/**
 * The only place a transport dispatches a turn to the agent.
 *
 * T4 drives speech turns through this same method rather than adding a second
 * path — two dispatch sites would mean rotation, history trimming and audit
 * correlation each have two places to go wrong.
 */
@Injectable()
export class VoiceTurnRunner {
  private readonly logger = new Logger(VoiceTurnRunner.name);

  constructor(
    private readonly agent: ClaudeAgentService,
    private readonly sessions: VoiceSessionStore
  ) {}

  async runTurn(
    transport: AudioTransport,
    conversation: Conversation,
    text: string
  ): Promise<string> {
    transport.send({ type: 'agent.thinking' });

    const before = snapshotPrivilege(conversation.session);

    const turn = await this.agent.respond(
      conversation.session,
      text,
      trimHistory(conversation.history)
    );
    conversation.history = turn.history;

    const previousId = conversation.session.sessionId;
    this.sessions.set(previousId, conversation);

    let currentId = previousId;
    if (privilegeChanged(before, conversation.session)) {
      const rotated = this.sessions.rotate(previousId);
      if (rotated) {
        currentId = rotated;
        // logId, never sessionId: the id is a bearer credential and this line
        // would otherwise put a live one in the log stream.
        this.logger.log(`Rotated session credential for ${conversation.session.logId}`);
      }
    }

    transport.send({ type: 'turn.complete' });
    return currentId;
  }
}
```

Note: `runTurn` returns the current id and **does not** emit `session.rotated` — that frame is T1b's deliverable.

- [ ] **Step 10: Implement the gateway**

Create `apps/api/src/modules/voice/transport/voice.gateway.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { createAnonymousSession } from '../session/voice-session';
import { Conversation, VoiceSessionStore } from '../session/voice-session.store';
import { AudioTransport } from './audio-transport.interface';
import { parseClientFrame } from './frames';
import { VoiceTurnRunner } from './voice-turn-runner';

/**
 * BrowserWebSocketTransport's frame handling.
 *
 * This class holds ClaudeAgentService (through VoiceTurnRunner) and
 * VoiceSessionStore. It deliberately holds no reference to
 * ToolRegistryService or to any tool: the transport must not be able to call a
 * tool directly, because every authorization decision, every idempotency key
 * and every audit row is produced inside ToolExecutorService. A static
 * import-graph test in transport-isolation.spec.ts pins that.
 */
@Injectable()
export class VoiceGateway {
  /** Which session each live socket is bound to, for one-socket-per-session. */
  private readonly bound = new WeakMap<AudioTransport, string>();

  constructor(
    private readonly sessions: VoiceSessionStore,
    private readonly runner: VoiceTurnRunner
  ) {}

  async handleFrame(transport: AudioTransport, raw: unknown): Promise<void> {
    const parsed = parseClientFrame(raw);

    if (!parsed.ok) {
      transport.send({ type: 'error', code: parsed.code });
      return;
    }

    const frame = parsed.frame;

    if (frame.type === 'session.start') {
      const sessionId = this.resume(frame.sessionId);
      this.bound.set(transport, sessionId);
      transport.send({ type: 'session.ready', sessionId });
      return;
    }

    if (frame.type === 'turn.text') {
      const sessionId = this.bound.get(transport);
      const conversation = sessionId ? this.sessions.get(sessionId) : undefined;

      if (!conversation) {
        transport.send({ type: 'error', code: 'session_expired' });
        return;
      }

      const currentId = await this.runner.runTurn(transport, conversation, frame.text);
      this.bound.set(transport, currentId);
    }
  }

  /**
   * An id the server does not hold is not adopted, and is not an error either:
   * it quietly starts a fresh conversation. Rejecting it would turn the
   * gateway into an oracle answering "does this session exist?" one guess at a
   * time — the enumeration attack the HTTP endpoint was written to avoid.
   */
  private resume(candidate?: string): string {
    const existing = candidate ? this.sessions.get(candidate) : undefined;
    if (existing) {
      return existing.session.sessionId;
    }

    const conversation: Conversation = { session: createAnonymousSession(), history: [] };
    this.sessions.set(conversation.session.sessionId, conversation);
    return conversation.session.sessionId;
  }
}
```

- [ ] **Step 11: Run and watch it pass**

Run: `npm run test --workspace=@smileflow/api -- voice-gateway`
Expected: PASS, 4 tests.

- [ ] **Step 12: Write the failing bypass-prevention test**

This test type is **new to this repository** — Phase 0 pins the executor's behaviour, not the import graph, so there is no existing pattern to copy.

Create `apps/api/tests/voice/transport-isolation.spec.ts`:

```ts
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const TRANSPORT_DIR = join(__dirname, '../../src/modules/voice/transport');

function importedModules(source: string): string[] {
  const matches = source.matchAll(/from\s+['"]([^'"]+)['"]/g);
  return [...matches].map((m) => m[1]);
}

describe('the transport layer cannot reach tools', () => {
  const files = readdirSync(TRANSPORT_DIR).filter((f) => f.endsWith('.ts'));

  it('has transport files to check', () => {
    // Guards against the sweep below silently passing on an empty directory.
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files)('%s imports neither the registry nor any tool', (file) => {
    const source = readFileSync(join(TRANSPORT_DIR, file), 'utf8');
    const imports = importedModules(source);

    const forbidden = imports.filter(
      (spec) => spec.includes('tool-registry') || /\.tool$/.test(spec) || spec.includes('/tools/')
    );

    expect(forbidden).toEqual([]);
  });
});
```

- [ ] **Step 13: Run and watch it pass**

Run: `npm run test --workspace=@smileflow/api -- transport-isolation`
Expected: PASS.

- [ ] **Step 14: Mutation check on the bypass test — mandatory**

Add `import { ToolRegistryService } from '../tools/tool-registry.service';` to `voice.gateway.ts`.
Run: `npm run test --workspace=@smileflow/api -- transport-isolation`
Expected: **FAIL** on `voice.gateway.ts`. **Remove the import**, re-run, confirm green. A bypass test that cannot detect a bypass is worse than no test.

- [ ] **Step 15: Register the gateway and wire the adapter**

In `voice.module.ts` add `VoiceGateway` and `VoiceTurnRunner` to `providers`.

In `main.ts`, after `const app = await NestFactory.create(AppModule);`:

```ts
import { WsAdapter } from '@nestjs/platform-ws';
// ...
app.useWebSocketAdapter(new WsAdapter(app));
```

T3 replaces this with the origin-checking subclass.

- [ ] **Step 16: Full suite, typecheck, lint, commit**

```bash
npm run test --workspace=@smileflow/api
cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../..
npm run lint
git add apps/api package-lock.json
git commit -m "feat(voice): add the websocket transport seam and frame protocol"
```

**Acceptance criteria:**
- `session.start` issues a 43-char id and replies `session.ready`.
- `turn.text` drives a full turn: `agent.thinking` → `turn.complete`, no speech provider involved.
- Unknown id starts fresh and does not close the connection.
- Unknown frame type, unknown field, and every identity-bearing field are rejected with `bad_frame`, and session state is provably unchanged (same object identity, `patientId` still null).
- Static import test proves the transport imports no registry and no tool, **with a passing mutation check**.

**Security checks:**
- Gateway holds only `VoiceSessionStore` and `VoiceTurnRunner`.
- No client-supplied field other than `sessionId` influences anything, and `sessionId` can only *select* a session, never create one with a chosen id.
- No `sessionId` in any log line — `VoiceTurnRunner` logs `logId` only.
- `ClaudeAgentService` unmodified.

**Mutation/negative tests:**
- Registry import added to the gateway → isolation test red (Step 14, mandatory).
- Remove the `FORBIDDEN_KEYS` check → the ten identity-field cases go red.
- Make `resume()` adopt an unknown candidate id verbatim → "starts a fresh session" goes red.

**Rollback conditions:** Roll back if `@nestjs/websockets` resolves to `11.x`, or if the import-graph test cannot be made to fail in Step 14.

---

### Task T1b: `session.rotated` control frame

**Objective:** Tell a connected browser its credential changed, so it can resume under the new one. Split out of T1 because the frame needs a transport to travel on, which did not exist when T1 was specified as dependency-free.

**Dependencies:** T1a, T2.

**Files:**
- Modify: `apps/api/src/modules/voice/transport/voice-turn-runner.ts`
- Test: `apps/api/tests/voice/session-rotation-ws.spec.ts` (create)

**Interfaces:**
- Consumes: `VoiceTurnRunner.runTurn`, `FakeTransport` pattern (T2); `privilegeChanged` (T1a).
- Produces: no new signatures — `runTurn` now emits `session.rotated` before `turn.complete`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/voice/session-rotation-ws.spec.ts`, reusing T2's `FakeTransport` and `FakeIntakeTool` (copy both in — the executor may be reading tasks out of order, and duplicated fixtures in tests are cheaper than shared ones that drift):

```ts
describe('session rotation over the websocket', () => {
  it('emits exactly one session.rotated, before turn.complete', async () => {
    const { gateway } = await buildGatewayWithIntake();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    const originalId = (transport.sent[0] as { sessionId: string }).sessionId;

    await gateway.handleFrame(transport, { type: 'turn.text', text: 'my name is Dana' });

    const types = transport.typesSent();
    expect(types).toEqual([
      'session.ready',
      'agent.thinking',
      'session.rotated',
      'turn.complete',
    ]);

    const rotated = transport.sent[2] as { type: 'session.rotated'; sessionId: string };
    expect(rotated.sessionId).not.toBe(originalId);
    expect(rotated.sessionId).toHaveLength(43);
  });

  it('does not emit session.rotated on an ordinary turn', async () => {
    const { gateway } = await buildGatewayWithIntake();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'what are your hours?' });

    expect(transport.typesSent()).not.toContain('session.rotated');
  });

  it('accepts the new id and refuses the old one on a later frame', async () => {
    const { gateway, store } = await buildGatewayWithIntake();
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    const originalId = (transport.sent[0] as { sessionId: string }).sessionId;
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'my name is Dana' });
    const newId = (transport.sent[2] as { sessionId: string }).sessionId;

    expect(store.get(originalId)).toBeUndefined();
    expect(store.get(newId)).toBeDefined();

    // A second socket presenting the dead id gets a fresh session, not an error.
    const other = new FakeTransport();
    await gateway.handleFrame(other, { type: 'session.start', sessionId: originalId });
    const resumed = (other.sent[0] as { sessionId: string }).sessionId;
    expect(resumed).not.toBe(originalId);
    expect(resumed).not.toBe(newId);
  });

  it('never puts either session id in a log line', async () => {
    const logs: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation((m) => {
      logs.push(String(m));
    });

    const { gateway } = await buildGatewayWithIntake();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    const originalId = (transport.sent[0] as { sessionId: string }).sessionId;
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'my name is Dana' });
    const newId = (transport.sent[2] as { sessionId: string }).sessionId;

    const joined = logs.join('\n');
    expect(joined).not.toContain(originalId);
    expect(joined).not.toContain(newId);
    expect(joined).toMatch(/Rotated session credential for [0-9a-f]{16}/);

    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm run test --workspace=@smileflow/api -- session-rotation-ws`
Expected: FAIL — `session.rotated` is never sent.

- [ ] **Step 3: Emit the frame**

In `voice-turn-runner.ts`, inside the `if (rotated)` block, after the log line:

```ts
        transport.send({ type: 'session.rotated', sessionId: rotated });
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm run test --workspace=@smileflow/api -- session-rotation-ws`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mutation check**

Move the `transport.send({ type: 'session.rotated' ... })` line outside the `if (rotated)` guard so it fires every turn. Run the suite. Expected: "does not emit session.rotated on an ordinary turn" goes red. **Restore.**

- [ ] **Step 6: Full suite, typecheck, lint, commit**

```bash
npm run test --workspace=@smileflow/api
cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../..
npm run lint
git add apps/api
git commit -m "feat(voice): announce credential rotation over the socket"
```

**Acceptance criteria:**
- Exactly one `session.rotated` on a privilege-changing turn, ordered before `turn.complete`.
- No `session.rotated` on an ordinary turn.
- Old id gone from the store; a socket presenting it gets a fresh session, not an error.

**Security checks:**
- Neither id appears in any log line; the rotation log carries the 16-hex `logId` only.
- The new id travels only down the already-established socket that carried the old one.

**Mutation/negative tests:** Unguarded emission → ordinary-turn test red (Step 5, mandatory).

**Rollback conditions:** Roll back if the old id remains resolvable after rotation, or if any id reaches a log line.

---

### Task T3: WebSocket security controls

**Objective:** Make the socket safe to expose: origin allowlist shared with HTTP CORS, connection and message rate limits, size and duration caps, one live socket per session, and clean teardown.

**Dependencies:** T2.

**Files:**
- Create: `apps/api/src/common/config/allowed-origins.ts`
- Create: `apps/api/src/modules/voice/transport/transport-limits.ts`
- Create: `apps/api/src/modules/voice/transport/ws-origin.adapter.ts`
- Modify: `apps/api/src/modules/voice/transport/voice.gateway.ts`
- Modify: `apps/api/src/main.ts:31-34`
- Test: `apps/api/tests/voice/allowed-origins.spec.ts` (create)
- Test: `apps/api/tests/voice/transport-limits.spec.ts` (create)
- Test: `apps/api/tests/voice/ws-security.spec.ts` (create)

**Interfaces:**
- Consumes: `VoiceGateway`, `AudioTransport`, `VoiceErrorCode` (T2).
- Produces: `allowedOrigins(): string[]`, `isOriginAllowed(origin: string | undefined): boolean`, the `WS_MAX_*` constants, `class WsOriginAdapter extends WsAdapter`.

- [ ] **Step 1: Write the failing origin-helper test**

Create `apps/api/tests/voice/allowed-origins.spec.ts`:

```ts
import { allowedOrigins, isOriginAllowed } from '../../src/common/config/allowed-origins';

describe('allowed origins', () => {
  const original = process.env.FRONTEND_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = original;
  });

  it('falls back to the local dev origin when FRONTEND_URL is unset', () => {
    delete process.env.FRONTEND_URL;
    expect(allowedOrigins()).toEqual(['http://localhost:3000']);
  });

  it('parses a comma separated list and trims whitespace', () => {
    process.env.FRONTEND_URL = 'https://a.example.com, https://b.example.com';
    expect(allowedOrigins()).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('accepts an origin on the list and rejects one that is not', () => {
    process.env.FRONTEND_URL = 'https://a.example.com';
    expect(isOriginAllowed('https://a.example.com')).toBe(true);
    expect(isOriginAllowed('https://evil.example.com')).toBe(false);
  });

  it('rejects a missing origin', () => {
    process.env.FRONTEND_URL = 'https://a.example.com';
    expect(isOriginAllowed(undefined)).toBe(false);
  });

  it('does not treat a prefix match as a match', () => {
    process.env.FRONTEND_URL = 'https://a.example.com';
    expect(isOriginAllowed('https://a.example.com.evil.test')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, fail, implement**

Run: `npm run test --workspace=@smileflow/api -- allowed-origins` → FAIL.

Create `apps/api/src/common/config/allowed-origins.ts`:

```ts
const DEFAULT_ORIGIN = 'http://localhost:3000';

/**
 * One allowlist for both HTTP CORS and the WebSocket upgrade.
 *
 * CORS does not apply to WebSocket handshakes, so the gateway has to check
 * Origin itself. Reading the same env var through the same helper is what stops
 * the two lists drifting apart — a socket that accepts an origin CORS rejects
 * is a hole with no obvious owner.
 */
export function allowedOrigins(): string[] {
  const raw = process.env.FRONTEND_URL;
  if (!raw || raw.trim() === '') {
    return [DEFAULT_ORIGIN];
  }
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/** Exact match only — a prefix or suffix match is how origin checks get bypassed. */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) {
    return false;
  }
  return allowedOrigins().includes(origin);
}
```

Run again → PASS, 5 tests.

- [ ] **Step 3: Point `main.ts` at the shared helper**

Replace `main.ts:31-34`:

```ts
  app.enableCors({
    origin: allowedOrigins(),
    credentials: true,
  });
```

with `import { allowedOrigins } from './common/config/allowed-origins';` added. Behaviour for a single `FRONTEND_URL` is unchanged; it now also accepts a list.

- [ ] **Step 4: Write the failing limits test**

Create `apps/api/tests/voice/transport-limits.spec.ts`:

```ts
import {
  WS_MAX_FRAME_BYTES,
  WS_MAX_TURNS_PER_SESSION,
  WS_MAX_TURNS_PER_MINUTE,
  WS_MAX_UPLINK_BYTES_PER_TURN,
  WS_MAX_CONNECTION_MS,
  WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE,
} from '../../src/modules/voice/transport/transport-limits';
import { MAX_HISTORY_TURNS } from '../../src/modules/voice/voice.controller';

describe('websocket limits', () => {
  // Every value written out as a literal. Phase 0 shipped a test comparing
  // VOICE_CONFIG.maxTokens to itself, which passed while the value was wrong.
  it('pins each limit to a literal', () => {
    expect(WS_MAX_FRAME_BYTES).toBe(65536);
    expect(WS_MAX_TURNS_PER_SESSION).toBe(40);
    expect(WS_MAX_TURNS_PER_MINUTE).toBe(10);
    expect(WS_MAX_UPLINK_BYTES_PER_TURN).toBe(2097152);
    expect(WS_MAX_CONNECTION_MS).toBe(600000);
    expect(WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE).toBe(20);
  });

  // These three are separate mechanisms and conflating them has already been
  // proposed once. MAX_HISTORY_TURNS trims what is resent to the model; the
  // HTTP throttle is per-IP on POST /voice/text; the WS limits are per-session
  // on the socket.
  it('keeps the socket turn cap independent of history trimming', () => {
    expect(MAX_HISTORY_TURNS).toBe(12);
    expect(WS_MAX_TURNS_PER_SESSION).not.toBe(MAX_HISTORY_TURNS);
    expect(WS_MAX_TURNS_PER_SESSION).toBeGreaterThan(MAX_HISTORY_TURNS);
  });
});
```

- [ ] **Step 5: Run, fail, implement the constants**

Create `apps/api/src/modules/voice/transport/transport-limits.ts`:

```ts
/**
 * Socket limits. All are per-session or per-connection and are NOT related to:
 *   - MAX_HISTORY_TURNS (12) — how much transcript is resent to the model
 *   - @Throttle({limit:10,ttl:60000}) — per-IP cap on POST /voice/text
 * A socket neither consumes nor is limited by the HTTP budget.
 */

/** One audio frame. ~20 ms of 16 kHz linear16 is ~640 bytes, so this is ample. */
export const WS_MAX_FRAME_BYTES = 64 * 1024;

/** Lifetime ceiling on agent turns, so one socket cannot spend unbounded model budget. */
export const WS_MAX_TURNS_PER_SESSION = 40;

/** Rate ceiling on agent turns. A person speaking to a receptionist never exceeds this. */
export const WS_MAX_TURNS_PER_MINUTE = 10;

/** Bounds a single turn's audio: 2 MB is far past any plausible utterance. */
export const WS_MAX_UPLINK_BYTES_PER_TURN = 2 * 1024 * 1024;

/** Hard connection cap, independent of the 30-minute session TTL. */
export const WS_MAX_CONNECTION_MS = 10 * 60 * 1000;

/** New sockets per IP per minute, checked at upgrade. */
export const WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE = 20;
```

Run → PASS, 2 tests.

- [ ] **Step 6: Write the failing security-behaviour test**

Create `apps/api/tests/voice/ws-security.spec.ts`. Cover the four behaviours that are not just constants:

```ts
describe('websocket security behaviour', () => {
  it('starts a fresh session for an unknown id and never reveals existence', async () => {
    const { gateway } = await buildGateway();
    const a = new FakeTransport();
    const b = new FakeTransport();

    await gateway.handleFrame(a, { type: 'session.start' });
    const live = (a.sent[0] as { sessionId: string }).sessionId;

    await gateway.handleFrame(b, { type: 'session.start', sessionId: 'definitely-not-issued' });

    // The response to an unknown id must be indistinguishable in shape from a
    // first contact: same frame type, no error, a new id.
    expect(b.typesSent()).toEqual(['session.ready']);
    expect(b.closedWith).toBeNull();
    expect((b.sent[0] as { sessionId: string }).sessionId).not.toBe(live);
  });

  it('rejects a second socket on a live session and leaves the first working', async () => {
    const { gateway } = await buildGateway();
    const first = new FakeTransport();
    await gateway.handleFrame(first, { type: 'session.start' });
    const sessionId = (first.sent[0] as { sessionId: string }).sessionId;

    const second = new FakeTransport();
    await gateway.handleFrame(second, { type: 'session.start', sessionId });

    expect(second.closedWith).toBe('session_conflict');

    // Closing the first instead would let anyone holding a stolen id kick the
    // legitimate caller off their own call.
    await gateway.handleFrame(first, { type: 'turn.text', text: 'still there?' });
    expect(first.typesSent()).toContain('turn.complete');
    expect(first.closedWith).toBeNull();
  });

  it('releases the session slot on teardown so the caller can reconnect', async () => {
    const { gateway } = await buildGateway();
    const first = new FakeTransport();
    await gateway.handleFrame(first, { type: 'session.start' });
    const sessionId = (first.sent[0] as { sessionId: string }).sessionId;

    await first.fireTeardown();

    const reconnect = new FakeTransport();
    await gateway.handleFrame(reconnect, { type: 'session.start', sessionId });

    expect(reconnect.closedWith).toBeNull();
    expect((reconnect.sent[0] as { sessionId: string }).sessionId).toBe(sessionId);
  });

  it('closes the connection when the per-session turn cap is exceeded', async () => {
    const { gateway } = await buildGateway();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    for (let i = 0; i < WS_MAX_TURNS_PER_SESSION + 1; i++) {
      await gateway.handleFrame(transport, { type: 'turn.text', text: `turn ${i}` });
    }

    expect(transport.closedWith).toBe('rate_limited');
  });
});
```

- [ ] **Step 7: Run, fail, implement**

Extend `VoiceGateway`: track `turnCount` and a per-session live-socket registry; on `session.start` for a session that already has a live transport, `transport.close('session_conflict')` and return without binding. Register an `onTeardown` that releases the live-socket entry. On `turn.text`, increment and compare against `WS_MAX_TURNS_PER_SESSION` and a one-minute sliding window against `WS_MAX_TURNS_PER_MINUTE`; over either, `transport.close('rate_limited')`.

- [ ] **Step 8: Implement the origin adapter**

Create `apps/api/src/modules/voice/transport/ws-origin.adapter.ts`:

```ts
import { WsAdapter } from '@nestjs/platform-ws';
import { isOriginAllowed } from '../../../common/config/allowed-origins';
import { WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE, WS_MAX_FRAME_BYTES } from './transport-limits';

/**
 * Rejects a handshake before the upgrade completes.
 *
 * This is why the transport is raw `ws` rather than Socket.IO: `verifyClient`
 * runs during the HTTP upgrade, so a disallowed Origin never becomes a
 * WebSocket at all. A check after the upgrade would mean an unauthorised page
 * had already opened a socket into the process.
 */
export class WsOriginAdapter extends WsAdapter {
  private readonly recentByIp = new Map<string, number[]>();

  create(port: number, options?: Record<string, unknown>) {
    return super.create(port, {
      ...options,
      maxPayload: WS_MAX_FRAME_BYTES,
      verifyClient: (info: { origin: string; req: { socket: { remoteAddress?: string } } }) => {
        if (!isOriginAllowed(info.origin)) {
          return false;
        }
        return this.underIpLimit(info.req.socket.remoteAddress ?? 'unknown');
      },
    });
  }

  private underIpLimit(ip: string): boolean {
    const now = Date.now();
    const recent = (this.recentByIp.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= WS_MAX_CONNECTIONS_PER_IP_PER_MINUTE) {
      this.recentByIp.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.recentByIp.set(ip, recent);
    return true;
  }
}
```

Swap `main.ts` to `app.useWebSocketAdapter(new WsOriginAdapter(app));`.

- [ ] **Step 9: Mutation checks — all three mandatory**

1. `isOriginAllowed` → `return true` unconditionally. Expected: origin tests red. Restore.
2. Remove the `session_conflict` branch. Expected: duplicate-socket test red. Restore.
3. Change `WS_MAX_FRAME_BYTES` to `65537`. Expected: literal-pin test red. Restore.

- [ ] **Step 10: Full suite, typecheck, lint, commit**

```bash
npm run test --workspace=@smileflow/api
cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../..
npm run lint
git add apps/api
git commit -m "feat(voice): add websocket origin, rate and lifetime controls"
```

**Acceptance criteria:** Every control has a test; every constant a literal pin; unknown session starts fresh with a response indistinguishable from first contact; duplicate socket rejected with the first left working; teardown releases the slot; the WS turn cap is provably distinct from `MAX_HISTORY_TURNS`.

**Security checks:** Origin exact-match only, checked pre-upgrade; one allowlist for CORS and WS; per-IP connection cap; `maxPayload` enforced by the server, not by application code that could be bypassed; teardown always releases.

**Mutation/negative tests:** Steps 9.1–9.3, all mandatory.

**Rollback conditions:** Roll back if the duplicate-connection path can close the *first* socket, or if an unknown session id produces a response distinguishable from first contact.

---

### Task T4: STT integration behind `SpeechToText`

**Objective:** Turn caller audio into dispatched turns via Deepgram, with a confidence gate that re-prompts at the transport level and never asks the agent to judge whether it heard correctly.

**Dependencies:** T2.

**Files:**
- Create: `apps/api/src/modules/voice/speech/speech-to-text.interface.ts`
- Create: `apps/api/src/modules/voice/speech/deepgram-stt.service.ts`
- Modify: `apps/api/src/modules/voice/transport/voice.gateway.ts`
- Modify: `apps/api/src/modules/voice/voice.module.ts`
- Test: `apps/api/tests/voice/stt-confidence.spec.ts` (create)

**Interfaces:**
- Consumes: `VoiceTurnRunner.runTurn` (T2) — T4 calls it; it does **not** add a second dispatch path.
- Produces: `interface SpeechToText { start(session): Promise<void>; write(chunk: Buffer): void; end(): Promise<void>; onPartial(handler): void; onFinal(handler): void }`, `SPEECH_TO_TEXT` DI token, `STT_MIN_CONFIDENCE`, `LOW_CONFIDENCE_REPROMPT`.

- [ ] **Step 1: Write the failing confidence-gate test**

Create `apps/api/tests/voice/stt-confidence.spec.ts`:

```ts
describe('STT confidence gate', () => {
  it('dispatches a turn when confidence is at or above the threshold', async () => {
    const { gateway, agentSpy, stt } = await buildGatewayWithFakeStt();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    stt.emitFinal('I would like to book a cleaning', 0.95);
    await flush();

    expect(agentSpy).toHaveBeenCalledTimes(1);
    expect(transport.typesSent()).toContain('turn.complete');
  });

  it('re-prompts without invoking the agent when confidence is below threshold', async () => {
    const { gateway, agentSpy, stt, tts } = await buildGatewayWithFakeStt();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    stt.emitFinal('my date of birth is nineteen eighty', 0.41);
    await flush();

    // The whole point: the model is never asked whether it heard correctly.
    expect(agentSpy).toHaveBeenCalledTimes(0);
    expect(tts.spoken).toEqual([LOW_CONFIDENCE_REPROMPT]);
  });

  it('pins the threshold and the re-prompt to literals', () => {
    expect(STT_MIN_CONFIDENCE).toBe(0.6);
    expect(LOW_CONFIDENCE_REPROMPT).toBe(
      "Sorry, I didn't catch that. Could you say it again?"
    );
  });

  it('does not advance the turn counter on a re-prompt', async () => {
    const { gateway, store, stt } = await buildGatewayWithFakeStt();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    const id = (transport.sent[0] as { sessionId: string }).sessionId;

    stt.emitFinal('mumble', 0.2);
    await flush();

    expect(store.get(id)?.session.turnIndex).toBe(0);
  });

  it('ignores interim results and dispatches only on a final', async () => {
    const { gateway, agentSpy, stt } = await buildGatewayWithFakeStt();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    stt.emitPartial('I would like');
    stt.emitPartial('I would like to book');
    await flush();

    expect(agentSpy).toHaveBeenCalledTimes(0);
    expect(transport.typesSent()).toContain('stt.partial');
  });
});
```

> ### ⛔ BLOCKED — ruling required before this task runs
>
> **The confidence gate needs to speak, but T4 depends only on T2.** The
> re-prompt in `handleFinal` below calls `this.speak(...)`, which needs
> `TextToSpeech` — and the spec assigns that interface to **T5**, which T4 does
> not depend on. T4 cannot both "ask the caller to repeat" and depend only on
> T2 as written.
>
> This is a spec-level dependency question, not an implementation detail, so it
> is **not** improvised here. Three resolutions, all of which change approved
> scope or dependencies:
>
> 1. Move the `TextToSpeech` **interface and DI token only** (not the
>    ElevenLabs implementation) from T5 into T2. Smallest change; T2 already
>    owns the transport seam, and T5 keeps the whole provider integration.
> 2. Add T5 to T4's dependencies. Simple, but serialises two tasks that were
>    deliberately parallel siblings off T2.
> 3. Have T4 emit the re-prompt as a server frame and let T5 speak it once TTS
>    exists. Keeps dependencies untouched, but the caller hears nothing until
>    T5 lands, so T4's acceptance criterion is not met at T4.
>
> **Recommended: option 1.** It preserves the approved dependency graph, keeps
> T4 and T5 parallel, and moves an interface — not behaviour.
>
> Everything else in T4 is unaffected: the zero-agent-invocation property is
> fully testable against a `TextToSpeech` fake under any of the three.

- [ ] **Step 2: Run, fail, implement the interface and the gate**

Run: `npm run test --workspace=@smileflow/api -- stt-confidence` → FAIL.

Create `apps/api/src/modules/voice/speech/speech-to-text.interface.ts`:

```ts
import { VoiceSession } from '../session/voice-session';

/** DI token so a fake can be substituted without touching the gateway. */
export const SPEECH_TO_TEXT = Symbol('SPEECH_TO_TEXT');

/**
 * Below this, the transport asks the caller to repeat instead of guessing.
 * Intake collects names, dates of birth and phone numbers, where a confident
 * mishearing is worse than an extra question.
 */
export const STT_MIN_CONFIDENCE = 0.6;

export const LOW_CONFIDENCE_REPROMPT =
  "Sorry, I didn't catch that. Could you say it again?";

export interface SttFinal {
  text: string;
  confidence: number;
}

export interface SpeechToText {
  start(session: VoiceSession): Promise<void>;
  write(chunk: Buffer): void;
  end(): Promise<void>;
  onPartial(handler: (text: string) => void): void;
  onFinal(handler: (result: SttFinal) => void | Promise<void>): void;
}
```

Wire it in `voice.gateway.ts`. The gate returns **before** any agent call:

```ts
  private async handleFinal(
    transport: AudioTransport,
    conversation: Conversation,
    result: SttFinal
  ): Promise<void> {
    if (result.confidence < STT_MIN_CONFIDENCE) {
      // Deliberately not an agent turn. Asking the model whether it heard
      // correctly would put a low-confidence transcript into the context and
      // give it something to guess from; it also means ClaudeAgentService
      // would need to know about confidence, which it must not.
      await this.speak(transport, LOW_CONFIDENCE_REPROMPT);
      return;
    }

    await this.runner.runTurn(transport, conversation, result.text);
  }
```

- [ ] **Step 3: Implement `DeepgramSttService`**

Streaming `linear16`, 16 kHz mono, interim results on, `endpointing: 800`, dispatch on `speech_final`. Read `process.env.DEEPGRAM_API_KEY` at construction; if absent and the flag is on, log a warning naming the variable — **never the value** — and fail closed with `stt_unavailable`.

- [ ] **Step 4: Prove `ClaudeAgentService` is untouched**

```bash
git diff --name-only main -- apps/api/src/modules/voice/agent/claude.agent.ts
```
Expected: **empty output.** If this prints a path, stop and report — the confidence gate has leaked into the agent.

- [ ] **Step 5: Mutation check**

Change the gate to `confidence < 0` (never fires). Expected: the zero-invocation test goes red. Restore.

- [ ] **Step 6: Full suite, typecheck, lint, commit**

```bash
npm run test --workspace=@smileflow/api
cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../..
npm run lint
git add apps/api
git commit -m "feat(voice): stream speech to text with a confidence gate"
```

**Acceptance criteria:** A full turn runs on a fake STT with no network; a below-threshold final produces the fixed re-prompt with `agent.respond` called **exactly 0 times**; threshold and re-prompt literal-pinned; interim results never dispatch; `turnIndex` unchanged by a re-prompt.

**Security checks:** `DEEPGRAM_API_KEY` read server-side only, never logged, never sent to the client; missing key fails closed; no transcript written to any log line.

**Mutation/negative tests:** Step 5, mandatory. Also: make the gate call `runTurn` before the check → zero-invocation test red.

**Rollback conditions:** Roll back if `claude.agent.ts` shows any diff, or if a second dispatch path appears alongside `VoiceTurnRunner.runTurn`.

---

### Task T5: TTS integration behind `TextToSpeech`

**Objective:** Speak the reply as it is generated, chunked on sentence boundaries so first audio starts early, with a working `cancel()` used for teardown.

**Dependencies:** T2.

**Files:**
- Create: `apps/api/src/modules/voice/speech/text-to-speech.interface.ts`
- Create: `apps/api/src/modules/voice/speech/sentence-chunker.ts`
- Create: `apps/api/src/modules/voice/speech/elevenlabs-tts.service.ts`
- Modify: `apps/api/src/modules/voice/transport/voice.gateway.ts`
- Modify: `apps/api/src/modules/voice/voice.module.ts`
- Test: `apps/api/tests/voice/sentence-chunker.spec.ts` (create)
- Test: `apps/api/tests/voice/tts-streaming.spec.ts` (create)

**Interfaces:**
- Consumes: `AudioTransport.onTeardown` (T2) — T5 registers into the existing registry; it does not create a second teardown path.
- Produces: `chunkSentences(text: string): string[]`, `interface TextToSpeech { synthesise(text): AsyncIterable<Buffer>; cancel(): void }`, `TEXT_TO_SPEECH` token, `MIN_CHUNK_LENGTH`.

- [ ] **Step 1: Write the failing chunker test**

Create `apps/api/tests/voice/sentence-chunker.spec.ts`:

```ts
import { chunkSentences, MIN_CHUNK_LENGTH } from '../../src/modules/voice/speech/sentence-chunker';

describe('sentence chunker', () => {
  it('splits on sentence boundaries', () => {
    expect(chunkSentences('We open at eight. We close at six.')).toEqual([
      'We open at eight.',
      'We close at six.',
    ]);
  });

  it('does not fragment on an abbreviation', () => {
    expect(chunkSentences('Dr. Chen can see you at nine.')).toEqual([
      'Dr. Chen can see you at nine.',
    ]);
  });

  it('handles question and exclamation marks', () => {
    expect(chunkSentences('Can you come Tuesday? Great!')).toEqual([
      'Can you come Tuesday?',
      'Great!',
    ]);
  });

  it('flushes a trailing fragment with no terminator', () => {
    expect(chunkSentences('We open at eight. And then')).toEqual([
      'We open at eight.',
      'And then',
    ]);
  });

  it('returns nothing for empty input', () => {
    expect(chunkSentences('')).toEqual([]);
    expect(chunkSentences('   ')).toEqual([]);
  });

  it('pins the minimum chunk length to a literal', () => {
    expect(MIN_CHUNK_LENGTH).toBe(12);
  });
});
```

- [ ] **Step 2: Run, fail, implement the chunker**

Run: `npm run test --workspace=@smileflow/api -- sentence-chunker` → FAIL.

Create `apps/api/src/modules/voice/speech/sentence-chunker.ts`:

```ts
/**
 * A chunk shorter than this is not treated as a finished sentence, so "Dr."
 * and "Mr." do not end one. Twelve characters is comfortably longer than any
 * common abbreviation and shorter than any real sentence worth speaking alone.
 */
export const MIN_CHUNK_LENGTH = 12;

/**
 * Splits a reply into speakable chunks so synthesis can start on the first
 * sentence while the model is still producing the rest. That head start is
 * what makes the latency budget reachable.
 */
export function chunkSentences(text: string): string[] {
  if (text.trim().length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let buffer = '';

  // Keep the terminator with the sentence it ends.
  for (const piece of text.split(/(?<=[.!?])\s+/)) {
    buffer = buffer.length === 0 ? piece : `${buffer} ${piece}`;

    if (buffer.length >= MIN_CHUNK_LENGTH && /[.!?]$/.test(buffer)) {
      chunks.push(buffer);
      buffer = '';
    }
  }

  if (buffer.trim().length > 0) {
    chunks.push(buffer.trim());
  }

  return chunks;
}
```

- [ ] **Step 3: Write the failing streaming + teardown test**

Create `apps/api/tests/voice/tts-streaming.spec.ts`:

```ts
describe('TTS streaming and teardown', () => {
  it('emits the first audio frame before the whole reply is synthesised', async () => {
    const { gateway, tts } = await buildGatewayWithFakeTts();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    await gateway.handleFrame(transport, { type: 'turn.text', text: 'hours?' });

    // First frame lands while later sentences are still pending.
    expect(transport.audioFrames.length).toBeGreaterThan(0);
    expect(tts.synthesiseCalls.length).toBeGreaterThan(1);
  });

  it('falls back to text delivery when TTS fails twice', async () => {
    const { gateway, tts } = await buildGatewayWithFakeTts({ failEveryChunk: true });
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    await gateway.handleFrame(transport, { type: 'turn.text', text: 'hours?' });

    expect(transport.sent).toContainEqual({ type: 'error', code: 'tts_unavailable' });
    // The turn is not lost — the reply arrives as text on the socket.
    expect(transport.typesSent()).toContain('turn.complete');
  });

  it('cancels in-flight synthesis exactly once on teardown', async () => {
    const { gateway, tts } = await buildGatewayWithFakeTts({ slow: true });
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    const turn = gateway.handleFrame(transport, { type: 'turn.text', text: 'hours?' });
    await transport.fireTeardown();
    await turn;

    expect(tts.cancelCalls).toBe(1);
  });

  it('emits no further audio frames after teardown', async () => {
    const { gateway } = await buildGatewayWithFakeTts({ slow: true });
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    const turn = gateway.handleFrame(transport, { type: 'turn.text', text: 'hours?' });
    await transport.fireTeardown();
    const framesAtTeardown = transport.audioFrames.length;
    await turn;

    expect(transport.audioFrames.length).toBe(framesAtTeardown);
  });

  it('has no barge-in detection: caller audio during playback does not cancel', async () => {
    const { gateway, tts } = await buildGatewayWithFakeTts({ slow: true });
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });

    const turn = gateway.handleFrame(transport, { type: 'turn.text', text: 'hours?' });
    await gateway.handleAudio(transport, Buffer.alloc(640));
    await turn;

    // Barge-in is Phase 2. cancel() exists for teardown and nothing else.
    expect(tts.cancelCalls).toBe(0);
  });
});
```

- [ ] **Step 4: Run, fail, implement**

Implement `ElevenLabsTtsService` streaming per chunk, retrying once per chunk, falling back to text on repeat failure. Register `cancel()` via `transport.onTeardown(...)` — T2's registry, not a new one. Track a `cancelled` flag so no frame is forwarded after teardown.

- [ ] **Step 5: Mutation checks**

1. Make `cancel()` a no-op → "cancels exactly once" red. Restore.
2. Remove the `cancelled` guard on frame forwarding → "no further audio frames" red. Restore.

- [ ] **Step 6: Full suite, typecheck, lint, commit**

```bash
npm run test --workspace=@smileflow/api
cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../..
npm run lint
git add apps/api
git commit -m "feat(voice): stream text to speech with sentence chunking"
```

**Acceptance criteria:** First frame before full generation; chunker handles abbreviations, terminators, end-flush, empty input; text fallback on repeat failure; `cancel()` called exactly once on teardown and no frames after; **no barge-in detection present**.

**Security checks:** `ELEVENLABS_API_KEY` server-side only, never logged, never sent to the client; provider errors surface as `tts_unavailable`, never as provider text.

**Mutation/negative tests:** Steps 5.1–5.2, both mandatory.

**Rollback conditions:** Roll back if `cancel()` is wired to any caller-speech signal — that is Phase 2 work and must not appear here.

---

### Task T7: Error surface hardening for the WS path

**Objective:** Guarantee the browser never receives provider, database, or exception text on any failure path.

**Dependencies:** T3.

**Files:**
- Create: `apps/api/src/modules/voice/transport/error-mapper.ts`
- Modify: `apps/api/src/modules/voice/transport/voice.gateway.ts`
- Test: `apps/api/tests/voice/ws-error-surface.spec.ts` (create)

**Interfaces:**
- Consumes: `VoiceErrorCode`, `VOICE_ERROR_CODES` (T2).
- Produces: `toClientError(error: unknown, fallback: VoiceErrorCode): { type: 'error'; code: VoiceErrorCode }`, `logServerError(logger, logId, error): void`.

- [ ] **Step 1: Write the failing leak test**

Create `apps/api/tests/voice/ws-error-surface.spec.ts`:

```ts
const LEAKY_ERRORS = [
  new Error('connect ECONNREFUSED 10.0.0.5:5432'),
  new Error('Deepgram: 401 Unauthorized (project 9f2a)'),
  new Error('ElevenLabs quota exceeded for voice rachel'),
  new Error('AnthropicError: overloaded_error'),
  Object.assign(new Error('PrismaClientKnownRequestError'), { code: 'P2002' }),
];

describe('websocket error surface', () => {
  it.each(LEAKY_ERRORS)('maps %s to an enumerated code with no provider text', (error) => {
    const frame = toClientError(error, 'internal');

    expect(VOICE_ERROR_CODES).toContain(frame.code);
    expect(Object.keys(frame)).toEqual(['type', 'code']);
    expect(JSON.stringify(frame)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(frame)).not.toMatch(/Deepgram|ElevenLabs|Anthropic|Prisma/i);
  });

  it('never lets an error message reach the client through the gateway', async () => {
    const { gateway } = await buildGatewayThatThrows(
      new Error('Deepgram: 401 Unauthorized (project 9f2a)')
    );
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'hours?' });

    const serialised = JSON.stringify(transport.sent);
    expect(serialised).not.toContain('401');
    expect(serialised).not.toContain('9f2a');
    expect(serialised).not.toMatch(/Deepgram/i);
  });

  it('logs the real error against logId and never the session id', async () => {
    const logs: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation((m) => {
      logs.push(String(m));
    });

    const { gateway } = await buildGatewayThatThrows(new Error('Deepgram: 401 Unauthorized'));
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    const sessionId = (transport.sent[0] as { sessionId: string }).sessionId;
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'hours?' });

    const joined = logs.join('\n');
    expect(joined).toContain('Deepgram: 401 Unauthorized');
    expect(joined).not.toContain(sessionId);

    spy.mockRestore();
  });

  it('leaves the global HTTP exception filter alone', () => {
    const source = readFileSync(
      join(__dirname, '../../src/common/filters/all-exceptions.filter.ts'),
      'utf8'
    );
    // Phase 2 owns this. Changing it here would be scope creep into a surface
    // that has no authenticated users yet.
    expect(source).toContain('exception.message');
  });
});
```

- [ ] **Step 2: Run, fail, implement the mapper**

Run: `npm run test --workspace=@smileflow/api -- ws-error-surface` → FAIL.

Create `apps/api/src/modules/voice/transport/error-mapper.ts`:

```ts
import { Logger } from '@nestjs/common';
import { VoiceErrorCode } from './error-codes';
import { ServerFrame } from './frames';

/**
 * Builds the only error shape the browser ever sees.
 *
 * It deliberately never reads `error.message`. A Deepgram 401 names the
 * project, a Prisma error names the constraint, an Anthropic error names the
 * model state, and a socket error names the host and port. None of that is the
 * caller's business, and a client that never receives it cannot leak it.
 */
export function toClientError(
  _error: unknown,
  fallback: VoiceErrorCode
): Extract<ServerFrame, { type: 'error' }> {
  return { type: 'error', code: fallback };
}

/** The real error goes here — server-side, correlated by the non-secret logId. */
export function logServerError(logger: Logger, logId: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  logger.error(`Voice transport failure for ${logId} — ${detail}`);
}
```

- [ ] **Step 3: Route every gateway catch through the mapper**

Wrap frame handling, turn dispatch, STT and TTS calls so no `catch` block sends anything but a mapped code.

- [ ] **Step 4: Mutation check**

Make `toClientError` include `message: String(error)`. Expected: all leak tests red. Restore.

- [ ] **Step 5: Full suite, typecheck, lint, commit**

```bash
npm run test --workspace=@smileflow/api
cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../..
npm run lint
git add apps/api
git commit -m "feat(voice): enumerate every client-facing websocket error"
```

**Acceptance criteria:** Five representative provider/database errors all map to enumerated codes with a two-key frame; nothing reaches the client but `type` and `code`; the real error is logged against `logId`; the global HTTP filter is unchanged.

**Security checks:** No provider identity, no host, no port, no SQL, no stack. `sessionId` absent from every log assertion.

**Mutation/negative tests:** Step 4, mandatory.

**Rollback conditions:** Roll back if any client frame carries a field beyond `type` and `code`, or if `all-exceptions.filter.ts` shows a diff.

---

### Task T6: Public route and browser widget

**Objective:** Create the first unauthenticated page in the app and put the voice widget on it, so an anonymous caller can complete intake and booking by speaking.

**Dependencies:** T3, T4, T5, T7.

**Files:**
- Create: `apps/web/src/app/(public)/layout.tsx`
- Create: `apps/web/src/app/(public)/voice/page.tsx`
- Create: `apps/web/src/components/voice/voice-widget.tsx`
- Create: `apps/web/src/components/voice/use-voice-socket.ts`
- Create: `apps/web/public/voice-capture-worklet.js`
- Test: `apps/web/tests/voice-widget.test.tsx` (create)

**Interfaces:**
- Consumes: the server frame protocol from T2 (`session.ready`, `session.rotated`, `stt.partial`, `agent.thinking`, `turn.complete`, `error`).
- Produces: `<VoiceWidget />`, `useVoiceSocket(url)`.

**Context the implementer needs:** `apps/web` has **no public surface today** — `src/app/page.tsx` is `redirect('/login')` and the only route groups are `(auth)`, `(portal)`, `(staff)`. There is no `middleware.ts`, so nothing gates routes at the edge; a new route group is public by default. Web tests are jsdom, live in `apps/web/tests/**/*.test.tsx`, and `@/` maps to `src/`.

- [ ] **Step 1: Write the failing widget test**

Create `apps/web/tests/voice-widget.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { VoiceWidget } from '@/components/voice/voice-widget';

describe('VoiceWidget', () => {
  it('discloses that the caller is speaking to an automated assistant', () => {
    render(<VoiceWidget />);
    expect(screen.getByText(/automated assistant/i)).toBeInTheDocument();
  });

  it('offers a labelled control to start talking', () => {
    render(<VoiceWidget />);
    expect(screen.getByRole('button', { name: /start talking/i })).toBeInTheDocument();
  });

  it('shows a permission message when the microphone is refused', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: jest.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });

    render(<VoiceWidget />);
    screen.getByRole('button', { name: /start talking/i }).click();

    expect(await screen.findByText(/microphone access/i)).toBeInTheDocument();
  });

  it('never renders a provider key', () => {
    const { container } = render(<VoiceWidget />);
    expect(container.innerHTML).not.toMatch(/sk-|api[_-]?key/i);
  });
});
```

- [ ] **Step 2: Run, fail, build the widget and the hook**

Run: `npm run test --workspace=@smileflow/web` → FAIL.

Build `use-voice-socket.ts` (native `WebSocket` — **no client library**, which keeps the bundle clean and is why raw `ws` was chosen server-side), storing `sessionId` in component state and **replacing it on `session.rotated`**. Build `voice-widget.tsx` with idle / requesting-permission / listening / thinking / speaking / error states and a persistent disclosure line.

- [ ] **Step 3: Create the public route group**

`apps/web/src/app/(public)/layout.tsx` — a minimal shell with **no staff or portal navigation** and no authenticated data fetching. `apps/web/src/app/(public)/voice/page.tsx` renders `<VoiceWidget />`.

- [ ] **Step 4: Write the failing route test**

```tsx
it('renders the public voice page without any authenticated navigation', () => {
  render(<PublicLayout><VoicePage /></PublicLayout>);
  expect(screen.queryByRole('link', { name: /dashboard/i })).toBeNull();
  expect(screen.queryByRole('link', { name: /patients/i })).toBeNull();
  expect(screen.queryByRole('link', { name: /billing/i })).toBeNull();
  expect(screen.getByText(/automated assistant/i)).toBeInTheDocument();
});
```

- [ ] **Step 5: Add the capture worklet**

`apps/web/public/voice-capture-worklet.js` downsamples from the device rate to 16 kHz mono `linear16` in ~20 ms frames, using `AudioWorkletProcessor` — **not** `ScriptProcessorNode`, which is deprecated and runs on the main thread.

- [ ] **Step 6: Verify the route is reachable unauthenticated**

```bash
npm run dev --workspace=@smileflow/web
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/voice
```
Expected: `200`, with no redirect to `/login`.

- [ ] **Step 7: Verify no secret reaches the bundle**

```bash
npm run build --workspace=@smileflow/web
grep -rniE "deepgram|elevenlabs|sk-[a-z0-9]|anthropic" apps/web/.next/static/ || echo "clean"
```
Expected: `clean`. If anything matches, **stop** — a provider credential is in a browser bundle.

- [ ] **Step 8: End-to-end manual check**

With `VOICE_AGENT_ENABLED=true`, `VOICE_BROWSER_ENABLED=true` and real provider keys in `apps/api/.env`, open `/voice`, speak an intake ("my name is …"), then book. Confirm: booking lands in the database, an `AuditLog` row exists for each tool call, and the widget received a `session.rotated`.

- [ ] **Step 9: Lint, test, commit**

```bash
npm run test --workspace=@smileflow/web
npm run lint
git add apps/web
git commit -m "feat(web): add the public voice page and browser widget"
```

**Acceptance criteria:** `/voice` reachable **without authentication** and does not redirect to login; **no staff or portal navigation** and no authenticated data on the page; visible **"automated assistant" disclosure**; **anonymous Tier 1 intake→book by voice succeeds**; no provider key and no WebSocket client library in the shipped bundle.

**Security checks:** No credential in the bundle (Step 7 is a hard gate); the widget never sends `patientId`/`userId`/`identityVerified` — it holds only `sessionId`; the new public route exposes nothing but the widget.

**Mutation/negative tests:** Remove the disclosure line → disclosure test red. Add a `<Link href="/dashboard">` to the public layout → navigation test red.

**Rollback conditions:** Roll back if Step 7 finds any provider string, or if the public route exposes any authenticated data.

---

### Task T8: Tier-2 unreachability proof

**Objective:** Prove that no verified-tier tool can be reached through the gateway and that nothing can set `identityVerified`. **No identity verification is written** — that is Phase 2.

**Dependencies:** T2 (executable here because `turn.text` drives a real turn without STT/TTS).

**Files:**
- Test: `apps/api/tests/voice/tier-isolation-gateway.spec.ts` (create)

**Interfaces:** Consumes `VoiceGateway`, `FakeTransport` (T2). Produces no production code — this task is tests only.

- [ ] **Step 1: Write the failing tier test**

Boot the **real** `VoiceModule` so all ten real tools are registered, then drive a turn per verified tool:

```ts
const VERIFIED_TOOLS = [
  'get_my_appointments',
  'get_my_invoices',
  'get_my_balance',
  'reschedule_appointment',
  'cancel_appointment',
];

describe('tier 2 is unreachable through the gateway', () => {
  it.each(VERIFIED_TOOLS)('%s returns verification_required', async (toolName) => {
    const { gateway, toolResults } = await buildRealModuleGateway(toolName);
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    await gateway.handleFrame(transport, { type: 'turn.text', text: `please ${toolName}` });

    expect(toolResults).toEqual([{ status: 'failed', error: 'verification_required' }]);
  });

  it('leaves identityVerified false for the life of the session', async () => {
    const { gateway, store } = await buildRealModuleGateway('get_clinic_info');
    const transport = new FakeTransport();

    await gateway.handleFrame(transport, { type: 'session.start' });
    const id = (transport.sent[0] as { sessionId: string }).sessionId;
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'hours?' });

    expect(store.get(id)?.session.identityVerified).toBe(false);
  });

  it('has no gateway path that can set identityVerified', () => {
    const dir = join(__dirname, '../../src/modules/voice/transport');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source).not.toMatch(/identityVerified\s*=/);
    }
  });

  it('has no production caller of createVerifiedSession', () => {
    const hits = execSync(
      "grep -rl 'createVerifiedSession' apps/api/src || true",
      { cwd: join(__dirname, '../../../..') }
    ).toString().trim().split('\n').filter(Boolean);

    // It is exported from voice-session.ts as the fixture the Phase 0
    // authorization suite is built on. Nothing else in src/ may call it.
    expect(hits).toEqual(['apps/api/src/modules/voice/session/voice-session.ts']);
  });
});
```

- [ ] **Step 2: Run and confirm it passes against the current code**

Run: `npm run test --workspace=@smileflow/api -- tier-isolation-gateway`
Expected: PASS, 8 tests.

- [ ] **Step 3: Mutation check — mandatory, this is the whole point of the task**

In `voice.gateway.ts`'s `resume()`, force `conversation.session.identityVerified = true;`.
Run the suite.
Expected: **all five tier tests plus the "leaves identityVerified false" test go red.**
**Restore**, re-run, confirm green. If forcing verification does not turn the suite red, the tests are decorative and the task has not been done.

- [ ] **Step 4: Commit**

```bash
npm run test --workspace=@smileflow/api
npm run lint
git add apps/api/tests/voice/tier-isolation-gateway.spec.ts
git commit -m "test(voice): prove tier 2 stays unreachable through the gateway"
```

**Acceptance criteria:** All five verified tools return `verification_required` through the gateway; `identityVerified` stays `false`; no transport file assigns it; `createVerifiedSession` has exactly one `src/` hit, its own definition.

**Security checks:** No verification flow written; no code path constructs a verified session; the tier gate is exercised through the real module, not a stub.

**Mutation/negative tests:** Step 3, mandatory and blocking.

**Rollback conditions:** Roll back if Step 3 does not turn the suite red.

---

### Task T9: Transport observability

**Objective:** Make the transport debuggable in production without ever emitting a credential, a transcript, or audio.

**Dependencies:** T3, T4, T5.

**Files:**
- Create: `apps/api/src/modules/voice/transport/transport-metrics.service.ts`
- Modify: `apps/api/src/modules/voice/transport/voice.gateway.ts`
- Modify: `apps/api/src/modules/voice/voice.module.ts`
- Test: `apps/api/tests/voice/transport-metrics.spec.ts` (create)

**Interfaces:** Produces `class TransportMetricsService` with `connectionOpened(logId)`, `connectionClosed(logId, reason)`, `turnCompleted(logId, ms)`, `sttConfidence(logId, value)`, `ttsFirstFrame(logId, ms)`, `providerError(logId, provider)`, `sessionRotated(logId)`.

- [ ] **Step 1: Write the failing hygiene test**

```ts
describe('transport observability', () => {
  it('records the lifecycle keyed on logId', async () => {
    const { gateway, lines } = await buildGatewayWithMetrics();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'hours?' });
    await transport.fireTeardown();

    const joined = lines.join('\n');
    expect(joined).toMatch(/connection.opened/);
    expect(joined).toMatch(/turn.completed/);
    expect(joined).toMatch(/connection.closed/);
  });

  it('never emits the session id, the transcript, or audio', async () => {
    const { gateway, lines, store } = await buildGatewayWithMetrics();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    const sessionId = (transport.sent[0] as { sessionId: string }).sessionId;
    const secret = 'my date of birth is the fourth of June nineteen eighty';
    await gateway.handleFrame(transport, { type: 'turn.text', text: secret });

    const joined = lines.join('\n');
    expect(joined).not.toContain(sessionId);
    expect(joined).not.toContain(secret);
    expect(joined).not.toContain('date of birth');
    expect(joined).toContain(store.get(sessionId)!.session.logId);
  });

  it('records a rotation event', async () => {
    const { gateway, lines } = await buildGatewayWithMetricsAndIntake();
    const transport = new FakeTransport();
    await gateway.handleFrame(transport, { type: 'session.start' });
    await gateway.handleFrame(transport, { type: 'turn.text', text: 'my name is Dana' });

    expect(lines.join('\n')).toMatch(/session.rotated/);
  });
});
```

- [ ] **Step 2: Run, fail, implement, run, pass**

Run: `npm run test --workspace=@smileflow/api -- transport-metrics` → FAIL.

Create `apps/api/src/modules/voice/transport/transport-metrics.service.ts`. Every method takes
`logId` first and accepts **no parameter that could carry a credential or a transcript** — the
signatures make the guarantee structural rather than a convention someone has to remember:

```ts
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class TransportMetricsService {
  private readonly logger = new Logger('VoiceTransport');

  connectionOpened(logId: string): void {
    this.logger.log(`connection.opened ${logId}`);
  }

  connectionClosed(logId: string, reason: string): void {
    this.logger.log(`connection.closed ${logId} reason=${reason}`);
  }

  turnCompleted(logId: string, durationMs: number): void {
    this.logger.log(`turn.completed ${logId} ms=${durationMs}`);
  }

  /** The score, never the words. A transcript in a log is a medical record in a log. */
  sttConfidence(logId: string, confidence: number): void {
    this.logger.log(`stt.confidence ${logId} value=${confidence.toFixed(2)}`);
  }

  ttsFirstFrame(logId: string, latencyMs: number): void {
    this.logger.log(`tts.first_frame ${logId} ms=${latencyMs}`);
  }

  providerError(logId: string, provider: 'stt' | 'tts' | 'agent'): void {
    this.logger.warn(`provider.error ${logId} provider=${provider}`);
  }

  sessionRotated(logId: string): void {
    this.logger.log(`session.rotated ${logId}`);
  }
}
```

- [ ] **Step 3: Mutation check**

Add `sessionId` to `connectionOpened`'s emitted line. Expected: hygiene test red. Restore.

- [ ] **Step 4: Commit**

```bash
npm run test --workspace=@smileflow/api
npm run lint
git add apps/api
git commit -m "feat(voice): record transport metrics against the log id"
```

**Acceptance criteria:** Connection, turn, latency, rotation and provider-error events recorded; **no `sessionId`, transcript or audio in any emitted line**.

**Security checks:** `logId` only; method signatures make passing a credential awkward by construction.

**Mutation/negative tests:** Step 3, mandatory.

**Rollback conditions:** Roll back if any metric method accepts a `sessionId` parameter.

---

### Task T10: Docs, flags and the single-process constraint

**Objective:** Ship the phase behind a flag, document the constraints honestly, and warn an operator who configures a deployment the architecture cannot support.

**Dependencies:** All (T0, T1a, T1b, T2, T3, T4, T5, T6, T7, T8, T9).

**Files:**
- Modify: `apps/api/src/modules/voice/voice.config.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Test: `apps/api/tests/voice/startup-constraints.spec.ts` (create)

**Interfaces:** Produces `VOICE_CONFIG.browserEnabled`, `warnIfMultiInstance(logger): boolean`.

- [ ] **Step 1: Write the failing startup-warning test**

```ts
describe('single-process constraint', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('warns when browser voice is on and more than one instance is declared', () => {
    process.env.VOICE_BROWSER_ENABLED = 'true';
    process.env.APP_INSTANCES = '2';
    const logger = { warn: jest.fn() } as unknown as Logger;

    expect(warnIfMultiInstance(logger)).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((logger.warn as jest.Mock).mock.calls[0][0]).toMatch(/single process/i);
  });

  it('stays quiet for a single instance', () => {
    process.env.VOICE_BROWSER_ENABLED = 'true';
    process.env.APP_INSTANCES = '1';
    const logger = { warn: jest.fn() } as unknown as Logger;

    expect(warnIfMultiInstance(logger)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays quiet when APP_INSTANCES is unset', () => {
    process.env.VOICE_BROWSER_ENABLED = 'true';
    delete process.env.APP_INSTANCES;
    const logger = { warn: jest.fn() } as unknown as Logger;

    expect(warnIfMultiInstance(logger)).toBe(false);
  });

  it('stays quiet when browser voice is off, however many instances', () => {
    process.env.VOICE_BROWSER_ENABLED = 'false';
    process.env.APP_INSTANCES = '4';
    const logger = { warn: jest.fn() } as unknown as Logger;

    expect(warnIfMultiInstance(logger)).toBe(false);
  });

  it('defaults browser voice to off', () => {
    delete process.env.VOICE_BROWSER_ENABLED;
    expect(readBrowserEnabled()).toBe(false);
  });
});
```

- [ ] **Step 2: Run, fail, implement**

Add `browserEnabled: process.env.VOICE_BROWSER_ENABLED === 'true'` to `VOICE_CONFIG`. Implement `warnIfMultiInstance` — it **warns rather than refuses**, because an operator who has read the design and accepts sticky-session routing should not be blocked by a guess. Call it from `bootstrap()`.

- [ ] **Step 3: Update `.env.example`**

Replace the voice block with:

```
# Voice agent
VOICE_AGENT_ENABLED=false
ANTHROPIC_API_KEY=your-anthropic-api-key

# Voice agent — browser voice (Phase 1)
VOICE_BROWSER_ENABLED=false
DEEPGRAM_API_KEY=your-deepgram-api-key
ELEVENLABS_API_KEY=your-elevenlabs-api-key

# Browser origin allowlist. Comma separated. Also used for the WebSocket
# Origin check — CORS does not cover WebSocket handshakes.
FRONTEND_URL=http://localhost:3000

# Session and idempotency state is in-process. Running more than one instance
# with VOICE_BROWSER_ENABLED=true needs sticky routing; see the README.
APP_INSTANCES=1
```

`FRONTEND_URL` is declared in `packages/config/src/env.ts` and `docker-compose.yml` but has never been in `.env.example`.

- [ ] **Step 4: Write the README section**

The README has **no voice section at all** — Phase 0 shipped the agent undocumented. Add one covering: what the agent does, Tier 1 vs Tier 2, the two flags, required provider keys, how to run it locally, the single-process constraint and its Phase 2 Redis resolution, and the deferred list (barge-in, telephony, identity verification).

- [ ] **Step 5: Verify no secret was committed**

```bash
git diff --cached | grep -inE "sk-[a-z0-9]{8}|[0-9a-f]{32}" && echo "SECRET SUSPECTED — STOP" || echo "clean"
```

- [ ] **Step 6: Full suite, typecheck, lint, commit**

```bash
npm run test --workspace=@smileflow/api
npm run test --workspace=@smileflow/web
cd apps/api && npx tsc --noEmit -p tsconfig.json && cd ../..
npm run lint
git add .env.example README.md apps/api
git commit -m "docs(voice): document browser voice, flags and the single-process limit"
```

**Acceptance criteria:** Warning fires for `APP_INSTANCES=2` with browser voice on, and not for `1`, unset, or browser voice off; `VOICE_BROWSER_ENABLED` defaults false; `.env.example` carries placeholders only; README documents the constraint and the deferred list.

**Security checks:** No real provider value committed (Step 5 is a hard gate); `.env.example` holds placeholder names only.

**Mutation/negative tests:** Change the warning condition to `APP_INSTANCES !== '2'` → the "stays quiet for a single instance" test goes red.

**Rollback conditions:** Roll back if Step 5 flags anything, or if either flag defaults to `true`.

---

## Phase boundary — do not cross

If any task appears to require one of these, **stop and report**. Each is deliberately deferred:

| Item | Owner |
|---|---|
| Identity verification, authenticated voice sessions | Phase 2 |
| Activating Tier 2 tools | Phase 2 |
| Barge-in **detection** (the `cancel()` contract ships in T5) | Phase 2 |
| Redis migration (design recorded in spec §2.9) | Phase 2 |
| Changing `all-exceptions.filter.ts` | Phase 2 |
| Twilio, telephony, `TwilioMediaStreamTransport` | Phase 3 |

## Self-review notes

- **Spec coverage:** every spec section maps to a task — §2.2→T1a/T1b, §2.3→T8, §2.4→T3, §2.6→T2, §2.7→T2, §2.8→T7, §2.9→T10 (docs only), §2.10→T3, §3→T4, §4→T5, §5→deferred by design, §6→T2/T3, §7→T3, §8→T4/T5, §9→T9, §11→T10, §13→all.
- **Type consistency:** `runTurn(transport, conversation, text)` is defined in T2 and called unchanged in T1b and T4. `onTeardown(fn)` is defined in T2 and consumed in T3 and T5. `VoiceErrorCode` is defined in T2 and consumed in T3, T5, T7.
- **Phase 0 guarantee:** `claude.agent.ts`, `tool-executor.service.ts`, `tool-registry.service.ts`, `idempotency.service.ts` and every `*.tool.ts` appear in **no task's modify list**. T4 Step 4 makes that a hard, checkable gate.
