import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import sharp from "sharp";
import { createServer } from "vite";

test("actual paper handoff is neutral on both faces and turning activates scoped shading", { timeout: 120_000 }, async (t) => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const evidence = [];
  for (const width of [360, 390, 430, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    let releaseMain;
    const mainGate = new Promise((resolve) => { releaseMain = resolve; });
    await page.route("**/src/main.jsx*", async (route) => { await mainGate; await route.continue().catch(() => {}); });
    const sample = () => page.evaluate(() => {
      const root = document.querySelector(".pastel-intro-cover");
      return ["left", "right"].map((side) => {
        const panel = root.querySelector(`.pastel-intro-cover__panel--${side}`);
        return { side, shade: Number(getComputedStyle(panel, "::after").opacity), content: getComputedStyle(panel, "::after").content, width: panel.getBoundingClientRect().width, progress: Number(getComputedStyle(root).getPropertyValue(`--pastel-intro-${side}-progress`)) };
      });
    });
    try {
      await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "commit" });
      await page.locator("#pastel-intro-early-poster img").first().evaluate((image) => image.decode());
      const early = await page.screenshot();
      releaseMain();
      await page.waitForFunction(() => {
        if (!document.querySelector(".pastel-intro-cover") || document.querySelector("#pastel-intro-early-poster")?.dataset.handoff !== "claimed") return false;
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        return true;
      });
      const neutral = await sample();
      const handedOff = await page.screenshot();
      const differences = [];
      const invitationWidth = Math.min(width, 430);
      const invitationLeft = (width - invitationWidth) / 2;
      for (const face of neutral) {
        assert.equal(face.shade, 0, `${width}px ${face.side}: initial runtime shade`);
        assert.equal(face.progress, 0, `${width}px ${face.side}: initial runtime progress`);
        const patch = { left: face.side === "left" ? invitationLeft + 8 : invitationLeft + invitationWidth - 48, top: 8, width: 40, height: 120 };
        const [before, after] = await Promise.all([early, handedOff].map((png) => sharp(png).extract(patch).removeAlpha().raw().toBuffer()));
        const mean = before.reduce((sum, value, index) => sum + Math.abs(value - after[index]), 0) / before.length;
        assert.ok(mean <= 1, `${width}px ${face.side}: neutral handoff paper mean difference ${mean}`);
        differences.push({ side: face.side, mean });
      }
      await page.evaluate(() => {
        delete document.hidden;
        delete document.visibilityState;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.locator(".pastel-intro-cover__start").click();
      await page.waitForFunction(() => {
        const root = document.querySelector(".pastel-intro-cover");
        if (!root) return false;
        const value = Number(getComputedStyle(root).getPropertyValue("--pastel-intro-right-progress"));
        if (value <= 0.25 || value >= 0.85) return false;
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        return true;
      }, null, { timeout: 20_000 });
      const turning = await sample();
      for (const face of turning) {
        assert.ok(face.shade > 0 && face.shade <= 1, `${width}px ${face.side}: turning shade must activate`);
        assert.notEqual(face.content, "none", `${width}px ${face.side}: scoped shade layer exists`);
        assert.ok(face.width < invitationWidth * 0.502 - 1, `${width}px ${face.side}: hinge must foreshorten the paper`);
      }
      evidence.push({ width, neutral, differences, turning });
      if (process.env.RIBBON_QA_DIR) {
        await mkdir(process.env.RIBBON_QA_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.RIBBON_QA_DIR, `independent-paper-turn-${width}.png`) });
      }
    } finally {
      releaseMain();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  }
  if (process.env.RIBBON_QA_DIR) await writeFile(join(process.env.RIBBON_QA_DIR, "independent-paper-state.json"), JSON.stringify(evidence, null, 2));
});
