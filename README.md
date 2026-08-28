# SmileFlow — Dental Clinic Management Platform

[![CI](https://github.com/pmnafshari/Clinic_Master/actions/workflows/ci.yml/badge.svg)](https://github.com/pmnafshari/Clinic_Master/actions/workflows/ci.yml)

A full-stack web application for running a small to mid-size dental clinic: appointment booking, patient records, dental charting, treatment planning, billing, and a patient-facing portal — in one system.

Built as a production-style MVP with Next.js, NestJS, PostgreSQL, and Prisma in a Turborepo monorepo.

## What it does

The platform covers the full patient journey, replacing phone-based scheduling, paper clinical notes, and spreadsheet billing.

| Module | Capability |
|--------|-----------|
| **Patients** | Registration, profiles, medical and dental history, document references |
| **Appointments** | Calendar booking, provider availability, double-booking prevention, status lifecycle |
| **Charting** | Interactive odontogram with per-tooth conditions (cavity, filling, crown, root canal, extraction, missing) and clinical notes |
| **Treatment plans** | Multi-item plans built from clinical charts, with costs, priorities, and progress tracking |
| **Billing** | Invoices generated from treatment plans, line items, payments (cash / card / insurance), balance tracking |
| **Patient portal** | Self-service booking, appointment history, invoices, treatment summaries, profile management |
| **Reporting** | Revenue, appointment volume, and treatment breakdowns with CSV export |
| **Audit log** | User-attributed change tracking across business mutations |

Access is governed by role-based permissions across five roles: **admin**, **dentist**, **assistant**, **receptionist**, and **patient**.


## Voice agent

A caller can ask about the clinic and book an appointment by speaking to an automated
assistant. It is off by default and has to be switched on deliberately.

### What it can and cannot do

The agent runs at one of two tiers, and only the first is reachable today.

| Tier | Reachable | Tools |
|---|---|---|
| **Tier 1 — anonymous** | yes | clinic info, service pricing, availability, patient intake, book appointment |
| **Tier 2 — verified** | **no** | own appointments, invoices, balance, reschedule, cancel |

Tier 2 needs identity verification, which does not exist yet. Every verified-tier tool
returns `verification_required`, and a test boots the real module and proves it for each
one. Nothing in the codebase can set `identityVerified`.

### Running it locally

```bash
cp .env.example .env          # then fill in the keys below
docker compose -f docker/docker-compose.yml up -d
npm run db:migrate && npm run db:seed
npm run dev
```

Then set, in `.env`:

```
VOICE_AGENT_ENABLED=true
VOICE_BROWSER_ENABLED=true
NEXT_PUBLIC_VOICE_BROWSER_ENABLED=true
ANTHROPIC_API_KEY=...
DEEPGRAM_API_KEY=...        # speech to text
ELEVENLABS_API_KEY=...      # text to speech
```

Open <http://localhost:3000/voice>.

**Without the speech keys it still works**, degraded: the recogniser reports
`stt_unavailable` and replies arrive as text rather than audio. That is a deliberate
fallback, not a failure — the turn still completes. The Phase 0 text endpoint,
`POST /api/voice/text`, needs only `ANTHROPIC_API_KEY`.

### Feature flags

| Flag | Default | Effect |
|---|---|---|
| `VOICE_AGENT_ENABLED` | `false` | The text endpoint returns 404 when off |
| `VOICE_BROWSER_ENABLED` | `false` | The `/voice` socket closes immediately when off, issuing no session |
| `NEXT_PUBLIC_VOICE_BROWSER_ENABLED` | `false` | The public page renders no widget when off |
| `VOICE_PHONE_ENABLED` | `false` | The Twilio webhook answers every call with `<Reject/>` when off, minting no ticket and opening no media stream |

All four are **default-deny**: absent reads the same as false, and only the exact
string `true` enables anything.

### Security notes

- **`sessionId` is a bearer credential.** It is server-issued, 256 bits of CSPRNG, never
  chosen by a client, and never written to a log, metric, error or database row. The
  non-secret `logId` is the only session identifier in observability output.
- **It rotates on privilege change.** When intake binds a patient to a session, a fresh
  id is issued and the old one is destroyed immediately — not left to expire. Idempotency
  keys derive from a separate nonce, so a retry spanning a rotation still de-duplicates.
- **An unknown session id is not an error.** It quietly starts a fresh conversation, so
  the endpoint cannot be used to ask "does this session exist?" one guess at a time.
- **One live socket per session.** A second connection presenting the same id is rejected;
  the first is left untouched, so a stolen id cannot kick the real caller off.
- **Provider credentials stay server-side.** They are never sent to the browser, embedded
  in a page, or minted into client tokens. The browser talks only to our socket.
- **The browser never sees a provider error.** Every client-facing failure is one of eight
  enumerated codes with no provider text, host, port or stack. Real errors are logged
  server-side against `logId`.
- **The transport cannot reach a tool.** Every tool call goes through `ToolExecutorService`,
  which makes the tier decision and writes the audit row — including for blocked calls.

### Shared state and required Redis configuration

Voice session and idempotency state lives in **Redis**, so any instance can serve any
caller's next turn. `APP_INSTANCES` and the single-process startup warning no longer
describe a limitation — they remain only as a reminder to point every instance at the
same Redis.

**Production Redis must be configured with a memory ceiling and an eviction policy.**
This is not optional and `docker-compose.yml` does not provide it outside local
development:

```
maxmemory        <sized for your deployment, e.g. 256mb>
maxmemory-policy volatile-lru
```

*Why a TTL alone is not enough.* Every key carries one — 30 minutes for a session, 15 for
an idempotency result — but a TTL bounds how long a key lives, not how many exist at once.
Session keys are created from caller traffic, so a burst can accumulate faster than the TTL
retires them. The in-process stores used to cap this by entry count; Redis has no such cap,
so the ceiling has to come from configuration.

*Why `volatile-lru` and not `allkeys-lru`.* Every key this application writes has a TTL, so
the two behave identically today. `volatile-lru` additionally guarantees that a key written
later **without** a TTL cannot be silently evicted.

*Why not the default `noeviction`.* A full Redis then starts refusing writes, which takes
voice down across every instance at once. Evicting the oldest expiring key degrades one
conversation instead.

*What eviction costs.* Losing a session key ends that conversation; the caller reconnects
and starts a new one. Losing an idempotency key allows a booking to be retried — the
database is still the backstop there, with `Serializable` transactions and the exclusion
constraint that prevents provider double-booking.

### External provider verification — outstanding

Speech providers are exercised in tests through fakes and through a directly-tested wire
format. **Neither has been verified against the live service.** Before a staging or
production deployment, confirm with real credentials:

- **Deepgram** — WebSocket handshake, `Authorization: Token` header, streaming audio in,
  `CloseStream` on end, and a real utterance producing a transcript.
- **ElevenLabs** — endpoint path, `xi-api-key` header, request body shape, streaming
  response, cancellation mid-stream, and the single retry.

Unit and contract coverage is not a substitute for either.

### Phone channel

Patients can call the clinic. An inbound call reaches a signed Twilio webhook, which
mints a single-use ticket and returns TwiML pointing Twilio at a media-stream socket;
audio runs μ-law 8 kHz in both directions with no transcoding anywhere.

A phone caller starts anonymous. Caller ID is a hint and never proof, so reaching
anything patient-specific means proving control of the number already on file: a
one-time code is texted there, and submitting it correctly verifies the session **for
a bounded window** rather than for the life of the call. When that window lapses the
next Tier-2 request is refused on the same open connection.

The number must match **exactly one** patient. Zero matches and several matches are
refused identically, so a caller cannot learn which happened.

**Operating it — enabling the channel, rotating `OTP_HMAC_SECRET`, what fails when
Redis is down, and which metrics exist — is documented in
[docs/voice-phone-runbook.md](docs/voice-phone-runbook.md).**

Phone verification requires patient phone numbers stored in E.164. The match is exact
string equality, deliberately: a fuzzy authentication check is not a lesser version of
authentication. Records held in other formats cannot be matched, and migrating them is
separate, planned work.

### Not in this phase

Barge-in (the `cancel()` contract exists and is used for teardown only) · voicemail ·
call recording · conversation persistence · analytics · outbound calling · warm
transfer to a human · multi-language.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS, TanStack Query, Radix UI |
| Backend | NestJS, Prisma ORM, Passport JWT, Helmet, Throttler |
| Database | PostgreSQL 16, Redis 7 |
| Monorepo | Turborepo with npm workspaces |
| Testing | Jest, Supertest (API integration), Testing Library (components) |
| CI | GitHub Actions — lint, test, build |

## Project structure

```
.
├── apps/
│   ├── web/                # Next.js frontend
│   │   └── src/
│   │       ├── app/        # App Router — (auth), (staff), (portal) route groups
│   │       ├── components/ # UI primitives and layout
│   │       ├── hooks/      # TanStack Query data hooks
│   │       └── lib/        # API client, auth context, utilities
│   └── api/                # NestJS backend
│       ├── prisma/         # Schema, migrations, seed script
│       └── src/
│           ├── common/     # Guards, decorators, filters, interceptors
│           └── modules/    # auth, users, patients, appointments, charting,
│                           # treatment-plans, billing, portal, reporting,
│                           # notifications, audit
├── packages/
│   ├── shared-types/       # TypeScript contracts shared by web and api
│   └── config/             # Shared configuration and env parsing
├── docker/                 # Docker Compose — PostgreSQL, Redis, api, web
├── docs/                   # Planning, architecture, and security documentation
└── turbo.json              # Turborepo pipeline
```

## Getting started

### Prerequisites

- Node.js 18 or later
- Docker and Docker Compose
- npm 10 or later

### Setup

```bash
# 1. Clone and install
git clone https://github.com/pmnafshari/Clinic_Master.git
cd Clinic_Master
npm install

# 2. Create environment files from the template
cp .env.example apps/api/.env
echo "NEXT_PUBLIC_API_URL=http://localhost:3001/api" > apps/web/.env.local

# 3. Start PostgreSQL and Redis
npm run db:up

# 4. Apply migrations and generate the Prisma client
npm run db:migrate
npm run db:generate

# 5. Seed demo data
npm run db:seed

# 6. Start both apps
npm run dev
```

### URLs

| Service | Address |
|---------|---------|
| Frontend | http://localhost:3000 |
| API | http://localhost:3001/api |
| Swagger docs | http://localhost:3001/api/docs *(development only)* |

### Demo accounts

Created by the seed script. These are local demo credentials for a throwaway database — they are not valid anywhere else.

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@smileflow.com | password123 |
| Dentist | dentist@smileflow.com | password123 |
| Receptionist | receptionist@smileflow.com | password123 |

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start web and api in watch mode |
| `npm run build` | Build all apps and packages |
| `npm run lint` | Lint the workspace |
| `npm run test` | Run all test suites |
| `npm run format` | Format with Prettier |
| `npm run db:up` | Start PostgreSQL and Redis containers |
| `npm run db:down` | Stop the containers |
| `npm run db:migrate` | Apply Prisma migrations |
| `npm run db:generate` | Regenerate the Prisma client |
| `npm run db:seed` | Load demo data (safe to re-run) |

Run a single workspace directly with `npm run test --workspace=@smileflow/api`.

## API overview

Full interactive documentation is served by Swagger at `/api/docs` in development.

| Module | Endpoints |
|--------|-----------|
| Auth | `POST /auth/login`, `POST /auth/register`, `POST /auth/refresh`, `GET /auth/me` |
| Users | `GET/POST/PATCH/DELETE /users` |
| Patients | `GET/POST/PATCH/DELETE /patients` |
| Appointments | `GET/POST/PATCH/DELETE /appointments`, `PATCH /appointments/:id/status` |
| Charting | `GET/POST /charting/:patientId` |
| Treatment plans | `GET/POST/PATCH/DELETE /treatment-plans` |
| Billing | `GET /invoices`, `GET /invoices/:id`, `POST /invoices/:id/payments` |
| Portal | `GET/POST /portal/*` |
| Reporting | `GET /reports/*` |

## Data model

PostgreSQL via Prisma. Core entities:

- **User** — system accounts and roles
- **Patient** — patient profiles and history
- **Appointment** — scheduled visits with provider and status
- **ClinicalChart** / **ChartToothEntry** — charting sessions and per-tooth records
- **TreatmentPlan** / **TreatmentPlanItem** — planned procedures with costs
- **Invoice** / **Payment** — billing and settlement
- **Notification** — patient and staff messaging records
- **AuditLog** — attributed change history

## Security

The codebase went through a dedicated security review and remediation pass; findings and fixes are documented in [docs/SECURITY-REMEDIATION.md](docs/SECURITY-REMEDIATION.md). Controls in place include role and ownership checks on every protected route, sanitized user responses that never expose password hashes, rate limiting on authentication endpoints, Helmet security headers, audit logging on business mutations, and Swagger restricted to development.

**Before deploying anywhere real:**

- Replace `JWT_SECRET` and `JWT_REFRESH_SECRET` with strong random values. The defaults in `.env.example` and `docker/docker-compose.yml` are development placeholders and are intentionally obvious.
- Replace the default `postgres:postgres` database credentials.
- Never commit `.env` files. Only `.env.example` is tracked, and `.gitignore` is configured to keep it that way.

## Data integrity

Two guarantees are enforced by Postgres rather than by application code, so they hold even if a caller bypasses the service layer:

- **No double-booking.** An `EXCLUDE USING gist` constraint on `Appointment` makes overlapping non-cancelled appointments for the same provider impossible. Ranges are half-open, so a 09:30 appointment may follow one ending at 09:30. The service also runs its conflict check and insert in a single serializable transaction, so the common case returns a clean `409` rather than a raw constraint error.
- **Valid status values.** `CHECK` constraints pin `status` and `method` columns to the value sets declared in `@smileflow/shared-types`.

Both live in hand-written migrations that Prisma cannot regenerate from `schema.prisma` alone — always run `db:migrate` rather than pushing the schema.

Money is handled with `Decimal` end to end. Invoice totals are derived from line items on the server, and payments are recorded at `Serializable` isolation so concurrent payments cannot overpay an invoice.

## Known gaps

Tracked deliberately rather than left unsaid. These are the next things I would address:

- **Rendering strategy.** Every page is a client component. Read-heavy routes (patient list, reports) should fetch on the server; this is the main refactor outstanding.
- **Token storage.** Access and refresh tokens live in `localStorage`, which is readable by any injected script. `httpOnly` cookies are the correct home for them in an application holding patient records.
- **Pagination.** Implemented for patients; invoices and appointments still return the full table.
- **Timezones.** Provider availability assumes the server's local timezone and a fixed 08:00–18:00 day.
- **Accessibility.** Radix primitives supply keyboard and focus behaviour, but the app has had no dedicated a11y pass.
- **Type-safety debt.** 31 `no-explicit-any` warnings in the API, surfaced by lint rather than suppressed.

## Documentation

| Document | Contents |
|----------|----------|
| [docs/project-description.md](docs/project-description.md) | Product definition, target users, business goals |
| [docs/architecture.md](docs/architecture.md) | Architecture style, layers, module boundaries |
| [docs/phases.md](docs/phases.md) | Delivery phases from discovery through release |
| [docs/PLAN.md](docs/PLAN.md) | Folder structure and implementation plan |
| [docs/SECURITY-REMEDIATION.md](docs/SECURITY-REMEDIATION.md) | Security findings and remediation record |

## License

MIT
