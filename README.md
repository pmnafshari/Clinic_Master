# SmileFlow — Dental Clinic Management Platform

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
| `npm run db:seed` | Load demo data |

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
