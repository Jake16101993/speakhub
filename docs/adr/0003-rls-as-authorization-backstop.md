# ADR 0003 — Row Level Security as the authorization backstop

- **Status:** accepted
- **Date:** 2026-08-16

## Context

Every serverless handler constructs its Supabase client with `SUPABASE_SECRET_KEY`, the
service-role key: `api/admin.js:4`, `api/teacher.js:4`, `api/topics.js:3`, and all of
`lib/api/**`. Row Level Security is therefore never evaluated, and all tenant isolation is a
hand-written JavaScript filter inside each handler — for example `.eq('user_id', customerId)`
in the history endpoint.

There is no second line of defence. One forgotten filter, one unvalidated `booking_id`, or one
action branch placed above the `requireAdmin` gate at `api/admin.js:2723` exposes every
customer record. That gate's position is currently the entire boundary between anonymous
traffic and privileged database access.

## Decision

Enable RLS on all tables and express the real access rules as policies. Student-facing reads
move to a request-scoped client under RLS. The service-role key is reserved for genuinely
privileged paths: admin actions, payment confirmation, and cron work.

## Rationale

- Defence in depth: an application bug should degrade to "no rows" rather than "all rows".
- Policies are declarative and reviewable in a migration; scattered `.eq()` calls are not.
- The product already depends on Supabase Auth identities — synthetic users are created during
  login (`lib/api/customers/login.js`) and manual booking (`api/admin.js:774`) — so the
  identity plumbing RLS needs already exists.

## Consequences

- Each endpoint must be re-checked to confirm it still returns the intended rows once policies
  are active; this is a per-endpoint migration, not a switch.
- Requires a working session concept for students, which depends on ADR 0004 (real identity).
- Needs a regression check in CI or staging: with the handler's own filter removed, student A's
  credentials must return zero of student B's rows.
- Slightly more complex local setup: developers must run against a database that has policies,
  which is another reason a staging project is required.
- Ordering matters: this lands after identity (ADR 0004), because policies keyed to a
  phone-only, non-expiring token would encode the current weakness into the database.
