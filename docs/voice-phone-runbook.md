# Voice phone channel — operator runbook

Everything an operator needs to turn the phone channel on, keep it running, and
understand what it does when a dependency fails.

The channel is **default-deny**. With `VOICE_PHONE_ENABLED` unset, the webhook
answers every inbound call with a TwiML `<Reject/>`, no media stream is opened,
and no ticket is minted. Absent is not consent.

---

## 1. Enabling the channel

### Twilio setup (outside the codebase)

1. A **voice-capable phone number** on the account.
2. That number's **A Call Comes In** webhook set to
   `POST https://<host>/voice/phone/incoming`.
3. The same URL in `TWILIO_VOICE_WEBHOOK_URL`, **exactly**.
4. **Messaging enabled** on the number, for one-time code delivery.
5. **Geographic permissions** allowing the destination country for SMS.

> Step 3 is the one that bites. Twilio computes its request signature over the
> URL it actually called, and the application validates against the configured
> value rather than the request's own `Host` header — behind a proxy that header
> is attacker-influenced, and a signature whose input an attacker chooses is not
> a signature. A mismatch of scheme, host, or path fails **every** request with a
> 403 that looks exactly like an attack.

### Application configuration

| Variable | Purpose |
|---|---|
| `VOICE_PHONE_ENABLED` | `true` and nothing else enables the channel |
| `TWILIO_ACCOUNT_SID` | REST client and signature validation |
| `TWILIO_AUTH_TOKEN` | REST client and signature validation |
| `TWILIO_PHONE_NUMBER` | the number codes are sent from |
| `TWILIO_VOICE_WEBHOOK_URL` | the URL signatures are validated against |
| `OTP_HMAC_SECRET` | hashes codes at rest and phone numbers in key names |
| `SMS_PROVIDER` | `twilio` to deliver; `logging` (or unset) to send nothing |

All are **server-side only**. None has a `NEXT_PUBLIC_` variant, and none may
acquire one: a browser-readable Twilio credential is a credential an attacker
can bill.

`SMS_PROVIDER` is matched by exact name. Only `twilio` reaches the real
provider — no trimming, no case folding, no prefix matching, because each of
those turns a typo into live message delivery. Any unrecognised value fails
closed rather than falling back.

### Local development

The phone channel cannot be exercised from a laptop without a publicly
reachable HTTPS URL, because Twilio has to reach the webhook. Use a tunnel and
set `TWILIO_VOICE_WEBHOOK_URL` to the tunnel URL exactly. Tunnel URLs change on
restart unless reserved, and a changed URL breaks signature validation on the
next call.

---

## 2. Rotating `OTP_HMAC_SECRET`

Generate with `openssl rand -hex 32`.

Rotating invalidates every **outstanding** one-time code, because a stored code
is an HMAC under the old key and no longer matches anything computed under the
new one. Nothing is corrupted and no session is logged out; callers mid-verification
are told the code did not match and can request another.

Codes live for five minutes, so the window of affected callers is small. Rotate
during a quiet period if that matters, and expect a brief rise in re-requests.

**There is no fallback key.** With the variable absent, code issuing and
verification both refuse rather than hashing under a default — a predictable key
would make stored codes forgeable by anyone who read the source.

---

## 3. What happens when Redis is down

Redis holds voice sessions, idempotency records, auth tickets, and all OTP
state. When it is unreachable the channel degrades in one direction only:
**everything that grants access fails closed.**

| | Behaviour |
|---|---|
| Inbound call | Answered, but declined with `<Reject/>` — no ticket can be minted, so there is nothing safe to point a media stream at |
| Live call already connected | Continues; the next turn fails when its session cannot be loaded |
| Requesting a code | Refuses. No SMS is sent, because the rate limit could not be claimed |
| Submitting a code | Refuses. The session stays unverified |
| Tier-1 tools (hours, pricing, availability) | Unaffected while the session is loadable |
| Tier-2 tools (appointments, invoices, balance) | Refused, because verification cannot be established |

There is deliberately **no degraded mode** in which a code verifies while its
rate limiting is unavailable, and no in-process cache in front of Redis.

---

## 4. Metrics and alerting

### Redis memory — required

Redis runs with `--maxmemory 256mb --maxmemory-policy volatile-lru`. **Every
voice key carries a TTL**, so under that policy every voice key is an eviction
candidate: `volatile-lru` behaves as `allkeys-lru` here and there is no
protected class.

Monitor and alert:

| Metric | Alert |
|---|---|
| `evicted_keys` | **any non-zero rate** |
| `used_memory` | sustained approach to `maxmemory` |

A non-zero eviction rate is not a capacity nicety. A live conversation is as
evictable as a spent ticket, so evictions mean callers are being dropped
mid-call and verified sessions are silently losing their verification. The
margin is normally large — a ticket is ~100 bytes against a budget dominated by
multi-KB session records — so any eviction at all means something is wrong.

Read them with `redis-cli INFO stats` and `redis-cli INFO memory`.

### OTP metrics — not implemented

**There are no OTP-specific metrics counters.** No request rate, no failure
rate, no lockout counter, no eligibility counter. This is stated plainly rather
than left to be discovered: an operator looking for them will not find them, and
should not infer that a flat line means nothing is happening.

What exists instead is the application log, which deliberately carries very
little: no code, no phone number, no HMAC of either, no ticket, no CallSid, and
no Twilio credential or signature. `logId` is the only session identifier that
may appear in a log line.

Building OTP telemetry is future work and is not part of this phase.

---

## 5. Security properties worth knowing before you operate it

- **Caller ID is a hint, never proof.** It is spoofable, and on its own it
  grants nothing. Only a correct one-time code verifies a caller.
- **A phone number must match exactly one patient.** Zero matches and two or
  more matches are both refused, identically — a caller cannot tell which
  happened, because that difference is information about real people.
- **Phone verification expires.** A code buys a bounded window, not the life of
  the call. When it lapses, the next Tier-2 request is refused on the same open
  connection with no reconnection involved, and the caller is asked to verify
  again.
- **The media socket requires a ticket.** Twilio does not sign the WebSocket
  handshake, so the single-use ticket minted by the signed webhook is the only
  thing separating a real call from someone who found the URL. There is no
  anonymous phone mode.
