# Cloudflare deployment review

## Decision

Use a direct Cloudflare Worker Custom Domain for `https://wdcard.enmsoftware.com/`, with Worker Static Assets, D1, R2, and Access deployed as one Cloudflare-owned application boundary. `enm-server` has no origin, reverse-proxy, backup, mirror, or recovery role in this project.

This is the confirmed architecture decision. Production is live at `https://wdcard.enmsoftware.com/` with the D1 content-revision API, private R2 media contract, Access JWT verification, and content/guestbook administrator UI. The production bindings and custom domain in `wrangler.jsonc` are the deployment source of truth; sensitive Access values remain deployment-only secrets.

## Fit with the current repository

- `dist/client/` contains the Vite SPA assets.
- `dist/server/index.js` is prepared from `worker/index.js`; it serves `/api/guestbook/*`, `/api/content`, `/api/admin/*`, and private-R2-backed `/api/media/*`, then falls back to the SPA shell for unknown HTML routes.
- `dist/.openai/hosting.json` declares the `GUESTBOOK_DB` D1 binding and `WEDDING_MEDIA` R2 binding, while migrations are copied to `dist/.openai/drizzle/`.
- `/admin/guestbook`, `/admin/content`, and their administrator APIs fail closed unless the Cloudflare Access JWT signature, issuer, audience, expiry, and exact two-address deployment allowlist are valid.
- Public guestbook writes fail closed in production unless the Wrangler `GUESTBOOK_RATE_LIMITER` binding is present; counter keys never contain plaintext visitor names.

Cloudflare Workers Static Assets deploys Worker code and static assets as one unit. A Custom Domain makes the Worker the origin for the full hostname and lets Cloudflare manage the required DNS record and certificate. D1 is exposed to the Worker through an environment binding, which matches the repository's `env.GUESTBOOK_DB` contract without another network hop.

## Cloudflare-only boundary

- Static application code is deployed through Worker Static Assets.
- Public invitation content and revision metadata are stored in D1 so administrator edits do not require a code deployment.
- Uploaded originals and optimized image revisions are stored in a private R2 bucket.
- Media uploads are reserved atomically in D1 and capped at 2GiB for the entire project before any R2 write. `/admin/content` shows used and remaining capacity; individual originals remain capped at 25MB and each three-file revision at 30MB.
- `/admin/*` and `/api/admin/*` are protected by Access, with the Worker independently validating the Access JWT and the exact two-email allowlist.
- Content editing uses explicit local/admin draft, preview, and publish states rather than publishing every keystroke. Published D1 revisions and immutable R2 keys provide the rollback substrate; the first production admin release may expose rollback only after its review interaction is accepted.

Changing React components, validation rules, Worker behavior, or the data schema still requires a code deployment. Editing an already modeled phrase, event value, image, order, crop position, or alt text does not.

This project intentionally accepts Cloudflare as its only production data plane and does not add a separate backup system. D1 Time Travel and immutable R2 revision keys are recovery conveniences within Cloudflare, not a second backup architecture.

## Runtime acceptance and operations

- RSVP is confirmed disabled. Keep the public UI, Worker routes, storage, and admin surface free of attendance-response collection.
- OG title, description, and the 1200×630 JPEG are confirmed. Search indexing is fixed off through the HTML robots meta, Static Assets `_headers`, and the Worker `X-Robots-Tag` response header. Keeping both header paths covers Cloudflare's default asset-first delivery and Worker-generated responses without requiring every static request to invoke the Worker.
- Do not add `Disallow: /` for the public HTML: search crawlers must be able to read the `noindex` directive. This is indexing control, not access control; anyone with the URL can still open the invitation.
- Add an account-level USD 1 budget alert as a secondary notification. It is not a hard stop; the 2GiB application quota is the cost-control boundary.
- Keep Access protection on `/admin/*`, `/api/admin/*`, and `/api/guestbook/admin/*`. `ADMIN_AUTH_MODE=cloudflare-access-jwt`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and the exact two-address `WEDDING_ADMIN_EMAILS` allowlist must remain deployment-only; never put those values in client code.
- `wrangler.jsonc` records the provisioned D1 identifier and R2 bucket name. Treat unexpected changes to either binding as a deployment review event.
- Keep `workers.dev` and preview URLs disabled so the Custom Domain cannot be bypassed through another public route.
- After every production deployment, read back the active Worker version and run authenticated administrator plus public-content canaries before closing the release.

## Official references

- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Static Assets configuration and bindings](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare D1 getting started](https://developers.cloudflare.com/d1/get-started/)
- [Cloudflare Access path-specific policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
