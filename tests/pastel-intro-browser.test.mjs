import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../public/assets/design/ribbon-sequence/manifest.json", import.meta.url), "utf8"));
const expectedFrames = manifest.frames.map((_frame, index) => index);

// Installed before App: observe actual fetch/decode/draw without changing assets,
// timing, or production code. Keep hero identity/source inside the browser only.
function instrumentIntro() {
  const byteIndexes = new WeakMap();
  const blobIndexes = new WeakMap();
  const bitmapIndexes = new WeakMap();
  const evidence = window.__ribbonQA = {
    draws: [], mounts: 0, mountedAt: null, removedAt: null, openedAt: null,
    hero: null, heroSource: null, heroPreserved: true,
  };
  const originalBytes = Response.prototype.arrayBuffer;
  Response.prototype.arrayBuffer = async function (...args) {
    const bytes = await originalBytes.apply(this, args);
    const match = this.url.match(/\/ribbon-sequence\/frame-(\d+)-[^/]+\.webp$/);
    if (match) byteIndexes.set(bytes, Number(match[1]));
    return bytes;
  };
  const OriginalBlob = window.Blob;
  window.Blob = class extends OriginalBlob {
    constructor(parts, options) {
      super(parts, options);
      const first = parts?.[0];
      if (first && byteIndexes.has(first)) blobIndexes.set(this, byteIndexes.get(first));
    }
  };
  const originalBitmap = window.createImageBitmap.bind(window);
  window.createImageBitmap = async (blob, ...args) => {
    const bitmap = await originalBitmap(blob, ...args);
    if (blobIndexes.has(blob)) bitmapIndexes.set(bitmap, blobIndexes.get(blob));
    return bitmap;
  };
  const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
    const result = originalDraw.call(this, source, ...args);
    if (this.canvas.matches(".pastel-intro-cover__ribbon")) {
      const index = bitmapIndexes.get(source);
      let alphaPixels = null;
      if (index === 45) {
        const pixels = this.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
        alphaPixels = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) alphaPixels++;
      }
      evidence.draws.push({ index, at: performance.now(), alphaPixels });
    }
    return result;
  };
  let mountedCover;
  function observe() {
    const cover = document.querySelector(".pastel-intro-cover");
    if (cover && cover !== mountedCover) {
      mountedCover = cover;
      evidence.mounts++;
      evidence.mountedAt = performance.now();
    }
    if (mountedCover && !cover && evidence.removedAt === null) evidence.removedAt = performance.now();
    if (cover?.classList.contains("pastel-intro-cover--opening-panels") && evidence.openedAt === null) {
      evidence.openedAt = performance.now();
    }
    const hero = document.querySelector(".pastel-hero-photo img, .quiet-invitation .hero-photo img");
    if (hero?.complete && hero.naturalWidth > 0) {
      if (!evidence.hero) {
        evidence.hero = hero;
        evidence.heroSource = hero.currentSrc;
      } else if (hero !== evidence.hero || hero.currentSrc !== evidence.heroSource) evidence.heroPreserved = false;
    }
  }
  new MutationObserver(observe).observe(document, { childList: true, subtree: true, attributes: true });
  document.addEventListener("load", observe, true);
}

async function finalState(page) {
  await page.waitForFunction(() => {
    const hero = document.querySelector(".pastel-hero-photo img, .quiet-invitation .hero-photo img");
    return !document.querySelector(".pastel-intro-cover") && hero?.complete && hero.naturalWidth > 0
      && getComputedStyle(hero).opacity === "1"
      && getComputedStyle(hero.parentElement).opacity === "1";
  }, null, { timeout: 12_000 });
  // Explicit computed-style read after transitions; mutation events alone are insufficient.
  return page.evaluate(() => {
    const e = window.__ribbonQA;
    const hero = document.querySelector(".pastel-hero-photo img, .quiet-invitation .hero-photo img");
    const ancestors = [];
    for (let node = hero; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      ancestors.push({ opacity: Number(style.opacity), display: style.display, visibility: style.visibility });
    }
    return {
      draws: e.draws, mounts: e.mounts, mountedAt: e.mountedAt, removedAt: e.removedAt, openedAt: e.openedAt,
      bodyLocked: document.body.classList.contains("intro-lock"), coverPresent: Boolean(document.querySelector(".pastel-intro-cover")),
      heroPreserved: e.heroPreserved && hero === e.hero && hero.currentSrc === e.heroSource,
      heroLoaded: hero.naturalWidth > 0, ancestors,
      viewportWidth: innerWidth,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
    };
  });
}

function assertAccessible(state, expectedWidth = 390) {
  assert.equal(state.viewportWidth, expectedWidth, "The browser must actually use the requested viewport width.");
  assert.equal(state.bodyLocked, false);
  assert.equal(state.coverPresent, false);
  assert.equal(state.heroLoaded, true);
  assert.equal(state.heroPreserved, true);
  assert.ok(state.ancestors.every((s) => s.opacity === 1 && s.display !== "none" && s.visibility === "visible"), "Hero and its ancestors must be visible after the final transition.");
  assert.ok(state.overflow <= 1, "Invitation must not overflow the viewport horizontally.");
}

function assertCompletePlayback(state) {
  assert.equal(state.mounts, 1);
  assert.deepEqual(state.draws.map((draw) => draw.index), expectedFrames);
  const terminal = state.draws.at(-1);
  assert.equal(terminal.alphaPixels, 0);
  assert.ok(state.openedAt - terminal.at >= manifest.panelDelayMs, "Paper must wait at least 300 ms after the actual transparent terminal draw.");
  assert.ok(state.removedAt >= state.openedAt + manifest.panelDurationMs - 5);
}

test("real invitation ribbon preserves every frame and restores access across loading failures and viewports", { timeout: 180_000 }, async (t) => {
  const server = await createServer({ root: projectRoot, logLevel: "silent", server: { host: "127.0.0.1", port: 0, strictPort: false } });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); });
  await server.listen();
  const address = server.httpServer.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const artifactDir = process.env.RIBBON_QA_DIR;
  if (artifactDir) await mkdir(artifactDir, { recursive: true });
  async function screenshot(page, name) {
    if (artifactDir) {
      const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const png = await page.screenshot({ path: join(artifactDir, `${name}.png`) });
      assert.equal(png.readUInt32BE(16), dimensions.width, "Screenshot pixels must match the actual viewport width.");
      assert.equal(png.readUInt32BE(20), dimensions.height, "Screenshot pixels must match the actual viewport height.");
    }
  }
  async function newPage(options = {}) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, ...options });
    assert.equal(await page.evaluate(() => innerWidth), options.viewport?.width ?? 390, "Viewport setup must take effect before loading App.");
    await page.addInitScript(instrumentIntro);
    return page;
  }

  await t.test("all 46 real frames precede paper opening; reload mounts again even with reduced motion", async () => {
    const page = await newPage({ reducedMotion: "reduce" });
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ribbonQA.draws.length > 0);
      assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("intro-lock")), true);
      await screenshot(page, "initial-390-reduced-motion");
      await page.waitForFunction(() => window.__ribbonQA.openedAt !== null);
      await screenshot(page, "panels-opening-390");
      const state = await finalState(page);
      assertAccessible(state);
      assertCompletePlayback(state);
      await screenshot(page, "final-390-reduced-motion");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ribbonQA.draws.length > 0);
      assert.equal(await page.evaluate(() => window.__ribbonQA.mounts), 1);
      await page.locator(".pastel-intro-cover").click({ position: { x: 10, y: 10 } });
      assertAccessible(await finalState(page));
    } finally { await page.close(); }
  });

  for (const width of [360, 430, 768, 1440]) {
    await t.test(`normal Pastel ${width}px plays the real ribbon across the actual viewport`, async () => {
      const page = await newPage({ viewport: { width, height: 900 }, reducedMotion: "no-preference" });
      try {
        await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.__ribbonQA.draws.length > 0);
        const initial = await page.evaluate(() => {
          const canvas = document.querySelector(".pastel-intro-cover__ribbon");
          const rect = canvas.getBoundingClientRect();
          return {
            viewportWidth: innerWidth, canvasWidth: rect.width, canvasLeft: rect.left,
            firstDrawIndex: window.__ribbonQA.draws[0].index,
            bodyLocked: document.body.classList.contains("intro-lock"),
            overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
          };
        });
        assert.equal(initial.viewportWidth, width);
        assert.equal(initial.firstDrawIndex, 0);
        assert.ok(Math.abs(initial.canvasWidth - width) < 0.5, "The actual ribbon canvas must span the whole viewport.");
        assert.ok(Math.abs(initial.canvasLeft) < 0.5, "The ribbon canvas must stay horizontally registered to the viewport.");
        assert.equal(initial.bodyLocked, true);
        assert.ok(initial.overflow <= 1, "The active cover must not cause horizontal overflow.");
        await screenshot(page, `initial-${width}-normal`);
        const state = await finalState(page);
        assertAccessible(state, width);
        assertCompletePlayback(state);
        await screenshot(page, `final-${width}-normal`);
      } finally { await page.close(); }
    });
  }

  await t.test("cold 400ms ribbon assets still complete every real frame before the cover opens", async () => {
    const page = await newPage();
    await page.route("**/ribbon-sequence/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const state = await finalState(page);
      assertAccessible(state);
      assertCompletePlayback(state);
    } finally { await page.close(); }
  });

  for (const scenario of ["skip-loading", "fetch-failure", "fetch-timeout"]) {
    await t.test(scenario, async () => {
      const page = await newPage();
      const blocked = [];
      let requests = 0;
      await page.route("**/ribbon-sequence/*.webp", (route) => {
        requests++;
        if (scenario === "fetch-failure") return route.fulfill({ status: 503, body: "Synthetic frame failure" });
        blocked.push(route);
      });
      try {
        await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.__ribbonQA.mounts > 0);
        if (scenario === "skip-loading") {
          await page.locator(".pastel-intro-cover").click({ position: { x: 10, y: 10 } });
        }
        const state = await finalState(page);
        assertAccessible(state);
        assert.ok(requests > 0, "The scenario must reach actual frame loading.");
        assert.equal(state.draws.length, 0);
        assert.equal(state.openedAt, null);
        if (scenario === "fetch-timeout") {
          assert.ok(state.removedAt - state.mountedAt >= 4_900, "The delayed fetch must exercise the loading timeout.");
          assert.ok(state.removedAt - state.mountedAt < 8_000, "Timeout must restore access within its bounded allowance.");
        }
      } finally {
        await Promise.allSettled(blocked.map((route) => route.abort()));
        await page.close();
      }
    });
  }

  for (const width of [360, 390, 430, 768, 1440]) {
    for (const variant of ["pastel", "quiet"]) {
      await t.test(`${variant} ${width}px has no overflow and respects the intro exemption`, async () => {
        const page = await newPage({ viewport: { width, height: 900 } });
        let sequenceRequests = 0;
        page.on("request", (request) => { if (request.url().includes("/ribbon-sequence/")) sequenceRequests++; });
        try {
          // Capture must bypass Pastel; Quiet must bypass without requiring capture.
          await page.goto(`${baseUrl}/?${variant === "pastel" ? "capture=1" : "variant=quiet"}`, { waitUntil: "networkidle" });
          const state = await finalState(page);
          assertAccessible(state, width);
          assert.equal(state.mounts, 0);
          assert.equal(sequenceRequests, 0);
        } finally { await page.close(); }
      });
    }
  }
});
