# Envelope visible-onset correction — 2026-09-25

## Root cause

The 1.18.0 change removed the explicit delay *after the transparent terminal frame*, not the gap after the ribbon actually left the viewport. It still waited for all 73 frames before starting paper motion.

The real frame alpha bounds and existing viewport transform show that at 390×844, the ribbon is outside the viewport at frame 53; frame 54 clears the conservative 16px safety margin. The transparent terminal is frame 72. At 30fps, those remaining invisible frames account for 600–633ms of apparent idle time. A zero timer after frame 72 cannot remove this gap.

## Correction

- Keep the accepted ribbon frames, pack, manifest, registration and hinge curves unchanged.
- Keep the 800ms paper duration unchanged.
- Bind measured alpha bounds to the exact immutable frame-pack SHA-256; reject stale/unknown bounds.
- Begin paper motion on the first displayed frame for which the current viewport and every remaining frame prove a 16px-clear exit.
- Continue all 73 frames in order alongside paper motion. Retire the already-exited ribbon surface so a later resize cannot reintroduce it.
- Pause both animation clocks when the document is hidden; finish only when both clocks complete. Keep fail-open watchdogs, skip cleanup and music-after-opening behavior.
- Unknown assets retain the conservative terminal-frame handoff.

## Verification contract

Tests recompute alpha bounds from the actual packed WebP bytes. Browser tests measure the actual exit, opening event and first visible 2px paper gap; a zero-delay event alone is insufficient. Production canaries retain every-frame/hash validation and additionally reject opening before exit, a post-exit wait above 120ms, or a visible gap delayed beyond 200ms.

The 390×900 Chromium render measured 21.8ms from clear exit to opening and 102.0ms to the first visible gap, with an 804.9ms paper lifetime and all 73 frames drawn. Timing varies by refresh rate and device; these are test measurements, not universal guarantees.
