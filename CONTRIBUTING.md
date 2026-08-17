# Contributing

## Before your first change

Read, in order:

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the system works today.
2. [`docs/ARCHITECTURE-TARGET.md`](docs/ARCHITECTURE-TARGET.md) — where it is going, and why.
3. [`SECURITY.md`](SECURITY.md) — non-negotiable rules.
4. [`docs/DEVOPS.md`](docs/DEVOPS.md) — environments, deploys, runbook.

## Ground rules

- **No web-UI uploads.** All history before the migration to this repository consists of
  289 commits titled "Add files via upload". That stops here: branch, commit, PR.
- **`main` is deployed.** A merge to `main` is a production deploy. Nothing lands without
  a green CI run and one review.
- **The database is code.** Schema, RPCs, triggers and RLS policies live in `supabase/`.
  A change made only in the Supabase dashboard does not exist as far as this repo is
  concerned, and will be overwritten.
- **No new conventions.** This codebase has exactly one style per area. Match the file you
  are editing rather than introducing a second pattern.

## Workflow

```bash
git switch -c fix/short-description
# change, verify locally
git commit -m "fix(booking): reject holds past expires_at"
git push -u origin fix/short-description
gh pr create --fill
```

Branch names: `feat/…`, `fix/…`, `chore/…`, `docs/…`, `refactor/…`.

Commit messages: [Conventional Commits](https://www.conventionalcommits.org/).
Scopes in use: `booking`, `payment`, `auth`, `admin`, `teacher`, `student`, `db`, `ci`, `docs`.

## Local development

```bash
cp .env.example .env.local     # fill in from Vercel / Supabase
npm ci
npx vercel dev                 # serves static pages + api/ functions
```

`vercel dev` is the only faithful local runtime: it applies the `vercel.json` rewrites
that map `/api/bookings/create` and friends onto `api/router.js`. A plain static server
will render the pages but every data-driven view stays empty.

Without Supabase credentials the UI shell renders and every API call returns an
environment error. That is expected, not a bug.

## What "done" means

A pull request is done when the change is **verified against the real surface**, not when
it compiles:

| Change | Required evidence |
|---|---|
| UI | The flow exercised in a browser, with a screenshot |
| API | The endpoint called against staging data, with the response |
| Payment | A PayOS sandbox order taken through to `PAID` |
| Database | Migration applied to staging, plus rollback verified |
| Bug fix | The original reproduction no longer triggers |

There is no test suite yet (see the testing ADR). Until one exists, manual evidence in the
PR body is the contract.

## Reviewing

Reviewers must check:

- Does an unauthenticated caller reach anything new? (`.github/public-actions.txt`)
- Is money or seat state mutated outside a Postgres transaction?
- Is any new secret, phone number or name written to logs?
- Does the PR change an env var without updating `.env.example` **and** Vercel?
- Is there a rollback path?

## Adding an endpoint

Vercel's plan caps this project at 12 serverless functions, and it is at that ceiling.
New endpoints must be added as an `action` inside an existing handler, routed through
`api/router.js` and `vercel.json`. CI enforces the ceiling.
