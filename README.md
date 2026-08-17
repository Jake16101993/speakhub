# SpeakHub

Booking, payment and assessment platform for an offline English speaking club in Ho Chi Minh
City. Students browse the timetable, pay for one or more sessions through PayOS, take an
AI-scored placement test, attend classes, and track progress. Staff manage the schedule,
topics and payments through an admin panel; teachers see their roster and mark attendance.

Live surfaces:

| Path | Audience |
|---|---|
| `/` | students and visitors |
| `/admin` | operations staff |
| `/teacher` | teachers |

## Stack

Static HTML (no build step) · Vercel serverless functions · Supabase Postgres + Storage ·
PayOS · OpenAI. Business-critical logic lives in Postgres functions.

## Documentation

Read in this order:

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the system works today, with
   `file:line` references throughout.
2. [`docs/ARCHITECTURE-TARGET.md`](docs/ARCHITECTURE-TARGET.md) — target state, phased
   migration plan, and explicit non-goals.
3. [`docs/DEVOPS.md`](docs/DEVOPS.md) — environments, CI gates, deploy, rollback, runbook.
4. [`SECURITY.md`](SECURITY.md) — reporting channel and the rules for contributors.
5. [`CONTRIBUTING.md`](CONTRIBUTING.md) — workflow and what "done" means here.
6. [`docs/adr/`](docs/adr) — architecture decision records.

## Quick start

```bash
cp .env.example .env.local     # fill in from Vercel / Supabase
npm ci
npx vercel dev
```

`vercel dev` is the only faithful local runtime: it applies the `vercel.json` rewrites that
map `/api/bookings/create` and friends onto `api/router.js`. Without Supabase credentials the
pages render but every data-driven view stays empty — expected, not a bug.

⚠️ There is no staging database yet. Local and preview deployments currently talk to
production Supabase and live PayOS. See `docs/DEVOPS.md`.

## Repository layout

```
index.html            student SPA
admin.html            admin panel
teacher/index.html    teacher app
api/                  Vercel serverless functions (budget: 12, currently 6)
  router.js           multiplexes 9 endpoints onto lib/api/** via vercel.json rewrites
  admin.js            29 actions: admin + public student endpoints
  sessions.js         public timetable, 3-month cap
  topics.js           signed URLs for paid topic material
  teacher.js          teacher auth, schedule, attendance
lib/api/              handlers behind router.js (bookings, customers, orders, payos)
assets/               images
docs/                 architecture, devops, ADRs
```

## Status

Under active remediation. Known defects, missing flows and technical debt are tracked as
issues and mapped to the project board; security findings are tracked as **private security
advisories**, never as public issues.
