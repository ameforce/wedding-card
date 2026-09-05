import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { validateRibbonManifest } from "../src/intro/ribbon-player.mjs";

const directory = new URL("../public/assets/design/ribbon-sequence/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
validateRibbonManifest(manifest);
assert.equal(manifest.fps, 30, "The approved ribbon motion uses 30 fps.");
const maximumFrameSurfaces = 4 + 2 + 1; // cached frames, in-flight decodes, canvas backing store
assert.ok(manifest.width * manifest.height * 4 * maximumFrameSurfaces <= 32 * 1024 * 1024, "Frame surfaces must fit within 32 MiB (browser overhead excluded).");
assert.equal(new Set(manifest.frames).size, manifest.frames.length, "Frame names must be unique.");
const names = await readdir(directory);
assert.equal(names.filter((name) => name.endsWith(".webp")).length, manifest.frames.length, "The published directory must contain only this sequence's frames.");

let bytes = 0;
const occupancy = [];
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
  for (let offset = 3; offset < data.length; offset += 4) if (data[offset] !== 0) nontransparent += 1;
  occupancy.push(nontransparent);
}
assert.ok(occupancy[0] > 0, "The tied frame must be visible.");
assert.equal(occupancy.at(-1), 0, "The terminal frame must be fully transparent before paper opening.");
assert.ok(bytes <= 4 * 1024 * 1024, "The compressed public sequence must fit within 4 MiB.");
console.log(JSON.stringify({
  passed: true, directory: fileURLToPath(directory), frameCount: manifest.frames.length,
  width: manifest.width, height: manifest.height, fps: manifest.fps, bytes,
  estimatedFrameSurfaceBytes: manifest.width * manifest.height * 4 * maximumFrameSurfaces,
  firstFrameNontransparentPixels: occupancy[0], terminalFrameNontransparentPixels: occupancy.at(-1),
}));
