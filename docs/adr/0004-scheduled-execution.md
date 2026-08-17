# ADR 0004 — Introduce scheduled execution

- **Status:** accepted
- **Date:** 2026-08-16

## Context

Nothing in the system runs unless an HTTP request triggers it. `vercel.json` declares no
`crons`, there is no queue, and no background job exists.

Four consequences, all observed in the code:

1. **Hold expiry is opportunistic.** A 15-minute `expires_at` hold is released when some
   request happens to touch it. Release otherwise depends on the browser: a 20-second
   heartbeat, a 60-second away-release, and a 75-second server grace window
   (`lib/api/payos/create.js:41-47`). A closed laptop leaves a seat held.
2. **Recurring sessions may never materialise.** `api/admin.js:598` inserts one seed row and
   defers to a database trigger; the JS equivalent, `materializeRecurringSessions`
   (`api/sessions.js:30`), is never called from anywhere.
3. **Reminders are never sent.** `action=reminders` computes a churn list for staff to phone
   manually.
4. **`session_events` has no writer**, so the notifications screen is permanently empty.

## Decision

Add one scheduled function, `api/cron.js`, invoked by Vercel `crons`, owning:

- expiring stale PENDING holds and their orders and bookings;
- materialising recurring sessions into a rolling window;
- emitting T-24h class reminders through the outbound messaging module;
- sweeping abandoned orders and reconciling payments whose webhook never arrived.

It counts against the 12-function budget, which the project can afford (currently 6).

## Rationale

- Correctness must not depend on a browser tab staying open.
- One scheduled entry point with an internal switch keeps the function budget intact and
  keeps all periodic behaviour in one reviewable place.
- Vercel crons need no additional infrastructure; a queue would be premature at this volume.

## Consequences

- Cron invocations must be authenticated (Vercel's cron secret) so the endpoint is not a
  public trigger.
- Every job must be idempotent: crons can overlap or retry.
- Client-side hold heartbeats become a UX nicety instead of the mechanism of record, and can
  eventually be simplified.
- Reconciling payments server-side removes today's dependence on the student keeping the
  payment tab open.
- The outbound messaging module (Zalo ZNS) becomes a prerequisite for the reminder job.
