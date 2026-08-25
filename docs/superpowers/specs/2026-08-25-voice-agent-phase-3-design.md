# Voice Agent — Phase 3 Design: Telephony Channel and Phone Verification

**Status:** design only. Nothing in this document is implemented.
**Date:** 2026-08-25
**Baseline:** `main` @ `b7b724a` (Phase 2 + Redis migration merged)

Phase 3 adds a telephone channel and the OTP verification that makes it usable.
The agent, the tool registry, the executor's authorization choke point and the
idempotency layer keep their existing behaviour; what changes is the session
contract (deliberately, under ruling), the audio format seam, and the set of
transports.

---

## 0. Why the boolean was insufficient

The master design states both halves of a contradiction in adjacent sentences
(`2026-08-10-voice-agent-design.md` §4):

> `submit_verification_code` promotes to `VERIFIED` **with a short expiry**.
>
> Both channels satisfy **the same single flag**, which is what makes the
> telephony seam cheap.

`identityVerified: boolean` has no deadline field. "Same single flag" and "short
expiry" cannot both hold.

This did not surface in Phase 2 because browser verification is genuinely
binary. `VoiceGateway.resume` calls `createVerifiedSession` at connect time, the
session is *born* verified, and `identityVerified` never transitions during its
life. Its natural expiry is the session's own 1800s TTL, and that is correct:
the credential behind it is a JWT checked at connect, and the connection *is*
the grant.

Phone verification has the opposite shape. The session is born `false`, is
promoted mid-call by a tool, and the credential behind the promotion is a
six-digit SMS code — far weaker than a JWT, on a channel where the design
already says caller ID "is a hint, never proof". Binding that promotion to the
1800s session TTL would open a thirty-minute window of financial-record access
on the strength of one SMS. That is the reason for an explicit deadline, and a
boolean cannot carry one.

**Ruling applied:** Option A. `verifiedUntil` becomes authoritative session
state. It is deliberately *not* derived from a Redis side key — a derived flag
would make `identityVerified` mean something different depending on which code
path read it, and the whole point of the choke point is that there is one
answer.

---

## 0.1 Five findings that shaped this design

These emerged from working the rulings through to concrete code. Each is a
correctness or security consequence that was not visible at pre-flight, and each
is carried into the plan as named, mutation-tested work.

### F-I — Rotation must compare *effective* verification, not the raw boolean

`snapshotPrivilege` reads `identityVerified` directly today. Left alone under
Option A, a session that verifies → expires → re-verifies shows `true` on both
sides of the comparison, so `privilegeChanged` reports no gain and **no rotation
fires on re-verification** — leaving a bearer id that existed at lower privilege
in service. The snapshot field becomes `verificationActive`, computed by
`isVerificationActive`.

- expiry is a privilege **loss** → does **not** rotate
- re-verification after expiry is a privilege **gain** → **must** rotate

### F-II — Twilio media streams are rejected at the upgrade today

`isOriginAllowed(undefined)` returns `false` and Twilio sends no `Origin`
header, so `verifyClient` would refuse 100% of media streams. The phone path is
admitted **separately**, and the browser policy is not relaxed to accommodate
it:

- browser `/voice`: Origin allowlist unchanged, exact match, **absent Origin
  still rejected**
- browser `/voice`: per-IP connection cap unchanged
- phone `/voice/phone`: Origin not checked (no browser exists to protect against
  CSWSH), per-IP cap not applied (all Twilio traffic shares egress IPs), and
  **ticket admission is the authenticator instead**

Both separations are mutation-tested: relaxing the browser Origin check must
turn the suite red, and accepting an unticketed phone connection must turn the
suite red.

### F-III — `VoiceTicketService` is in-process and already broken in Phase 2

Tickets live in a `BoundedTtlMap` with a synchronous `consume()`. Behind a load
balancer with `APP_INSTANCES > 1`, a ticket issued on instance A cannot be
redeemed on instance B, so **browser voice verification fails intermittently in
production today**. The Redis migration covered sessions and idempotency and did
not reach this. Phase 3 needs the same primitive for a strictly worse case — the
webhook and the media socket are *always* two separate connections — so one
Redis-backed ticket service serves both channels.

Classified as a **pre-existing Phase 2 defect fix**, not a phone feature.

### F-IV — `Patient.phone` is not unique

Shared household numbers are ordinary in a dental practice. Proving control of
one must not open another family member's balance. Exactly one match is required
to verify; 0 or ≥2 fail closed, with a response that distinguishes none of the
three cases.

### F-V — Twilio does not sign the WebSocket handshake

Only the HTTP webhook is signed. The WSS endpoint is publicly reachable, so
anyone who learns the URL can connect. `/voice/phone` therefore requires a
valid, single-use, server-issued ticket minted by the signed webhook and bound
to that call; an absent, expired, unknown or replayed ticket **closes the
socket**. The `/voice` public widget is unchanged — a bad ticket there still
leaves the session anonymous, because an anonymous widget session is a
legitimate product surface while an unticketed phone connection is not a caller.

---

## 1. Updated `VoiceSession` contract

`apps/api/src/modules/voice/session/voice-session.ts`

```ts
export interface VoiceSession {
  sessionId: string;
  logId: string;
  idempotencyNonce: string;
  userId: string | null;
  patientId: string | null;

  identityVerified: boolean;

  /**
   * Absolute deadline for `identityVerified`, in epoch milliseconds.
   *
   * `null` means "verified for the lifetime of the session" and is the browser
   * case: the JWT was checked at connect, the connection is the grant, and the
   * session TTL is the only bound that applies.
   *
   * A number is the phone case: OTP proves control of a phone number, which is
   * a weaker credential than a JWT, so the access it grants is time-boxed
   * independently of the session.
   *
   * Meaningless when `identityVerified` is false. Authorization never reads it
   * on its own — see `isVerificationActive`.
   */
  verifiedUntil: number | null;

  turnIndex: number;
}
```

### Constructors

| Constructor | `identityVerified` | `verifiedUntil` | Channel |
|---|---|---|---|
| `createAnonymousSession(sessionId?)` | `false` | `null` | both |
| `createVerifiedSession(sessionId, userId, patientId)` | `true` | `null` | browser (unchanged) |
| `promoteToPhoneVerified(session, {userId, patientId, now, ttlMs})` | `true` | `now + ttlMs` | phone (new) |

`promoteToPhoneVerified` mutates the session in place. That is deliberate and
follows the existing precedent: `PatientIntakeTool` is `tier: 'public'` with
`needsPatientContext = true`, and `ToolExecutorService` hands such a tool the
*real* session object rather than a clone precisely so its writes survive the
turn. The OTP tool uses the same mechanism. No change to
`ToolExecutorService`'s narrowing logic is required.

`userId` is set to `patient.userId ?? null`. A patient with no portal account
verifies successfully and stays `userId: null`; every Tier-2 tool authorizes on
`patientId`, so nothing depends on `userId` being present.

### Deserialization of pre-existing sessions

Sessions written before the deploy have no `verifiedUntil` key, so
`JSON.parse` yields `undefined`. `VoiceSessionStore.get()` must normalize
`undefined → null`.

This is safe and is the only correct choice: before this deploy nothing but
`createVerifiedSession` could set `identityVerified: true`, so every
pre-existing verified session is a browser session, and `null` is exactly its
correct value. An in-flight caller is not logged out by the deploy.

### Frame hygiene

`verifiedUntil` and `verified_until` are added to `FORBIDDEN_KEYS` in
`transport/frames.ts`. The allowed-key lists are already exhaustive so this is
belt to that braces, but the file's own comment requires it: *"adding a session
field cannot silently open a hole"*.

---

## 2. Authorization semantics

One new pure function is the single source of truth.

`apps/api/src/modules/voice/session/verification.ts`

```ts
export function isVerificationActive(
  session: Pick<VoiceSession, 'identityVerified' | 'verifiedUntil'>,
  now: number = Date.now()
): boolean {
  if (!session.identityVerified) return false;
  if (session.verifiedUntil === null) return true;
  return session.verifiedUntil > now;
}
```

The authorization rule, verbatim from the ruling:

```
identityVerified === true
AND (verifiedUntil === null OR verifiedUntil > Date.now())
```

`ToolExecutorService.dispatch` (`tool-executor.service.ts:47`) changes from

```ts
if (tool.tier === 'verified' && !session.identityVerified) {
```

to

```ts
if (tool.tier === 'verified' && !isVerificationActive(session)) {
```

Everything else about the gate is unchanged: same `verification_required`
result, same `logId`-only warning, same position ahead of the narrowing step.

**An expired phone verification is indistinguishable from an unverified session
for Tier-2 authorization.** It is not a distinct error code — surfacing
"expired" versus "never verified" tells a caller something about a session they
may not own.

`now` is a parameter rather than an injected clock because the function is
pure. Tests pass an explicit `now`; production takes the default.

### The audit record must report the effective value

`ToolExecutorService` writes `identityVerified: session.identityVerified` into
the `AuditLog` payload (`tool-executor.service.ts:120`). Left alone, an expired
phone session would be **refused** by the gate and **audited as verified** — the
forensic record contradicting the authorization decision that produced it.

The payload records both:

```ts
identityVerified: session.identityVerified,        // raw: was it ever verified
verificationActive: isVerificationActive(session), // effective: was it verified NOW
verifiedUntil: session.verifiedUntil,              // why, if not
```

The structural guard below treats this line as a known **non-authorization**
read and permits it explicitly; every other new read fails the suite.

### Structural invariant

After this change, **no file other than `verification.ts` may read
`identityVerified` to make an authorization decision.** A guard test greps
`src/` for `.identityVerified` and asserts the call sites are exactly the
known set (the interface declaration, the two constructors, the promotion
helper, `privilege-change.ts`, `verification.ts`, `frames.ts`'s string
literal). A new unguarded read fails the suite.

---

## 3. Session rotation and expiry behaviour

### Rotation preserves `verifiedUntil` for free — and must be proven to

`VoiceSessionStore.rotate()` reads the conversation, changes only
`session.sessionId`, `RENAME`s the key and rewrites the record with the
remaining TTL. Because `verifiedUntil` is a plain JSON number it survives
serialization, `RENAME` and rewrite with no store change at all.

The security consequence follows directly: **an expired verification cannot be
resurrected by rotation**, because rotation copies the deadline verbatim rather
than recomputing it. A test must pin this — rotate a session whose
`verifiedUntil` is in the past and assert a Tier-2 tool is still refused.

### `privilegeChanged` must compare *effective* verification

This is the one non-obvious consequence of the ruling.

`snapshotPrivilege` currently captures the raw boolean. If it kept doing so, a
session that was verified, expired, and then re-verified would have
`before.identityVerified === true` and `after.identityVerified === true` — no
gain detected, **no rotation on re-verification**. Re-verification is a
privilege gain and must rotate the bearer credential.

```ts
export interface PrivilegeSnapshot {
  patientId: string | null;
  verificationActive: boolean;   // was: identityVerified
}

export function snapshotPrivilege(session: VoiceSession, now = Date.now()): PrivilegeSnapshot {
  return {
    patientId: session.patientId,
    verificationActive: isVerificationActive(session, now),
  };
}
```

`privilegeChanged` compares effective values on both sides. Consequences,
each of which gets a test:

| Transition during a turn | Rotate? | Why |
|---|---|---|
| anonymous → phone-verified | **yes** | privilege gained |
| expired → re-verified | **yes** | privilege gained; the bearer id existed at lower privilege |
| verified → expired | no | privilege *lost*; rotation exists to retire a credential that was exposed at a lower privilege, and losing access does not create that exposure |
| browser verified at connect | unchanged | born verified, no in-turn transition |

`verifiedUntil` is deliberately absent from the snapshot. A shrinking deadline
is not a privilege change.

### Expiry revokes access on an open socket

Expiry is enforced at authorization time, on every tool dispatch, against the
session record loaded from Redis for that turn. No timer, no push, no socket
event. A caller whose WebSocket has stayed open for the whole call simply finds
the next Tier-2 tool refused with `verification_required`, and the agent asks
them to verify again. This satisfies "OTP expiry must revoke Tier-2 access even
if the WebSocket connection remains open" without any connection-level
machinery.

### Session TTL untouched

`SESSION_TTL_MS` stays at 1800s. `OTP_VERIFIED_TTL_MS` (10 min, §5) is
strictly shorter, so verification always expires before the session does and
the two clocks never need reconciling.

---

## 4. OTP state machine

State lives in Redis under `voice:otp:`, keyed by session. **None of it enters
`VoiceSession`** — in particular the caller's phone number never does, so it
never reaches a frame, a log line, or the model.

```
        ┌──────────────────────────── request_verification_code ─────┐
        │                                                            │
        ▼                                                            │
     NONE ──request──▶ PENDING ──submit(correct)──▶ CONSUMED ──▶ session verified
        ▲                 │                                       (verifiedUntil set)
        │                 ├──submit(wrong) × OTP_MAX_ATTEMPTS──▶ LOCKED
        │                 │                                          │
        └────── code TTL expires ──────────────────────────────┐     │
                          │                                    │     │
                          └────── submit(wrong, < max) ────────┘     │
                                    (stays PENDING)                  │
                                                          OTP_LOCK_MS│
                                                                     ▼
                                                                   NONE
```

### Tools

Both are `tier: 'public'` (an anonymous caller must be able to reach them) and
both declare `needsPatientContext = true` so they receive the real session
object.

**`request_verification_code`** — input schema: `{}`. **No phone parameter, ever.**

This mirrors the Phase 0 identity design exactly: *"a prompt injection has no
parameter to attack, because the tool schema does not expose one."* The number
to send to is read server-side from the OTP service's caller record, which the
Twilio transport wrote at call setup. A browser session has no caller record,
so the tool returns `verification_unavailable` there — it is globally
registered but functional only on the phone channel, and it is structurally
incapable of being used to probe arbitrary numbers.

**`submit_verification_code`** — input schema: `{ code: string }`, validated as
exactly six digits before it reaches Redis.

### Responses are uniform

`request_verification_code` returns the same result whether the caller ID
matches one patient, several, or none: *"If that number is on file, a code has
been sent."* Every branch consumes the resend cooldown. Nothing in the response,
the error code, or the agent's phrasing distinguishes the cases.

Timing is not treated as a covert channel here, and the reason is worth
recording rather than leaving implicit: every branch performs the same single
indexed patient query, and an attacker who wants to know whether a number
belongs to a patient can simply call the clinic. The uniform *response* is what
matters, because that is what an automated prober can consume at scale.

---

## 5. OTP Redis key schema and TTLs

Namespace `voice:otp:`, alongside the existing `voice:session:` and
`voice:idem:`. All keys carry a TTL; none is written without one.

| Key | Value | TTL | Written by |
|---|---|---|---|
| `voice:otp:caller:<sessionId>` | E.164 phone | 1800s | phone transport at call setup |
| `voice:otp:code:<sessionId>` | JSON `{codeHash, patientId}` | 300s | `request_verification_code` |
| `voice:otp:attempts:<sessionId>` | integer | 300s | `submit_verification_code` |
| `voice:otp:lock:<sessionId>` | `1` | 900s | attempt limiter |
| `voice:otp:cooldown:<sessionId>` | `1` | 60s | resend limiter |
| `voice:otp:req:<phoneHmac>` | integer | 3600s | per-number request cap |

### Constants

```ts
export const OTP_CODE_TTL_MS            = 5  * 60 * 1000;  // time to enter the code
export const OTP_VERIFIED_TTL_MS        = 10 * 60 * 1000;  // the "short expiry"
export const OTP_MAX_ATTEMPTS           = 5;
export const OTP_RESEND_COOLDOWN_MS     = 60 * 1000;
export const OTP_MAX_REQUESTS_PER_PHONE_PER_HOUR = 5;
export const OTP_LOCK_MS                = 15 * 60 * 1000;
export const OTP_CODE_DIGITS            = 6;
```

`OTP_VERIFIED_TTL_MS` (10 min) sits below `PHONE_MAX_CONNECTION_MS` (20 min,
§9) so a long call re-verifies mid-conversation rather than silently keeping
access, and well below `SESSION_TTL_MS` (30 min).

### Two things are hashed, and why

- **The code** is stored as `HMAC-SHA256(code, OTP_HMAC_SECRET)`, never in
  plaintext. A Redis `MONITOR` session, an `RDB` snapshot, or a memory dump
  would otherwise hand over live one-time codes.
- **The phone number** is HMAC'd in the `voice:otp:req:` key name. A phone
  number in a Redis *key* leaks through `SCAN` output, slowlog entries and
  monitoring exporters — places that are not treated as sensitive. The value
  under `voice:otp:caller:` is a value, not a key, and is bounded by the
  session TTL.

`OTP_HMAC_SECRET` is a new required secret; the service refuses to start
without it when the phone channel is enabled (fail closed, matching the
existing provider-key pattern).

### Atomicity

Two operations need to be atomic across instances. Both are Lua, evaluated
server-side in one round trip.

**`otp_submit`** — read the challenge, compare hashes, and either consume or
count the failure, with no window between the steps:

```
-- KEYS: code, attempts, lock   ARGV: candidateHash, maxAttempts, attemptsTtl, lockTtl
if redis.call('EXISTS', KEYS[3]) == 1 then return {'locked'} end
local rec = redis.call('GET', KEYS[1])
if not rec then return {'expired'} end
if <hash in rec> == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2])
  return {'ok', <patientId in rec>}
end
local n = redis.call('INCR', KEYS[2])
if n == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
if n >= tonumber(ARGV[2]) then
  redis.call('SET', KEYS[3], '1', 'PX', ARGV[4])
  redis.call('DEL', KEYS[1], KEYS[2])
  return {'locked'}
end
return {'wrong'}
```

A read-compare-delete written in TypeScript would let two concurrent submissions
of the same correct code both consume it, and — worse — would let a burst of
concurrent wrong guesses each read `attempts` before any of them wrote, beating
the cap. The script closes both.

**`otp_request`** — check cooldown, check the per-number hourly cap, and claim
both in one step, so two simultaneous requests cannot both pass:

```
-- KEYS: cooldown, reqCount   ARGV: cooldownTtl, maxPerHour, hourTtl
if redis.call('SET', KEYS[1], '1', 'PX', ARGV[1], 'NX') == false then return {'cooldown'} end
local n = redis.call('INCR', KEYS[2])
if n == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
if n > tonumber(ARGV[2]) then return {'capped'} end
return {'ok'}
```

Note the ordering: the cooldown is claimed with `SET NX` *before* the counter
increments, so a caller who is rate-limited by cooldown does not burn their
hourly budget.

### Failure behaviour

Redis unavailable, script error, or malformed record → both tools return
`verification_unavailable` and the session stays unverified. **Fail closed,
without exception.** There is no degraded mode in which OTP verification
succeeds while its rate limiting is unavailable.

### Logging

The code, the phone number, and the HMAC of either are never logged at any
level. `logId` remains the only session identifier permitted in a log line. A
log-hygiene test captures the logger across a full request/submit cycle and
asserts none of the three appears.

---

## 6. Caller-ID lookup semantics

Caller ID selects **which number a code is sent to**. It never sets
`identityVerified` and never binds a patient on its own.

`Patient.phone` is `String` — required, indexed, and **not unique**
(`prisma/schema.prisma:56,78`). Shared household numbers are ordinary in a
dental practice, and that shapes the rule:

| Patients matching the caller ID | Behaviour |
|---|---|
| 0 | uniform response, no SMS sent |
| exactly 1 | code sent, challenge bound to that `patientId` |
| 2 or more | **fail closed** — uniform response, no SMS, verification unavailable |

Failing closed on a shared number is the security-relevant case: proving control
of a household phone must not open one family member's balance to another. The
agent offers a transfer to the front desk instead.

**Ruled 2026-08-25: fail closed. No DOB disambiguation, and no additional
identity attribute or disambiguation mechanism anywhere in Phase 3.**

The uniform-response requirement is stronger than "same error code". The tool
result, the error code, the agent's phrasing, and the audit record must not
reveal:

- whether the number exists on file at all,
- how many patients matched,
- whether the refusal came from zero matches or from two or more.

All three branches return the identical `verification_unavailable` result and
the identical spoken response.

**Internally the two refusal reasons are also collapsed.**
`TransportMetricsService` is logger-backed — every "metric" is a log line — so a
`reason=ambiguous` dimension would write to the log that this caller's number
matches two or more patient records. That is patient-linkage information
derived from a phone number, sitting in a log correlated with a call. The
metric records a single `ineligible` value covering both zero and ≥2, which
preserves the operational signal (how often verification cannot proceed)
without distinguishing the cases anywhere, caller-visible or not.

### Normalization

Twilio delivers `From` in E.164 (`+15551234567`); existing `Patient.phone` rows
are free-form. Rather than a data migration, the lookup generates the plausible
stored formats from the E.164 value and queries
`where: { phone: { in: [...candidates] } }`. This keeps the existing
`@@index([phone])` usable, where a normalizing expression on the column would
not.

Recorded as a known wart: the right long-term fix is a normalized
`phoneE164` column with a backfill. That is **out of scope for Phase 3** —
it is a schema migration touching every patient row and belongs in its own
change.

---

## 7. Twilio SMS architecture

`SMS_PROVIDER=mock` is a single line in `.env.example:38` and appears nowhere
else in the repository — no reader, no interface, no implementation, no
consumer. The roadmap's *"Twilio SMS replaces `SMS_PROVIDER=mock`"* describes
replacing something that was never built. **SMS sending is net-new.**

```ts
export const SMS_SENDER = Symbol('SMS_SENDER');

export interface SmsSender {
  /** Resolves on accepted-for-delivery. Throws on refusal; never returns a provider error string. */
  send(toE164: string, body: string): Promise<void>;
}
```

Two implementations: `TwilioSmsSender` (production) and `LoggingSmsSender`
(non-production, records that a send happened and to which HMAC'd number —
never the code). The `SMS_PROVIDER` env var finally gets a reader and selects
between them; `mock` outside production is the default, and production requires
`twilio` explicitly.

Twilio errors are caught at this boundary and converted to a generic failure.
Nothing from the Twilio SDK — status codes, account identifiers, error messages
— reaches the caller, the model, or the transcript, matching the rule already
enforced for Anthropic, Deepgram and ElevenLabs in `error-codes.ts`.

---

## 8. Twilio Media Streams transport

### Call flow

```
PSTN call
  → Twilio POST /voice/phone/incoming        (signed webhook)
  → 200 text/xml: <Response><Connect>
        <Stream url="wss://host/voice/phone?ticket=…"/>
      </Connect></Response>
  → Twilio opens WSS /voice/phone
  → {event:'connected'} {event:'start', streamSid, callSid}
  → {event:'media', media:{payload:<base64 μ-law 8k, 20ms>}} …
  → {event:'stop'}
```

### `TwilioMediaStreamTransport implements AudioTransport`

The interface is unchanged. The implementation differs from
`BrowserWebSocketTransport` in one way that matters:

- **`send(frame)` sends nothing to Twilio.** A phone caller has no UI to render
  `session.rotated`, `reply.text` or `status` frames, and Twilio's Media Stream
  protocol rejects events it does not define. Control frames are recorded for
  metrics and dropped. This is a deliberate asymmetry and gets an explicit test:
  no `ServerFrame` may ever be JSON-serialized onto a Twilio socket.
- **`sendAudio(chunk)`** wraps the μ-law bytes as
  `{event:'media', streamSid, media:{payload: base64}}`.
- **`close(code)`** closes the socket; Twilio ends the call. The code is not
  transmitted — there is no client to read it.
- **`onTeardown` / `runTeardown`** identical to the browser transport, including
  the run-once guard.

Barge-in remains out of scope, but the Twilio `clear` event is noted here as the
mechanism a future phase would use to flush queued playback.

### Authenticating the media stream socket

The WSS endpoint is publicly reachable and **Twilio does not sign the WebSocket
handshake** — only the HTTP webhook. Anyone who learns the URL can connect.

The mitigation is the pattern the browser already uses: the webhook mints a
one-time ticket, embeds it in the `<Stream url="…?ticket=…">`, and the socket
redeems it before reading a frame. Unlike the browser ticket it must be
Redis-backed (§11), because the webhook and the media socket are separate
connections that a load balancer may route to different instances.

An absent, expired or spent ticket **closes the socket** on the phone path.
This differs from the browser path, where a bad ticket merely leaves the session
anonymous — there, an anonymous session is a legitimate product surface (the
public widget). On the phone path an unticketed connection is not a caller, it
is someone who found the URL.

### Origin check — currently rejects every Twilio connection

`isOriginAllowed(undefined)` returns `false` (`allowed-origins.ts:38-40`) and
Twilio sends no `Origin` header. As it stands, **`WsOriginAdapter.verifyClient`
would reject 100% of Twilio media streams at the upgrade.**

`verifyClient` must branch on the request path:

| | `/voice` (browser) | `/voice/phone` (Twilio) |
|---|---|---|
| Origin | exact-match allowlist, absent = reject | not checked |
| Per-IP connection cap | enforced | not enforced |
| Authenticator | ticket optional (anonymous allowed) | ticket **required** |
| `maxPayload` | `WS_MAX_FRAME_BYTES` | same |

Skipping the origin check on the phone path is safe for the reason the check
exists: it defends against cross-site WebSocket hijacking by a browser page, and
there is no browser in this path. Skipping the per-IP cap is necessary rather
than merely safe — all Twilio media streams arrive from a small set of Twilio
egress addresses, so a shared 20-per-minute cap would start refusing a busy
clinic's calls.

**Both branches are mutation-tested.** Making `/voice` skip the origin check
must turn the suite red; so must making `/voice/phone` accept a connection with
no ticket.

---

## 9. Audio format as an explicit capability

Format is currently hardcoded to browser values in two places:

- `deepgram-stt.service.ts:10,94-96` — `linear16`, 16 kHz.
- `elevenlabs-tts.service.ts:51` — no `output_format` at all, so the provider
  default (`mp3_44100_128`) is what ships today.

Twilio Media Streams are μ-law 8 kHz in both directions. Both providers support
that natively, so **no DSP transcoding is required** — but the format has to
become a parameter rather than a constant.

```ts
export type AudioFormat = 'linear16_16000' | 'mulaw_8000';

export type SpeechToTextFactory = (format: AudioFormat) => SpeechToText;
export type TextToSpeechFactory = (format: AudioFormat) => TextToSpeech;
```

| | browser | phone |
|---|---|---|
| Deepgram | `encoding=linear16&sample_rate=16000` | `encoding=mulaw&sample_rate=8000` |
| ElevenLabs | *(unchanged — no `output_format`)* | `output_format=ulaw_8000` |

**The browser path must be byte-identical to Phase 2.** A test pins the exact
Deepgram query string and the exact ElevenLabs request body/URL produced for
`linear16_16000` against the values shipping today. In particular the browser
request continues to send no `output_format`, because adding one would change
what the widget receives.

If a provider rejects the μ-law configuration, the phone transport fails closed
with `stt_unavailable` / `tts_unavailable`. There is no resampling fallback.

> `output_format=ulaw_8000` on the ElevenLabs streaming endpoint is taken from
> the provider's documented format list and is **not yet verified against the
> live API**. Verifying it is an explicit acceptance criterion (P3-9), not an
> assumption this design is allowed to rest on.

---

## 10. Webhook and signature security

`POST /voice/phone/incoming`

1. **Signature.** `X-Twilio-Signature` is HMAC-SHA1 over the full URL plus
   sorted POST parameters. Validated with `twilio.validateRequest`. Mismatch →
   `403`, no body detail.
2. **URL used for validation is `TWILIO_VOICE_WEBHOOK_URL`, not the request's
   own host.** Behind a proxy, `Host` and `X-Forwarded-*` are attacker-
   influenced; validating against a header lets an attacker choose the string
   the HMAC is computed over.
3. **Raw body.** Signature validation needs the exact bytes. The body parser is
   configured to retain the raw buffer for this route.
4. **Validation pipe.** The global
   `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })` would
   reject every Twilio webhook, because Twilio posts far more fields than we
   read. This route opts out locally with
   `forbidNonWhitelisted: false, whitelist: true` — the signature is the real
   gate, and the body is Twilio's schema, not ours. The opt-out is route-local
   and commented; the global setting is untouched.
5. **Response.** TwiML XML with an explicit `Content-Type: text/xml`.
6. **Rate limiting.** This one *is* an HTTP route with an `ExecutionContext`,
   so `ThrottlerGuard` applies and is used. This is the direct contrast with
   the OTP tools, where it cannot be (§12).
7. **Feature flag.** `VOICE_PHONE_ENABLED` defaults to off. A deployment that
   has not switched the phone channel on returns a TwiML `<Reject/>` and never
   opens a stream — matching the browser flag's default-deny, where "an absent
   variable is not consent".

---

## 11. Multi-instance and concurrency model

Every piece of Phase 3 state is in Redis. No new store is introduced.

### Pre-existing gap this phase must close

`VoiceTicketService` (`session/voice-ticket.service.ts`) holds tickets in an
in-process `BoundedTtlMap`, and `consume()` is synchronous. **Behind a load
balancer with `APP_INSTANCES > 1`, a ticket issued by instance A cannot be
redeemed on instance B**, so browser voice verification fails intermittently
today. The Redis migration covered sessions and idempotency and did not reach
this.

Phase 3 must fix it regardless of intent, because the phone ticket has the same
shape and a strictly worse exposure (webhook and media socket are always two
separate connections). Moving the service to Redis with `SET NX PX` + `GETDEL`
closes both at once, and `consume()` becomes `async`.

**Ruled 2026-08-25: in scope for Phase 3, and recorded as a pre-existing
Phase 2 multi-instance defect fix — not a phone feature.** It is tasked as
**D-2** in the defect track (see the implementation plan). One ticket primitive
serves both browser and phone; a second implementation is prohibited, and the
in-process cache is not reintroduced in any form, including as a read-through
optimisation.

Security properties preserved verbatim across the migration: CSPRNG opaque
ticket, single use, short TTL, server-side identity binding, atomic consume, no
PII encoded in the ticket, never logged, and fail closed on expiry, reuse,
unknown ticket, or Redis failure. The `newOpaqueId()` generator and
`TICKET_TTL_MS` are unchanged; only the backing store and the sync/async
boundary move.

### Deliberately left in-process

`WsOriginAdapter.recentByIp` is per-instance, so the per-IP connection cap is
effectively `N × 20` across `N` instances. Pre-existing, unchanged by this
phase, and irrelevant on the phone path (where it is skipped entirely).
Documented as a known limitation; **out of scope** unless you rule otherwise.

### Redis eviction is reduced, not eliminated

`docker-compose` runs Redis with `--maxmemory 256mb --maxmemory-policy
volatile-lru`. **Every voice key carries a TTL**, so every voice key is an
eviction candidate under memory pressure — `volatile-lru` behaves as
`allkeys-lru` here, and there is no protected class. Removing
`MAX_PENDING_TICKETS` therefore replaces a count bound with a memory bound; it
does not remove eviction.

That is acceptable, and the reasons are recorded rather than assumed:

- **The margin is large.** A ticket is ~100 bytes with a 60s TTL. The dominant
  consumer is `voice:session:` records carrying conversation history at a few
  KB each with a 30-minute TTL; 256 MB holds tens of thousands of concurrent
  sessions, orders of magnitude beyond a dental practice.
- **Eviction fails closed.** An evicted ticket resolves to nothing: the browser
  socket stays anonymous, the phone socket is closed. An evicted session ends
  the conversation with `session_expired`. Neither grants anything.
- **It is observable.** `used_memory` and `evicted_keys` become required
  operational metrics with an alert on any non-zero eviction rate, since under
  this policy a live conversation is as evictable as a spent ticket.

What must **not** happen is a count-based cap reappearing in front of Redis in
any form.

### Clock

Expiry is evaluated against `Date.now()` on whichever instance handles the turn,
compared to an absolute deadline stored in the session record. No coordination
is needed. The only shared assumption is NTP-level clock agreement, and a skew
of seconds is immaterial against a ten-minute deadline. Recorded because it is
the one thing that would break silently.

### Media streams are sticky by construction

One call is one socket on one instance. No cross-instance audio routing exists
or is needed. Only the *session record* and the *ticket* cross instances, and
both are in Redis.

### Idempotency untouched

No change to `IdempotencyService`, its keys, its TTLs, or its in-flight
coalescing. Verification expiry does not interact with it: a replayed write
returns the first call's cached result without re-entering the tier gate, which
is the existing and correct behaviour.

---

## 12. Rate limiting: why not `ThrottlerGuard`

The master design says OTP rate limiting reuses the existing `ThrottlerGuard`.
It cannot, for two independent reasons:

1. **The voice socket has no Nest handlers.** `voice-socket.gateway.ts:63`
   reads frames from a raw `socket.on('message')`; there is no
   `@SubscribeMessage`, so no guard in the pipeline ever runs for a voice
   frame. Same class of gap as `ValidationPipe` being HTTP-only, which Phase 1
   already found and documented.
2. **Tool calls are not requests.** A tool is invoked by the model inside a
   turn. There is no `ExecutionContext` and no IP for the throttler to track —
   true on the HTTP channel as well as the socket.

All OTP limiting is therefore Redis-backed inside the OTP service (§5).
`ThrottlerGuard` keeps its existing job on `POST /voice/text` and takes on the
Twilio webhook, both of which are real HTTP routes.

---

## 13. Files likely to change

### New

| File | Purpose |
|---|---|
| `session/verification.ts` | `isVerificationActive`, the authorization rule |
| `session/phone-verification.constants.ts` | OTP TTLs, caps, digits |
| `otp/otp.service.ts` | Redis state machine, Lua scripts, rate limits |
| `otp/otp.lua.ts` | `otp_request` / `otp_submit` scripts as constants |
| `otp/phone-lookup.service.ts` | caller ID → patient, fail-closed on ambiguity |
| `sms/sms-sender.interface.ts` | `SMS_SENDER` token + `SmsSender` |
| `sms/twilio-sms.sender.ts` | production implementation |
| `sms/logging-sms.sender.ts` | non-production implementation |
| `tools/request-verification-code.tool.ts` | Tier 1, empty input schema |
| `tools/submit-verification-code.tool.ts` | Tier 1, `{code}` |
| `transport/twilio-media-stream.transport.ts` | `AudioTransport` for phone |
| `transport/voice-phone-socket.gateway.ts` | `/voice/phone`, ticket-required |
| `transport/phone-limits.ts` | per-channel connection/turn limits |
| `voice-phone.config.ts` | `VOICE_PHONE_ENABLED` flag |
| `phone/twilio-webhook.controller.ts` | signed webhook → TwiML |
| `phone/twilio-signature.guard.ts` | signature validation |

### Modified

| File | Change |
|---|---|
| `session/voice-session.ts` | `verifiedUntil` field; `promoteToPhoneVerified` |
| `session/voice-session.store.ts` | normalize `undefined → null` on read |
| `session/privilege-change.ts` | snapshot effective verification |
| `session/voice-ticket.service.ts` | Redis-backed; `consume()` becomes async |
| `tools/tool-executor.service.ts` | tier gate calls `isVerificationActive` |
| `transport/frames.ts` | `verifiedUntil` added to `FORBIDDEN_KEYS` |
| `transport/ws-origin.adapter.ts` | path-branched `verifyClient` |
| `speech/speech-to-text.interface.ts` | factory takes `AudioFormat` |
| `speech/text-to-speech.interface.ts` | factory takes `AudioFormat` |
| `speech/deepgram-stt.service.ts` | format-driven encoding/sample rate |
| `speech/elevenlabs-tts.service.ts` | format-driven `output_format` |
| `transport/voice.gateway.ts` | pass channel format to the factories |
| `voice.module.ts` | wire OTP, SMS, phone transport, webhook |
| `.env.example`, `README`, CI workflow | new variables and secrets |

`agent/claude.agent.ts`, `tools/tool-registry.service.ts`, the ten existing
tools, and `idempotency/idempotency.service.ts` are **not** modified.

---

## 14. Test and mutation-test strategy

Every task lands with tests that fail before the implementation. The mutations
below are mandatory: each must be applied to production code, shown to turn a
named test red, and reverted — and the mutated region printed to confirm the
edit actually applied, per the discipline established in Phase 1.

### Authorization and expiry

| Mutation | Must break |
|---|---|
| `verifiedUntil > now` → `>= 0` | expired phone session reaches a Tier-2 tool |
| `verifiedUntil === null` → `true` | every session treated as non-expiring |
| tier gate reverted to `!session.identityVerified` | expired session authorized |
| `promoteToPhoneVerified` sets `verifiedUntil = null` | phone verification never expires |
| store's `undefined → null` normalization removed | legacy browser session loses access |
| `rotate()` recomputes `verifiedUntil` from now | expired verification resurrected by rotation |
| `snapshotPrivilege` reverted to the raw boolean | re-verification after expiry does not rotate |

Explicit state tests: anonymous; browser-verified (`null`); phone-verified live;
phone-verified expired; phone-verified expired then re-verified; each across a
rotation; each on a second API instance reading the same Redis.

### OTP

| Mutation | Must break |
|---|---|
| `otp_submit` compares plaintext instead of HMAC | code-hashing test |
| attempt `INCR` moved out of Lua into TypeScript | concurrent-guess cap test |
| lock check removed from `otp_submit` | locked session accepts a code |
| `DEL` of the challenge removed on success | single-use test |
| cooldown `SET NX` → `SET` | resend cooldown bypass |
| ambiguous-phone branch returns the first match | shared-number fail-closed test |
| zero-match branch returns a distinct error | enumeration-uniformity test |
| Redis failure path returns success | fail-closed test |

Plus: a log-hygiene test asserting the code, the phone number and their HMACs
never appear in any captured log line; a concurrency test firing
`OTP_MAX_ATTEMPTS + 3` simultaneous wrong guesses and asserting the cap holds
exactly.

### Transport

| Mutation | Must break |
|---|---|
| `/voice` branch skips the origin check | browser CSWSH test |
| `/voice/phone` accepts a connection with no ticket | phone ticket-required test |
| ticket redemption made non-single-use | replay test |
| `TwilioMediaStreamTransport.send` serializes frames to the socket | "no control frames to Twilio" test |
| webhook validates against `Host` instead of the configured URL | forged-host signature test |
| signature guard returns true on mismatch | forged-signature test |
| browser format changed to `mulaw_8000` | browser byte-identity test |

### Regression

The full suite (713 tests at the Phase 1 freeze, more since) stays green.
Browser voice behaviour must be provably unchanged: same Deepgram query string,
same ElevenLabs request, same frames, same limits, same anonymous-widget path.

---

## 15. Task breakdown

The full breakdown — per-task scope, files, tests, mandatory mutations, exit
criteria, and the defect/feature classification — lives in the companion
implementation plan, `2026-08-25-voice-agent-phase-3-plan.md`.

Summary of the two tracks:

- **Defect track (D-1 … D-3)** — pre-existing defects that Phase 3 correctness
  depends on. Each is a bug in shipped code, reachable today, independent of
  telephony.
- **Feature track (F-1 … F-7)** — net-new phone channel and OTP verification.

## 16. Acceptance criteria

1. An expired phone verification is refused by every Tier-2 tool, on an open
   socket, with no reconnection — proven by mutation.
2. A browser session verified by JWT has `verifiedUntil === null` and is
   unaffected by every change in this phase; its Deepgram and ElevenLabs
   requests are byte-identical to Phase 2.
3. `verifiedUntil` survives Redis serialization, retrieval, rotation and a read
   from a second API instance. An expired deadline is never resurrected by
   rotation.
4. Re-verification after expiry rotates the session id; expiry alone does not.
5. Caller ID alone never sets `identityVerified` — pinned by a test that binds
   caller ID and asserts a Tier-2 tool is still refused.
6. A phone number matching two or more patients yields no SMS and no
   verification.
7. `request_verification_code` returns an identical result for zero, one and
   many matches.
8. `OTP_MAX_ATTEMPTS + 3` concurrent wrong guesses lock the session after
   exactly `OTP_MAX_ATTEMPTS`.
9. A correct code can be consumed exactly once, including under concurrency.
10. All OTP limits hold when the same session is driven through two API
    instances against one Redis.
11. Redis unavailability fails verification closed.
12. No OTP code, phone number, or HMAC appears in any log line.
13. An unticketed, expired-ticket or replayed-ticket connection to
    `/voice/phone` is closed.
14. A webhook with an absent, forged, or wrong-URL signature is rejected `403`.
15. `VOICE_PHONE_ENABLED` unset ⇒ the phone channel is unreachable.
16. Twilio credentials appear in no frame, log, transcript, or client response.
17. Live verification (P3-9) confirms: SMS delivery, inbound call → media
    stream, μ-law transcript from Deepgram, and `ulaw_8000` playback from
    ElevenLabs.
18. Full suite, typecheck, lint and build green.

---

## 17. Explicitly out of scope

- **Barge-in / interruption detection** — the Twilio `clear` event is noted in
  §8 as the future mechanism; nothing listens for caller speech during playback.
- **Outbound calling** of any kind.
- **Voicemail, call recording, transcription persistence, analytics.**
- **Warm transfer to a human** — the agent offers it verbally; no transfer is
  implemented.
- **Multi-language** STT/TTS.
- **A normalized `phoneE164` column and backfill** (§6) — a schema migration
  touching every patient row, deferred to its own change.
- **`WsOriginAdapter.recentByIp` → Redis** (§11) — pre-existing, per-instance,
  skipped on the phone path.
- **DTMF input** — `dtmf` events are ignored; codes are spoken, not keyed.
- **Any change to the ten existing tools' behaviour**, to `ClaudeAgent`, to
  `ToolRegistry`, or to `IdempotencyService`.
- **The ElevenLabs default voice id correction** — frozen by prior ruling.
- **Changing `SESSION_TTL_MS`.**

---

## 18. Rulings applied

| Date | Question | Ruling |
|---|---|---|
| 2026-08-25 | Verification expiry representation | **Option A** — `verifiedUntil: number \| null` is authoritative session state. Not derived from a Redis side key. |
| 2026-08-25 | OTP rate limiting mechanism | **Redis-backed inside the OTP service.** `ThrottlerGuard` is not used for tool rate limiting. |
| 2026-08-25 | Shared patient phone numbers | **Fail closed.** Exactly one match is required; 0 or ≥2 refuse. No DOB disambiguation, no additional identity attribute in Phase 3. |
| 2026-08-25 | `VoiceTicketService` Redis migration | **In scope**, classified as a pre-existing Phase 2 defect fix. One shared ticket primitive; no in-process cache. |

No open items remain. The implementation plan is
`2026-08-25-voice-agent-phase-3-plan.md`.
