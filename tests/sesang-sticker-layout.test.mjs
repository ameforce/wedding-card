import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing CSS rule: ${selector}`);
  return match[1];
}

function pixels(block, property) {
  const match = block.match(new RegExp(`${property}\\s*:\\s*(-?[\\d.]+)(?:px)?`));
  assert.ok(match, `Missing pixel declaration: ${property}`);
  return Number(match[1]);
}

test("peeking Sesang stickers keep every animated top and side edge inside their mask", async () => {
  const motion = rule(".sesang-sticker-motion");
  const wrapperWidth = pixels(motion, "width");
  const wrapperHeight = pixels(motion, "height");
  const padding = pixels(motion, "padding");
  const imageWidth = wrapperWidth - (padding * 2);
  const keyframe = css.match(/48%\s*\{\s*transform:\s*translateY\((-?[\d.]+)px\)\s*rotate\((-?[\d.]+)deg\)/);

  assert.equal(wrapperWidth, 108);
  assert.equal(wrapperHeight, 108);
  assert.equal(padding, 6);
  assert.match(motion, /overflow:\s*hidden/);
  assert.ok(keyframe, "Missing Sesang float apex");

  const translateY = Number(keyframe[1]);
  const radians = Math.abs(Number(keyframe[2])) * Math.PI / 180;

  for (const asset of ["sesang-left.webp", "sesang-right.webp"]) {
    const assetPath = fileURLToPath(new URL(`../public/assets/stickers/${asset}`, import.meta.url));
    const metadata = await sharp(assetPath).metadata();
    const imageHeight = imageWidth * metadata.height / metadata.width;
    const rotatedWidth = (imageWidth * Math.cos(radians)) + (imageHeight * Math.sin(radians));
    const rotatedHeight = (imageHeight * Math.cos(radians)) + (imageWidth * Math.sin(radians));
    const topClearance = padding + translateY - ((rotatedHeight - imageHeight) / 2);
    const sideClearance = padding - ((rotatedWidth - imageWidth) / 2);

    assert.ok(topClearance > 0, `${asset} clips vertically at the float apex`);
    assert.ok(sideClearance > 0, `${asset} clips horizontally at the float apex`);
  }
});

test("sticker presentation keeps the intended edge peek without a floating shadow", () => {
  assert.equal(pixels(rule(".sesang-cameo.is-left .sesang-sticker-motion"), "left"), -16);
  assert.equal(pixels(rule(".sesang-cameo.is-right .sesang-sticker-motion"), "right"), -16);
  assert.match(rule(".sesang-cameo img"), /filter:\s*none/);

  const sleep = rule(".sesang-cameo.is-sleep .sesang-sticker-motion");
  assert.equal(pixels(sleep, "left"), -10);
  assert.equal(pixels(sleep, "padding"), 0);
  assert.match(sleep, /overflow:\s*visible/);
});
