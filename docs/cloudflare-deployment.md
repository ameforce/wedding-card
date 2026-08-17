# Cloudflare deployment review

## Decision

Use a direct Cloudflare Worker Custom Domain for `https://wdcard.enmsoftware.com/`, with Worker Static Assets, D1, R2, and Access deployed as one Cloudflare-owned application boundary. `enm-server` has no origin, reverse-proxy, backup, mirror, or recovery role in this project.

This is the confirmed architecture decision. The repository now implements the D1 content-revision API, private R2 media contract, Access JWT verification, and reviewable content-admin UI. DNS, Worker resources, Access policies, secrets, and production deployment remain unapplied external effects until the administrator review gate passes.

## Fit with the current repository

- `dist/client/` contains the Vite SPA assets.
- `dist/server/index.js` is prepared from `worker/index.js`; it serves `/api/guestbook/*`, `/api/content`, `/api/admin/*`, and private-R2-backed `/api/media/*`, then falls back to the SPA shell for unknown HTML routes.
- `dist/.openai/hosting.json` declares the `GUESTBOOK_DB` D1 binding and `WEDDING_MEDIA` R2 binding, while migrations are copied to `dist/.openai/drizzle/`.
- `/admin/guestbook`, `/admin/content`, and their administrator APIs fail closed unless the Cloudflare Access JWT signature, issuer, audience, expiry, and exact two-address deployment allowlist are valid.
- Public guestbook writes fail closed in production unless the Wrangler `GUESTBOOK_RATE_LIMITER` binding is present; counter keys never contain plaintext visitor names.

Cloudflare Workers Static Assets deploys Worker code and static assets as one unit. A Custom Domain makes the Worker the origin for the full hostname and lets Cloudflare manage the required DNS record and certificate. D1 is exposed to the Worker through an environment binding, which matches the repository's `env.GUESTBOOK_DB` contract without another network hop.

## Cloudflare-only boundary

- Static application code is deployed through Worker Static Assets.
- Public invitation content and revision metadata will be stored in D1 so administrator edits do not require a code deployment.
- Uploaded originals and optimized image revisions will be stored in a private R2 bucket.
- Media uploads are reserved atomically in D1 and capped at 2GiB for the entire project before any R2 write. `/admin/content` shows used and remaining capacity; individual originals remain capped at 25MB and each three-file revision at 30MB.
- `/admin/*` and `/api/admin/*` will be protected by Access, with the Worker independently validating the Access JWT and the exact two-email allowlist.
- Content editing uses explicit local/admin draft, preview, and publish states rather than publishing every keystroke. Published D1 revisions and immutable R2 keys provide the rollback substrate; the first production admin release may expose rollback only after its review interaction is accepted.

Changing React components, validation rules, Worker behavior, or the data schema still requires a code deployment. Editing an already modeled phrase, event value, image, order, crop position, or alt text does not.

This project intentionally accepts Cloudflare as its only production data plane and does not add a separate backup system. D1 Time Travel and immutable R2 revision keys are recovery conveniences within Cloudflare, not a second backup architecture.

## Remaining decisions and runtime prerequisites

- RSVP is confirmed disabled. Keep the public UI, Worker routes, storage, and admin surface free of attendance-response collection.
- OG title, description, and the 1200×630 JPEG are confirmed. Search indexing is fixed off through the HTML robots meta, Static Assets `_headers`, and the Worker `X-Robots-Tag` response header. Keeping both header paths covers Cloudflare's default asset-first delivery and Worker-generated responses without requiring every static request to invoke the Worker.
- Do not add `Disallow: /` for the public HTML: search crawlers must be able to read the `noindex` directive. This is indexing control, not access control; anyone with the URL can still open the invitation.
- Provision the production Worker/static-assets project, D1 database and all migrations, `GUESTBOOK_DB` binding, private `WEDDING_MEDIA` R2 bucket, and Access runtime values in the deployment environment.
- Add an account-level USD 1 budget alert as a secondary notification. It is not a hard stop; the 2GiB application quota is the cost-control boundary.
- `wrangler.jsonc` intentionally uses Wrangler automatic provisioning for the initial D1/R2 creation by declaring only the bindings. The first authenticated deploy writes the generated D1 identifiers and R2 bucket name back to the config; review and commit that deterministic write-back before treating the deployment state as closed.
- Apply Access protection to `/admin/*`, `/api/admin/*`, and `/api/guestbook/admin/*`. Configure `ADMIN_AUTH_MODE=cloudflare-access-jwt`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and the exact two-address `WEDDING_ADMIN_EMAILS` allowlist; never put those values in client code.
- Disable or equally protect the direct `workers.dev` hostname, then verify the Custom Domain cannot be bypassed through another route.
- Attach `wdcard.enmsoftware.com` as a Worker Custom Domain only after checking that the hostname has no conflicting existing CNAME.

## Official references

- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Static Assets configuration and bindings](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare D1 getting started](https://developers.cloudflare.com/d1/get-started/)
- [Cloudflare Access path-specific policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
