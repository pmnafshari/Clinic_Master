# Voice Agent Phase 1 — Browser Voice (Tier 1) — Design

**Date:** 2026-08-19
**Status:** Design for review. No code written.
**Builds on:** Phase 0 (`feat/voice-agent-phase-0`, PR #1) — text-only foundation, complete.

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

Twilio or any telephony. Barge-in. Redis. Identity verification. Tier 2 tools. Payment tools.

### The load-bearing property

`ClaudeAgentService`, `ToolExecutorService`, the tool registry, and `IdempotencyService` are
**unchanged**. Every property proven in Phase 0 — the tier gate, `needsPatientContext`, the
idempotency guarantees, the audit trail — continues to hold because the audio layer sits entirely
above them and reaches the agent through the same entry point the text endpoint uses.

---

## 2. Session and security

### 2.1 The WebSocket is anonymous, and carries no identity

A WebSocket connection is **not** an identity claim. Connecting proves nothing about who is
speaking. `sessionId` remains a server-issued 256-bit bearer credential and is **never** written to
logs, metrics, traces, or error messages — `logId` is the only session identifier that appears in
observability output, exactly as in Phase 0.

Phase 1 does not set `identityVerified`. It stays `false` for the life of every session.

### 2.2 Session fixation — rotation on privilege change

Phase 0 recorded session fixation as a hard prerequisite for browser voice. It is fixed here.

**When rotation happens.** Whenever the session's privilege changes:

- `start_patient_intake` binds a `patientId` to a previously unbound session — a privilege change,
  because the session can now act for a specific patient;
- `identityVerified` transitions to `true` (cannot occur in Phase 1; the hook exists so Phase 2
  inherits it rather than re-deriving it).

**How rotation works.**

1. The tool completes and the session's privilege has changed.
2. The server mints a fresh 256-bit `sessionId`.
3. The session record is re-keyed in the store under the new id, and **the old key is deleted in the
   same operation**. The old credential is invalid immediately — not on expiry.
4. The server pushes a `session.rotated` control frame carrying the new `sessionId`.
5. The client replaces its stored value. Any later frame presenting the old id is rejected.

**Why the client can learn it safely.** The new id travels down the already-established, already-
authenticated socket the caller is holding — the same channel that carried the original id. No new
exposure surface is created.

**Idempotency survives rotation, by construction.** Phase 0 separated `sessionId` (the bearer
credential) from `idempotencyNonce` (the replay namespace). Rotation replaces the credential and
**carries the nonce and `turnIndex` across unchanged**, so keys computed before and after rotation
still collide for the same operation. A retry that spans a rotation still de-duplicates. Had the key
been derived from `sessionId`, rotation would silently create a fresh namespace and re-execute
writes — which is precisely the Critical found and fixed in Phase 0.

`logId` also carries across, so the audit trail for one conversation stays correlatable.

### 2.3 Tier 2 remains unreachable — and it is tested

Phase 1 does not simply decline to verify; it proves Tier 2 cannot be reached:

- No code path constructs a verified session. `createVerifiedSession` stays test-only.
- A test boots the real `VoiceModule`, opens a voice session through the gateway, and asserts every
  `verified`-tier tool returns `verification_required`.
- A test asserts no gateway path can set `identityVerified`.

**Phase 2 owns the verification flow** (patient logs in, the voice session is bound to that
authenticated user, tier tests re-run against a genuinely verified session). Designing it here would
re-merge the phase split.

### 2.4 WebSocket security controls

| Control | Rule |
|---|---|
| Origin validation | `Origin` checked against an allowlist; mismatch closes before upgrade |
| Connection rate limit | Per-IP cap on new connections per minute |
| Message rate limit | Per-session cap on frames/sec and on agent turns/min |
| Max frame size | Audio chunks capped (64 KB); oversize closes the connection |
| Max connection duration | Hard cap (10 min), independent of session TTL |
| Max session duration | Existing 30-min TTL, unchanged |
| Concurrent connections | **One live socket per session.** A second connection presenting the same `sessionId` is rejected, not silently joined — joining would let a stolen id eavesdrop on a live conversation |
| Clean disconnect | Close the STT stream, cancel in-flight TTS, abort the agent turn, flush audit, release the session slot |

### 2.5 Provider credentials

Deepgram and ElevenLabs keys live **only** in server environment variables. They are never sent to
the browser, never embedded in a page, and never minted into short-lived client tokens. The browser
speaks to our WebSocket and nothing else. `.env.example` gains placeholder names only.

### 2.6 The audio path cannot bypass Phase 0

```
browser audio → STT → ClaudeAgentService → ToolExecutorService → tool → audit
```

The transport layer **must not call tools directly**. It has no reference to `ToolRegistryService`
or any tool. Enforced by a test asserting the gateway module does not import them, mirroring the
Phase 0 test that pins `ToolExecutorService` as the only dispatch site.

### 2.7 Transport abstraction

`AudioTransport` is the seam. `BrowserWebSocketTransport` implements it in Phase 1;
`TwilioMediaStreamTransport` implements it in Phase 3 without touching the agent, tools, or
security layers. The interface carries audio frames and control events only — never identity.

### 2.8 Error surface

Raw `Error.message` must never reach the client. The Phase 0 finding stands: the global exception
filter returns `exception.message` verbatim, and an Anthropic/Deepgram/ElevenLabs SDK error carries
provider identity and internal state.

Phase 1 fixes this **for the WebSocket path**: every error sent to the browser is a fixed,
enumerated code (`stt_unavailable`, `agent_unavailable`, `tts_unavailable`, `rate_limited`,
`session_expired`, `internal`) with no provider text. The real error is logged server-side against
`logId`.

The global HTTP filter is **not** changed here — that remains a Phase 2 item, before any
authenticated surface exists.

### 2.9 Redis — target design, not built in Phase 1

Phase 1 ships single-process. The constraint is documented in the README and enforced by a startup
warning if more than one instance is configured.

When it moves (Phase 2 or first horizontal scale), the cut-over is:

| State | Today | Target | Semantics |
|---|---|---|---|
| Session store | `BoundedTtlMap` in `voice.controller.ts` | Redis hash, TTL 30 min | `SET` with `EX`; rotation is `RENAME` + `DEL` in a `MULTI` |
| Idempotency `completed` | `BoundedTtlMap` | Redis, TTL 15 min | `SET NX EX` — the winner executes |
| Idempotency `inFlight` | in-process promise map | Redis lock | `SET NX EX` with a short lease; losers poll for the result |

**The `IdempotencyService` interface does not change** — `keyFor` and `runOnce` keep their
signatures; only the backing store swaps. No second state mechanism is introduced.

---

## 3. STT — streaming and endpointing

Deepgram streaming, `linear16`, 16 kHz mono. Interim results enabled for responsiveness; the final
transcript drives the turn.

**Endpointing** is Deepgram's, with an explicit silence threshold (start ~800 ms) rather than
client-side VAD. A turn is dispatched to the agent on `speech_final`, not on the first `is_final`.

**Confidence gate.** Per the approved design's error handling: below a configured confidence
threshold, the agent asks the caller to repeat rather than guessing. This matters most for names,
dates of birth and phone numbers, which intake collects.

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
`synthesise(text) → AsyncIterable<AudioFrame>`, plus `cancel()` (unused in Phase 1; required by
barge-in later).

**The system prompt already forbids markdown, lists and symbols** and instructs speech-shaped
output — written in Phase 0 for exactly this moment.

---

## 5. Barge-in — specified, deferred

Not built in Phase 1. Specified so Phase 2 does not re-derive it:

- Detect caller speech while TTS is playing (Deepgram continues receiving throughout).
- Call `TextToSpeech.cancel()`, stop forwarding frames, and instruct the client to flush its buffer.
- Abort the in-flight Claude stream; **retain partial assistant text in history** so the next turn
  reflects what the caller actually heard.
- Resume listening.

The `cancel()` hook exists in the Phase 1 interface so adding barge-in does not change the contract.

---

## 6. WebSocket lifecycle and failure handling

**Connect** → origin check → rate-limit check → mint session (or resume with a valid `sessionId`)
→ `session.ready {sessionId}`.

**Turn** → client streams audio → `stt.partial` events for UI feedback → `speech_final` →
`agent.thinking` → TTS frames stream down → `turn.complete`.

**Disconnect** (clean or dropped) → close STT, cancel TTS, abort the agent turn, flush audit,
release the connection slot. The session survives its TTL so a reconnect can resume; the socket does
not.

**Failure modes**

| Failure | Behaviour |
|---|---|
| STT unavailable | Spoken apology + handoff; `stt_unavailable` to client |
| Agent/Anthropic error | Existing `FRONT_DESK_FALLBACK_REPLY`, spoken; `agent_unavailable` |
| TTS unavailable | Deliver the reply as text on the socket so the turn is not lost; `tts_unavailable` |
| Rate limited | `rate_limited`, connection closed |
| Session expired | `session_expired`; client starts a new session |
| Client vanishes mid-turn | Server-side cancellation of STT/TTS/agent; no orphaned provider streams |

---

## 7. Audio format and buffering

- **Uplink:** PCM `linear16`, 16 kHz, mono, ~20 ms frames. Browser captures via
  `AudioWorklet` (not the deprecated `ScriptProcessorNode`), downsampling from the device rate.
- **Downlink:** whatever ElevenLabs returns (MP3 or PCM), played through a small jitter buffer so
  sentence boundaries do not click.
- **Backpressure:** if the client cannot keep up, drop downlink frames rather than growing an
  unbounded queue; uplink overflow closes the connection (it means the cap is being exceeded).
- Caps: max frame 64 KB, max uplink bytes per turn, max turns per session.

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
| Unit | Sentence chunker, audio framing, endpointing rules, rotation logic |
| Transport | Fake STT/TTS; full turn exercised without network or microphone |
| Security | Origin rejection, rate limits, oversize frames, duplicate-session rejection, old-`sessionId`-after-rotation rejection |
| Tier isolation | Every `verified` tool returns `verification_required` through the gateway |
| Bypass prevention | Gateway module does not import the registry or any tool |
| Idempotency across rotation | A retry spanning a rotation still de-duplicates |
| Secret hygiene | No `sessionId` or provider key in any log line or client frame |
| Regression | The whole Phase 0 suite continues to pass unchanged |

**Every test must be capable of failing.** Ten tests in Phase 0 shipped asserting a value against
its own source. Every constant introduced here (rate limits, caps, thresholds) gets a **literal**
pin, and each security control gets a mutation check proving the test catches its removal.

---

## 11. Rollout

Behind the existing `VOICE_AGENT_ENABLED` flag plus a new `VOICE_BROWSER_ENABLED`, both default
`false`. Enabled first in local dev, then a staging deploy with real provider keys, then the public
site. The text endpoint from Phase 0 remains available throughout as a fallback and a test surface.

---

## 12. Security boundaries — summary

| Boundary | Enforced by |
|---|---|
| Model cannot reach another patient's data | Tier gate + no identifier in any tool schema (Phase 0) |
| Public tools cannot see patient identity | `needsPatientContext` narrowing (Phase 0) |
| Transport cannot reach tools | No registry import; gateway calls only the agent |
| Stolen `sessionId` cannot join a live call | One socket per session |
| A rotated-away `sessionId` is useless | Deleted on rotation, not expired |
| Provider credentials never leave the server | Browser talks only to our WebSocket |
| Provider internals never reach the client | Enumerated error codes only |
| Every tool call is attributable | `AuditLog` via the executor (Phase 0) |

---

## 13. Task breakdown

Dependencies are strict: a task may not begin until its dependencies are complete and reviewed.

**T1 — `sessionId` rotation on privilege change** *(blocker for everything else)*
Deps: none. Rotate on `patientId` binding; re-key and delete the old entry atomically; carry
`idempotencyNonce`, `turnIndex` and `logId` across; `session.rotated` control event.
Accept: old id rejected immediately; a retry spanning rotation still de-duplicates; rotation
recorded against `logId`; literal pins on any new constant.

**T2 — `AudioTransport` interface + `BrowserWebSocketTransport` skeleton**
Deps: T1. Interface carries audio and control events only, never identity. No provider calls yet.
Accept: gateway imports neither the registry nor any tool (tested); Phase 3 seam documented.

**T3 — WebSocket security controls**
Deps: T2. Origin allowlist, connection and message rate limits, frame-size cap, connection and
session duration caps, one-socket-per-session, clean teardown.
Accept: a test per control, each with a literal pin and a mutation check.

**T4 — STT integration behind `SpeechToText`**
Deps: T2. Deepgram streaming, `linear16`/16 kHz, interim results, `speech_final` dispatch,
confidence gate.
Accept: full turn driven by a fake STT with no network; confidence-below-threshold asks the caller
to repeat; no credential in any log.

**T5 — TTS integration behind `TextToSpeech`**
Deps: T2. ElevenLabs streaming, sentence chunker, `cancel()` present but unused.
Accept: first frame emitted before the full reply is generated; chunker unit-tested including
abbreviations and end-flush; text fallback when TTS fails.

**T6 — Browser widget**
Deps: T3, T4, T5. Public-site component, `AudioWorklet` capture, jitter-buffered playback, mic
permission and error states, visible "automated assistant" disclosure.
Accept: end-to-end anonymous intake→book by voice in local dev; no provider key in the bundle.

**T7 — Error surface hardening for the WS path**
Deps: T3. Enumerated client-facing error codes; real errors logged against `logId` only.
Accept: no provider or database text reachable by the client; the global HTTP filter untouched.

**T8 — Tier-2 unreachability proof**
Deps: T2. Tests asserting every `verified` tool returns `verification_required` through the gateway
and that nothing can set `identityVerified`.
Accept: mutation — forcing `identityVerified = true` turns the suite red.

**T9 — Transport observability**
Deps: T3–T5. Connection, turn, latency and provider-error metrics keyed on `logId`.
Accept: no `sessionId`, transcript or audio in any emitted line.

**T10 — Docs, flags and the single-process constraint**
Deps: all. `VOICE_BROWSER_ENABLED`, `.env.example` placeholders, README section, startup warning if
more than one instance is configured, Redis target design recorded.
Accept: constraint documented and warned about; no provider values committed.

### Blockers and prerequisites

- **T1 blocks everything.** Session fixation must be fixed before a browser client exists.
- **Provider accounts** needed before T4/T5 can be verified against real services; both are built
  behind interfaces so development proceeds with fakes.
- **PR #1 should merge first** so Phase 1 branches from a clean `main`.
- **Not blockers, deferred by decision:** Redis, barge-in, identity verification, Tier 2, telephony,
  the global HTTP exception filter.
