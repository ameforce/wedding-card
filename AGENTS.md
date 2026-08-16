# Prototype Instructions

## Wedding-card decisions

- Figma is optional and is not a source of truth. The rendered browser implementation is authoritative.
- Maintain one semantic component tree with `quiet` and `pastel` visual variants. Do not fork full pages or long-lived design branches.
- Never infer names, date, venue, contact, account, family relation, RSVP policy, or public copy.
- Design placeholders must stay visibly labeled and must be rejected by the default production build.
- Never generate people or likeness substitutes. Photo slots use non-person abstract design assets until supplied real photographs are approved.
- Approved real studio photographs may be cropped and responsively optimized, but people must never be AI-edited. Use actual 세상이 references only for the alternating left/right tuxedo-cat sticker cameos and provide a motion-free reduced-motion state. Preserve 세상이의 dominant yellow-green irises with only a close-inspection-level blue/cyan reflection.
- Preserve the stickers' genuine transparent alpha and intentional horizontal edge peeking. Their float motion must not clip nontransparent top or side edges at any phase, and CSS must not add a drop shadow or matte halo that makes the sticker background appear detached.
- Treat typography alignment as acceptance-critical: verify mixed Korean/Latin baselines, optical alignment of decorative separators, and matching title/icon centerlines in repeated controls at every required viewport.
- Confirmed ceremony facts are `김종인` and `유지혜`, `2026년 12월 27일 일요일 오후 3시` in `Asia/Seoul`, `더 바실리움`, and `경기 성남시 분당구 양현로 322`. Keep `Asia/Seoul` for calendar semantics, but omit `KST` from domestic Korean invitation, copy, and share text.
- Quiet Editorial uses a readable December 2026 calendar with Sunday 27 emphasized and the concise ceremony time. Cat decoration must stay absolutely placed inside natural section whitespace; never reserve standalone spacer regions for it.
- Pastel Letter omits a separate event timeline, gives the existing story a full-width readable mobile treatment, and uses larger portrait-oriented gallery tiles that open an accessible close/previous/next lightbox with mobile swipe navigation. Its utility and venue actions must read as independent soft controls, not coupon-like rows divided by separators.
- Quiet and Pastel photographs share one accessible lightbox behavior. Keep its backdrop in the active invitation's light paper/pastel tone rather than introducing a dark gallery surface.
- Pastel's watercolor hero and invitation body must read as one continuous pastel surface without a divider above `INVITATION`. Keep one calendar action near the invitation and one share action near the footer; do not restore duplicate copy or calendar controls.
- A venue-map screenshot may render only from the local real asset contract with descriptive alt text and preserved source attribution. Never restore a fictional design map.
- Integrate map attribution into the map card using natural invitation copy such as `카카오맵 제공`; do not render it as a detached report-style note.
- Mobile readability is acceptance-critical. Do not preserve mockup-scale microtype when it becomes difficult to read on a physical phone.
- Activate safe client-side utilities as soon as their required facts are confirmed. A start-only iCalendar event must omit `DTEND` rather than infer an end time; contact remains unavailable until a real contact is supplied.
- Calendar and invitation sharing must prefer capability-checked native Web Share behavior from a direct user action. Treat cancellation as final; use an explicit `.ics` download or copy fallback when sharing is unavailable, insecure, blocked, or fails, and never claim that the web can force a specific default calendar app across platforms.
- Validate both variants at 360, 390, 430, 768, and 1440px widths, including keyboard focus and reduced motion.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
