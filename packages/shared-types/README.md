# @smileflow/shared-types

TypeScript contracts for the SmileFlow HTTP API, imported by both `apps/api` and `apps/web`.

These describe the **wire format** — the shape of JSON as it crosses the network — not the database schema. That distinction matters in two places:

- **Dates are `string`**, not `Date`. `JSON.stringify` turns a `Date` into an ISO 8601 string, and nothing on the client turns it back. Typing these as `Date` produced runtime bugs where `.toLocaleDateString()` was called on a string.
- **Money is `number`**. The database stores `Decimal` for exactness, and the API serialises it. Client code should format these for display and never use them for arithmetic that gets written back.

For the database-side shapes, use the types Prisma generates from `apps/api/prisma/schema.prisma`.
