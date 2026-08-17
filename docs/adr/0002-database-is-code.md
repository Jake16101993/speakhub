# ADR 0002 — The database is code

- **Status:** accepted
- **Date:** 2026-08-16

## Context

Five Postgres functions own the behaviour that decides money and capacity:

| RPC | Owns |
|---|---|
| `create_booking_order` | price, seat locking, 15-minute hold |
| `confirm_payos_payment` | PENDING → PAID / CONFIRMED |
| `reschedule_booking` | reschedule quota, 24-hour cutoff, program match |
| `get_public_sessions` | remaining seats |
| `verify_teacher_login` | teacher password verification |

None of them existed in the repository. Neither did the 22 table definitions, the triggers
that `api/admin.js:598` relies on for recurring sessions, or any RLS policy. Everything was
edited directly in the Supabase dashboard.

Consequences observed during review: nobody could review the pricing logic, no rollback path
existed for a bad edit, error codes (`SESSION_FULL`, `RESCHEDULE_TOO_LATE`) were only
discoverable by reading JavaScript error mapping, and a new developer could not run the
product at all.

## Decision

Schema, RPCs, triggers and RLS policies are source code. They live in `supabase/migrations/`
and change only through a migration in a pull request.

Editing the production database through the Supabase dashboard is prohibited, except for a
declared incident — after which the change must be back-filled as a migration the same day.

## Consequences

- One-time cost: dump the current schema and split it into ordered migrations, which is
  Phase 0 and blocks all other planned work.
- Every schema change now needs a tested rollback path, because reverting application code
  does not revert a migration.
- A staging Supabase project becomes necessary: migrations must be applied somewhere before
  production.
- RPC signatures and thrown error codes get documented as part of the dump, so error mapping
  in `lib/api/**` can finally be verified against the source.
- CI can eventually diff the deployed schema against the migrations and fail on drift.
