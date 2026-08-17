# ADR 0007 — Retire Vercel and serve the frontend from our own server

- **Status:** accepted
- **Date:** 2026-08-17
- **Supersedes:** ADR 0001's frontend decision, and ADR 0006's "static pages stay on Vercel"
- **Plan:** [`../MIGRATION-OFF-SUPABASE.md`](../MIGRATION-OFF-SUPABASE.md), Phase 6

## Context

ADR 0006 moved the database and the API to our own server and explicitly kept the static pages
on Vercel, with `vercel.json` rewrites proxying `/api/*` to the server. The product owner has
since decided to drop Vercel entirely: frontend and backend both run on infrastructure the
project controls. As in ADR 0006 this is a business requirement, so the decision is *how* to
land it without an outage, not *whether*.

The application side is already done and verified, which is what makes this cheap:

- `server.mjs` serves the three HTML pages, the assets and every API route from one process.
  Phase 2 verified it on the host: three pages at 200 with zero broken images and zero JS
  errors, and the `Self-host route parity` CI job fails if `vercel.json` gains a rewrite that
  `server.mjs` does not answer.
- No handler uses a Vercel-specific API. `@vercel/*`, `process.env.VERCEL` and `waitUntil` have
  zero occurrences.
- The frontends call `/api/*` relatively, with no absolute origin anywhere, so serving pages and
  API from a single origin removes a hop rather than adding one — the opposite of ADR 0006's
  rewrite-proxy shape, which is now dead.

So there is no application work left. Everything remaining is hosting risk, and it is not small.

## Decision

Serve `speakhub.vn` from Ventra Server 1 through the existing Cloudflare Tunnel, with
Cloudflare's proxy enabled, and delete the Vercel project only after the cutover has held.

Sequenced so that each step is separately reversible:

1. **Move the `speakhub.vn` zone to Cloudflare with records byte-identical to today.** The zone
   must sit in the same Cloudflare account as the tunnel — a CNAME to `cfargotunnel.com` from
   another account is refused with Error 1014. Nothing about serving changes in this step;
   Vercel still answers. Rehearsed against Cloudflare's own nameservers before the registrar is
   touched, and rolled back by pointing the nameservers back at Mắt Bão.
2. **Publish `staging.speakhub.vn`** through the tunnel and run the product against it.
3. **Satisfy the preconditions below.** This is the real work.
4. **Cut the apex and `www` over** to a proxied CNAME onto the tunnel, during a low-traffic
   window, with the Vercel deployment left intact. Rollback is a DNS change back, which is why
   the records keep a short TTL until the cutover has held for a week.
5. **Delete the Vercel project and `vercel.json`** last. Until then `vercel.json` remains the
   route contract that CI checks; afterwards `server.mjs` owns the route table and the parity
   job inverts.

**Preconditions for step 4.** Each is a fact about the host, measured on 2026-08-17, and each
is a way this decision costs the business money if skipped:

| Precondition | Why, with the measurement |
|---|---|
| Backups running, with a rehearsed restore | Nothing is backed up today. Vercel held no state, so losing the host lost nothing; after cutover the host holds the booking and payment record |
| Postgres data on the SSD | `/` is a spinning `WDC WD10EZEX`, while a 223.6G SSD sits unmounted holding an old Windows install. Payment writes fsync to the slow disk today |
| A UPS | There is no UPS and a power cut has already corrupted a filesystem on this fleet. An unclean Postgres shutdown mid-payment is the worst case in this system |
| RAM headroom stated and enforced | 3.4Gi total, 2.2Gi available, shared with a live crawler pipeline. Production traffic must not be able to OOM the crawler, or the reverse |
| Cache rules for the static pages | `server.mjs` sends `no-store` for HTML, so with Vercel gone every landing-page view would reach the office uplink. The landing page must be edge-cacheable; `/admin` and `/teacher` must not be |
| The two host-level findings closed | The SSH key was published in plaintext in a document and is still in use, and the console password is `1`. Acceptable for a box serving nothing; not acceptable for one serving payments |

## Consequences

**Gained.** One origin serves pages and API, so the ADR 0006 rewrite-proxy hop never gets
built. Deploys stop depending on a third party's build pipeline. The last vendor in the request
path after Supabase is gone, which was the point.

**Paid, and honestly.** Availability moves from Vercel's anycast edge to one desktop on one
office uplink with no UPS. Cloudflare's proxy recovers more of that than it may appear — TLS
terminates at the edge, DDoS is absorbed there, static assets cache there, and Always Online can
serve cached HTML while the origin is down — but the API has no equivalent: when the host or the
uplink is down, booking and payment are down. That is a real reduction in availability, accepted
deliberately, and it is why the preconditions above are preconditions and not follow-ups.

Compression on the origin hop became load-bearing rather than a nicety, and was measured and
fixed while writing this: nginx's `gzip_proxied` defaults to `off`, which disables compression
whenever a request carries a `Via` header — exactly how a tunnelled request arrives. The landing
page crossed the uplink at 583,739 bytes; it now crosses at 211,543.

**Unchanged.** No framework, no bundler. ADR 0002 through ADR 0005 are untouched: they describe
Postgres, authorization and testing, none of which depends on who serves the HTML.

**Revisit if** the office uplink or the single host proves unable to hold the traffic — in which
case the fallback is a rented VPS as the origin, not a return to Vercel, since the requirement
that we control the infrastructure is what drove this.
