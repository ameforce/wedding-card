# Private guestbook deployment contract

The browser never receives a guestbook list, password hash, database credential, or administrator secret. Public API behavior is intentionally write-only:

- `POST /api/guestbook/entries` creates a private entry and returns only the fixed non-sensitive `permanent` retention policy. Display names are trimmed, NFKC-normalized, and unique; a duplicate is rejected with guidance to add an affiliation or alias.
- `POST /api/guestbook/entries/unlock` returns one entry only after its exact normalized name and password pass server-side verification.
- `PATCH /api/guestbook/entries` updates that uniquely named entry only after the same verification.
- `GET /api/guestbook/entries` is always rejected.
- `GET /api/guestbook/admin/entries` is the only list endpoint and fails closed unless a Cloudflare Access JWT passes signature, issuer, audience, expiry, and exact two-email allowlist validation inside the Worker.

Author passwords are intentionally length-validated at 4–72 characters to keep guest entry practical, then processed with PBKDF2-HMAC-SHA256 at 100,000 iterations and a random 128-bit salt. This is the maximum supported by the deployed workerd runtime. The encoded verifier carries its iteration count, and the Worker rejects unsupported metadata before derivation; plaintext passwords are neither stored nor logged. Comparisons scan every derived byte. The short minimum is compensated by a shared five-per-minute unlock/update credential budget, a 15-minute D1-backed lock after five failures in one 15-minute window, and a four-check per-isolate PBKDF2 concurrency ceiling. A successful authentication resets only that entry's failure state.

Public create, unlock, and update responses never expose the internal entry id. Lookup and update return the same generic authentication failure for a missing name, wrong password, or unsafe legacy duplicate. A D1 unique index provides the final duplicate-name race guard.

Guestbook messages have a permanent-retention policy. The Worker has no deletion or expiry endpoint, migration, TTL, or cleanup job for entries; do not add one without an explicit change to this decision. This application retention policy has no separate backup commitment; D1 operator access controls remain required.

Production requires all of the following before guestbook use:

1. Provision D1 and bind it as `GUESTBOOK_DB`; apply all ordered files in `migrations/`.
2. Protect `/admin/*` and `/api/admin/*` with Cloudflare Access, and protect `/api/guestbook/admin/*` with the same application policy.
3. Configure `ADMIN_AUTH_MODE=cloudflare-access-jwt`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and `WEDDING_ADMIN_EMAILS` only in the deployment environment. The Worker fetches the team's Access JWKS and validates `Cf-Access-Jwt-Assertion`; it fails closed unless the allowlist contains exactly two distinct groom/bride emails. Never commit, bundle, source-map, or render those addresses.
4. Keep the direct Worker preview hostname disabled or protected so it cannot bypass the Custom Domain Access policy.

Until D1 and the identity gateway are attached, public writes return `503` and administrator reads return `503`; no in-memory or public fallback is used.

Production sets `REQUIRE_GUESTBOOK_RATE_LIMIT=1` and binds both `GUESTBOOK_RATE_LIMITER` and `GUESTBOOK_CREDENTIAL_RATE_LIMITER` through Wrangler. Before any public body is read, all guestbook mutations consume one 30-per-minute SHA-256 caller budget; unlock/update also consume one shared 30-per-minute authentication-class budget per Cloudflare location. After bounded parsing, unlock and update consume the same five-per-minute SHA-256 normalized-name credential budget. Plaintext addresses, names, messages, or passwords are never sent to either limiter. A missing required binding fails the affected public operation closed with `503`.

Every JSON body is read through a byte-counted stream and canceled as soon as its route limit is exceeded. `Content-Length` is only an early rejection optimization, not the body-size security boundary.
