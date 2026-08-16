# Private guestbook deployment contract

The browser never receives a guestbook list, password hash, database credential, or administrator secret. Public API behavior is intentionally write-only:

- `POST /api/guestbook/entries` creates a private entry and returns only its opaque receipt id.
- `POST /api/guestbook/entries/:id/unlock` returns one entry only after its name and password pass server-side verification.
- `PATCH /api/guestbook/entries/:id` updates one entry only after the same verification.
- `GET /api/guestbook/entries` is always rejected.
- `GET /api/guestbook/admin/entries` is the only list endpoint and fails closed unless an upstream identity provider has authenticated the request and injected a trusted assertion plus email.

Author passwords are length-validated, then processed with PBKDF2-HMAC-SHA256 at 600,000 iterations and a random 128-bit salt. The encoded verifier is stored in D1; plaintext passwords are neither stored nor logged. Comparisons scan every derived byte.

Production requires all of the following before guestbook use:

1. Provision D1 and bind it as `GUESTBOOK_DB`; apply `migrations/0001_guestbook.sql`.
2. Protect `/admin/guestbook` and `/api/guestbook/admin/*` with the deployment platform's identity gateway (Sites Sign in with ChatGPT or an equivalent upstream).
3. Configure `GUESTBOOK_AUTH_MODE=trusted-email-header`, set `GUESTBOOK_AUTH_EMAIL_HEADER` and `GUESTBOOK_AUTH_ASSERTION_HEADER` to gateway-owned headers that clients cannot inject, and set `GUESTBOOK_ADMIN_EMAILS` to the exact verified couple email allowlist.
4. Verify the gateway strips any client-supplied copies of both headers before injecting its own values.

Until D1 and the identity gateway are attached, public writes return `503` and administrator reads return `503`; no in-memory or public fallback is used.

Open production risk: this prototype does not yet have a distributed rate limiter. Before enabling the public write endpoint, add a platform-enforced rate limit for create, unlock, and update attempts (especially repeated failures) without recording plaintext names, messages, or passwords. The D1/auth bindings alone do not mitigate online guessing or write abuse.
