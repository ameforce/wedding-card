# Prototype Instructions

## Wedding-card decisions

- Figma is optional and is not a source of truth. The rendered browser implementation is authoritative.
- Maintain one semantic component tree with `quiet` and `pastel` visual variants. Do not fork full pages or long-lived design branches.
- Never infer names, date, venue, contact, account, family relation, RSVP policy, or public copy.
- Design placeholders must stay visibly labeled and must be rejected by the default production build.
- Never generate people or likeness substitutes. Photo slots use non-person abstract design assets until supplied real photographs are approved.
- Approved real studio photographs may be cropped and responsively optimized, but people must never be AI-edited. Use actual 세상이 references only for the alternating left/right tuxedo-cat sticker cameos and provide a motion-free reduced-motion state. Preserve 세상이의 dominant yellow-green irises with only a close-inspection-level blue/cyan reflection.
- Validate both variants at 360, 390, 430, 768, and 1440px widths, including keyboard focus and reduced motion.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
