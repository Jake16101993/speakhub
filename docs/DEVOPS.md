# DevOps — environments, pipeline, runbook

## Environments

| Environment | Branch / trigger | Frontend | Database | Payment | Status |
|---|---|---|---|---|---|
| Production | `main` | Vercel production | Supabase production | PayOS live | live |
| Preview | any pull request | Vercel preview URL | **shares production today** | PayOS live | ⚠️ unsafe |
| Local | working tree | `vercel dev` | whatever `.env.local` points at | PayOS live | ⚠️ unsafe |

**Known gap, highest operational priority after the schema dump:** there is no staging
database. A preview deployment and a developer's laptop both talk to production Supabase and
live PayOS. Until a staging project exists, treat every local run as production access:
never create test orders, never mutate `class_sessions`.

Target: a `speakhub-staging` Supabase project plus PayOS sandbox credentials wired to Vercel
preview environments, so previews are safe by default.

## Secrets

All runtime configuration lives in Vercel → Project Settings → Environment Variables.
`.env.example` is the source of truth for **which** variables exist; it never contains values.

Rules:

- Production values are set only in Vercel, never in a file, never in an issue or PR.
- Preview and production must eventually hold *different* Supabase and PayOS values.
- Rotation procedure and blast radius per secret: see [`../SECURITY.md`](../SECURITY.md).
- `SPEAKHUB_TEACHER_SECRET` must be set explicitly — the code silently falls back to
  `SPEAKHUB_ADMIN_SECRET`, then to `SUPABASE_SECRET_KEY` (`api/teacher.js:42-49`).

## Pipeline

Two workflows, both on push to `main` and on every pull request.

### `.github/workflows/ci.yml`

| Job | Gate |
|---|---|
| `syntax` | `node --check` on every file in `api/` and `lib/`; imports each handler and asserts it exports `default.fetch()` (env-related throws are tolerated) |
| `config` | `package.json` and `vercel.json` parse; every dependency pinned to an exact version; lockfile present and in sync; **serverless function count ≤ 12**; every `vercel.json` rewrite resolves to a real file |
| `static` | no tracked `.env*` file except `.env.example`; every local asset referenced by the HTML pages exists; reports page weight |

### `.github/workflows/security.yml`

| Job | Gate |
|---|---|
| `secrets` | TruffleHog over full history, verified + unknown findings |
| `dependencies` | `npm audit`, fails on high or critical |
| `guardrails` | unauthenticated actions in `api/admin.js` must match `.github/public-actions.txt`; no PII in log statements; no server secret name in a client-served HTML file |

Also runs weekly (Monday 02:00 UTC) so a newly disclosed CVE surfaces without a push.

### Why these gates

Each one encodes a defect that already exists in this codebase:

- the function-count gate: the whole `router.js` indirection exists because the limit was hit;
- the rewrite-target gate: a rewrite pointing at a missing file returns 404 with no warning;
- the pinned-dependency gate: `@payos/node` was `"latest"`, so the payment client could change
  between two deploys of identical source;
- the public-action gate: `api/admin.js` decides authentication by *statement order*;
- the PII-log gate: `lib/api/customers/history.js` used to log phone numbers on every call.

### Not enabled

Three GitHub features this project wants are unavailable on the organisation's **Free** plan
while the repository is **private**:

| Feature | API result | Substitute in place |
|---|---|---|
| CodeQL / GitHub secret scanning (needs Advanced Security) | n/a | TruffleHog job in `security.yml` |
| Repository security advisories | `POST /security-advisories` → `404` | `type:security` issues in this private repo — see `SECURITY.md` |
| Branch protection / rulesets | `403 Upgrade to GitHub Pro…` | squash-only merges, CI on every PR, `CODEOWNERS`, and convention |

Making the repository public would unlock protection and advisories, but would also publish an
exploitable-weakness list with exact line numbers. Upgrade the plan instead.

## Branch protection

### Not enforceable on the current plan

`ventra-rocket` is on the GitHub **Free** plan, and this repository is **private**. Both the
rulesets API and classic branch protection return:

```
403 Upgrade to GitHub Pro or make this repository public to enable this feature.
```

So `main` cannot technically require a review or a green check today. Making the repository
public to unlock protection is not an acceptable trade: it would expose the endpoint surface
and the vulnerabilities tracked in the private advisories.

### What is enforced instead

| Control | State |
|---|---|
| Squash-merge only, merge commits and rebase disabled | ✅ set via repo settings |
| Branch deleted automatically on merge | ✅ set |
| Dependabot alerts and automated security fixes | ✅ enabled |
| CI + Security workflows run on every pull request | ✅ enabled — advisory, not blocking |
| `CODEOWNERS` requests the right reviewer | ✅ present — advisory, not blocking |
| Required approvals, required checks, force-push block | ❌ needs GitHub Team |

Until the plan changes, this is **convention enforced by people**: no direct pushes to `main`,
no merge with a red check, no self-merge on payment, auth or database paths.

### To make it real

Upgrade the organisation to GitHub **Team**, then apply the ruleset: pull request required,
1 approving review, stale approvals dismissed, `CODEOWNERS` review required, conversation
resolution required, force-push and deletion blocked, and these checks required:
`JS syntax + module graph`, `Config integrity`, `Static asset sanity`,
`Project-specific guardrails`, `Secret scan`.

## Deploying

A merge to `main` **is** the production deploy — Vercel builds and promotes automatically.
There is no manual release step and no approval gate beyond PR review.

Before merging anything that touches payment, booking state, or authentication, confirm the PR
body contains real verification evidence (see [`../CONTRIBUTING.md`](../CONTRIBUTING.md)).

## Rollback

1. Revert the merge commit on `main` and push — Vercel redeploys the previous state.
2. Or, in the Vercel dashboard, promote the last known-good deployment (faster, no git churn).
3. **Database changes do not roll back with the code.** A migration must ship with a tested
   down-path, or the rollback is manual SQL. This is why dashboard-only schema edits are
   forbidden.

## Runbook

### Payments stop confirming

1. Check PayOS status and whether webhooks are arriving (Vercel logs, `payos:webhook`).
2. The client-side reconcile loop is the fallback: `/api/payos/reconcile` queries PayOS
   directly, so payments still confirm while a user has the tab open. A silent webhook is not
   customer-visible immediately — it becomes visible for users who close the tab.
3. Confirm `PAYOS_CHECKSUM_KEY` matches the PayOS dashboard: a rotated key makes every
   webhook fail signature verification.

### Seats look wrong / a class appears full

1. Seat counts come from the `get_public_sessions` RPC and include PENDING holds.
2. Holds expire opportunistically, not on a schedule — a stale hold can block a seat until
   something touches the row. Inspect `orders` with `payment_status='PENDING'` past
   `expires_at`.
3. Check for duplicate `class_sessions` rows for the same logical class.

### Admin panel returns errors after login

`runAdminActionWithRetry` (`api/admin.js:2667`) already retries Supabase `PGRST303`
clock-skew failures once. Repeated failures mean a genuine Supabase or key problem, not skew.

### Placement or progress tests fail

Check `OPENAI_API_KEY` validity and account spend limits. `PLACEMENT_RESULT_INVALID` /
`PROGRESS_RESULT_INVALID` (HTTP 502) mean the model returned unparseable JSON — a model or
prompt issue, not an infrastructure one.

### Suspected credential leak

Rotate immediately per the table in `SECURITY.md`, starting with `SUPABASE_SECRET_KEY`
(service-role: full database access, bypasses RLS).

## Observability — current gap

Today: `console.log` / `console.error` into Vercel runtime logs. No error tracker, no metrics,
no alerting, no uptime check. Nothing notices a failing webhook or a spike in OpenAI spend.

Minimum worth adding, in order:

1. Uptime check on `/` and `/api/sessions`.
2. Error tracking with release tagging (Sentry or equivalent).
3. An alert on OpenAI daily spend and on `payos:webhook` signature failures.
