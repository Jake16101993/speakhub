# ADR 0006 — Move off Supabase to a self-hosted Postgres and Node server

- **Status:** accepted
- **Date:** 2026-08-16
- **Amends:** ADR 0001 (backend only; the frontend decision stands)
- **Plan:** [`../MIGRATION-OFF-SUPABASE.md`](../MIGRATION-OFF-SUPABASE.md)

## Context

ADR 0001 decided to keep the serverless + Supabase stack, on the grounds that the defects
found in review were caused by missing engineering practice rather than by the stack. That
reasoning was correct and is unchanged.

The trigger for revisiting is not a defect. It is a product-owner requirement: the database
must live on infrastructure the project controls. ADR 0001 explicitly reserved the right to
revisit on "a concrete trigger"; this is one, and it is a business requirement rather than a
technical preference, so the decision is *where* to land, not *whether* to move.

Three measurements taken at commit `6b1165c` bound the cost:

- 167 `supabase.from(...)` chains, 118 of them in `api/admin.js`.
- The five Postgres functions that own seat allocation, hold expiry, payment idempotency and
  reschedule quota are plain Postgres and port unchanged.
- No handler uses any Vercel-specific API, and no handler verifies a Supabase Auth token —
  `auth.getUser`, `access_token` and `auth.uid()` have zero occurrences.

So the migration is a data-access-layer rewrite, not a platform rewrite.

## Decision

Move both the database and the API execution onto one VPS:

- Postgres, same major version as the source, reachable only over a unix socket.
- MinIO for the `topics` bucket, keeping private objects and short-lived presigned URLs.
- The existing handlers, unchanged in shape, hosted by a small `node:http` adapter.
- Static pages stay on Vercel; `vercel.json` rewrites proxy `/api/*` to the VPS.
- `pg` with hand-written SQL. No ORM, no query builder.

Rejected alternatives:

| Option | Why not |
|---|---|
| Keep Vercel functions, only move Postgres | Serverless to a remote Postgres needs PgBouncer, exposes the database to the internet, keeps the 12-function ceiling, keeps the absence of cron, and multiplies latency on multi-query endpoints such as the admin overview |
| Self-host Supabase in Docker | Cheapest in code changes, but keeps the dependency it is meant to remove — PostgREST, GoTrue, Storage API — and trades one managed service for eight containers to operate. Still no scheduled execution |
| Managed Postgres elsewhere (RDS, Neon) | Does not satisfy the requirement that the data sit on our own server |
| Rewrite handlers onto a framework during the move | Two risky changes at once, on a live payment path |

## Consequences

**Gained.** Scheduled execution becomes possible, which unblocks issues #14 and #16 and
retires target-architecture Phase 4. RLS becomes enforceable, because the app can connect as a
`NOBYPASSRLS` role instead of Supabase's service-role key — that is issue #4 and target
Phase 3. The 12-function ceiling disappears, so `api/router.js` becomes optional rather than
load-bearing. CI can run a real Postgres, which is the first practical path out of ADR 0005's
"no tests" position. A staging environment finally exists.

**Paid.** The VPS is a single point of failure where there were two managed services, so
backups, restore drills, TLS, disk and OS upkeep become ours. 167 query chains get rewritten
with no test suite to catch drift, mitigated by a throwaway parity harness that diffs against
Supabase during the port. There is a write freeze at cutover. The Vercel rewrite adds one
network hop, measured in Phase 2, with serving static pages from Caddy as the fallback.

**Unchanged.** ADR 0001's frontend decision: no framework, no bundler, `index.html` split only
where a seam pays for itself. ADR 0002 (the database is code) becomes strictly more true, since
migrations are now the only way schema changes reach production. ADR 0003 (RLS as
authorization backstop) survives intact — it describes a Postgres feature, not a Supabase one,
and it gets teeth for the first time. ADR 0004 (introduce scheduled execution) keeps its
reasoning; only the mechanism changes from `vercel.json` crons to systemd timers.

**Revisit if** a second venue or genuine traffic growth makes one server insufficient, or if
operating the VPS reliably turns out to cost more attention than the team has — in which case
managed Postgres, not Supabase, is the fallback.
