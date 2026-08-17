## What changed

<!-- One paragraph. What behaviour is different after this PR? -->

Closes #

## Why

<!-- The problem being solved. Link the issue; do not restate it. -->

## Evidence it works

<!--
Required. Delete the lines that do not apply, fill in the ones that do.
"Tests pass" alone is not evidence for this codebase — most of it has no tests.
-->

- [ ] Exercised locally: <!-- URL / flow / screenshot -->
- [ ] Verified against Supabase staging data
- [ ] Payment path tested with a PayOS sandbox order
- [ ] Not verifiable locally because: <!-- reason -->

## Risk

- [ ] Touches payment or booking state (`orders`, `payments`, `bookings`)
- [ ] Touches authentication or authorization
- [ ] Changes database schema, an RPC, or an RLS policy
- [ ] Changes what is reachable without authentication (update `.github/public-actions.txt`)
- [ ] Adds or changes an environment variable (update `.env.example` and Vercel)
- [ ] None of the above

## Rollback

<!-- How to undo this if it misbehaves in production. -->
