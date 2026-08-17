# ADR 0001 — Keep the serverless + Supabase stack

- **Status:** accepted; backend scope amended by [ADR 0006](0006-move-off-supabase-to-self-hosted-postgres.md) on 2026-08-16
- **Date:** 2026-08-16
- **Context:** first architecture review after the repository moved to `ventra-rocket`

## Context

The product is a booking and assessment system for a single offline English club in Ho Chi
Minh City: three static HTML pages, six Vercel serverless functions, Supabase Postgres and
Storage, PayOS for payment, OpenAI for assessment. There is no build step, no framework, no
tests, and — at the time of review — no documentation.

The obvious reaction to an 11,754-line `index.html` is to rewrite it in a framework.

## Decision

Keep the stack. Do not migrate to React, Next.js, or any framework, and do not introduce a
bundler as part of remediation work.

## Rationale

- The severe defects found in review are **not** caused by the stack. They are: the database
  schema and RPCs living outside version control, no Row Level Security, no scheduled
  execution, phone-only authentication, and no staging environment. A framework migration
  fixes none of them.
- Correctness-critical logic already sits in Postgres functions (`create_booking_order`,
  `confirm_payos_payment`, `reschedule_booking`). That is the right place for it, and it is
  unaffected by frontend choices.
- A rewrite would put a working payment path — verified HMAC webhook, server-side reconcile,
  server-computed pricing — at risk for no customer-visible gain.
- Team size and traffic (one venue, hundreds of students) do not justify the operational
  weight of a framework, a build pipeline, or additional services.

## Consequences

- Remediation is sequenced by risk (see `ARCHITECTURE-TARGET.md`), not by technology.
- `index.html` is split incrementally into plain ES modules, only where a seam pays for
  itself; the audio recorder duplicated between placement and progress tests is the first.
- ~~The 12-function Vercel budget stays a hard architectural constraint; new endpoints are
  actions on existing handlers, enforced by CI.~~ Superseded by ADR 0006: the API moves to a
  self-hosted Node process, so the ceiling disappears. The CI gate stays until the cutover
  completes.
- The trigger clause below fired on 2026-08-16 — not for a technical reason, but because the
  product owner requires the database on owned infrastructure. See ADR 0006. **The frontend
  half of this decision is unaffected: still no framework, still no bundler.**
- Revisit the frontend only on a concrete trigger: a native or offline client requirement, or a
  second venue with genuinely different scheduling rules.
