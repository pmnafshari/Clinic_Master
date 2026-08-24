# Voice Agent Phase 1 — Browser Voice (Tier 1) — Design

**Date:** 2026-08-19
**Revised:** 2026-08-20 — pre-implementation review findings folded in. See §14 for the change log.
**Status:** Design approved for planning. No code written.
**Builds on:** Phase 0 — text-only foundation, merged to `main` as `f221bd1` (PR #1).

---

## 1. Scope

Phase 1 puts a **voice widget on the public site** so a prospective patient can ask about the
clinic, give their details, and book — by speaking. It adds a transport in front of the Phase 0
agent. It does not change the agent, the tools, the authorization gate, or the audit trail.

### Decided

| Question | Decision |
|---|---|
| Session identity | **Anonymous.** Even a logged-in patient gets an anonymous session. |
| Tier | **Tier 1 only.** Tier 2 stays unreachable. |
| Placement | **Public site**, new-patient booking journey. |
| Process model | **Single process.** Redis deferred. |
| Audio | **Streaming both directions**, no barge-in. |
| Transport | **WebSocket relay**, provider credentials server-side only. |

### Explicitly NOT in Phase 1

Twilio or any telephony. Barge-in detection. Redis. Identity verification. Tier 2 tools. Payment
tools. The global HTTP exception filter.

### The load-bearing property

`ClaudeAgentService`, `ToolExecutorService`, the tool registry, and `IdempotencyService` are
**unchanged**. Every property proven in Phase 0 — the tier gate, `needsPatientContext`, the
idempotency guarantees, the audit trail — continues to hold because the audio layer sits entirely
above them and reaches the agent through the same entry point the text endpoint uses:
`ClaudeAgentService.respond(session, userText, history)`.

**Phase 0 code that Phase 1 does change**, deliberately and with the Phase 0 suite as the bar:

| File | Change | Task |
|---|---|---|
| `voice/util/bounded-ttl-map.ts` | add `delete(key)` | T0 |
| `voice/voice.controller.ts` | session map moves out to `VoiceSessionStore`; rotation applied | T0, T1a |
| `voice/voice.module.ts` | provide and export `VoiceSessionStore`; register the gateway | T0, T2 |
| `main.ts` | shared origin allowlist helper; WebSocket adapter | T2, T3 |

Nothing in that list is the agent, the executor, the registry, or the idempotency service.

---

## 2. Session and security

### 2.1 The WebSocket is anonymous, and carries no identity

A WebSocket connection is **not** an identity claim. Connecting proves nothing about who is
speaking. `sessionId` remains a server-issued 256-bit bearer credential and is **never** written to
logs, metrics, traces, or error messages — `logId` is the only session identifier that appears in
observability output, exactly as in Phase 0.

Phase 1 does not set `identityVerified`. It stays `false` for the life of every session.

### 2.2 Session fixation — rotation on privilege change

Phase 0 recorded session fixation as a hard prerequisite for browser voice. It is fixed here, and it
is fixed **for both transports** — the Phase 0 text endpoint remains live throughout the phase
(§11), so rotation that only covered the WebSocket would leave the flaw reachable.

**When rotation happens.** Whenever the session's privilege changes:

- `start_patient_intake` binds a `patientId` to a previously unbound session — a privilege change,
  because the session can now act for a specific patient. This is the **only** trigger reachable in
  Phase 1: `patient-intake.tool.ts` holds the sole `session.patientId =` assignment in the codebase.
- `identityVerified` transitions to `true` (cannot occur in Phase 1; the predicate covers it so
  Phase 2 inherits the behaviour rather than re-deriving it — no verification code is written here).

**Where rotation runs.** In the **session store**, not in a transport and not in the agent. Both the
HTTP controller and the WebSocket gateway capture `session.patientId` before calling
`agent.respond(...)`, compare it after, and ask the store to rotate when it changed. The agent, the
executor and the tools are untouched.

**Timing, stated explicitly.** `patientId` is bound deep inside a tool call, so rotation lands at
**end of turn**, not the instant the tool returns. The old id therefore stays valid for the
remainder of that one turn. This is accepted: the fixation attacker already holds the planted id for
the whole conversation, so end-of-turn rotation closes the window at the first moment the session
has anything worth stealing. Rotating mid-turn would require the executor or the agent to know about
the session store, which would break the load-bearing property for no security gain.

**How rotation works.**

1. The turn completes and the session's privilege has changed.
2. The server mints a fresh 256-bit `sessionId` (`newOpaqueId()`).
3. `VoiceSessionStore.rotate(oldId)` re-keys the stored record under the new id and **deletes the
   old key in the same synchronous operation**. The old credential is invalid immediately — not on
   expiry. Single-process Node makes this atomic by construction; §2.9 records the Redis equivalent.
4. **HTTP:** the response body's `sessionId` field carries the new id — the endpoint already returns
   the authoritative id on every turn, so no protocol change is needed, only a test pinning that the
   returned id changed and the old one no longer resumes.
   **WebSocket:** the server pushes a `session.rotated` control frame carrying the new `sessionId`.
5. The client replaces its stored value. Any later request or frame presenting the old id is treated
   as an unrecognised id — see §2.4 for why that means "start fresh", not "error".

**Why the client can learn it safely.** The new id travels down the already-established channel the
caller is holding — the same channel that carried the original id. No new exposure surface.

**What rotation carries across.** The stored record is re-keyed, not rebuilt, so
`idempotencyNonce`, `turnIndex`, `logId`, `patientId` and the **conversation history** all survive
unchanged. Only `sessionId` changes.

**Idempotency survives rotation, by construction.** Phase 0 separated `sessionId` (the bearer
credential) from `idempotencyNonce` (the replay namespace). `IdempotencyService.keyFor` derives keys
from `idempotencyNonce : turnIndex : toolName : sha256(input)` and **never reads `sessionId`**, so
keys computed before and after rotation still collide for the same operation. A retry that spans a
rotation still de-duplicates. Had the key been derived from `sessionId`, rotation would silently
create a fresh namespace and re-execute writes — precisely the Critical found and fixed in Phase 0.

`logId` also carries across, so the audit trail for one conversation stays correlatable.

### 2.3 Tier 2 remains unreachable — and it is tested

Phase 1 does not simply decline to verify; it proves Tier 2 cannot be reached:

- No production code path constructs a verified session, and none is added here.
- `createVerifiedSession` is exported from `session/voice-session.ts` but is **called only from
  tests**. Phase 1 keeps it that way and makes the rule enforceable rather than conventional: a test
  asserts that no file under `apps/api/src/` imports it. Phase 1 does **not** delete or relocate it —
  it is the fixture the whole Phase 0 authorization suite is built on.
- A test boots the real `VoiceModule`, drives a full turn through the gateway using the `turn.text`
  control frame (§2.7), and asserts every `verified`-tier tool returns `verification_required`.
- A test asserts no gateway path can set `identityVerified`.

**Phase 2 owns the verification flow** (patient logs in, the voice session is bound to that
authenticated user, tier tests re-run against a genuinely verified session). Designing it here would
re-merge the phase split.

### 2.4 WebSocket security controls

| Control | Rule |
|---|---|
| Origin validation | `Origin` checked against the shared allowlist (§2.10); mismatch closes **before the upgrade completes** |
| Connection rate limit | Per-IP cap on new connections per minute, enforced at upgrade time |
| Message rate limit | Per-session cap on frames/sec and on agent turns — see §7 for the named constants |
| Max frame size | Audio chunks capped (64 KB); oversize closes the connection |
| Max connection duration | Hard cap (10 min), independent of session TTL |
| Max session duration | Existing 30-min TTL, unchanged |
| Concurrent connections | **One live socket per session.** A second connection presenting the same `sessionId` is rejected, not silently joined — joining would let a stolen id eavesdrop on a live conversation |
| Clean disconnect | Close the STT stream, cancel in-flight TTS, abort the agent turn, flush audit, release the session slot |

**Unknown `sessionId` on connect — resolved.** Phase 0 deliberately makes an unrecognised id start a
fresh conversation rather than erroring, and pins it with a test (`does not reveal which session ids
exist`). The WebSocket **matches that behaviour exactly**: an id the server does not hold is not
adopted, is not an error, and silently yields a new anonymous session whose id is returned in
`session.ready`. Diverging here would turn the gateway into the enumeration oracle the HTTP endpoint
was written to avoid.

**Duplicate connection — the accepted trade-off.** Rejecting a second socket on a live session does
reveal that the session exists. That is accepted, and recorded here as a decision rather than left
implicit: the fact is only observable to someone already presenting a valid 256 CSPRNG-bit id, so it
is not an enumeration path — an attacker who can produce a live id has already won whatever the
oracle would have told them. Eavesdropping on a live conversation is the larger risk, so the second
socket is rejected with `session_conflict` and closed. The **first** socket is left untouched:
closing it instead would let anyone holding a stolen id kick the legitimate caller off.

Both behaviours get a test (T3).

### 2.5 Provider credentials

Deepgram and ElevenLabs keys live **only** in server environment variables. They are never sent to
the browser, never embedded in a page, and never minted into short-lived client tokens. The browser
speaks to our WebSocket and nothing else. `.env.example` gains placeholder names only.

### 2.6 The audio path cannot bypass Phase 0

```
browser audio → STT → ClaudeAgentService → ToolExecutorService → tool → audit
```

The transport layer **must not call tools directly**. It has no reference to `ToolRegistryService`
or any tool; it holds `ClaudeAgentService` and `VoiceSessionStore` and nothing else from the voice
module.

This is enforced by a **static import-graph test asserting the gateway module imports neither the
registry nor any `*.tool.ts`**. This is a new test technique for this repository — Phase 0 pins the
executor's *behaviour* (tier gate, narrowing, non-mutation, schema hygiene) across 22 tests in
`tool-authorization.spec.ts`, but has no import-graph assertion to copy. T2 chooses the mechanism and
must include a mutation check: adding a registry import to the gateway has to turn the suite red.

### 2.7 Transport abstraction and the frame protocol

`AudioTransport` is the seam. `BrowserWebSocketTransport` implements it in Phase 1;
`TwilioMediaStreamTransport` implements it in Phase 3 without touching the agent, tools, or security
layers. The interface carries audio frames and control events only — **never identity**.

**Frame schemas are explicit and validated.** Phase 0's controller relies on the global
`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` to guarantee that no request body
field other than `sessionId` and `message` is ever read. **That pipe is HTTP-only and a Nest
WebSocket gateway does not inherit it.** Phase 1 therefore declares the wire protocol and validates
every inbound frame against it.

**Client → server**

| Frame | Fields | Notes |
|---|---|---|
| `session.start` | `sessionId?` | Optional resume; unknown id silently starts fresh (§2.4) |
| `audio.chunk` | binary payload | PCM `linear16`, 16 kHz mono; ≤ 64 KB |
| `audio.end` | — | Caller released the mic |
| `turn.text` | `text` | Text turn over the socket. Drives a full agent turn with no speech provider involved — the network-free integration path used by T8 and the transport tests |

**Server → client**

`session.ready {sessionId}` · `session.rotated {sessionId}` · `stt.partial {text}` ·
`agent.thinking` · `audio.frame` (binary) · `reply.text {text}` · `turn.complete` ·
`error {code}` (§2.8)

`reply.text` carries the spoken reply as text. It is the delivery half of the §6 TTS fallback —
the failure table promised text on the socket but the frame list did not previously name a frame
able to carry it. It is emitted **only** on the fallback path, never alongside audio.

**Validation rules, tested in T2:**

- Unknown frame types are rejected and the frame is not processed.
- **Unknown fields are rejected** — the frame is refused rather than stripped, mirroring
  `forbidNonWhitelisted`.
- A frame carrying `patientId`, `userId`, `identityVerified`, `turnIndex`, `idempotencyNonce`,
  `logId`, `tier` or any snake_case equivalent is **rejected and must not modify session state**.
  This mirrors the Phase 0 test at `tool-authorization.spec.ts:152`, which pins the same property
  against model-supplied tool input.
- `sessionId` is the only client-supplied field that influences session selection, and it can only
  select — never create a session with a chosen id, exactly as in Phase 0.

### 2.8 Error surface

Raw `Error.message` must never reach the client. The Phase 0 finding stands and is verified: the
global exception filter returns `exception.message` verbatim (`all-exceptions.filter.ts:45`), and an
Anthropic/Deepgram/ElevenLabs SDK error carries provider identity and internal state.

Phase 1 fixes this **for the WebSocket path**: every error sent to the browser is a fixed,
enumerated code with no provider text —

`stt_unavailable` · `agent_unavailable` · `tts_unavailable` · `rate_limited` · `session_expired` ·
`session_conflict` · `bad_frame` · `internal`

The real error is logged server-side against `logId`.

The global HTTP filter is **not** changed here — that remains a Phase 2 item, before any
authenticated surface exists.

### 2.9 Redis — Phase 2 design only, not built in Phase 1

**Nothing in this section is implemented in Phase 1.** No Redis client is added; no task touches it.
It is recorded so the Phase 2 cut-over does not re-derive the semantics.

Phase 1 ships single-process. The constraint is documented and warned about at startup (§11).

| State | Today | Phase 2 target | Semantics |
|---|---|---|---|
| Session store | `BoundedTtlMap` behind `VoiceSessionStore` | Redis hash, TTL 30 min | `HSET` + `EXPIRE`, refreshed per turn |
| Session rotation | `rekey()` — set new, delete old | `RENAME oldKey newKey` | `RENAME` is atomic, moves the value, **removes the source key by definition, and preserves the TTL**. There is no accompanying `DEL`: the old key is already gone, and a `DEL` after it would either be a no-op or destroy the new key. Use `RENAMENX` only if collision safety is wanted — with a fresh 256-bit id, collision is not a practical concern. |
| Idempotency `completed` | `BoundedTtlMap` | Redis, TTL 15 min | `SET NX EX` — the winner executes |
| Idempotency `inFlight` | in-process promise map | Redis lock | `SET NX EX` with a short lease; losers poll for the result |

**The `IdempotencyService` and `VoiceSessionStore` interfaces do not change** at cut-over —
`keyFor`, `runOnce`, `get`, `set`, `delete`, `rekey` keep their signatures; only the backing store
swaps. Extracting `VoiceSessionStore` in T0 is what makes that swap a one-file change. No second
state mechanism is introduced.

### 2.10 One origin allowlist, not two

`main.ts` already restricts HTTP CORS to `process.env.FRONTEND_URL || 'http://localhost:3000'` — a
single value. CORS does **not** apply to WebSocket handshakes, so the gateway needs its own origin
check; the risk is two allowlists that drift apart.

Phase 1 introduces **one shared helper**, `apps/api/src/common/config/allowed-origins.ts`, exporting
`allowedOrigins(): string[]` which parses `FRONTEND_URL` as a comma-separated list and falls back to
`http://localhost:3000`. Both `app.enableCors(...)` and the WebSocket upgrade check read it. This
generalises the existing single value to a list without changing its default or its env var name.

`FRONTEND_URL` is declared in `packages/config/src/env.ts` and `docker/docker-compose.yml` but is
**missing from `.env.example`**; T10 adds it.

---

## 3. STT — streaming and endpointing

Deepgram streaming, `linear16`, 16 kHz mono. Interim results enabled for responsiveness; the final
transcript drives the turn.

**Endpointing** is Deepgram's, with an explicit silence threshold (start ~800 ms) rather than
client-side VAD. A turn is dispatched to the agent on `speech_final`, not on the first `is_final`.

**Confidence gate — transport-level, agent untouched.** When a final transcript's confidence is
below the configured threshold, the **transport** emits a fixed re-prompt ("Sorry, I didn't catch
that — could you say it again?") straight to TTS and **does not dispatch the turn**.
`ClaudeAgentService` is not invoked, not modified, and never sees the low-confidence text. The model
is not asked to decide whether it heard correctly — that would put the load-bearing property at
risk to save a canned sentence.

T4 pins this with an explicit **zero-agent-invocation test**: a below-threshold final produces the
re-prompt and `agent.respond` is called exactly `0` times.

This matters most for names, dates of birth and phone numbers, which intake collects.

`SpeechToText` interface: `start(session)`, `write(chunk)`, `end()`, and an event stream of
`{partial}` / `{final, confidence}`. Deepgram sits behind it; tests use a fake.

---

## 4. TTS — streaming and sentence chunking

ElevenLabs streaming. Claude's reply is chunked on sentence boundaries and each sentence is
synthesised as it completes, so first audio starts while the rest is still generating — this is what
makes the ~1.5 s budget reachable.

Chunking splits on `.!?` followed by whitespace, with a minimum chunk length so abbreviations do not
fragment speech, and a flush at end-of-stream.

Audio frames are forwarded to the transport as they arrive. `TextToSpeech` interface:
`synthesise(text) → AsyncIterable<AudioFrame>`, plus `cancel()`.

**One delivery path, two outcomes.** A reply is delivered by a single function that either speaks
it or sends it as text — never both, and never a second copy of the logic. It reports which outcome
occurred, so "no audio was produced" is a value the tests can assert rather than an absence they
have to infer:

```
deliverReply(transport, text) -> 'audio' | 'text'
```

`'text'` means the caller heard nothing: `reply.text` plus `tts_unavailable` went down the socket
and no `audio.frame` did. **A missing provider is never reported as `'audio'`.** The unbound-token
state and a provider that throws take the *same* branch — there is deliberately no separate
"no provider configured" path to drift out of sync with the "provider failed" one.

**The interface and its DI token are declared in T2, alongside `AudioTransport`; the ElevenLabs
implementation behind them is entirely T5's.** The token is injected **optionally**, because T4 and T5 are parallel siblings and nothing binds
`TEXT_TO_SPEECH` until T5 lands: a required injection would leave the app unable to boot in the
window between them. Optional injection is not permission to fail silently — §10 requires tests
proving the unbound state boots, falls back visibly, and is never mistaken for success.

They are split because the STT confidence gate (§3)
has to speak a re-prompt, and T4 depends only on T2 — without the interface at the seam, T4 would
have to depend on T5 and two deliberately parallel tasks would serialise. T4 consumes the interface
through a fake and never touches a provider. Declaring a seam is not implementing what sits behind
it: no synthesis, no chunking, no provider call and no `cancel()` behaviour moves out of T5.

**`cancel()` is implemented and used in Phase 1** — for teardown only. It is called on clean
disconnect, on a dropped connection, on connection-duration cap, and on session expiry, to stop
in-flight synthesis and avoid orphaned provider streams (§2.4, §6). It is **not** wired to barge-in
detection: nothing in Phase 1 listens for caller speech during playback. Barge-in is Phase 2 (§5),
and it reuses this contract without changing it.

T5 pins teardown cancellation with tests: disconnect mid-synthesis calls `cancel()` exactly once and
emits no further audio frames.

**The system prompt already forbids markdown, lists and symbols** and instructs speech-shaped
output — written in Phase 0 for exactly this moment (`system-prompt.ts:19`).

---

## 5. Barge-in — specified, deferred to Phase 2

Detection and wiring are **not built in Phase 1**. Specified so Phase 2 does not re-derive it:

- Detect caller speech while TTS is playing (Deepgram continues receiving throughout).
- Call `TextToSpeech.cancel()` — the contract already exists from Phase 1 (§4) — stop forwarding
  frames, and instruct the client to flush its buffer.
- Abort the in-flight Claude stream; **retain partial assistant text in history** so the next turn
  reflects what the caller actually heard.
- Resume listening.

The only Phase 1 obligation is that `cancel()` exists and works, which teardown already requires.

---

## 6. WebSocket lifecycle and failure handling

**Connect** → origin check → per-IP connection rate-limit check → resume if the presented
`sessionId` is one the server holds, otherwise mint a fresh anonymous session (§2.4) → reject as
`session_conflict` if that session already has a live socket → `session.ready {sessionId}`.

**Turn** → client streams `audio.chunk` → `stt.partial` events for UI feedback → `speech_final` →
(confidence gate, §3) → `agent.thinking` → TTS frames stream down → `turn.complete`. If privilege
changed during the turn, `session.rotated {sessionId}` precedes `turn.complete` (§2.2).

**Disconnect** (clean or dropped) → close STT, `cancel()` TTS, abort the agent turn, flush audit,
release the connection slot. The session survives its TTL so a reconnect can resume; the socket does
not.

**Failure modes**

| Failure | Behaviour |
|---|---|
| STT unavailable | Spoken apology + handoff; `stt_unavailable` to client |
| Agent/Anthropic error | Existing `FRONT_DESK_FALLBACK_REPLY`, spoken; `agent_unavailable` |
| TTS unavailable — provider threw, **or no provider bound yet** | Both take the same branch: `reply.text` with the reply, then `tts_unavailable`, and no `audio.frame`. The turn is not lost and the caller is not told audio was produced |
| Rate limited | `rate_limited`, connection closed |
| Session expired | `session_expired`; client starts a new session |
| Duplicate socket | `session_conflict`, second connection closed, first untouched |
| Malformed / identity-bearing frame | `bad_frame`, frame not processed, session state unchanged |
| Client vanishes mid-turn | Server-side cancellation of STT/TTS/agent; no orphaned provider streams |

---

## 7. Audio format, buffering and limits

- **Uplink:** PCM `linear16`, 16 kHz, mono, ~20 ms frames. Browser captures via
  `AudioWorklet` (not the deprecated `ScriptProcessorNode`), downsampling from the device rate.
- **Downlink:** whatever ElevenLabs returns (MP3 or PCM), played through a small jitter buffer so
  sentence boundaries do not click.
- **Backpressure:** if the client cannot keep up, drop downlink frames rather than growing an
  unbounded queue; uplink overflow closes the connection (it means the cap is being exceeded).

**The new limits, and what they are not.** Three different things are easy to conflate; they are
distinct and none replaces another:

| Constant | Scope | Purpose |
|---|---|---|
| `MAX_HISTORY_TURNS = 12` (Phase 0, unchanged) | per conversation | How much transcript is **resent to the model**. Not a cap on turns — a caller may exceed it and simply loses the earliest context. |
| `@Throttle({ limit: 10, ttl: 60000 })` (Phase 0, unchanged) | per **IP**, HTTP `POST /voice/text` only | Guards the cost of the text endpoint. Does not and cannot apply to WebSocket frames. |
| `WS_MAX_TURNS_PER_MINUTE` (new) | per **session**, WebSocket only | Rate cap on agent turns over a socket. Independent budget from the HTTP throttle — a socket does not consume it and is not limited by it. |
| `WS_MAX_TURNS_PER_SESSION` (new) | per session, lifetime | Hard ceiling on total turns, so one socket cannot spend unbounded model budget within the 10-min connection cap. |
| `WS_MAX_FRAME_BYTES = 64 * 1024` (new) | per frame | Oversize closes the connection. |
| `WS_MAX_UPLINK_BYTES_PER_TURN` (new) | per turn | Bounds a single turn's audio. |

Every one of these gets a **literal-pinned** test (T3) — the value asserted against a written-out
literal, never against the constant that defines it. Phase 0 shipped a test comparing
`VOICE_CONFIG.maxTokens` to itself, which hid a real bug; that failure mode is not repeated.

---

## 8. Provider failure and retry

- **STT:** one reconnect attempt mid-session; a second failure ends the turn with a handoff.
- **TTS:** retry once per sentence chunk; on repeat failure fall back to text delivery.
- **Agent:** unchanged from Phase 0 — errors are caught inside `callModel` and surface as the
  front-desk fallback.
- **No retry loops without a cap.** Every retry is bounded and logged against `logId`.
- Provider errors are never forwarded verbatim to the client (§2.8).

---

## 9. Audit and observability

Tool-call auditing is unchanged — every call, including blocked ones, already lands in `AuditLog`
via `ToolExecutorService`.

Phase 1 adds **transport-level** observability, all keyed on `logId`, never `sessionId`:
connection open/close with reason, turn count and duration, STT confidence distribution, TTS
latency to first frame, provider error counts, and rotation events. No audio is persisted; no
transcript is written to logs.

---

## 10. Testing strategy

| Layer | Coverage |
|---|---|
| Unit | Sentence chunker, audio framing, endpointing rules, rotation logic, `BoundedTtlMap.delete` |
| Store | `VoiceSessionStore` get/set/delete/rekey; rotation preserves nonce, turnIndex, logId, history |
| Transport | Fake STT/TTS; full turn exercised via `turn.text` without network or microphone |
| Frame validation | Unknown type rejected; unknown field rejected; identity-bearing frame rejected and session unchanged |
| Security | Origin rejection, rate limits, oversize frames, duplicate-session rejection, unknown-session-starts-fresh, old-`sessionId`-after-rotation rejection |
| Rotation across transports | HTTP returns the new authoritative id and refuses the old one; WS emits `session.rotated` |
| Tier isolation | Every `verified` tool returns `verification_required` through the gateway |
| Bypass prevention | Gateway module imports neither the registry nor any tool (static import graph) |
| Idempotency across rotation | A retry spanning a rotation still de-duplicates |
| Confidence gate | Below-threshold final → re-prompt, agent invoked exactly 0 times |
| Teardown | Disconnect mid-synthesis calls `cancel()` once; no further frames |
| TTS absent | Boots with no `TEXT_TO_SPEECH` bound; the same delivery path returns `'text'`, emits `reply.text` + `tts_unavailable`, emits zero audio frames, and is never reported as success; exactly one `tts_unavailable` emission site exists in `src/` |
| Secret hygiene | No `sessionId` or provider key in any log line or client frame |
| Regression | The whole Phase 0 suite continues to pass unchanged |

**Every test must be capable of failing.** Ten tests in Phase 0 shipped asserting a value against
its own source. Every constant introduced here (rate limits, caps, thresholds) gets a **literal**
pin, and each security control gets a mutation check proving the test catches its removal.

---

## 11. Rollout and the single-process constraint

Behind the existing `VOICE_AGENT_ENABLED` flag plus a new `VOICE_BROWSER_ENABLED`, both default
`false`. Enabled first in local dev, then a staging deploy with real provider keys, then the public
site. The text endpoint from Phase 0 remains available throughout as a fallback and a test surface.

**The single-process constraint, made concrete.** Session and idempotency state live in-process
(§2.9), so running more than one API instance with browser voice enabled would route a caller's
second turn to a process that has never heard of their session. A process cannot discover its own
replica count, so the check is driven by an explicit declaration:

- New env var `APP_INSTANCES`, default `1`.
- At startup, if `VOICE_BROWSER_ENABLED === 'true'` and `APP_INSTANCES !== '1'`, log a **warning**
  naming the constraint and the Phase 2 Redis migration. It warns rather than refuses: an operator
  who has read §2.9 and accepts sticky-session routing should not be blocked by a guess.
- README records the constraint alongside the Redis target design.

Tested by asserting the warning fires for `APP_INSTANCES=2` and does not for `1` or unset.

---

## 12. Security boundaries — summary

| Boundary | Enforced by |
|---|---|
| Model cannot reach another patient's data | Tier gate + no identifier in any tool schema (Phase 0) |
| Public tools cannot see patient identity | `needsPatientContext` narrowing (Phase 0) |
| Transport cannot reach tools | No registry import (static test); gateway calls only the agent |
| Browser cannot assert identity | Frame schema rejects identity-bearing fields (§2.7) |
| Stolen `sessionId` cannot join a live call | One socket per session |
| A rotated-away `sessionId` is useless | Deleted on rotation, not expired — both transports |
| Session ids cannot be enumerated | Unknown id starts fresh on both transports (Phase 0 behaviour preserved) |
| Provider credentials never leave the server | Browser talks only to our WebSocket |
| Provider internals never reach the client | Enumerated error codes only |
| Tier 2 cannot be reached | No production caller of `createVerifiedSession` (static test) + gateway tier test |
| Every tool call is attributable | `AuditLog` via the executor (Phase 0) |

---

## 13. Task breakdown

Twelve tasks. Dependencies are strict: a task may not begin until its dependencies are complete and
reviewed.

**T0 — `VoiceSessionStore` extraction** *(new; prerequisite for rotation)*
Deps: none.
Injectable `VoiceSessionStore` wrapping `BoundedTtlMap<Conversation>`, provided **and exported** from
`VoiceModule`; `VoiceController` migrated to it and no longer owning a private map. Add
`BoundedTtlMap.delete(key)` — it currently exposes only `size`/`get`/`set`, so today the old key
cannot be removed at all. Add `VoiceSessionStore.rekey(oldId, newId)` (set new, delete old, one
synchronous operation) and `rotate(oldId)` which mints the id, rekeys, updates `session.sessionId`
and returns it.
Accept: `BoundedTtlMap.delete` test with **literal-pinned** assertions — after deleting one of two
entries, `size === 1` and `get(deleted) === undefined`; deleting an absent key does not throw and
leaves `size === 1`; mutation check — making `delete` a no-op turns the test red. `rekey` preserves
`idempotencyNonce`, `turnIndex`, `logId`, `patientId` and history, verified field by field. The
**entire Phase 0 suite stays green** with no test edited.

**T1a — transport-agnostic session rotation** *(blocker for browser work)*
Deps: T0.
Rotate on `patientId` binding, detected by before/after comparison around `agent.respond` — no
change to the agent, executor, registry, tools or `IdempotencyService`. Applies to the **existing
HTTP endpoint** immediately, since it stays live all phase.
Accept: HTTP turn that runs intake returns a **different** `sessionId` than it was given; the old id
no longer resumes and instead silently starts a fresh conversation (anti-enumeration preserved); a
retry spanning the rotation still de-duplicates; rotation recorded against `logId` and never logging
either id; literal pins on any new constant.

**T2 — `AudioTransport`, gateway skeleton, and the frame protocol**
Deps: T1a.
`@nestjs/websockets` + `@nestjs/platform-ws` over the `ws` library, wired with a custom adapter in
`main.ts`. **Pin the Nest packages to `^10`** (latest is `11.x`, whose peer range demands
`@nestjs/common ^11`; this repo is on Nest `10.3`, so `11.x` would break peer resolution). Add
`ws` and `@types/ws`. **Chosen because `ws` exposes the HTTP upgrade** — a `verifyClient` hook (or an explicit
`server.on('upgrade')` handler) lets origin and per-IP checks reject the handshake *before the
upgrade completes*, which §2.4 requires and which Socket.IO's higher-level handshake does not give as
directly. Raw `ws` also keeps binary PCM framing simple and needs **no client library in the browser
bundle** — the native `WebSocket` API is enough.
Includes the frame schemas of §2.7, per-frame validation, and the `turn.text` control frame that
drives a complete agent turn with no speech provider involved.
Also declares the **`TextToSpeech` interface and its `TEXT_TO_SPEECH` DI token** next to
`AudioTransport` — **the interface only**. No synthesis, no sentence chunking, no provider client and
no `cancel()` implementation: all of that stays in T5. The seam sits here so T4's confidence gate can
speak through a fake without depending on T5 (§4).
Accept: static import-graph test — gateway imports neither `ToolRegistryService` nor any `*.tool.ts`
— **with a mutation check**; unknown frame type rejected; unknown field rejected; a frame carrying
`patientId`/`userId`/`identityVerified` rejected **and session state provably unchanged**; a full
turn driven end-to-end through `turn.text` against a stubbed agent; Phase 3 seam documented.
Also: the module **boots with no `TEXT_TO_SPEECH` bound**; in that state `deliverReply` returns
`'text'`, emits `reply.text` then `tts_unavailable`, emits **zero** audio frames, and never reports
`'audio'`; a source scan proves exactly **one** `tts_unavailable` emission site, so no second
fallback mechanism can be added without the test failing.

**T1b — `session.rotated` control frame**
Deps: T1a, T2. *(Split out of T1: the frame needs a transport to travel on, which did not exist at
T1's original "Deps: none".)*
Emit `session.rotated {sessionId}` when T1a's rotation fires on a socket, before `turn.complete`.
Accept: a `turn.text` turn that triggers intake emits exactly one `session.rotated`; the old id is
rejected on a subsequent frame; the new id resumes; no id appears in any log line.

**T3 — WebSocket security controls**
Deps: T2.
Origin allowlist via the shared `allowedOrigins()` helper (§2.10) — `main.ts` CORS refactored to the
same helper so there is one source of truth — plus connection and message rate limits, frame-size
cap, connection and session duration caps, one-socket-per-session, unknown-session-starts-fresh,
clean teardown.
Accept: a test per control, each with a **literal pin** and a mutation check. Specifically: unknown
`sessionId` silently yields a new session and never reveals existence; a duplicate connection is
rejected with `session_conflict` **and the first socket keeps working**; the new constants of §7 are
pinned to literals and are demonstrably distinct from `MAX_HISTORY_TURNS` and the HTTP throttle.

**T4 — STT integration behind `SpeechToText`**
Deps: T2. *(Unchanged. The confidence gate speaks its re-prompt through the `TextToSpeech`
interface declared in T2, driven by a fake in tests — T4 never reaches a real provider and never
depends on T5.)*
Deepgram streaming, `linear16`/16 kHz, interim results, `speech_final` dispatch, confidence gate.
Accept: full turn driven by a fake STT with no network; **below-threshold final produces the fixed
transport-level re-prompt with `agent.respond` invoked exactly 0 times**, and `ClaudeAgentService`
is byte-for-byte unmodified; no credential in any log.

**T5 — TTS integration behind `TextToSpeech`**
Deps: T2.
ElevenLabs streaming, sentence chunker, `cancel()` implemented for teardown. T5 owns **everything
behind** the interface T2 declared: the provider client, the chunker, retry and text fallback, and
the `cancel()` behaviour. It implements the interface; it does not redefine it.
Accept: first frame emitted before the full reply is generated; chunker unit-tested including
abbreviations and end-flush; text fallback when TTS fails; **teardown tests** — disconnect
mid-synthesis calls `cancel()` exactly once and emits no further audio frames; no barge-in detection
present. Also: once `TEXT_TO_SPEECH` is bound, **the same `deliverReply` path** returns `'audio'`,
uses the bound implementation, and emits no `tts_unavailable` — proving T5 changes which
implementation runs, not which path runs.

**T6 — Public route and browser widget**
Deps: T3, T4, T5, **T7**. *(T7 added so the widget is never exposed before the error surface is
enumerated.)*
`apps/web` currently has **no public surface** — the root page redirects to `/login` and the only
route groups are `(auth)`, `(portal)`, `(staff)`. This task creates one: a new
`apps/web/src/app/(public)/` route group with its own layout, hosting the widget. `AudioWorklet`
capture, jitter-buffered playback, mic permission and error states.
Accept: the route is **reachable without authentication** and does not redirect to login; it exposes
**no staff or portal navigation** and no authenticated data; a visible **"automated assistant"
disclosure** is present; **end-to-end anonymous Tier 1 intake→book by voice** succeeds in local dev;
no provider key and no WebSocket client library in the shipped bundle.

**T7 — Error surface hardening for the WS path**
Deps: T3.
The enumerated codes of §2.8; real errors logged against `logId` only.
Accept: no provider, database or exception text reachable by the client on any failure path; the
global HTTP filter untouched (that is Phase 2).

**T8 — Tier-2 unreachability proof**
Deps: T2. *(Executable at T2 because T2 ships `turn.text`, which drives a real turn through the
gateway without STT/TTS. Previously this depended on a skeleton that could not drive a turn at all.)*
Tests asserting every `verified` tool returns `verification_required` through the gateway, that
nothing can set `identityVerified`, and that no file under `apps/api/src/` imports
`createVerifiedSession`. **No identity verification is activated or written.**
Accept: mutation — forcing `identityVerified = true` turns the suite red.

**T9 — Transport observability**
Deps: T3, T4, T5.
Connection, turn, latency, rotation and provider-error metrics keyed on `logId`.
Accept: no `sessionId`, transcript or audio in any emitted line; rotation events present.

**T10 — Docs, flags and the single-process constraint**
Deps: all.
`VOICE_BROWSER_ENABLED`; `.env.example` gains `DEEPGRAM_API_KEY` / `ELEVENLABS_API_KEY` placeholders,
`VOICE_BROWSER_ENABLED`, `APP_INSTANCES`, and the currently-missing `FRONTEND_URL`; README section
covering the voice agent (Phase 0 shipped it undocumented) and the single-process constraint;
startup warning per §11; Redis target design recorded as Phase 2 design-only.
Accept: warning fires for `APP_INSTANCES=2` and not for `1` or unset; constraint documented; no
provider values committed.

### Dependency graph

```
T0 ── T1a ── T2 ─┬─ T1b
                 ├─ T3 ── T7 ─┐
                 ├─ T4 ───────┼─ T6
                 ├─ T5 ───────┘
                 └─ T8
       T3+T4+T5 ── T9
             all ── T10
```

### Blockers and prerequisites

- **T0 and T1a block everything.** The store must be shared before a second transport exists, and
  session fixation must be fixed before a browser client exists.
- **Provider accounts** needed before T4/T5 can be verified against real services; both are built
  behind interfaces so development proceeds with fakes.
- **Not blockers, deferred by decision:** Redis, barge-in detection, identity verification, Tier 2,
  telephony, the global HTTP exception filter.

---

## 14. Change log — 2026-08-20 revision

Folded in from the pre-implementation review against the merged Phase 0 codebase.

| # | Change | Sections |
|---|---|---|
| 1 | T1 split into T1a (transport-agnostic rotation) and T1b (`session.rotated` frame, depends on T2) | §13 |
| 2 | New T0: `VoiceSessionStore` extraction, `BoundedTtlMap.delete()`, `rekey()` | §1, §2.9, §13 |
| 3 | `BoundedTtlMap.delete()` literal-pinned test with mutation check | §13 T0 |
| 4 | Rotation applies to the HTTP endpoint, which returns the new authoritative id | §2.2, §13 T1a |
| 5 | Public route `(public)` added explicitly to T6 with four acceptance criteria | §13 T6 |
| 6 | Frame schemas declared; unknown fields and identity-bearing fields rejected | §2.7, §6, §10 |
| 7 | Unknown WS `sessionId` starts fresh; duplicate connection rejected; both tested | §2.4, §6, §13 T3 |
| 8 | `cancel()` implemented in Phase 1 for teardown; barge-in detection stays Phase 2 | §4, §5, §13 T5 |
| 9 | T8 executable at T2 via the `turn.text` control frame | §2.3, §2.7, §13 T8 |
| 10 | Confidence gate is transport-level; zero-agent-invocation test | §3, §13 T4 |
| 11 | WS library fixed: `@nestjs/platform-ws` + `ws`, chosen for pre-upgrade origin checking | §13 T2 |
| 12 | One shared `allowedOrigins()` helper for CORS and WS; `FRONTEND_URL` added to `.env.example` | §2.10, §13 T3, T10 |
| 13 | Redis rotation corrected to `RENAME` alone; section marked Phase 2 design-only | §2.9 |
| 14 | `createVerifiedSession` stays test-only, enforced by a static import test | §2.3, §12, §13 T8 |
| 15 | Single-process constraint made concrete via `APP_INSTANCES` | §11, §13 T10 |
| 16 | WS turn limits given their own named constants, distinguished from `MAX_HISTORY_TURNS` and the HTTP throttle | §7, §13 T3 |
| 17 | T6 now depends on T7 | §13 |

**Amendment, 2026-08-20 (post-plan review).** Writing the implementation plan surfaced a
contradiction: T4's confidence gate must speak a re-prompt, but `TextToSpeech` sat in T5 while T4
depends only on T2. Resolved by moving the **interface and DI token only** into T2 and leaving the
ElevenLabs implementation wholly in T5. The dependency graph is unchanged — T4 still depends on T2
alone, and T4/T5 remain parallel siblings. No task was added, removed, merged, split or reordered.

**Amendment, 2026-08-24 (T6 pre-flight — dependency/scope correction).** Two prerequisites
for T6 turned out to belong to no completed task. Recorded here as a correction found during
review, not rewritten into earlier history.

*The production `BrowserWebSocketTransport` was missing.* §2.7 assigns it to Phase 1 and the plan's
file table maps it onto `voice.gateway.ts`, but T2's acceptance criteria covered the frame schemas,
the validation rules, the `turn.text` control frame and the import-graph test — **none of which
require a bound socket**. `VoiceGateway` was therefore built as a plain `@Injectable` whose
`handleFrame`/`handleAudio` are called only by tests, no class implements `AudioTransport`, and no
`@WebSocketGateway` exists anywhere. Every T2–T9 guarantee is real but has only ever been exercised
through test doubles: real message framing, real close→teardown, and `verifyClient` have never run.
T2's acceptance was satisfiable without the class, so nothing caught its absence.

*It is completed in T6* because T6 is where it is first needed — T6's acceptance is an end-to-end
anonymous intake→book by voice, which is unreachable without it — and because folding it in keeps
the approved dependency graph and task count unchanged. It is a **thin adapter only**: text message
to the existing `handleFrame`, binary to the existing `handleAudio`, close to the existing teardown.
No second turn runner, dispatch path, session store or security path; no T3/T4/T5/T7 logic moves
into it.

*`VOICE_BROWSER_ENABLED` runtime enforcement moves to T6* because T6 mounts the first public,
unauthenticated surface and T6 does not depend on T10 — implementing T6 as originally written would
expose that surface with no flag gating it at all, the opposite of default-deny. Only the
configuration definition, the default-deny behaviour and the exposure gating move. **T10 keeps all
documentation scope**: `.env.example`, the README section, the `APP_INSTANCES` single-process
warning, and the final flags audit. This mirrors the earlier `TextToSpeech` correction, where the
declaration moved and the implementation stayed put.

**Amendment, 2026-08-20 (optional-injection review).** Optional injection of `TEXT_TO_SPEECH` is
kept — it is what lets T2 and T5 land independently — but it is no longer allowed to be a silent
production failure path. §4 now defines a single `deliverReply` returning `'audio' | 'text'`, §6's
failure row covers "no provider bound" and "provider threw" as one branch, §2.7 gains the
`reply.text` frame the fallback always needed, and §10 requires tests that the unbound state boots,
falls back visibly, and is never counted as success. No architecture, task or dependency changed.

Also corrected: §2.6 previously claimed to mirror "the Phase 0 test that pins `ToolExecutorService`
as the only dispatch site". **No such test exists** — Phase 0 pins the executor's behaviour, not the
import graph. The section now states that this is a new test technique and requires T2 to choose the
mechanism and prove it with a mutation check.
