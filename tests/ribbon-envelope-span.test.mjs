import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import sharp from "sharp";
import { createServer } from "vite";

test("ribbon reaches only the envelope folds through the initial poster and canvas handoff", { timeout: 120_000 }, async (t) => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const evidence = [];
  for (const width of [360, 390, 430, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    let releaseMain;
    const gate = new Promise((resolve) => { releaseMain = resolve; });
    await page.route("**/src/main.jsx*", async (route) => { await gate; await route.continue().catch(() => {}); });
    try {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "commit" });
      await page.locator("#pastel-intro-early-poster img").first().evaluate((image) => image.decode());
      const earlyFull = await page.screenshot();
      const isolate = await page.addStyleTag({ content: `html,body{background:transparent!important} body *{visibility:hidden!important} #pastel-intro-early-poster:not([data-handoff="claimed"]) .pastel-intro-cover__ribbon-window, #pastel-intro-early-poster:not([data-handoff="claimed"]) .pastel-intro-cover__ribbon-window *, .pastel-intro-cover .pastel-intro-cover__ribbon-window, .pastel-intro-cover .pastel-intro-cover__ribbon-window *{visibility:visible!important}` });
      const early = await page.screenshot({ omitBackground: true });
      releaseMain();
      await page.waitForFunction(() => {
        if (document.querySelector("#pastel-intro-early-poster")?.dataset.handoff !== "claimed") return false;
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        return true;
      });
      const runtime = await page.screenshot({ omitBackground: true });
      const bounds = await page.locator(".pastel-intro-cover .pastel-intro-cover__ribbon-window").boundingBox();
      const envelopeWidth = Math.min(width, 430);
      const left = (width - envelopeWidth) / 2;
      assert.equal(bounds.x, left);
      assert.equal(bounds.width, envelopeWidth);
      for (const [phase, png] of [["early", early], ["runtime", runtime]]) {
        const pixels = await sharp(png).ensureAlpha().raw().toBuffer();
        const alpha = (x, y) => pixels[(y * width + x) * 4 + 3];
        for (let y = 410; y < 435; y += 4) {
          assert.ok(alpha(left, y) >= 245, `${width}px ${phase}: left band reaches fold`);
          assert.ok(alpha(left + envelopeWidth - 1, y) >= 245, `${width}px ${phase}: right band reaches fold`);
        }
        for (let y = 0; y < 844; y += 1) {
          if (left > 0) {
            assert.equal(alpha(left - 1, y), 0, `${width}px ${phase}: left desktop margin stays empty`);
            assert.equal(alpha(left + envelopeWidth, y), 0, `${width}px ${phase}: right desktop margin stays empty`);
          }
        }
      }
      const [before, after] = await Promise.all([early, runtime].map((png) => sharp(png).ensureAlpha().raw().toBuffer()));
      const meanDifference = before.reduce((sum, value, index) => sum + Math.abs(value - after[index]), 0) / before.length;
      assert.ok(meanDifference < 1, `${width}px: poster/canvas handoff mean difference ${meanDifference}`);
      evidence.push({ width, bounds, meanDifference });
      await isolate.evaluate((node) => node.remove());
      if (process.env.RIBBON_QA_DIR) {
        await mkdir(process.env.RIBBON_QA_DIR, { recursive: true });
        await writeFile(join(process.env.RIBBON_QA_DIR, `envelope-early-${width}.png`), earlyFull);
        await page.screenshot({ path: join(process.env.RIBBON_QA_DIR, `envelope-handoff-${width}.png`) });
      }
      if (width === 390) {
        const preservation = await page.evaluate(async () => {
          const { drawRibbonFrame } = await import("/src/intro/ribbon-span.mjs");
          const { RIBBON_BAND_BOTTOMS, RIBBON_BAND_SOURCE_SHA256 } = await import("/src/intro/ribbon-band-regions.mjs");
          const manifest = await (await fetch("/assets/design/ribbon-sequence/manifest.json")).json();
          if (manifest.framePack.sha256 !== RIBBON_BAND_SOURCE_SHA256 || RIBBON_BAND_BOTTOMS.length !== manifest.frames.length) return { sourceMismatch: true };
          const canvases = Array.from({ length: 2 }, () => Object.assign(document.createElement("canvas"), { width: manifest.width, height: manifest.height }));
          const [original, corrected] = canvases.map((canvas) => canvas.getContext("2d", { willReadFrequently: true }));
          let checked = 0;
          let foldSamples = 0;
          let tailPixels = 0;
          for (const name of manifest.frames) {
            const image = await createImageBitmap(await (await fetch(`/assets/design/ribbon-sequence/${name}`)).blob());
            original.clearRect(0, 0, manifest.width, manifest.height);
            original.drawImage(image, 0, 0);
            drawRibbonFrame(corrected, image, manifest, checked);
            const a = original.getImageData(72, 0, 336, manifest.height).data;
            const b = corrected.getImageData(72, 0, 336, manifest.height).data;
            for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return { checked, mismatch: name };
            // The Blender paper is 11.9 units wide in a 14-unit camera. While
            // cloth crosses either physical fold, its visible coverage must
            // reach the corresponding web envelope edge, not stop inside it.
            for (const [side, fold, edge, x] of [[0, 36, 0, 0], [1, 443, 479, 408]]) {
              const bottom = RIBBON_BAND_BOTTOMS[checked][side];
              if (checked >= manifest.releaseCompleteFrame && bottom !== 0) return { releaseMismatch: name };
              const tailA = original.getImageData(x, bottom, 72, manifest.height - bottom).data;
              const tailB = corrected.getImageData(x, bottom, 72, manifest.height - bottom).data;
              for (let i = 0; i < tailA.length; i += 1) if (tailA[i] !== tailB[i]) return { checked, tailMismatch: { name, side, i } };
              tailPixels += tailA.filter((value, i) => i % 4 === 3 && value > 0).length;
              const source = original.getImageData(fold - 1, 0, 3, manifest.height).data;
              const output = corrected.getImageData(edge, 0, 1, manifest.height).data;
              for (let y = 0; y < bottom; y += 1) {
                if ([3, 7, 11].every((offset) => source[y * 12 + offset] >= 250)) {
                  if (output[y * 4 + 3] < 245) return { checked, foldMismatch: { name, fold, y } };
                  foldSamples += 1;
                }
              }
            }
            image.close();
            checked += 1;
          }
          return { checked, expected: manifest.frames.length, foldSamples, tailPixels };
        });
        assert.equal(preservation.checked, preservation.expected, `every frame preserves the authored center: ${JSON.stringify(preservation)}`);
        assert.ok(preservation.foldSamples > 1000, "physical fold coverage is exercised throughout the sequence");
        assert.ok(preservation.tailPixels > 1000, "visible free tails retain their original pixels throughout the sequence");
        evidence.push({ preservation });
      }
    } finally {
      releaseMain();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  }
  if (process.env.RIBBON_QA_DIR) await writeFile(join(process.env.RIBBON_QA_DIR, "envelope-span.json"), JSON.stringify(evidence, null, 2));
});
