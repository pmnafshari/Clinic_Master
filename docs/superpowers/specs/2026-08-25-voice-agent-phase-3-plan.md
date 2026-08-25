# Voice Agent — Phase 3 Implementation Plan

**Status:** plan only. Nothing is implemented. No branch, no dependencies.
**Design:** `2026-08-25-voice-agent-phase-3-design.md`
**Baseline:** `main` @ `b7b724a`

---

## 1. Two tracks

The work splits along a line worth keeping visible in the commit history,
because the two halves have different risk profiles, different review bars, and
different answers to "what breaks if we ship nothing else".

### Track A — Pre-existing defect fixes required for Phase 3 correctness

Bugs in **shipped** code, reachable in production today, independent of
telephony. They would be worth fixing if Phase 3 were cancelled.

| Task | Defect | Reachable today? |
|---|---|---|
| **D-1** | `VoiceTicketService` holds tickets in an in-process map | **Yes** — browser voice verification fails intermittently behind >1 instance |

**The defect track has exactly one task.** That is the honest count. Two other
pre-existing weaknesses were found and are *deliberately* not in it:
`WsOriginAdapter.recentByIp` being per-instance (documented, out of scope,
irrelevant on the phone path) and the ElevenLabs free-tier default voice id
(frozen by prior ruling). Neither is required for Phase 3 correctness, and
neither is smuggled in.

### Track B — Net-new Phase 3 features

| Task | Scope |
|---|---|
| **F-1** | Session contract + authorization semantics |
| **F-2** | OTP service: Redis state machine, Lua, rate limiting |
| **F-3** | Twilio SMS sender |
| **F-4** | Phone lookup + the two OTP tools |
| **F-5** | Audio format capability |
| **F-6** | Twilio webhook, signature validation, TwiML |
| **F-7** | Media stream transport + phone socket admission |
| **F-8** | Configuration, docs, CI, runbook |
| **F-9** | Live provider verification |

---

## 2. Dependency graph

```
D-1 ──┬──▶ F-6 ──┐
      │          ├──▶ F-7 ──┐
F-5 ──┼──────────┘          │
      └─────────────────────┤
                            ├──▶ F-8 ──▶ F-9
F-1 ──┬──▶ F-4 ─────────────┘
      │    ▲
F-2 ──┴────┴──▶ F-3 ────────┘
```

Acyclic. Independent roots: **D-1, F-1, F-2, F-5**.

Explicit edges:

| Task | Depends on | Why |
|---|---|---|
| D-1 | — | independent; ships alone if Phase 3 stops |
| F-1 | — | pure session/authorization change |
| F-2 | — | **independent.** `VOICE_REDIS` already exists from PR #5; the earlier claim that F-2 needed D-1 was a pattern-reuse preference, not a build dependency, and it serialized work for no reason |
| F-3 | F-2 | implements the `SmsSender` interface F-2 defines |
| F-4 | F-1, F-2 | needs `promoteToPhoneVerified` and the OTP state machine |
| F-5 | — | independent codec seam change |
| F-6 | D-1 | webhook mints a Redis-backed ticket |
| F-7 | D-1, F-5, F-6 | needs ticket admission, μ-law codecs, and a minted ticket |
| F-8 | F-3, F-4, F-7 | documents what exists |
| F-9 | F-8 | live verification against a configured deployment |

D-1, F-1, F-2 and F-5 are independent and may run in parallel.

---

# Track A — Pre-existing defect fixes

## D-1 · Redis-backed `VoiceTicketService`

**Classification:** pre-existing Phase 2 multi-instance defect fix.
**Not** a phone feature. The phone channel *consumes* this fix; it did not
cause it.

### The defect

`session/voice-ticket.service.ts` stores tickets in a `BoundedTtlMap` and
`consume()` is synchronous. Two distinct failures follow, both live today:

1. **Cross-instance.** A ticket issued by instance A is invisible to instance
   B. With `APP_INSTANCES > 1` behind a load balancer, the
   `GET /voice/ticket` and the `WS /voice` upgrade are separate connections
   that routinely land on different instances, so browser voice verification
   fails intermittently and silently — the socket simply stays anonymous and
   Tier-2 tools are refused.
2. **Eviction.** `MAX_PENDING_TICKETS = 1000` evicts the oldest entry when
   full, so under load a legitimate, unexpired ticket can be discarded before
   redemption. A count cap is the wrong bound for a TTL-scoped credential;
   Redis expiry is the right one.

### Scope

Move the backing store to Redis. Nothing else changes.

Security properties preserved **verbatim**, each pinned by a test that already
exists or is added here:

| Property | How it is preserved |
|---|---|
| CSPRNG opaque ticket | `newOpaqueId()` unchanged — 256 bits, base64url |
| Single use | `GETDEL` — atomic read-and-delete in one Redis command |
| Short TTL | `TICKET_TTL_MS = 60_000` unchanged, as `SET … PX 60000 NX` |
| Server-side identity binding | userId remains the *value*; the ticket is only a key |
| Atomic consume | `GETDEL` replaces get-then-delete; no interleaving window |
| No PII in the ticket | ticket is random bytes; nothing is encoded in it |
| Never logged | ticket added to the log-hygiene assertion set |
| Fail closed | expiry, reuse, unknown ticket, **and Redis failure** all return `undefined` |

**Eviction is reduced, not eliminated — and the plan must not claim otherwise.**
Redis runs `--maxmemory 256mb --maxmemory-policy volatile-lru`, and every voice
key carries a TTL, so every key stays an eviction candidate under memory
pressure. This task replaces a *count* bound with a *memory* bound. It is
accepted because the margin is large (a ticket is ~100 bytes against a budget
dominated by multi-KB session records), because eviction fails closed, and
because it becomes observable — F-8 adds `used_memory` and `evicted_keys` as
operational metrics with an alert on any non-zero eviction rate. See design §11.

`consume()` becomes `async`. `issue()` becomes `async`.

**No in-process cache is reintroduced in any form**, including as a
read-through or negative cache. A cache would restore exactly the bug being
fixed.

### Files

| File | Change |
|---|---|
| `session/voice-ticket.service.ts` | Redis-backed; `issue`/`consume` async; `pending` becomes an async count or is dropped |
| `session/verified-identity.service.ts` | `await this.tickets.consume(ticket)` |
| `transport/voice-socket.gateway.ts` | already async at the call site; verify no sync assumption remains |
| `voice.controller.ts` | `ticket()` at line 122 is **synchronous** today (`: { ticket: string }`); becomes `async` returning `Promise<{ ticket: string }>` |
| `util/bounded-ttl-map.ts` | **deleted** — see below |
| `tests/voice/voice-ticket.spec.ts` | rewritten; drops the `VOICE_CLOCK` provider |
| `voice.controller.ts:36` | stale comment naming `BoundedTtlMap` corrected |

**`BoundedTtlMap` becomes orphaned.** Verified against the repository: its only
production consumer is `voice-ticket.service.ts`. The apparent second reference
at `voice.controller.ts:36` is a comment, not a usage. Once tickets move to
Redis, both `BoundedTtlMap` and the `VOICE_CLOCK` token it exports have zero
production call sites, and `tests/voice/voice-ticket.spec.ts` — which imports
`VOICE_CLOCK` — is rewritten by this task anyway.

Delete the file, its spec, and the `VOICE_CLOCK` token. Retaining a DI token
and a bounded cache implementation with no consumer is an invitation to
reintroduce exactly the defect this task removes.

`pending` is **dropped**, not reimplemented. A Redis equivalent would need
`KEYS voice:ticket:*`, which is O(N) and blocking, and the value was
diagnostics-only.

### Redis key

| Key | Value | TTL |
|---|---|---|
| `voice:ticket:<ticket>` | userId | 60s |

### Tests (written first)

1. A ticket issued against one Redis client is redeemable by a **second
   service instance** sharing that Redis — the direct cross-instance proof.
2. Redeeming twice: the second returns `undefined`.
3. Two concurrent `consume()` calls on one ticket: exactly one wins.
4. An expired ticket returns `undefined` (TTL driven, not clock-mocked —
   assert via a short override or `PTTL`).
5. An unknown ticket returns `undefined` and does not throw.
6. Redis unavailable → `undefined`, never a throw, never a grant.
7. Issuing 2000 tickets: **all** remain redeemable (the eviction defect).
8. The ticket value never appears in any captured log line.

### Mandatory mutations

| Mutation | Must break |
|---|---|
| `GETDEL` → `GET` | test 2 and test 3 |
| TTL argument dropped from `SET` | test 4 |
| Redis error swallowed and `issue()`'s userId returned | test 6 |
| An in-process `Map` added in front of Redis | test 1 |

### Exit criteria

Full suite green; browser voice verification works across two API instances
against one Redis; no `BoundedTtlMap` usage remains in the ticket path.

---

# Track B — Net-new Phase 3 features

## F-1 · Session contract and authorization semantics

**Implements design §1, §2, §3 and finding F-I.** No phone code.

### Scope

1. `verifiedUntil: number | null` added to `VoiceSession`.
2. `createAnonymousSession` → `null`; `createVerifiedSession` → `null`
   (browser behaviour byte-identical).
3. `promoteToPhoneVerified(session, {userId, patientId, now, ttlMs})` mutating
   in place, following the `PatientIntakeTool` precedent.
4. `session/verification.ts` — `isVerificationActive(session, now?)`, the
   **sole** authorization reader.
5. Tier gate at `tool-executor.service.ts:47` calls it. Nothing else about the
   gate moves.
6. **Finding F-I:** `snapshotPrivilege` captures `verificationActive`, not the
   raw boolean.
7. `VoiceSessionStore.get()` normalizes `undefined → null`.
8. `verifiedUntil` / `verified_until` added to `FORBIDDEN_KEYS`.
9. **Audit payload corrected** — `tool-executor.service.ts:120` currently writes
   the raw `identityVerified`, so an expired phone session would be refused by
   the gate and audited as verified. It records `identityVerified` (raw),
   `verificationActive` (effective), and `verifiedUntil`.
10. Structural guard test.

### The structural guard

A test greps `src/` for `.identityVerified` and asserts the call sites are
**exactly** this set:

```
session/voice-session.ts        — interface declaration + 3 constructors
session/verification.ts         — the authorization rule
session/privilege-change.ts     — via isVerificationActive only
transport/frames.ts             — the FORBIDDEN_KEYS string literal
tools/tool-executor.service.ts  — AUDIT PAYLOAD ONLY (line ~120), never the gate
```

The tool-executor entry is the one that needs care: that file also holds the
tier gate, so the guard must distinguish the audit read from an authorization
read. It asserts the file contains exactly one `.identityVerified` occurrence
and that the gate line matches `isVerificationActive(`.

Any new read fails the suite. This is what stops a future task from
reintroducing a raw boolean check somewhere the expiry is not consulted.

### Tests (written first)

States, each asserted against a Tier-2 tool and a Tier-1 tool:

| State | `identityVerified` | `verifiedUntil` | Tier 2 |
|---|---|---|---|
| anonymous | false | null | refused |
| browser verified | true | null | allowed |
| phone verified, live | true | now + 10m | allowed |
| phone verified, expired | true | now − 1s | **refused** |
| phone verified, boundary | true | exactly now | **refused** (`>` not `>=`) |
| expired then re-verified | true | now + 10m | allowed |
| legacy record, key absent | true | *(undefined)* | allowed (normalized to null) |

Rotation matrix (finding F-I):

| Transition | Rotates? |
|---|---|
| anonymous → phone-verified | yes |
| expired → re-verified | **yes** |
| verified → expired | **no** |
| browser, no in-turn transition | no |

Plus: an expired session survives `rotate()` still expired; `verifiedUntil`
round-trips through `JSON` → `RENAME` → rewrite unchanged; a second store
instance on the same Redis reaches the identical decision.

### Mandatory mutations

| Mutation | Must break |
|---|---|
| `verifiedUntil > now` → `>= now` | boundary test |
| `verifiedUntil > now` → `true` | expired test |
| `verifiedUntil === null` → `true` | expired test |
| tier gate reverted to `!session.identityVerified` | expired test |
| `promoteToPhoneVerified` sets `verifiedUntil = null` | expiry test |
| store normalization removed | legacy-record test |
| `rotate()` recomputes `verifiedUntil` from `now` | resurrection test |
| `snapshotPrivilege` reverted to the raw boolean | **re-verification rotation test** |
| audit payload reverted to the raw boolean only | audit-reflects-refusal test |
| `verifiedUntil` removed from `FORBIDDEN_KEYS` | frame-hygiene test |

### Exit criteria

All eight mutations verified red-then-restored with the mutated region printed.
Browser behaviour unchanged. No phone code exists yet.

---

## F-2 · OTP service

**Implements design §4, §5 and §12.** No dependencies.

### Scope

Redis state machine, both Lua scripts, HMAC storage, all four rate limits,
fail-closed behaviour. Defines `SmsSender` and ships the non-production
`LoggingSmsSender`. **No tools, no Twilio, no transport.**

### Redis keys

| Key | Value | TTL |
|---|---|---|
| `voice:otp:caller:<sessionId>` | E.164 phone | 1800s |
| `voice:otp:code:<sessionId>` | JSON `{codeHash, patientId}` | 300s |
| `voice:otp:attempts:<sessionId>` | integer | 300s |
| `voice:otp:lock:<sessionId>` | `1` | 900s |
| `voice:otp:cooldown:<sessionId>` | `1` | 60s |
| `voice:otp:req:<phoneHmac>` | integer | 3600s |

### Hashing

- Code: `HMAC-SHA256(code, OTP_HMAC_SECRET)`. **Never stored or logged in
  plaintext.**
- Phone: HMAC'd in the `voice:otp:req:` **key name** — key space leaks through
  `SCAN`, slowlog and monitoring exporters in a way values do not.
- `OTP_HMAC_SECRET` is required when the phone channel is enabled; the service
  refuses to start without it.

### Atomicity

`otp_request` and `otp_submit` as specified in design §5, both Lua, both one
round trip. Rationale carried into the code comments: a TypeScript
read-compare-delete lets concurrent wrong guesses each read `attempts` before
any writes, beating the cap; and the cooldown is claimed with `SET NX` *before*
the hourly counter increments so a cooled-down caller does not burn budget.

### Tests (written first)

Happy path; wrong code; expired challenge; locked session; single-use
consumption; cooldown; hourly cap; lock expiry returning to `NONE`.

**Concurrency:** `OTP_MAX_ATTEMPTS + 3` simultaneous wrong guesses lock after
exactly `OTP_MAX_ATTEMPTS`. Two simultaneous correct submissions consume once.
Two simultaneous requests: one proceeds, one is cooled down.

**Cross-instance:** request on service instance A, submit on instance B against
one Redis — succeeds. Attempt counting and the lock hold when guesses alternate
between instances.

**Fail-closed:** Redis unreachable, Lua error, and malformed record each yield
`verification_unavailable` and leave the session unverified.

**Log hygiene:** across a full request→submit cycle, no captured log line
contains the code, the phone number, or either HMAC.

### Mandatory mutations

| Mutation | Must break |
|---|---|
| `otp_submit` compares plaintext | code-hashing test |
| attempt `INCR` lifted out of Lua into TypeScript | concurrency test |
| lock check removed from `otp_submit` | locked-session test |
| challenge `DEL` removed on success | single-use test |
| cooldown `SET NX` → `SET` | cooldown test |
| hourly `PEXPIRE` dropped | cap-window test |
| Redis catch returns success | fail-closed test |
| phone key name un-HMAC'd | key-hygiene test |

---

## F-3 · Twilio SMS sender

**Implements design §7.** Depends on **F-2**.

`TwilioSmsSender` behind `SMS_SENDER`; `SMS_PROVIDER` finally gets a reader
(`mock` default outside production; production must say `twilio` explicitly).

**Recorded in the plan and the commit message:** `SMS_PROVIDER=mock` exists
today only as a line in `.env.example:38` with no reader, interface, or
implementation anywhere in the repository. This is **net-new functionality**,
not a provider swap.

Twilio SDK errors are caught at this boundary and converted to a generic
failure — no status code, account identifier, or provider message reaches the
caller, the model, or the transcript, matching `error-codes.ts`.

### Tests

Send success; send refusal → generic failure; no Twilio string in any surfaced
error; credentials absent → fail closed at startup; provider selection by env;
the SDK is never constructed when `SMS_PROVIDER` is not `twilio`.

### Mandatory mutations

| Mutation | Must break |
|---|---|
| Twilio error rethrown verbatim | error-containment test |
| `SMS_PROVIDER` default flipped to `twilio` | provider-selection test |

---

## F-4 · Phone lookup and the OTP tools

**Implements design §4, §6 and finding F-IV.** Depends on **F-1**, **F-2**.

### Lookup (finding F-IV, ruled fail-closed)

| Matches | Behaviour |
|---|---|
| 0 | uniform response, no SMS |
| exactly 1 | code sent, challenge bound to that `patientId` |
| ≥ 2 | **fail closed** — uniform response, no SMS |

E.164 → candidate stored formats via `where: { phone: { in: [...] } }`, keeping
`@@index([phone])` usable. No schema migration.

**No additional identity attribute and no disambiguation mechanism is added
anywhere in Phase 3.**

### Tools

Both `tier: 'public'`, both `needsPatientContext = true`.

- `request_verification_code` — input schema `{}`. **No phone parameter, ever.**
  The number is read server-side from `voice:otp:caller:<sessionId>`. A browser
  session has no caller record and receives `verification_unavailable`. The tool
  is structurally incapable of probing an arbitrary number, mirroring the Phase 0
  rule that a prompt injection must have no parameter to attack.
- `submit_verification_code` — input `{ code }`, exactly six digits, validated
  before Redis is touched. On success calls `promoteToPhoneVerified`.

### Non-enumeration

Zero matches, one match, and many matches produce an identical tool result, an
identical error code, and identical spoken phrasing. The reason is recorded only
as a **single `ineligible`** metric value covering both cases.

`TransportMetricsService` is logger-backed — every method writes a log line — so
a `reason=ambiguous` dimension would record in the log that this caller's number
matches two or more patients. That is patient-linkage data derived from a phone
number. Zero and ≥2 are collapsed before the metric is emitted (design §6).

### Tests (written first)

Zero / one / many matches produce byte-identical tool results. Caller ID bound
but no OTP submitted → Tier-2 still refused (**caller ID never grants
verification**). Successful submission sets `verifiedUntil` and rotates the
session. A verified phone session reaching Tier-2 tools. Expiry mid-conversation
refusing the next Tier-2 call on the same open socket. `request` on a browser
session → `verification_unavailable`. Six-digit schema rejection of `12345`,
`1234567`, `12345a`, empty, and non-string.

### Mandatory mutations

| Mutation | Must break |
|---|---|
| ambiguous branch returns the first match | fail-closed test |
| zero-match branch returns a distinct error | uniformity test |
| a `phone` parameter added to the request schema | schema test |
| caller ID sets `identityVerified` directly | caller-ID-is-a-hint test |
| metric emits `no_match`/`ambiguous` instead of `ineligible` | metric-collapse test |
| digit validation relaxed | schema test |

---

## F-5 · Audio format capability

**Implements design §9.** No dependencies.

`AudioFormat = 'linear16_16000' | 'mulaw_8000'` threaded through both speech
factories.

| | browser | phone |
|---|---|---|
| Deepgram | `encoding=linear16&sample_rate=16000` | `encoding=mulaw&sample_rate=8000` |
| ElevenLabs | *no `output_format`* (unchanged) | `output_format=ulaw_8000` |

**Browser byte-identity is the point of this task.** A test pins the exact
Deepgram query string and the exact ElevenLabs URL and body produced for
`linear16_16000` against what ships today — including the continued **absence**
of `output_format`, since adding one would change what the widget receives.

No DSP. A provider rejecting μ-law fails closed with
`stt_unavailable` / `tts_unavailable`; there is no resampling fallback.

### Mandatory mutations

| Mutation | Must break |
|---|---|
| browser format changed to `mulaw_8000` | byte-identity test |
| `output_format` added to the browser request | byte-identity test |
| phone format falls back to `linear16_16000` | phone-codec test |
| a resampler introduced on provider rejection | fail-closed test |

---

## F-6 · Twilio webhook

**Implements design §10.** Depends on **D-1**.

`POST /voice/phone/incoming`:

1. `X-Twilio-Signature` validated with `twilio.validateRequest`.
2. **Against `TWILIO_VOICE_WEBHOOK_URL`, not the request's own host** — behind
   a proxy, `Host` and `X-Forwarded-*` are attacker-influenced, and validating
   against a header lets an attacker choose the string the HMAC covers.
3. Raw body retained for that route.
4. Route-local `ValidationPipe({whitelist: true, forbidNonWhitelisted: false})`
   — the global `forbidNonWhitelisted: true` would 400 every webhook, since
   Twilio posts far more fields than we read. The signature is the real gate.
   The global setting is untouched.
5. Mints a **single-use, call-bound ticket** (D-1's service) and returns TwiML
   `<Connect><Stream url="wss://…/voice/phone?ticket=…"/></Connect>` with
   `Content-Type: text/xml`.
6. `ThrottlerGuard` applies — this **is** a real HTTP route with an
   `ExecutionContext`, the direct contrast with the OTP tools where it cannot
   be (design §12).
7. `VOICE_PHONE_ENABLED` unset → TwiML `<Reject/>`, no stream, no ticket.

### Tests

Valid signature → TwiML with a ticket. Absent / forged / wrong-URL signature →
403 with no detail. Flag off → `<Reject/>` and no ticket minted. Unknown Twilio
fields do not 400. Response content type is `text/xml`. The ticket never appears
in a log line.

### Mandatory mutations

| Mutation | Must break |
|---|---|
| validates against `Host` instead of the configured URL | forged-host test |
| signature guard returns true on mismatch | forged-signature test |
| flag check removed | default-deny test |
| global pipe relaxed instead of route-local | global-pipe-unchanged test |

---

## F-7 · Media stream transport and phone socket admission

**Implements design §8 and findings F-II, F-V.** Depends on **D-1**, **F-5**,
**F-6**. The highest-risk task in the phase.

### `TwilioMediaStreamTransport implements AudioTransport`

Interface unchanged. One deliberate asymmetry from the browser transport:
**`send(frame)` transmits nothing to Twilio.** A phone caller has no UI to
render `session.rotated`, `reply.text` or `status`, and the Media Stream
protocol rejects undefined events. Control frames are counted for metrics and
dropped.

`sendAudio` wraps μ-law as `{event:'media', streamSid, media:{payload}}`.
`close` closes the socket. `onTeardown`/`runTeardown` mirror the browser
transport including the run-once guard.

### Socket admission (findings F-II, F-V)

`verifyClient` branches on request path. **The browser policy is not relaxed:**

| | `/voice` (browser) | `/voice/phone` (Twilio) |
|---|---|---|
| Origin | exact-match allowlist; **absent Origin still rejected** | not checked |
| Per-IP cap | **unchanged, enforced** | not applied |
| Authenticator | ticket optional — anonymous is a legitimate surface | **ticket required** |
| Bad/absent ticket | session stays anonymous (unchanged) | **socket closed** |
| `maxPayload` | `WS_MAX_FRAME_BYTES` | same |
| Connection cap | `WS_MAX_CONNECTION_MS` = 10m | `PHONE_MAX_CONNECTION_MS` = 20m |

Skipping Origin on the phone path is safe for the reason the check exists — it
defends against CSWSH by a browser page, and there is no browser. Skipping the
per-IP cap is *necessary*: all Twilio media streams arrive from a small set of
egress IPs, so a shared 20/minute cap would refuse a busy clinic's calls.

Twilio does not sign the WebSocket handshake (finding F-V), so the ticket minted
by the **signed** webhook is the only thing binding a media socket to a real
call.

### Tests

Ticket admission: valid → accepted and bound to the call; absent → closed;
expired → closed; unknown → closed; replayed → second socket closed.
**Cross-instance:** ticket minted by webhook on instance A, media socket
admitted on instance B.

Browser regression: origin allowlist unchanged, absent Origin still rejected,
per-IP cap still enforced, bad ticket still leaves the session anonymous rather
than closing.

Transport: no `ServerFrame` is ever JSON-serialized onto a Twilio socket; audio
is base64 μ-law wrapped as `media`; a call exceeding `PHONE_MAX_CONNECTION_MS`
is closed.

**Lifecycle and malformed input** — the Media Stream is an untrusted, ordered
event feed and every deviation gets a test:

| Case | Required behaviour |
|---|---|
| `media` arriving before `start` | ignored; no session created |
| `start` twice on one socket | second ignored; no second session |
| `stop` twice | teardown runs exactly once |
| `stop` then `media` | audio after stop is dropped |
| socket closes with no `stop` | teardown still runs |
| `close` and `error` both raised | teardown runs once |
| non-JSON text frame | dropped, socket survives |
| JSON missing `event` / unknown `event` | dropped, socket survives |
| `media.payload` not valid base64 | dropped, no throw |
| oversize frame | refused by `maxPayload` before buffering |

**TTS cancellation ordering.** Phase 1 shipped a defect where teardown awaited
Redis before cancelling speech, so audio kept flowing to a closing socket. The
Twilio transport preserves the fix: `cancelSpeech` runs **before any await** in
the teardown path, pinned by a test that fails if an `await` is introduced ahead
of it.

**Redis state cleanup.** On call end the transport deletes
`voice:otp:caller:<sessionId>` and any pending `voice:otp:code:` /
`voice:otp:attempts:` keys rather than leaving them to TTL. A test asserts the
namespace is empty after a completed and after an abandoned call.

### Mandatory mutations

| Mutation | Must break |
|---|---|
| `/voice` branch skips the Origin check | browser CSWSH test |
| `/voice` branch accepts absent Origin | browser absent-Origin test |
| `/voice` branch skips the per-IP cap | browser rate-limit test |
| `/voice/phone` accepts an unticketed connection | phone admission test |
| ticket redemption made non-single-use | replay test |
| `send()` serializes frames to the Twilio socket | no-control-frames test |
| an `await` inserted before `cancelSpeech` in teardown | TTS-ordering test |
| `media` accepted before `start` | event-order test |
| OTP key cleanup removed from teardown | Redis-cleanup test |
| phone path routed through the browser branch | both suites |

---

## F-8 · Configuration, documentation, CI

Depends on **F-3**, **F-4**, **F-7**.

New variables — all server-side only, GitHub Actions secrets, never reaching a
browser:

| Variable | Purpose |
|---|---|
| `TWILIO_ACCOUNT_SID` | REST + signature validation |
| `TWILIO_AUTH_TOKEN` | REST + signature validation |
| `TWILIO_PHONE_NUMBER` | SMS sender identity |
| `TWILIO_VOICE_WEBHOOK_URL` | the URL signatures are validated against |
| `OTP_HMAC_SECRET` | code and phone-key hashing |
| `VOICE_PHONE_ENABLED` | default-deny phone channel flag |
| `SMS_PROVIDER` | gains a reader; `mock` \| `twilio` |

`.env.example`, README, `docker-compose`, CI workflow, and an operator runbook
covering: enabling the channel, rotating `OTP_HMAC_SECRET`, what happens when
Redis is down (verification fails closed, calls still connect and Tier-1 tools
still work), and how to read the OTP metrics counters.

**Two pre-existing documentation defects are corrected here:**

1. `.env.example:66-68` still reads *"Voice session and idempotency state is
   in-process. Running more than one instance … needs sticky routing."* PR #5
   (`3149e18`) moved both to Redis. The note is stale and tells operators to
   deploy the opposite of what D-1 enables.
2. `voice.controller.ts:36`'s comment describes `BoundedTtlMap` capping
   conversations; that class is deleted by D-1.

**New operational metrics** (from design §11): Redis `used_memory` and
`evicted_keys`, with an alert on any non-zero eviction rate — under
`volatile-lru` a live conversation is as evictable as a spent ticket.

### Environment matrix

| | local dev | CI | staging / tunnel | production |
|---|---|---|---|---|
| `VOICE_PHONE_ENABLED` | `false` unless testing | `false` | `true` | `true` |
| `SMS_PROVIDER` | `mock` | `mock` | `twilio` | `twilio` |
| Twilio credentials | absent | **absent** | real | real |
| `TWILIO_VOICE_WEBHOOK_URL` | tunnel URL, exact | unset | tunnel/host URL | public host |
| `OTP_HMAC_SECRET` | dev value | fixed test value | secret | secret |
| Redis | docker-compose | service container | managed | managed |

**CI never holds Twilio credentials and never places a call or sends an SMS.**
Every phone test uses a fake sender and a fake socket, matching the existing
rule that CI contacts Anthropic only.

### Required external Twilio setup (operator, outside the codebase)

1. A voice-capable phone number on the account.
2. That number's **A Call Comes In** webhook set to
   `POST https://<host>/voice/phone/incoming`.
3. The same URL in `TWILIO_VOICE_WEBHOOK_URL`, exactly.
4. Messaging enabled on the number for OTP delivery.
5. Geographic permissions allowing the destination country for SMS.

A test asserts no Twilio credential, no OTP secret, and no HMAC appears in any
frame, log line, transcript, or client-visible error.

---

## F-9 · Live provider verification

Depends on **F-8**. **Acceptance-blocking — no unit or contract test
substitutes for any item here.**

| Check | Proves |
|---|---|
| Inbound PSTN call reaches the signed webhook | signature validation against the real Twilio signature |
| TwiML opens a media stream | `<Connect><Stream>` accepted, ticket admitted |
| Caller audio → Deepgram μ-law 8 kHz → transcript | `encoding=mulaw&sample_rate=8000` works live |
| Reply → ElevenLabs `output_format=ulaw_8000` → audible playback | **the one documented-but-unverified assumption in the design** |
| SMS delivered to a real handset | `TwilioSmsSender` end to end |
| Code accepted → Tier-2 tool answers | full phone verification path |
| Wait out `OTP_VERIFIED_TTL_MS` → Tier-2 refused on the same open call | expiry revokes on a live socket |
| Browser widget regression | unchanged after every codec change |

`output_format=ulaw_8000` is taken from ElevenLabs' documented format list and
has **never been exercised against the live API**. If it is rejected, the phone
TTS path fails closed and F-9 fails — it does not fall back to a resampler, and
the design is not permitted to rest on the assumption.

### How this is actually executed — there is no staging environment

Verified against the repository: the only workflows are `ci.yml` and
`nightly-agent-evals.yml`. **No staging deployment exists**, and Phase 2's live
verification was performed manually by the operator with real credentials.

Inbound telephony cannot be verified from a laptop the way Deepgram and
ElevenLabs were, because Twilio must **reach** the webhook: it needs a publicly
resolvable HTTPS URL. F-9 therefore requires one of:

- **a public tunnel** (ngrok or equivalent) in front of the local API, or
- **a deployed environment** with a real hostname.

With the tunnel option, one gotcha is load-bearing and must be in the runbook:
**`TWILIO_VOICE_WEBHOOK_URL` must match the tunnel URL exactly**, including
scheme and any trailing path. Twilio computes the signature over the URL it
called; validating against a different string fails every request with a 403
that looks identical to an attack. Tunnel URLs change on restart unless
reserved, so this breaks on the second run if it is not pinned.

Any live-verification item that cannot be executed is reported as **not
verified**. Unit and contract coverage is never presented as a substitute.

Credentials are configured outside the chat, never pasted into it, never logged,
never committed.

---

## 3. Cross-instance test requirements

Every task that touches shared state carries at least one test that drives
**two service instances against one Redis**, because a single-instance test
cannot distinguish shared state from process-local state — which is exactly the
defect D-1 fixes.

| Task | Cross-instance assertion |
|---|---|
| D-1 | ticket issued on A is redeemed on B; redeemed exactly once |
| F-1 | `verifiedUntil` written on A is enforced identically on B; expiry agrees |
| F-2 | request on A, submit on B; attempt cap and lock hold across alternating instances |
| F-4 | verification on A is visible to a Tier-2 tool dispatched on B |
| F-7 | webhook mints on A, media socket admitted on B |

Per-worker Redis DB isolation (`tests/jest.redis-setup.js`,
`JEST_WORKER_ID % 16`) already exists and is reused.

---

## 4. Mutation-test discipline

Carried forward from Phase 1 without relaxation. For every mutation listed
above:

1. Back up the file **by copy**, never by `git checkout` — that has already
   destroyed uncommitted work once in this project.
2. Apply the mutation, then **print the mutated region** and assert the edit
   matched exactly once. A silently non-applying regex has produced a false
   green twice.
3. Run the named test and confirm it goes **red**.
4. Restore from the copy and confirm the suite is green again.
5. If a mutation does not turn the relevant test red, **fix the test before
   accepting the task** — the test is the thing that was wrong.

A red full suite is classified and reproduced before any checkpoint commit,
even when the likely cause is infrastructure.

---

## 5. Acceptance criteria

1. An expired phone verification is refused by every Tier-2 tool on an open
   socket, with no reconnection — proven by mutation.
2. A browser session verified by JWT has `verifiedUntil === null`, is
   unaffected by every change in this phase, and its Deepgram and ElevenLabs
   requests are byte-identical to Phase 2.
3. `verifiedUntil` survives serialization, retrieval, rotation, and a read from
   a second instance. An expired deadline is never resurrected by rotation.
4. Re-verification after expiry rotates the session id; expiry alone does not.
5. `isVerificationActive` is the only authorization reader of
   `identityVerified`, enforced by the structural guard.
6. Caller ID alone never grants verification.
7. Zero, one, and many phone matches produce identical results; ≥2 sends no SMS.
8. `OTP_MAX_ATTEMPTS + 3` concurrent wrong guesses lock after exactly
   `OTP_MAX_ATTEMPTS`.
9. A correct code is consumable exactly once, including under concurrency.
10. All OTP limits hold across two instances against one Redis.
11. Redis unavailability fails verification closed, everywhere.
12. No OTP code, phone number, HMAC, ticket, or Twilio credential appears in any
    log line, frame, transcript, or client-visible error — proven positively by
    a log-capture test **and** negatively by a mutation that adds the code to a
    log line and must turn that test red. (The earlier plan asserted this
    criterion with no mutation behind it.)
13. Browser tickets work across instances; 2000 issued tickets all remain
    redeemable.
14. An unticketed, expired, unknown, or replayed connection to `/voice/phone`
    is closed; `/voice` widget behaviour is unchanged.
15. Webhook signatures are validated against the configured URL; absent, forged,
    and wrong-URL signatures are rejected 403.
16. `VOICE_PHONE_ENABLED` unset ⇒ the phone channel is unreachable.
17. Live verification (F-9) passes every row, including ElevenLabs
    `ulaw_8000`.
18. Full suite, typecheck, lint, and build green.

---

## 6. Explicitly out of scope

- Barge-in / interruption detection (the Twilio `clear` event is noted as the
  future mechanism; nothing listens during playback).
- Outbound calling of any kind.
- Voicemail, call recording, transcript persistence, analytics.
- Warm transfer to a human — offered verbally, not implemented.
- Multi-language STT/TTS.
- DTMF entry; `dtmf` events are ignored, codes are spoken.
- **Any additional identity attribute or disambiguation mechanism**, DOB
  included — ruled out 2026-08-25.
- A normalized `phoneE164` column and backfill — a migration touching every
  patient row, deferred to its own change.
- `WsOriginAdapter.recentByIp` → Redis: pre-existing, per-instance, skipped on
  the phone path, documented as a known limitation.
- The ElevenLabs default voice id correction — frozen by prior ruling.
- Changing `SESSION_TTL_MS`.
- Any change to the ten existing tools' behaviour, to `ClaudeAgent`, to
  `ToolRegistry`, or to `IdempotencyService`.
