import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ribbonFrameExitedViewport, validateRibbonManifest } from "../src/intro/ribbon-player.mjs";

const directory = new URL("../public/assets/design/ribbon-sequence/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
validateRibbonManifest(manifest);
assert.equal(manifest.schemaVersion, 1, "The approved ribbon manifest uses schema version 1.");
assert.equal(manifest.fps, 30, "The approved ribbon motion uses 30 fps.");
assert.equal(manifest.width, 960, "The approved ribbon canvas width is 960px.");
assert.equal(manifest.height, 640, "The approved ribbon canvas height is 640px.");
assert.equal(manifest.frames.length, 75, "The approved ribbon sequence contains exactly 75 frames.");
assert.equal(manifest.releaseFrame, 31, "The approved ribbon releases at frame 31.");
assert.equal(manifest.holdMs, 600, "The approved tied-frame hold is 600ms.");
assert.equal(manifest.panelDelayMs, 300, "The approved paper-panel delay is 300ms.");
assert.equal(manifest.panelDurationMs, 1200, "The approved paper-panel duration is 1200ms.");
const maximumFrameSurfaces = 4 + 2 + 1; // cached frames, in-flight decodes, canvas backing store
assert.ok(manifest.width * manifest.height * 4 * maximumFrameSurfaces <= 32 * 1024 * 1024, "Frame surfaces must fit within 32 MiB (browser overhead excluded).");
const isV2 = manifest.schemaVersion === 2;
if (isV2) {
  assert.deepEqual(
    { aspect: manifest.height * 3 === manifest.width * 2, bounded: manifest.width >= 480 && manifest.width <= 960, fps: manifest.fps },
    { aspect: true, bounded: true, fps: 30 },
    "v2 must use the default canvas or one uniformly downscaled 3:2 canvas.",
  );
  assert.equal(manifest.holdMs, 800, "v2 must retain the 800 ms tied hold.");
  assert.equal(manifest.panelDelayMs, 600, "v2 must wait 600 ms after release before panels move.");
  assert.equal(manifest.panelDurationMs, 1400, "v2 panels must use the measured 1400 ms curve duration.");
  assert.ok(manifest.rootYPx.slice(0, manifest.releaseCompleteFrame + 1).every((value) => value === 0), "Root must remain still until complete release.");
}
assert.equal(new Set(manifest.frames).size, manifest.frames.length, "Frame names must be unique.");
const names = await readdir(directory);
assert.deepEqual(
  names.toSorted(),
  ["manifest.json", ...manifest.frames].toSorted(),
  "The published directory must contain exactly the manifest and its declared WebP frames.",
);

let bytes = 0;
const occupancy = [];
const alphaBounds = [];
for (const name of manifest.frames) {
  const buffer = await readFile(new URL(name, directory));
  const digest = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
  assert.ok(name.endsWith(`-${digest}.webp`), `${name}: filename must bind the frame content hash.`);
  bytes += buffer.byteLength;
  const metadata = await sharp(buffer).metadata();
  assert.equal(metadata.format, "webp", `${name}: expected WebP data.`);
  assert.equal(metadata.hasAlpha, true, `${name}: transparent alpha channel is required.`);
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, manifest.width, `${name}: canvas width drifted.`);
  assert.equal(info.height, manifest.height, `${name}: canvas height drifted.`);
  let nontransparent = 0;
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  for (let offset = 3, pixel = 0; offset < data.length; offset += 4, pixel += 1) {
    if (data[offset] === 0) continue;
    nontransparent += 1;
    const x = pixel % info.width;
    const y = Math.floor(pixel / info.width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  occupancy.push(nontransparent);
  alphaBounds.push(nontransparent ? { left, top, width: right - left + 1, height: bottom - top + 1 } : null);
}
assert.ok(occupancy[0] > 0, "The tied frame must be visible.");
assert.equal(occupancy.at(-1), 0, "The terminal frame must be fully transparent before paper opening.");
assert.ok(bytes <= 4 * 1024 * 1024, "The compressed public sequence must fit within 4 MiB.");
if (isV2) {
  const posterBytes = await readFile(new URL(manifest.frames[manifest.poster.frameIndex], directory));
  assert.equal(createHash("sha256").update(posterBytes).digest("hex"), manifest.poster.sha256, "v2 poster must bind F0's exact bytes.");
  const previousVisibleIndex = manifest.frames.length - 2;
  assert.ok(alphaBounds[previousVisibleIndex], "The frame before transparent terminal must still show the released ribbon.");
  for (const viewport of [
    { width: 360, height: 800 }, { width: 390, height: 844 }, { width: 430, height: 932 },
    { width: 768, height: 1024 }, { width: 1440, height: 900 },
  ]) {
    assert.equal(
      ribbonFrameExitedViewport(manifest, previousVisibleIndex, viewport, alphaBounds[previousVisibleIndex]),
      true,
      `The released ribbon must leave ${viewport.width}x${viewport.height} by 16px before the terminal frame.`,
    );
  }
}
console.log(JSON.stringify({
  passed: true, directory: fileURLToPath(directory), frameCount: manifest.frames.length,
  width: manifest.width, height: manifest.height, fps: manifest.fps, bytes,
  estimatedFrameSurfaceBytes: manifest.width * manifest.height * 4 * maximumFrameSurfaces,
  firstFrameNontransparentPixels: occupancy[0], terminalFrameNontransparentPixels: occupancy.at(-1),
  physicsAdmission: isV2 ? "v2-root-track-and-exit-verified" : "transitional-v1-not-v2",
}));
