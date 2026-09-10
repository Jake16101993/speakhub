# V122 — Unified CS Login + Pagination + Registration Full State

- `/cs` is now the only CS portal. The password determines the branch: `CS_GOVAP_PASSWORD` => Gò Vấp, `CS_D2_PASSWORD` => District 2. Backend-issued supporter token remains branch-locked.
- Legacy `/cs_govap` and `/cs_d2` redirect to `/cs`.
- Fixed Admin Publisher `+ Add range` button function mismatch.
- Admin Remind and CS Remind paginate 10 students per page with numbered pages and previous/next buttons.
- Admin and CS Registration Support now show full sessions crossed out and disabled instead of hiding them.
- No new SQL.

# V121 — Branch-locked CS login

- `/cs_govap` uses Vercel env `CS_GOVAP_PASSWORD`.
- `/cs_d2` uses Vercel env `CS_D2_PASSWORD`.
- Supporter tokens now carry the authenticated branch. Backend overrides any client `scope` with the token branch, so changing URL/query cannot access another branch.
- Separate sessionStorage tokens per branch.
- No SQL migration required.

# SpeakHub V117

Adaptive, non-repeating test banks for Placement, Progress, Pronunciation, and Session Comprehension. Young Kid (<10), Teen Kid (10-15), Beginner, and Intermediate receive different difficulty. Content is consumed sequentially and cycles only after the relevant bank is exhausted. No new SQL beyond V112 AI Test Center schema.

# SpeakHub V116 — Pronunciation limits + non-repeat content

- Pronunciation buttons use a lighter orange background with black text for better contrast.
- Pronunciation Test is limited server-side to 3 completed attempts per learner per Vietnam calendar day.
- Pronunciation content is selected server-side from 576 paragraph combinations plus a 467-word pronunciation bank; completed references are checked to avoid repeating prior full tests.
- Session Comprehension is strictly one completed test per learner per real session. Both quiz creation and scoring reject a second attempt; the database unique key remains the final guard.
- Same-day comprehension sessions are only eligible after the session end time.
- No new SQL migration is required beyond the existing 112_ai_test_center.sql.

# SpeakHub V112 — AI Test Center

New: ~2-minute Pronunciation Test (paragraph + random words), post-session Comprehension Test with level-aware AI questions, demo topic “Why Do Some People Become Successful Faster Than Others?”, and Dashboard week/all counts for Placement / Progress / Pronunciation / Comprehension.

Before deploy: run `112_ai_test_center.sql` once in Supabase SQL Editor.

# SpeakHub V111

Publisher management UX update. No new SQL migration is required if V110 is already deployed.

- Admin tab renamed to Publisher Management; Booking Manager renamed to Booking Management.
- Publisher reporting supports All / Month / custom date range filters.
- The same report period applies to admin totals and each publisher detail card.
- Publisher portal uses the same All / Month / custom date range filter design.
- Added publisher search by name, phone, or slug.
- Removed admin customer/funnel detail and funnel text.
- Admin can edit publisher name, phone, and password, while keeping the affiliate slug unchanged.
- Existing commission scheme editing remains available.

# SpeakHub V109

Publisher reporting UX update. No new SQL migration is required if V108 publisher schema is already installed.

- Publisher portal refresh spinner, month filter, customer pagination.
- Publisher login by phone or slug.
- Admin Registration support rename and wider sidebar.
- Admin publisher monthly summary table + publisher pagination.
- New publisher code equals slug; V108 legacy login codes remain accepted for compatibility.

# SpeakHub V108 — Publisher Affiliate

Run `108_publishers_affiliate.sql` once in Supabase SQL Editor before deploying. Publisher short links use strict last-click attribution at order creation. Publisher portal: `/publisher`.

# SpeakHub V107

## Changes
- Topic PDF upload now uses a signed Supabase Storage upload URL so large PDFs do not pass through the Vercel API body.
- Topic upload is now 3-step: request signed upload -> browser uploads PDF directly to Storage -> Admin API finalizes vocabulary and session attachment.
- Added clearer HTTP/status error messages instead of generic REQUEST_FAILED.
- Existing topic image-page generation and teacher/session synchronization are preserved.
- No SQL migration is required for V107.

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
3. [`docs/MIGRATION-OFF-SUPABASE.md`](docs/MIGRATION-OFF-SUPABASE.md) — **in progress
   decision**: Postgres, object storage and the API move to a self-hosted VPS. Read this
   before touching any data-access code.
4. [`docs/DEVOPS.md`](docs/DEVOPS.md) — environments, CI gates, deploy, rollback, runbook.
5. [`SECURITY.md`](SECURITY.md) — reporting channel and the rules for contributors.
6. [`CONTRIBUTING.md`](CONTRIBUTING.md) — workflow and what "done" means here.
7. [`docs/adr/`](docs/adr) — architecture decision records.

## Quick start

```bash
cp .env.example .env.local     # fill in from Vercel / Supabase
npm ci
npx vercel dev                 # Vercel runtime
npm start                      # self-hosted runtime: node server.mjs on :8787
```

`vercel dev` applies the `vercel.json` rewrites that map `/api/bookings/create` and friends
onto `api/router.js`. `npm start` runs the same handlers under `server.mjs`, which mirrors that
route table for the self-hosted target; CI fails if the two disagree. Without Supabase
credentials the pages render but every data-driven view stays empty — expected, not a bug.

**Staging** runs the `server.mjs` path on Ventra Server 1. Its stack, deploy scripts and
runbook live in [`ventra-rocket/speakhub-infra`](https://github.com/ventra-rocket/speakhub-infra);
migrations and application code stay here.

⚠️ Vercel production and preview deployments still talk to production Supabase and live PayOS.
Staging does not. See `docs/DEVOPS.md`.

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

## V106 fixes
- Fixed `/cs` login crash caused by the login function shadowing the login DOM element.
- Hỗ trợ đăng ký now hides sessions that are already full.
- Added class filter to Hỗ trợ đăng ký in both Admin and CS.
- Removed the `ADMIN MENU` label from the Admin left sidebar.


## V110 - Publisher attribution + commission scheme
- Fixed direct affiliate URLs (`speakhub.vn/<slug>`) so the slug is read from the pathname; this fixes fresh/incognito traffic not being recorded.
- Added checkout fallback attribution using the browser's latest publisher slug while preserving last-click behavior.
- Admin publisher summary is total-only. One month filter controls both the total report and publisher detail cards; includes `Toàn bộ`.
- Publisher portal month filter also includes `Toàn bộ`.
- Added per-publisher fixed-VND commission ranges by number of sessions, with `+ Add range`, plus editing for existing publishers.
- Run `110_publisher_commission_scheme.sql` once before deploy.

## V120
- CS split by branch: `/cs_govap` and `/cs_d2`; branch-scoped documents, registration sessions, student schedule, and reminders.
- CS Remind tab and unread Chat SpeakHub badge.
- Publisher: new 4-character alphanumeric slugs (letter + number, uniqueness checked), 10-customer pagination with step filter and scroll-to-top, plus 30-day click chart.
- No new SQL migration required for V120.
