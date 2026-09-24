# Admin media reliability and batch workflow (v1.17.3)

## Incident and evidence

The administrator reported 2 successful photos and 28 failures, all rendered as `콘텐츠 요청을 처리하지 못했습니다.`. The original HTTP status, edge response, request IDs and failed file bytes were not captured in that report. Consequently, this change does not claim to have classified every historical failure individually.

The release immediately preceding this change, v1.17.2, copied every original into a JavaScript `Uint8Array` before calling R2. Up to 90MiB of original bytes plus derivatives were held per upload before quota reservation. The preceding PR #96 documents an earlier JavaScript stream pump producing CPU-limit failures and notes that its replacement still needed a production bulk-upload retest. Removing the pump but retaining full-original buffering did not remove the resource-sensitive architecture. Cloudflare isolates have a 128MB memory limit shared by concurrent requests; buffering multiple camera originals is therefore unsafe.

Client-side error handling hid non-JSON edge failures behind one generic message, preventing the administrator from distinguishing HTTP failures, quota failures and expired authentication. The old cleanup path could also release the database reservation when the physical R2 deletion had failed, undercounting storage.

References: repository PR #96; Cloudflare Workers limits (`https://developers.cloudflare.com/workers/platform/limits/`); R2 native body example (`https://developers.cloudflare.com/r2/api/workers/workers-api-reference/`).

## Fundamental changes

1. The browser computes the exact original + 480px WebP + 960px WebP sizes before transfer. Camera images are decoded sequentially and their bitmaps are closed; preparation retains original file references and small derivatives rather than decoded full-resolution bitmaps.
2. A single authenticated metadata request atomically reserves the entire selection in D1 or rejects all of it. One materialized quota snapshot and a transaction cover concurrent tabs/administrators. The existing 2GiB shared quota, 90MiB original ceiling and 2/4MiB derivative ceilings remain enforced.
3. Each immutable object is uploaded as its own raw HTTP body. The Worker passes the original `request.body` directly to R2, with exact length/MIME checks, without JavaScript pumping, cloning, concatenation or full-original buffering.
4. Conditional R2 writes make retry attempts immutable. Completion verifies all three stored objects before changing the media set to `stored`; repeated completion is idempotent. The client retries only idempotent operations, not batch reservation.
5. Three photos upload concurrently. Completion order does not change gallery order. Authentication failure stops queued work without discarding successful in-flight uploads. Progress reports actual aggregate bytes and completed photo count.
6. Capacity is checked before preparation, after derivative generation, immediately before reservation, and atomically on the server. An insufficient selection sends no media bytes. The explicit selection summary includes exact bytes; selecting files no longer starts upload automatically.

## Deletion and failure safety

Stored media now has individual selection, select-all for deletable items and one confirmation dialog for a batch. The confirmation lists selected items and the union of archived revisions that will be permanently removed. Each deletion remains serialized through the existing server-side revision/CAS checks. Current published media, a draft hero and the last draft-gallery photo remain protected. Unsaved local references are checked again at confirmation. The server refuses newly introduced archived references that were absent from the approved confirmation snapshot.

Quota is released only after physical R2 deletion succeeds. Never-started upload sessions can be cancelled immediately. Started or ambiguous network uploads remain accounted for and can be cleaned through the existing stored-media stale-upload flow after one hour; this is intentionally not an automatic background deletion. Failed deletion remains retryable through durable deletion jobs.

A real-workerd test caught an additional integration issue: D1 can include foreign-key cascading changes in `meta.changes`, whereas the Node SQLite adapter returns direct changes. Cleanup now explicitly removes the upload-session row in the same transaction before the quota row, preserving deterministic guards in both runtimes.

Already-open old clients are supported only for framed photo bodies no larger than 1MiB. Larger legacy requests receive an explicit refresh-required response before large buffering. The new UI supports the unchanged 90MiB original ceiling. No authentication bypass, billing-plan change or extra deployment endpoint is introduced.

## Verification

- Unit coverage: atomic reservation (including concurrent callers and exact quota boundary), invalid metadata/MIME/length, unchanged native stream identity, immutable retries, idempotent completion, Access/origin enforcement, partial failures, retained quota, failed physical deletion/retry, archived-revision approval changes, parallelism/order/auth-stop and bitmap cleanup.
- Real Cloudflare workerd + local D1/R2: three concurrent 90MiB synthetic originals, their derivatives, completion, exact usage, deletion and zero remaining usage.
- Built production UI + Chromium + actual local workerd/D1/R2: 30 valid synthetic JPEGs, explicit preflight, 30 completed media sets, 90 R2 objects and exact database/object byte reconciliation. This uses disposable local storage and synthetic authentication, not production credentials.
- Built UI with controlled API responses: 360/390/430/768/1440px, published-media protection, bulk deletion, dialog focus, capacity changing between selection and upload, three active transfers, selected order, authentication fail-closed and no page errors. Evidence: `artifacts/qa/media-20260924/report.json` and matching screenshots in the working tree.
- Existing full UI regression suite, build, lint, additive migration check, Sites/Worker tests and Cloudflare dry-run remain required, followed by protected main-branch CI and production canaries.

## Deployment and data scope

Release through the existing hotfix/PR/main flow and protected GitHub Actions controller. Migration 0008 is additive and does not rewrite existing content. No user media or invitation revision was deleted or published to perform these tests. The user-reported original failed files were not supplied to this verification, and an authenticated production media upload must not be reported as passed merely from local tests or unauthenticated deployment canaries.

After deployment, refresh `/admin`, select photos, review required/remaining bytes, then press the explicit upload button. Use stored-media checkboxes and the batch confirmation to remove selected stored objects. A gallery-only removal continues to modify the document without deleting R2 objects.

## CI release-blocker follow-up

Run `36005208044` passed all photo/upload tests but failed the local warm-ribbon canary. Its diagnostic reported cover mount at about 4878ms and fail-open removal at about 5189ms, with no ribbon frames drawn. The test was serving cold Vite development transforms, while the application deliberately retains a five-second readiness deadline. The new large workerd and browser suites also ran concurrently with that timing-sensitive test in the shared CI runner. The sibling integration run `36005184163` passed the same source, demonstrating execution-sensitive rather than deterministic upload failure.

The test now serves the actual `dist/client` build through a loopback-only fixture, preserving the published bootstrap, exact SHA/version headers, production `connect-src 'self'` constraint and media aliases. Ribbon expectations are read from that built artifact rather than the source directory. Worker/Sites files run with `--test-concurrency=1` so 270MiB upload stress and separate browser processes do not consume the render test's startup budget. The upload stress test still exercises three concurrent originals internally.

No production timeout, animation, acceptance assertion, authentication boundary or deploy gate was relaxed. Regression checks require production bundle URLs, absence of Vite development modules, actual built asset responses and isolated suite execution. Runtime application files are unchanged by this follow-up.
