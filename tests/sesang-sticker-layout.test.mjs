import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing CSS rule: ${selector}`);
  return match[1];
}

test("the remaining Sesang cameo preserves its transparent alpha without a shadow or mask", async () => {
  const assetPath = fileURLToPath(new URL("../public/assets/stickers/sesang-left.webp", import.meta.url));
  const asset = await sharp(assetPath).metadata();
  const sticker = rule(".sesang-cameo img");
  const motion = rule(".sesang-sticker-motion");

  assert.equal(asset.hasAlpha, true);
  assert.match(sticker, /filter:\s*none/);
  assert.match(sticker, /background:\s*transparent/);
  assert.match(sticker, /box-shadow:\s*none/);
  assert.doesNotMatch(motion, /overflow\s*:/);
});

test("Sesang is an absolute gallery-edge decoration, not a standalone spacer section", () => {
  const cameo = rule(".sesang-cameo");
  const galleryCameo = rule(".quiet-gallery .sesang-cameo");

  assert.match(cameo, /position:\s*absolute/);
  assert.doesNotMatch(cameo, /height\s*:/);
  assert.match(rule(".quiet-gallery"), /position:\s*relative/);
  assert.match(galleryCameo, /top:\s*clamp\(/);
  assert.match(galleryCameo, /left:\s*clamp\(8px/);
  assert.match(galleryCameo, /width:\s*clamp\(/);
  assert.match(app, /<section className="quiet-gallery section-pad"[\s\S]*?<SesangCameo asset=\{SESANG_STICKERS\.left\} side="left" \/>[\s\S]*?<\/section>/);
  assert.equal((app.match(/<SesangCameo/g) ?? []).length, 1);
  assert.doesNotMatch(app, /is-sleep|SESANG_STICKERS\.right|SESANG_STICKERS\.sleep/);
});

test("Sesang float motion remains still when reduced motion is requested", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sesang-cameo img \{ animation:\s*none !important; \}/);
});
