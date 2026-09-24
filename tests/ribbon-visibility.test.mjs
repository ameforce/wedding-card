import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { RIBBON_ALPHA_TOPS, RIBBON_VISIBILITY_SOURCE_SHA256 } from "../src/intro/ribbon-alpha-bounds.mjs";
import { canOpenPaperAfterRibbonFrame } from "../src/intro/ribbon-visibility.mjs";
import { calculateRootTranslation } from "../src/intro/ribbon-player.mjs";
const dir = new URL("../public/assets/design/ribbon-sequence/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", dir), "utf8"));

test("visible-exit bounds match every actual immutable packed frame", async () => {
  const pack = await readFile(new URL(manifest.framePack.file, dir));
  assert.equal(createHash("sha256").update(pack).digest("hex"), RIBBON_VISIBILITY_SOURCE_SHA256);
  const tops = [];
  let offset = 0;
  for (const length of manifest.framePack.lengths) {
    const { data, info } = await sharp(pack.subarray(offset, offset + length)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let top = null;
    for (let index = 3; index < data.length; index += 4) if (data[index]) { top = Math.floor((index - 3) / 4 / info.width); break; }
    tops.push(top);
    offset += length;
  }
  assert.deepEqual(tops, RIBBON_ALPHA_TOPS);
  assert.equal(offset, pack.length);
});

test("paper starts at the actual viewport exit, without changing any ribbon frame", () => {
  for (const width of [360, 390, 430, 768, 1440]) for (const height of [640, 844, 1200, 3000]) {
    const viewport = { width, height };
    const first = manifest.frames.findIndex((_, index) => canOpenPaperAfterRibbonFrame(manifest, index, viewport));
    assert.ok(first > 0 && first < manifest.frames.length - 1);
    assert.equal(canOpenPaperAfterRibbonFrame(manifest, first - 1, viewport), false);
    const scale = Math.min(width, 430) / manifest.width;
    for (let index = first; index < manifest.frames.length - 1; index++) {
      const top = height / 2 - manifest.registration.y * scale + calculateRootTranslation(manifest, index, viewport).y + RIBBON_ALPHA_TOPS[index] * scale;
      assert.ok(top >= height + 16, `${width}x${height} frame ${index} must remain outside`);
    }
    if (width === 390 && height === 844) assert.equal(first, 54);
    if (width === 390 && height === 1200) assert.equal(first, 61);
  }
});

test("unknown or stale measured assets fall back to the terminal-frame handoff", () => {
  for (const altered of [{ ...manifest, framePack: undefined }, { ...manifest, framePack: { sha256: "unknown" } }, { ...manifest, width: 960 }, { ...manifest, frames: manifest.frames.slice(1) }]) {
    assert.equal(canOpenPaperAfterRibbonFrame(altered, 61, { width: 390, height: 844 }), false);
  }
  for (const index of [-1, 0.5, 72, 73, NaN]) assert.equal(canOpenPaperAfterRibbonFrame(manifest, index, { width: 390, height: 844 }), false);
});
