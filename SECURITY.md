# Security Policy

## Reporting a vulnerability

**Never open a public issue or pull request for a vulnerability.**

Report through GitHub's private channel:
<https://github.com/ventra-rocket/speakhub/security/advisories/new>

Include the affected `file:line`, the impact, and reproduction steps. You will get
an acknowledgement within two business days.

## What this codebase handles

SpeakHub stores and processes:

- customer identity: full name, phone number, class history;
- payment records: PayOS order codes, amounts, payment status;
- assessment data: placement and progress test recordings, transcripts, scores;
- staff credentials: admin password, teacher accounts.

Assume every change to `api/`, `lib/api/` or `supabase/` is security-relevant.

## Current security posture

Known weaknesses are tracked as **private security advisories** on this repository,
not as public issues. Read them before touching authentication, payment or
database code. The main structural facts a contributor must know:

| Area | State |
|---|---|
| Student authentication | Phone number only. OTP is not implemented. |
| Row Level Security | Not used. Every handler holds the Supabase service-role key. |
| Authorization | Enforced in JavaScript, per handler, by hand. |
| Admin authentication | One shared password, 8-hour HMAC bearer token. |
| Teacher authentication | Username + password via RPC, 12-hour HMAC bearer token. |
| Rate limiting | None, on any endpoint. |
| Audit logging | Attendance only (`attendance_log`). |

## Rules for contributors

1. **Never** commit an environment file. Only `.env.example` belongs in git.
2. **Never** put a server secret name into an HTML page; CI blocks this.
3. **Never** log a phone number, name, token or password; CI blocks this.
4. Adding an endpoint that is reachable without authentication requires adding it to
   `.github/public-actions.txt` with a justification. CI fails otherwise.
5. Any endpoint that calls OpenAI or writes to the database must have a quota bound to
   a server-controlled identity, never to a client-supplied id.
6. Compare secrets with `crypto.timingSafeEqual`, never with `===`.

## Secret rotation

| Secret | Where | On rotation |
|---|---|---|
| `SUPABASE_SECRET_KEY` | Supabase → API keys | Every function loses database access until redeploy. Rotate during a maintenance window. |
| `SPEAKHUB_ADMIN_PASSWORD` | Vercel env | Immediate; admins re-login. |
| `SPEAKHUB_ADMIN_SECRET` | Vercel env | Invalidates all admin tokens. |
| `SPEAKHUB_TEACHER_SECRET` | Vercel env | Invalidates all teacher tokens. |
| `PAYOS_*` | PayOS dashboard | Coordinate: in-flight payment links break. |
| `OPENAI_API_KEY` | OpenAI dashboard | Placement and progress tests fail until updated. |

Rotate `SUPABASE_SECRET_KEY` and `OPENAI_API_KEY` immediately if either appears in a
log, a screenshot, or a public commit.
