# Cloudflare deployment review

## Decision

Use a direct Cloudflare Worker Custom Domain for `https://wdcard.enmsoftware.com/`, with the existing client assets, Worker API, D1 binding, and upstream identity protection deployed as one Cloudflare-owned application boundary. Do not place `enm-server` or nginx in the request path unless a future requirement introduces a server-only dependency that Workers cannot provide.

This is an architecture recommendation only. DNS, Worker, D1, Access, secrets, and production deployment remain unapplied external effects.

## Fit with the current repository

- `dist/client/` contains the Vite SPA assets.
- `dist/server/index.js` is prepared from `worker/index.js`; it serves `/api/guestbook/*`, reads `env.GUESTBOOK_DB`, and falls back to the SPA shell for unknown HTML routes.
- `dist/.openai/hosting.json` declares the `GUESTBOOK_DB` D1 binding, while migrations are copied to `dist/.openai/drizzle/`.
- `/admin/guestbook` and `/api/guestbook/admin/*` already fail closed unless trusted gateway headers and exactly two deployment-only administrator addresses are configured.

Cloudflare Workers Static Assets deploys Worker code and static assets as one unit. A Custom Domain makes the Worker the origin for the full hostname and lets Cloudflare manage the required DNS record and certificate. D1 is exposed to the Worker through an environment binding, which matches the repository's `env.GUESTBOOK_DB` contract without another network hop.

## Direct Cloudflare versus enm-server reverse proxy

| Concern | Direct Worker Custom Domain | enm-server/nginx reverse proxy |
| --- | --- | --- |
| SPA and API | One Worker/static-assets deployment | Requires a separately operated origin or still proxies back to the Worker |
| Guestbook data | Native `GUESTBOOK_DB` D1 binding | D1 remains Worker-native, so nginx does not replace the Worker API |
| TLS and DNS | Custom Domain provisions DNS and certificates | Origin, proxy, certificates, health, and upgrades become additional operations |
| Admin identity | Protect the two admin paths at the edge; Worker still fails closed | Must preserve trusted identity headers across an extra proxy boundary |
| Failure surface | Cloudflare application boundary only | Adds enm-server availability, networking, and proxy configuration to the critical path |

The direct option is therefore the smaller deployment that preserves the current runtime contract. An enm-server reverse proxy is justified only if a later confirmed feature requires server-local storage, a private-network dependency, or another runtime unavailable on Workers. In that case, keep the public Worker boundary and proxy only the required narrow path rather than moving the whole invitation.

## Remaining decisions and runtime prerequisites

- Confirm the RSVP contract: collected fields, deadline, recipient, and retention policy. No RSVP UI or endpoint should be inferred before then.
- Confirm OG title/description/image and whether search indexing is allowed. The representative URL alone does not authorize discoverability.
- Provision the production Worker/static-assets project, D1 database and migrations, `GUESTBOOK_DB` binding, secrets, and exactly two administrator emails in the deployment environment.
- Apply upstream identity protection to both `/admin/guestbook` and `/api/guestbook/admin/*`, then verify that client-supplied identity headers cannot reach the Worker as trusted values.
- Attach `wdcard.enmsoftware.com` as a Worker Custom Domain only after checking that the hostname has no conflicting existing CNAME.

## Official references

- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Static Assets configuration and bindings](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare D1 getting started](https://developers.cloudflare.com/d1/get-started/)
- [Cloudflare Access path-specific policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
