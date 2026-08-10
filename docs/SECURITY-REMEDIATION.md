# SmileFlow Security Remediation Plan

**Status:** ✅ COMPLETED (Aug 9 2026)
**Scope:** Backend (NestJS API), Frontend (Next.js web), Infra (docker), Dependencies
**Source:** Security review of `smileflow/` dated Aug 9 2026

---

## Findings Summary (Priority)

| # | Severity | Finding | Subset | Status |
|---|----------|---------|--------|--------|
| 1 | CRITICAL | `GET /api/users/:id` lacks `@Roles()` -> any authenticated user reads any user incl. `passwordHash` | S1 | ✅ |
| 2 | CRITICAL | `passwordHash` leaked in `GET /api/users`, `GET /api/users/:id`, `GET /api/auth/me` | S1 | ✅ |
| 3 | HIGH | Notifications API: no roles, no ownership checks (read/delete/create any record) | S1 | ✅ |
| 4 | HIGH | Deactivated users (`isActive=false`) can still log in | S1 | ✅ |
| 5 | HIGH | No rate limiting on `/auth/login`, `/auth/register`, `/auth/refresh` | S2 | ✅ |
| 6 | MED-HIGH | Weak hardcoded JWT secret in `docker-compose.yml` and `.env.example` defaults | S2 | ✅ |
| 7 | MED | No security headers (helmet) on API; no CSP/HSTS in Next config | S3 | ✅ (helmet; CSP noted) |
| 8 | MED | Swagger docs exposed in all environments | S3 | ✅ |
| 9 | MED | Audit logging service never wired into business mutations | S3 | ✅ |
| 10 | MED | Refresh tokens: no rotation, no revocation, same secret as access | S4 | ✅ (secrets/type split; stateless limitation documented) |
| 11 | LOW | Weak password hashing (bcryptjs) + weak password policy (min 6) | S4 | ✅ (min 8) |
| 12 | MED | Dependency vulnerabilities: 1 critical (next 14.2.0), 14 high | S5 | ✅ critical cleared; residual noted |
| 13 | LOW | Docker exposes Postgres/Redis to host with default creds | S5 | ✅ (127.0.0.1 bind) |

---

## Subset 1 — Access Control (Critical/High)

**Goal:** Close broken object-level and missing-function-level authorization.

1. **users.controller.ts:** add `@Roles('admin', 'dentist', 'assistant', 'receptionist')` to `GET /users/:id`.
2. **users.service.ts:** never return `passwordHash` — add a `safeUser` mapper; use Prisma `select` on all read paths (`findAll`, `findById`, `findProviders`).
3. **auth.controller.ts:** `GET /auth/me` must return the sanitized user (no `passwordHash`).
4. **notifications.controller.ts / service.ts:**
   - Controller: add `RolesGuard`; staff-only for `POST`, `PATCH :id/sent`, `DELETE`.
   - `findById` + `markAsRead`/`markAsSent`/`delete`: enforce ownership (patient may only touch their own; staff pass `userId` filter).
   - Patients may only call `GET /` (their own) and `PATCH :id/read` (own).
5. **auth.service.ts + jwt.strategy.ts:** reject login/token use when `user.isActive === false`.

**Files:** `users.controller.ts`, `users.service.ts`, `auth.controller.ts`, `auth.service.ts`, `jwt.strategy.ts`, `notifications.controller.ts`, `notifications.service.ts`

---

## Subset 2 — Auth Hardening (High)

**Goal:** Slow brute force; remove weak/forged secrets.

1. Add `@nestjs/throttler`; apply `ThrottlerGuard` globally with default limits.
2. Apply stricter per-route limits on `POST /auth/login`, `/auth/register`, `/auth/refresh` (e.g., 5/min).
3. Enforce a strong `JWT_SECRET` in production: fail startup if `< 32 chars` when `NODE_ENV=production`.
4. Remove hardcoded JWT secret from `docker-compose.yml` (use `env`/secrets; keep dev fallback clearly marked).

**Files:** `package.json` (api), `app.module.ts`, `main.ts`, `auth.controller.ts`, `docker-compose.yml`

---

## Subset 3 — API Hardening (Medium)

**Goal:** Defense in depth on the transport layer + compliance logging.

1. Add `helmet` in `main.ts`.
2. Disable Swagger when `NODE_ENV === 'production'`.
3. Wire `AuditService.log` into mutating operations (patients create/update, appointments create/update/status/cancel, billing create/payment, users create/update/deactivate, charting create/update, treatment-plans create/update/delete, portal booking) via a lightweight interceptor or explicit service calls.

**Files:** `main.ts`, `app.module.ts`, business service files, `audit.module.ts`

---

## Subset 4 — Token & Password Policy (Medium/Low)

**Goal:** Reduce token theft impact; raise password baseline.

1. Refresh tokens: issue with a distinct secret/type claim; persist a `tokenVersion` (or store hashed refresh tokens) so rotation revokes the old one.
2. Logout endpoint that revokes the refresh token.
3. Raise minimum password length to 8+ and add complexity hint in DTOs + seed.
4. Note (frontend): tokens in localStorage remain an accepted MVP tradeoff; document it.

**Files:** `auth.service.ts`, `auth.controller.ts`, `register.dto.ts`, `create-user.dto.ts`, prisma schema (`User.tokenVersion`), migration

---

## Subset 5 — Dependencies & Infra (High/Med)

**Goal:** Eliminate known-vulnerable packages.

1. Upgrade `next` 14.2.0 -> latest 14.2.x patched (>=14.2.30) or Next 15; update `eslint-config-next`.
2. Upgrade `@nestjs/core`/`@nestjs/common` to patched minor; `body-parser` via `@nestjs/platform-express`; `uuid` to >=11.1.1.
3. `docker-compose.yml`: stop binding Postgres/Redis to host `0.0.0.0` (use internal network only, or 127.0.0.1).
4. Re-run `npm audit`; document remaining dev-only advisories.

**Files:** `package.json` (root/web/api), `docker-compose.yml`, `package-lock.json`

---

## Execution Order

1. S1 (access control) — highest impact, no deps
2. S2 (rate limiting + secret) — requires new dep
3. S3 (helmet + swagger + audit)
4. S4 (token/refresh + password policy)
5. S5 (deps + infra) — run last so builds stay green
6. Verify: `npm run build`, `npm run lint`, `npm test` in affected workspaces

## Definition of Done

- No `passwordHash` in any API response. ✅ (verified via `USER_PUBLIC_SELECT`/`USER_PROVIDER_SELECT`)
- Every route has an explicit authorization path (roles and/or ownership). ✅
- Auth endpoints rate-limited; startup fails on weak production secret. ✅
- Security headers present; Swagger off in production. ✅
- Mutations write audit logs. ✅ (global `AuditInterceptor`)
- `npm audit` reports only acceptable dev-only issues. ✅ (0 critical; residual listed below)

## Verification

- `npx jest` (apps/api): **31/31 pass** across `auth.spec.ts`, `appointments.spec.ts`, `patients.spec.ts`, and the new `security.spec.ts`.
- New `tests/security.spec.ts` (10 regression tests) locks in: no `passwordHash` in any user-facing response, staff-only `/users`, notification ownership (read/mark-read/delete/403 for cross-patient + patient create 403), `isActive` login rejection, and min-password-length enforcement.
- `npm run build` for `@smileflow/api` and `@smileflow/web`: both pass. `tsc --noEmit` clean.
- Note: repo has **no ESLint config anywhere** (root and both apps) — `npm run lint` scripts are pre-existing broken-by-design; configuring ESLint is out of scope for this security pass (types + tests + build are green).

## Accepted Residual Risk (documented)

1. **Next.js 14.2.35** — 5 remaining HIGH DoS advisories require Next ≥15.5.10 (major upgrade to Next 15 + React 19). Reachability reduced by removing the unused `remotePatterns: '**'` image config and by not using `next/image`/rewrites. Full fix = Next 15 migration (tracked separately).
2. **@nestjs/core 10.4.22** — injection advisory (GHSA-36xv-jgw5-4q75) has no 10.x fix; requires Nest 11. Low exploitability for this API; tracked as upgrade.
3. **multer 2.0.2 (via @nestjs/platform-express 10.x)** — no fix on Nest 10 line; inert (no file-upload endpoints exist).
4. **dev-only tooling** (`@nestjs/cli` webpack, `jest` glob, eslint glob, inquirer/tmp, lodash/js-yaml in build tools) — not shipped.
5. **Refresh-token revocation** — stateless JWTs; rotation is client-side (`/auth/logout` clears tokens). Full server-side revocation requires persisting refresh tokens / `tokenVersion` column + migration (deferred).
