# ADR 0005 — Verification strategy while there are no tests

- **Status:** accepted
- **Date:** 2026-08-16

## Context

The repository contains no tests and no test tooling. Historically every change was uploaded
through the GitHub web UI and verified, if at all, by using the production site.

Adding a full test suite retroactively to an 11,754-line HTML monolith and 2,766-line handler
would take longer than the entire remediation plan and would mostly test plumbing rather than
the rules that matter.

## Decision

Two-track verification.

**Track 1 — evidence in the pull request (now).** CI enforces the mechanical gates: syntax,
config integrity, function budget, rewrite targets, secret scanning, PII in logs, and the
unauthenticated-action allowlist. Behavioural correctness is the author's responsibility and
must be evidenced in the PR body: the flow exercised, the endpoint response, the PayOS sandbox
order, the screenshot. "It compiles" is not evidence.

**Track 2 — tests where they defend a contract (Phase 6).** Write tests only for rules whose
breakage costs money or trust:

- hold expiry and release under the 75-second server grace;
- price calculation including `class_date_discounts`;
- reschedule quota (1 / 2 / 3) and the 24-hour cutoff;
- seat capacity under two concurrent booking attempts;
- PayOS webhook idempotency and amount verification;
- authorization: student A cannot read student B's rows.

Most of these live in Postgres, so they are tested as database tests against a staging
database, not as JavaScript unit tests. That is deliberate: testing the RPCs tests the real
logic, while testing the JS wrappers would mostly assert that `fetch` was called.

## Rationale

- The highest-value tests are impossible today because the schema and RPCs are not in the
  repository (ADR 0002). Test infrastructure follows the migration work, not the reverse.
- Guardrail CI catches the defect classes actually found in review, at a fraction of the cost
  of a suite.
- Explicit manual evidence is honest: it makes the current absence of automation visible in
  every PR instead of implying a safety net that does not exist.

## Consequences

- Reviewers must reject PRs whose evidence section is empty or generic.
- A staging Supabase project is a prerequisite for Track 2.
- No coverage target is set; a coverage number over this codebase would measure the wrong
  thing.
- If a bug reaches production twice in the same area, that area gets a test before the third
  fix.
