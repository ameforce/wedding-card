# Cloudflare deployment review

## Decision

Use a direct Cloudflare Worker Custom Domain for `https://wdcard.enmsoftware.com/`, with Worker Static Assets, D1, R2, and Access deployed as one Cloudflare-owned application boundary. `enm-server` has no origin, reverse-proxy, backup, mirror, or recovery role in this project.

This is the confirmed architecture decision. DNS, Worker, D1, R2, Access, secrets, and production deployment remain unapplied external effects.

## Fit with the current repository

- `dist/client/` contains the Vite SPA assets.
- `dist/server/index.js` is prepared from `worker/index.js`; it serves `/api/guestbook/*`, reads `env.GUESTBOOK_DB`, and falls back to the SPA shell for unknown HTML routes.
- `dist/.openai/hosting.json` declares the `GUESTBOOK_DB` D1 binding, while migrations are copied to `dist/.openai/drizzle/`.
- `/admin/guestbook` and `/api/guestbook/admin/*` already fail closed unless trusted gateway headers and exactly two deployment-only administrator addresses are configured.

Cloudflare Workers Static Assets deploys Worker code and static assets as one unit. A Custom Domain makes the Worker the origin for the full hostname and lets Cloudflare manage the required DNS record and certificate. D1 is exposed to the Worker through an environment binding, which matches the repository's `env.GUESTBOOK_DB` contract without another network hop.

## Cloudflare-only boundary

- Static application code is deployed through Worker Static Assets.
- Public invitation content and revision metadata will be stored in D1 so administrator edits do not require a code deployment.
- Uploaded originals and optimized image revisions will be stored in a private R2 bucket.
- `/admin/*` and `/api/admin/*` will be protected by Access, with the Worker independently validating the Access JWT and the exact two-email allowlist.
- Content editing will use draft, preview, publish, and rollback states rather than publishing every keystroke.

Changing React components, validation rules, Worker behavior, or the data schema still requires a code deployment. Editing an already modeled phrase, event value, image, order, crop position, or alt text does not.

This project intentionally accepts Cloudflare as its only production data plane and does not add a separate backup system. D1 Time Travel and immutable R2 revision keys are recovery conveniences within Cloudflare, not a second backup architecture.

## Remaining decisions and runtime prerequisites

- Confirm the RSVP contract: collected fields, deadline, recipient, and retention policy. No RSVP UI or endpoint should be inferred before then.
- Confirm OG title/description/image. Search indexing is fixed off through the HTML robots meta, Static Assets `_headers`, and the Worker `X-Robots-Tag` response header. Keeping both header paths covers Cloudflare's default asset-first delivery and Worker-generated responses without requiring every static request to invoke the Worker.
- Do not add `Disallow: /` for the public HTML: search crawlers must be able to read the `noindex` directive. This is indexing control, not access control; anyone with the URL can still open the invitation.
- Provision the production Worker/static-assets project, D1 database and migrations, `GUESTBOOK_DB` binding, secrets, and exactly two administrator emails in the deployment environment.
- Apply upstream identity protection to both `/admin/guestbook` and `/api/guestbook/admin/*`, then verify that client-supplied identity headers cannot reach the Worker as trusted values.
- Attach `wdcard.enmsoftware.com` as a Worker Custom Domain only after checking that the hostname has no conflicting existing CNAME.

## Official references

- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Static Assets configuration and bindings](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare D1 getting started](https://developers.cloudflare.com/d1/get-started/)
- [Cloudflare Access path-specific policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
