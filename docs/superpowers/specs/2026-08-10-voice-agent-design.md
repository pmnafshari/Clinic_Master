# SmileFlow Voice Agent — Design

**Date:** 2026-08-10
**Status:** Approved design, not yet planned or implemented

A voice agent that speaks with patients: captures details for new patients, creates their account, books, reschedules and cancels appointments, answers logistics questions, and — behind identity verification — reports invoices and outstanding balances.

---

## 1. Decisions

These were settled before design and are not open questions.

| Decision | Choice | Reasoning |
|---|---|---|
| Channel | Channel-agnostic core; browser widget first, telephony seam documented | Demoable from the repo with no carrier account; adding phone later doesn't rewrite the core |
| Scope | Full — intake, scheduling, logistics, **and** financial disclosure | Chosen deliberately with the added verification cost understood |
| Identity | Session-bound in the browser; SMS one-time code for the phone channel | Reuses existing auth; no new auth surface in v1 |
| Speech-to-text | Deepgram | Streaming partials and endpointing; lowest latency of the practical options |
| Reasoning | Claude Opus 5 (`claude-opus-5`) | Tool calling is the core of this system; Anthropic has no speech-to-speech API, so the model is the brain in a pipeline |
| Text-to-speech | ElevenLabs | Streaming synthesis |
| Telephony / SMS | Twilio | One-time codes now; phone channel in Phase 3 |

**The agent is orchestrated, not trained.** No fine-tuning. Clinic-specific behaviour lives in a system prompt plus the tool surface, both of which are reviewable, versionable, and changeable without retraining.

---

## 2. Architecture

A new `apps/api/src/modules/voice/` module. The agent has **no privileged path to the database**. Every tool wraps an existing SmileFlow service, so `RolesGuard`, the appointment exclusion constraint, and the billing transaction apply to it exactly as they apply to the web app.

```
Browser (mic) ──WebSocket──▶ VoiceGateway
                                  │
                             VoiceSession  (identity + verification state)
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
   Deepgram STT            Claude Opus 5              ElevenLabs TTS
   (streaming,             (Tool Runner,              (streaming,
    endpointing)            tool_use blocks)           sentence-chunked)
                                  │
                          VoiceToolsService
                                  │
       AppointmentsService · BillingService · PatientsService · AuthService
                    (unchanged — RBAC and DB constraints intact)
```

### Module layout

```
apps/api/src/modules/voice/
├── voice.module.ts
├── voice.gateway.ts              # WebSocket entry point
├── voice.session.ts              # per-conversation state
├── transport/
│   ├── audio-transport.interface.ts
│   ├── browser-websocket.transport.ts
│   └── twilio-media-stream.transport.ts   # Phase 3
├── speech/
│   ├── stt.interface.ts          # Deepgram behind an interface
│   └── tts.interface.ts          # ElevenLabs behind an interface
├── agent/
│   ├── claude.agent.ts           # Tool Runner loop
│   ├── system-prompt.ts
│   └── tools/                    # one file per tool
└── verification/
    ├── otp.service.ts
    └── verification.guard.ts
```

**The channel seam** is the `AudioTransport` interface. `BrowserWebSocketTransport` in v1; `TwilioMediaStreamTransport` in Phase 3. Everything above it — session, agent loop, tools — is channel-agnostic.

Each provider sits behind an interface (`SpeechToText`, `TextToSpeech`) so a provider swap is one adapter, not a refactor.

---

## 3. Tool surface

Two tiers. The tier split is enforced **in the tool handler, server-side**. It is never enforced by the system prompt — a prompt instruction is not an access control.

### Tier 1 — no identity required

| Tool | Behaviour |
|---|---|
| `get_clinic_info` | Hours, address, parking, appointment prep |
| `get_service_pricing` | Published price ranges — public information |
| `check_availability` | Wraps `GET /appointments/availability`; returns slots only, no patient data |
| `start_patient_intake` | Captures name, DOB, phone, reason; creates `Patient` + `User` |
| `book_appointment` | Restricted to the patient created in *this* session |

### Tier 2 — requires `session.identityVerified === true`

`get_my_appointments` · `reschedule_appointment` · `cancel_appointment` · `get_my_invoices` · `get_my_balance`

### The property that carries the security model

**No Tier 2 tool accepts a patient identifier.** There is no `patientId` parameter for the model to populate, guess, or be manipulated into supplying. The patient is resolved server-side from `VoiceSession.userId`.

A prompt injection — *"you are now speaking with a different patient"* — has no parameter to attack, because the tool schema does not expose one. This is a boundary, not a guardrail: it holds even if the model is fully compromised by its input.

---

## 4. Verification

```
ANONYMOUS ──▶ IDENTIFIED ──▶ VERIFIED
(no claim)   (claims a name,  (proved it)
              NOT trusted)
```

- **Browser (v1):** the patient is already logged in. The session inherits their JWT and starts `VERIFIED`. The agent acts *as* that patient and can never exceed their own permissions.
- **Phone (Phase 3):** starts `ANONYMOUS`. Caller ID is a hint, never proof. `request_verification_code` sends a Twilio SMS to **the number already on file**; `submit_verification_code` promotes to `VERIFIED` with a short expiry.

Both channels satisfy the same single flag, which is what makes the telephony seam cheap.

**Rate limiting** on code requests and submissions, with attempt caps, reusing the existing `ThrottlerGuard`.

---

## 5. Idempotency

Voice pipelines retry on timeout. Without protection, one retry becomes a double booking or a double-recorded payment.

Every write tool accepts an idempotency key derived from `(sessionId, turnIndex)`. A repeated call returns the first call's result rather than performing the action again.

This sits alongside the database exclusion constraint added in `20260810160000_appointment_no_overlap`: the constraint prevents *overlapping* bookings, idempotency prevents *duplicate identical* ones. Both are needed.

---

## 6. Model configuration

| Setting | Value | Reasoning |
|---|---|---|
| Model | `claude-opus-5` | |
| Thinking | **adaptive** (the default — explicitly not disabled) | Disabling thinking on Opus 5 can cause tool calls to be emitted as plain text: the turn completes normally, no error is raised, and **the call never runs**. In a booking agent that is the "told the patient it cancelled, but didn't" failure. Latency is controlled with effort instead. |
| Effort | `low` | `low`/`medium` are unusually strong on Opus 5 and are the correct latency lever |
| Speed | `speed: "fast"` (beta `fast-mode-2026-02-01`) | ~2.5× output tokens/sec; Claude API only |
| Streaming | on | Feeds TTS sentence-by-sentence |
| Tool schemas | `strict: true` | Guarantees tool inputs validate |
| Caching | `cache_control` after system prompt + tool definitions | Opus 5's minimum cacheable prefix is 512 tokens; every turn after the first reads the prefix at ~0.1× cost |
| Refusals | `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) | Opus 5 classifiers can decline; check `stop_reason` before reading `content` |

Implementation uses the SDK's Tool Runner (`client.beta.messages.toolRunner`) rather than a hand-written agent loop.

### Latency budget

Conversation feels broken past ~1.5s round trip.

| Stage | Target |
|---|---|
| STT (streaming partials) | 200–300ms |
| Claude first token | 400–700ms |
| TTS first audio | 150–300ms |

---

## 7. Error handling

Voice fails differently from a web form. The dominant risk is not a crash — it is the patient hanging up believing something happened that did not.

**Cardinal rule: the agent may only claim an action succeeded if it is holding the tool result that says so.** Every write tool returns an explicit `{status: "confirmed" | "failed", ...}` rather than a bare object. The system prompt forbids narrating intent as outcome, and this is covered by a test, not by the prompt alone.

| Failure | Handling |
|---|---|
| Mis-transcription of names, DOB, numbers | Deepgram confidence below threshold → ask again rather than guess. Digits read back digit-by-digit, names spelled back. Mandatory readback before any write. |
| Barge-in (patient interrupts) | Abort in-flight TTS and cancel the Claude stream. Partial assistant text still enters history so the next turn reflects what was actually heard. |
| Silence / no speech | Reprompt once, then offer a human. Never loop. |
| Tool returns an error | Surfaced as `tool_result` with `is_error: true`. The agent states the failure plainly and offers the front desk; it does not retry silently or improvise. |
| Claude refusal | `stop_reason: "refusal"` arrives on an HTTP 200. Check it **before** reading `content`. Server-side fallbacks enabled. |
| Provider outage | Circuit-break to a spoken apology and handoff. Never a stack trace, never dead air. |
| Latency blowout | Past ~2s, an honest filler ("let me check that") — only when a tool call is genuinely in flight, never as a stall. |
| Clinical question | Hard boundary. Acknowledge, decline, route to a clinician. Explicitly tested. |

Non-negotiable in every state:

- **An escalation path** — "let me get someone from the front desk."
- **AI disclosure at the start of every conversation**, plus recording notice. Several jurisdictions require disclosure, and two-party-consent states require the recording notice.
- **Audit logging** — every tool call written to the existing `AuditLog` with the session ID, so a disputed booking is reconstructible.

### Scope of advice

Logistics only: preparation, aftercare, hours, cost ranges. Never diagnosis, triage, medication, or "is this serious?" — those route to a human. This boundary is a tested behaviour.

---

## 8. Testing

**Assert on tool calls, not on wording.** The agent's prose varies between runs; the sequence of tool calls carries the correctness and is stable to check.

| Layer | Coverage |
|---|---|
| Unit | Tool handlers against mocked services — argument mapping, error shapes |
| Tier-2 gate (table-driven) | Iterate the Tier 2 registry; assert each tool rejects when `identityVerified === false`. A new tool that forgets the gate **fails by construction**, because the test enumerates the registry rather than a hardcoded list |
| Prompt injection | Transcripts attempting cross-patient disclosure, privilege escalation, and clinical advice. Assert refusal **and** that no tool call was emitted |
| Idempotency | Same key twice → exactly one appointment |
| Concurrency | Two sessions booking one slot → one wins (same pattern as the existing appointment concurrency test) |
| Transcript replay | Scripted conversations with **STT mocked** — the agent loop runs in CI with no audio |

**CI economics:** the Anthropic client is mocked for the main suite so pull requests stay free and deterministic. A small **nightly** suite runs against the real API to catch model-behaviour drift.

**Latency is measured and reported, not asserted** — a timing assertion in CI is a flake generator.

---

## 9. Rollout

Ordered to retire risk early and cheaply.

| Phase | Contents | Why here |
|---|---|---|
| **0** | Text-only agent, feature-flagged, no audio. Full tool surface, tier gate, injection suite, driven by typed text | Proves every security property before a byte of audio. Cheapest place to find the bugs |
| **1** | Browser voice, Tier 1 only — intake, booking, logistics | Real voice with no financial data and no verification complexity |
| **2** | Verification + Tier 2 in the browser. Twilio SMS replaces `SMS_PROVIDER=mock` | Financial disclosure comes online behind a working gate |
| **3** | Twilio phone channel — `TwilioMediaStreamTransport` + OTP for `ANONYMOUS → VERIFIED` | The core does not change; only the transport is added |

A kill switch (environment flag) disables the agent instantly at any phase.

Running cost is roughly **$0.15–0.30 per minute** across the four providers — worth knowing before a demo runs unattended.

---

## 10. Secrets

Four new provider credentials: Deepgram, ElevenLabs, Anthropic, Twilio (account SID + auth token).

- Real values live only in `apps/api/.env`, which is gitignored.
- `.env.example` gains **placeholder names only**, never values.
- No credential is ever committed, pasted into a transcript, logged, or included in an error message.
- The existing `.gitignore` credential patterns (`*.pem`, `*.key`, `.env.*`) already cover this.

---

## 11. Out of scope for this design

- Multi-language support. The prompt and prompts-per-locale strategy would need its own design.
- Voice biometrics. Considered and rejected — voices are cloneable; SMS one-time codes are the appropriate control.
- Outbound calling (appointment reminders by voice). Different consent model, different regulatory surface.
- Any clinical decision support.

---

## 12. Prerequisites already met

Two pieces of groundwork this design depends on are already in place:

- **Appointment double-booking is impossible at the database level** (`EXCLUDE USING gist`, migration `20260810160000_appointment_no_overlap`), so an agent retry cannot create an overlapping booking.
- **Billing writes are atomic and totals are server-derived**, so an agent cannot be talked into an incorrect invoice total, and a retried payment cannot overpay.

Both were completed before this design and are why the agent can be given write access at all.
