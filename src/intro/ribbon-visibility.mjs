import { ribbonFrameExitedViewport } from "./ribbon-player.mjs";
import { RIBBON_ALPHA_TOPS, RIBBON_VISIBILITY_SOURCE_SHA256 } from "./ribbon-alpha-bounds.mjs";

// Bind measured pixels to the exact decoded asset pack. Unknown assets retain
// the safe terminal-frame handoff instead of guessing an exit time.
export function supportsMeasuredRibbonExit(manifest) {
  return manifest?.schemaVersion === 2 && manifest.framePack?.sha256 === RIBBON_VISIBILITY_SOURCE_SHA256
    && manifest.width === 480 && manifest.height === 1920
    && manifest.frames?.length === RIBBON_ALPHA_TOPS.length;
}

export function canOpenPaperAfterRibbonFrame(manifest, index, viewport) {
  if (!supportsMeasuredRibbonExit(manifest) || !Number.isInteger(index)
    || index < 0 || index >= RIBBON_ALPHA_TOPS.length - 1) return false;
  // Check the full remaining motion, not only one blank frame. A curl or tail
  // returning into view must never be mistaken for a completed visible exit.
  for (let frame = index; frame < RIBBON_ALPHA_TOPS.length; frame++) {
    const top = RIBBON_ALPHA_TOPS[frame];
    if (top !== null && !ribbonFrameExitedViewport(manifest, frame, viewport, { top })) return false;
  }
  return true;
}
