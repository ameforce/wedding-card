// The fixed camera spans 14 world units, while the simulated paper spans 11.9.
// Its folds therefore project to 7.5% and 92.5% of each frame, including while
// the band passes behind the paper. Register those folds with the envelope
// edges: x=36 -> 0 and x=444 -> 480 on the authored 480px canvas.
// Stretch only the outer 15%; the central 70% containing the accepted knot
// and wings keeps its original pixels. Use this same mapping at every frame.
export const RIBBON_EDGE_RATIO = 0.15;
export const RIBBON_EDGE_SCALE = 2;
export const ribbonSpanStyle = {
  "--ribbon-edge-slice": `${RIBBON_EDGE_RATIO * 100}%`,
  "--ribbon-edge-scale": RIBBON_EDGE_SCALE,
};

export function drawRibbonFrame(context, frame, manifest) {
  const { width, height } = manifest;
  context.clearRect(0, 0, width, height);
  if (manifest.schemaVersion !== 2) {
    context.drawImage(frame, 0, 0, width, height);
    return;
  }
  const edge = width * RIBBON_EDGE_RATIO;
  const extended = edge * RIBBON_EDGE_SCALE;
  context.drawImage(frame, 0, 0, edge, height, edge - extended, 0, extended, height);
  context.drawImage(frame, width - edge, 0, edge, height, width - edge, 0, extended, height);
  context.save();
  context.beginPath();
  context.rect(edge, 0, width - 2 * edge, height);
  context.clip();
  // This final draw completes one frame and leaves its center pixel-identical.
  context.drawImage(frame, 0, 0, width, height);
  context.restore();
}
