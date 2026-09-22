// The 14-unit camera projects the 11.9-unit paper folds to x=36 and x=444.
// Map these folds to x=0 and x=480, only within the wrapping-band region.
// The free tails below that region retain their original pixels and motion.
// After complete paper release the whole ribbon uses its original pixels.
import { RIBBON_BAND_BOTTOMS, RIBBON_BAND_SOURCE_SHA256 } from "./ribbon-band-regions.mjs";

export const RIBBON_EDGE_RATIO = 0.15;
export const RIBBON_EDGE_SCALE = 2;
export const ribbonSpanStyle = {
  "--ribbon-edge-slice": "15%",
  "--ribbon-edge-scale": 2,
  "--ribbon-left-band-bottom": `${RIBBON_BAND_BOTTOMS[0][0] / 1920 * 100}%`,
  "--ribbon-right-band-bottom": `${RIBBON_BAND_BOTTOMS[0][1] / 1920 * 100}%`,
};
export function drawRibbonFrame(context, frame, manifest, index = 0) {
  const { width, height } = manifest;
  context.clearRect(0, 0, width, height);
  if (manifest.schemaVersion !== 2 || manifest.framePack?.sha256 !== RIBBON_BAND_SOURCE_SHA256) {
    context.drawImage(frame, 0, 0, width, height);
    return;
  }
  const edge = width * RIBBON_EDGE_RATIO;
  const extended = edge * RIBBON_EDGE_SCALE;
  const [left, right] = (RIBBON_BAND_BOTTOMS[index] ?? [0, 0]).map((y) => y * height / 1920);
  context.drawImage(frame, 0, 0, width, height, 0, 0, width, height);
  if (left) {
    context.clearRect(0, 0, edge, left);
    context.drawImage(frame, 0, 0, edge, left, edge - extended, 0, extended, left);
  }
  if (right) {
    context.clearRect(width - edge, 0, edge, right);
    context.drawImage(frame, width - edge, 0, edge, right, width - edge, 0, extended, right);
  }
  // The final full-frame draw preserves the authored center and the existing
  // render-canary observation point after the composite is complete.
  context.clearRect(edge, 0, width - edge * 2, height);
  context.save();
  context.beginPath();
  context.rect(edge, 0, width - edge * 2, height);
  context.clip();
  context.drawImage(frame, 0, 0, width, height);
  context.restore();
}
