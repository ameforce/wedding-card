# Cloudflare deployment review

## Decision

Use a direct Cloudflare Worker Custom Domain for `https://wdcard.enmsoftware.com/`, with Worker Static Assets, D1, R2, and Access deployed as one Cloudflare-owned application boundary. `enm-server` has no origin, reverse-proxy, backup, mirror, or recovery role in this project.

This is the confirmed architecture decision. Production is live at `https://wdcard.enmsoftware.com/` with the D1 content-revision API, private R2 media contract, Access JWT verification, and content/guestbook administrator UI. The production bindings and custom domain in `wrangler.jsonc` are the deployment source of truth; sensitive Access values remain deployment-only secrets.

GitHub Actions is the sole production deployment controller. ENM Jenkins and Cloudflare Git Builds are intentionally outside this project's deploy path. Pull requests receive validation only and never receive Cloudflare credentials; a protected `main` push runs the serialized production deployment in the GitHub `production` Environment.

## GitHub Actions deployment contract

`.github/workflows/cloudflare.yml` pins GitHub-owned actions to full commit SHAs and uses the exact Node version in `.node-version`. Its two jobs are deliberately separated:

1. `Verify` runs for pull requests to `develop` or `main`, and again for `main`: locked install, migration policy, lint, UI tests, one production build, Worker tests, and a Wrangler dry-run. On `main`, it seals the built Static Assets plus the Worker, Wrangler configuration, migrations, lock metadata, and credential-bearing deployment scripts with a per-file SHA-256 manifest and GNU-compatible checksum document, then uploads the exact Static Assets artifact through a full-SHA-pinned GitHub action.
2. `Deploy production` runs only after a successful `main` push verification. It downloads the same-run SHA-named artifact, relies on GitHub's artifact digest validation, and verifies every sealed build and deployment input with the runner's `sha256sum` both before and after the credential-free install and migration check. It does not rebuild, and it uploads the verified standalone Worker with Wrangler bundling disabled. Only then does it record the active Worker version and a D1 Time Travel bookmark, apply additive D1 migrations, upload and activate a Worker version tagged with the 40-character Git SHA, read the active version back, and run the bounded production canary. Before visual assertions, the canary polls fresh custom-domain HTML responses until both their version-metadata tag and version ID match that exact control-plane read-back, and it reports every observed pair if convergence fails. Cloudflare credentials exist only on the individual steps that call the Cloudflare control plane. The version-only path preserves the already provisioned Custom Domain and does not require or mutate Zone routes.

The GitHub `production` Environment must be restricted to `main` and contain only these secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`: a dedicated, expiring token scoped to this account with Workers Scripts Write, D1 Write, Workers R2 Storage Write, Account Settings Read, and Access: Apps and Policies Read. It intentionally has no Zone permission because CI must not mutate the Custom Domain route. Do not reuse a human global API key.

Protect `main` so changes arrive through a pull request and require the `Verify` check. Keep force pushes and branch deletion disabled. Repository Actions policy should allow GitHub-owned actions only and require actions to be pinned to a full commit SHA.

The deploy job never receives a Cloudflare Access administrator JWT. Its unattended canary therefore proves public delivery and security headers, the guestbook create/unlock/update lifecycle, remote D1 persistence and exact cleanup, plus unauthenticated administrator rejection. It must report the administrator result as `access-denied`, not as an authenticated administrator read. The latter remains an attended check with a short-lived allowlisted Access token.

An attended standalone `npm run canary:production` reads the current active Worker tag and exact version ID from the Cloudflare control plane when the two GitHub Actions identity variables are absent, then proves that the custom domain serves that pair. It therefore requires the same narrowly scoped Cloudflare credentials already needed for remote D1 read-back. Supplying only one identity variable is rejected. Direct production deployment scripts are intentionally unsupported; production changes flow only through the protected `main` GitHub Actions workflow.

If a check after `wrangler deploy` fails, the workflow rolls Worker traffic back to the exact version captured before deployment and verifies that version is active. It does not automatically restore D1: `scripts/check-d1-migrations.mjs` allows only additive, backward-compatible migration forms so the previous Worker can continue operating. Use the recorded D1 bookmark only for an explicitly reviewed recovery operation.

## Fit with the current repository

- `dist/client/` contains the Vite SPA assets.
- `dist/server/index.js` is prepared from `worker/index.js`; it serves `/api/guestbook/*`, `/api/content`, `/api/admin/*`, and private-R2-backed `/api/media/*`, then falls back to the SPA shell for unknown HTML routes.
- `dist/.openai/hosting.json` declares the `GUESTBOOK_DB` D1 binding and `WEDDING_MEDIA` R2 binding, while migrations are copied to `dist/.openai/drizzle/`.
- `/admin`, `/admin/guestbook`, and their administrator APIs fail closed unless the Cloudflare Access JWT signature, issuer, audience, expiry, and exact two-address deployment allowlist are valid. Exact `GET` and `HEAD /admin/content` requests permanently redirect to `/admin` with the query string preserved; `/api/admin/content` remains unchanged.
- Public guestbook writes fail closed in production unless the required Wrangler caller and credential limiter bindings are present; counter keys never contain plaintext visitor addresses or names.

Cloudflare Workers Static Assets deploys Worker code and static assets as one unit. A Custom Domain makes the Worker the origin for the full hostname and lets Cloudflare manage the required DNS record and certificate. D1 is exposed to the Worker through an environment binding, which matches the repository's `env.GUESTBOOK_DB` contract without another network hop.

## Cloudflare-only boundary

- Static application code is deployed through Worker Static Assets.
- Public invitation content and revision metadata are stored in D1 so administrator edits do not require a code deployment.
- Uploaded originals, optimized image revisions, and background MP3 files are stored under immutable keys in a private R2 bucket. Public image and audio responses are exposed only through `/api/media/*`; audio supports `GET`, `HEAD`, and single byte ranges.
- Photo and audio uploads are reserved atomically in D1 and share a 2GiB project cap before any R2 write. `/admin` shows used and remaining capacity; image originals and MP3 files remain capped at 25MB, while each three-file image revision remains capped at 30MB.
- Exact `/admin`, `/admin/*`, and `/api/admin/*` are protected by Access, with the Worker independently validating the Access JWT and the exact two-email allowlist.
- Content editing uses explicit local/admin draft, preview, and publish states rather than publishing every keystroke. Published D1 revisions and immutable R2 keys provide the rollback substrate; the first production admin release may expose rollback only after its review interaction is accepted.

Changing React components, validation rules, Worker behavior, or the data schema still requires a code deployment. Editing an already modeled phrase, event value, image, music file, music credit, order, crop position, or alt text does not.

This project intentionally accepts Cloudflare as its only production data plane and does not add a separate backup system. D1 Time Travel and immutable R2 revision keys are recovery conveniences within Cloudflare, not a second backup architecture.

## Runtime acceptance and operations

- The Worker upgrades every HTTP request for `wdcard.enmsoftware.com` to the same HTTPS path and query with `308` before reading a body or accessing application bindings. Local development and other Sites hosts retain their existing behavior. Upgrading the document prevents CSP `upgrade-insecure-requests` from moving only the module script across origins and leaving an HTTP invitation blank.
- The production render canary must independently probe HTTP `GET` and `HEAD` with redirects disabled and require the server's exact HTTPS `Location` and deployed Worker identity. A browser's internal `307 HttpsUpgrades` is not server redirect evidence. Verify the final HTTPS document, revision, hero, and errors after entry; retain the normal HTTPS warm/cold scenarios.

- RSVP is confirmed disabled. Keep the public UI, Worker routes, storage, and admin surface free of attendance-response collection.
- OG title, description, and the 1200×630 JPEG are confirmed. Search indexing is fixed off through the HTML robots meta, Static Assets `_headers`, and the Worker `X-Robots-Tag` response header. Keeping both header paths covers Cloudflare's default asset-first delivery and Worker-generated responses without requiring every static request to invoke the Worker.
- Do not add `Disallow: /` for the public HTML: search crawlers must be able to read the `noindex` directive. This is indexing control, not access control; anyone with the URL can still open the invitation.
- Add an account-level USD 1 budget alert as a secondary notification. It is not a hard stop; the 2GiB application quota is the cost-control boundary.
- Keep Access protection on exact `/admin`, `/admin/*`, `/api/admin/*`, and `/api/guestbook/admin/*`. The exact `/admin` application entry must be read back before deployment; `/admin/*` alone is insufficient proof for the root path. `ADMIN_AUTH_MODE=cloudflare-access-jwt`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and the exact two-address `WEDDING_ADMIN_EMAILS` allowlist must remain deployment-only; never put those values in client code.
- Production CI runs `npm run verify:cloudflare-access` before uploading a Worker version. The check fails closed unless one self-hosted Access application contains all four administrator destinations, has an allow policy, and has no bypass policy. Its token therefore requires `Access: Apps and Policies Read`.
- Roll out the URL migration in two protected `main` deployments: first keep `ADMIN_CONTENT_REDIRECT_ENABLED=false` so both `/admin` and `/admin/content` serve the editor, then set it to `true` only after the first version and Access boundary pass production canaries. This makes the first version a safe rollback target for cached `308` responses.
- `wrangler.jsonc` records the provisioned D1 identifier and R2 bucket name. Treat unexpected changes to either binding as a deployment review event.
- Keep `workers.dev` and preview URLs disabled so the Custom Domain cannot be bypassed through another public route.
- After every production deployment, read back the active Worker version and run `npm run canary:production` before closing the release. The render canary first proves bounded custom-domain convergence to the exact Git SHA version tag and exact active version ID, then checks HTTP-entry, warm-cache, and delayed-cold rendering against that same pair. Each scenario includes an explicit final computed-style sample after the transition window because MutationObserver events do not observe CSS-only opacity progress, and a validation failure preserves the named scenario plus response, DOM, and network diagnostics. The canary next checks the public invitation and security headers, creates one uniquely named synthetic guestbook row, unlocks and updates it with its transient password, verifies the D1 write, checks the administrator boundary, then deletes only that owned row and proves zero residue. It fails closed if version convergence or cleanup cannot be proved and never prints its password or administrator token.

## Post-deploy live canary

The full authenticated canary requires an explicit production-write gate and a short-lived Cloudflare Access JWT belonging to one of the two allowlisted administrators. Supply the JWT only through the process environment; never commit it, place it in a command argument, or persist it in a `.env` file:

```powershell
$env:WEDDING_CANARY_ALLOW_PRODUCTION_WRITE = "1"
$env:WEDDING_CANARY_ACCESS_TOKEN = "<short-lived Access JWT>"
npm run canary:production
Remove-Item Env:\WEDDING_CANARY_ACCESS_TOKEN
Remove-Item Env:\WEDDING_CANARY_ALLOW_PRODUCTION_WRITE
```

For an attended operator run where the administrator UI is checked separately in an already authenticated browser, set `WEDDING_CANARY_ALLOW_D1_ADMIN_READ=1` instead of an Access token. That reduced mode still proves the public lifecycle, remote D1 persistence, exact cleanup, and that the administrator endpoint rejects an unauthenticated request; it does not claim an authenticated administrator API read. `npm run deploy:cloudflare:verified` deliberately inherits the same gates so a deployment cannot be reported verified after silently skipping them.

## Official references

- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Static Assets configuration and bindings](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare D1 getting started](https://developers.cloudflare.com/d1/get-started/)
- [Cloudflare Access path-specific policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
