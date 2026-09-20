import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { build, createServer, preview } from "vite";
import sharp from "sharp";
import { createEarlyPosterMarkup } from "../scripts/intro/early-poster.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../public/assets/design/ribbon-sequence/manifest.json", import.meta.url), "utf8"));
const measuredPanelCurve = JSON.parse(await readFile(new URL("../scripts/ribbon/reference-paper-curve.json", import.meta.url), "utf8")).panelCurve;
const expectedFrames = manifest.frames.map((_frame, index) => index);

// Installed before App: observe actual fetch/decode/draw without changing assets,
// timing, or production code. Keep hero identity/source inside the browser only.
function instrumentIntro({ frameNames, terminalIndex, diagnostic = false }) {
  const byteIndexes = new WeakMap();
  const blobIndexes = new WeakMap();
  const bitmapIndexes = new WeakMap();
  const evidence = window.__ribbonQA = {
    draws: [], mounts: 0, mountedAt: null, removedAt: null, openedAt: null,
    hero: null, heroSource: null, heroPreserved: true, handoff: null, poster: null,
  };
  const timing = diagnostic ? evidence.timing = { rafCallbacks: [], decodes: [], mutationObserver: [], ribbonTrackStyleWrites: [] } : null;
  let activeRaf = null;
  if (timing) {
    const requestAnimationFrame = window.requestAnimationFrame.bind(window);
    let rafSequence = 0;
    window.requestAnimationFrame = (callback) => requestAnimationFrame((timestamp) => {
      const record = { sequence: rafSequence++, timestamp, invokedAt: performance.now(), callbackName: callback.name || "anonymous" };
      timing.rafCallbacks.push(record);
      const previous = activeRaf;
      activeRaf = record;
      try { return callback(timestamp); }
      finally { record.returnedAt = performance.now(); activeRaf = previous; }
    });
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (property, value, priority) {
      const track = document.querySelector(".pastel-intro-cover__ribbon-track");
      const isRibbonTrackProperty = track?.style === this && [
        "--pastel-intro-registration-x",
        "--pastel-intro-registration-y",
        "--pastel-intro-ribbon-y",
      ].includes(property);
      const before = isRibbonTrackProperty ? this.getPropertyValue(property) : null;
      const result = setProperty.call(this, property, value, priority);
      if (isRibbonTrackProperty) timing.ribbonTrackStyleWrites.push({ property, before, requested: String(value), after: this.getPropertyValue(property), at: performance.now() });
      return result;
    };
  }
  const originalBytes = Response.prototype.arrayBuffer;
  Response.prototype.arrayBuffer = async function (...args) {
    const bytes = await originalBytes.apply(this, args);
    const index = frameNames.indexOf(this.url.split("/").at(-1));
    if (index >= 0) byteIndexes.set(bytes, index);
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
    const index = blobIndexes.get(blob);
    const startedAt = timing ? performance.now() : 0;
    try {
      const bitmap = await originalBitmap(blob, ...args);
      if (index !== undefined) bitmapIndexes.set(bitmap, index);
      if (timing) timing.decodes.push({ index, startedAt, endedAt: performance.now(), ok: true });
      return bitmap;
    } catch (error) {
      if (timing) timing.decodes.push({ index, startedAt, endedAt: performance.now(), ok: false, error: String(error?.message || error) });
      throw error;
    }
  };
  const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
    const nativeDrawStartedAt = timing ? performance.now() : 0;
    const result = originalDraw.call(this, source, ...args);
    if (this.canvas.matches(".pastel-intro-cover__ribbon")) {
      const index = bitmapIndexes.get(source);
      const at = performance.now();
      let alphaPixels = null;
      let alphaTop = null;
      let getImageDataMs = null;
      let alphaScanMs = null;
      if (index >= terminalIndex - 1) {
        const readbackStartedAt = performance.now();
        const pixels = this.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
        getImageDataMs = performance.now() - readbackStartedAt;
        const scanStartedAt = performance.now();
        alphaPixels = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) {
          alphaPixels++;
          if (alphaTop === null) alphaTop = Math.floor((i - 3) / 4 / this.canvas.width);
        }
        alphaScanMs = performance.now() - scanStartedAt;
      }
      const draw = { index, at, alphaPixels, alphaTop, hidden: document.hidden };
      if (timing) Object.assign(draw, {
        nativeDrawMs: at - nativeDrawStartedAt,
        getImageDataMs,
        alphaScanMs,
        readbackTotalMs: getImageDataMs === null ? null : getImageDataMs + alphaScanMs,
        raf: activeRaf && { sequence: activeRaf.sequence, timestamp: activeRaf.timestamp, invokedAt: activeRaf.invokedAt },
      });
      evidence.draws.push(draw);
      // Read after the production call has applied the same frame's root transform.
      queueMicrotask(() => {
        const rect = this.canvas.getBoundingClientRect();
        draw.rect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        draw.viewportHeight = innerHeight;
        if (alphaTop !== null) draw.alphaViewportTop = rect.top + alphaTop * rect.height / this.canvas.height;
        if (index === 0 && evidence.poster) evidence.handoff = { poster: evidence.poster, canvas: draw.rect };
      });
    }
    return result;
  };
  let mountedCover;
  function observe(records = []) {
    const startedAt = timing ? performance.now() : 0;
    const posterImage = document.querySelector("#pastel-intro-early-poster img");
    if (posterImage && getComputedStyle(posterImage).visibility !== "hidden") {
      const rect = posterImage.getBoundingClientRect();
      evidence.poster = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
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
    if (timing) timing.mutationObserver.push({ startedAt, endedAt: performance.now(), durationMs: performance.now() - startedAt, recordCount: Array.isArray(records) ? records.length : 0 });
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
      draws: e.draws, mounts: e.mounts, mountedAt: e.mountedAt, removedAt: e.removedAt, openedAt: e.openedAt, handoff: e.handoff,
      early: window.__pastelIntroEarly ? { shownAt: window.__pastelIntroEarly.shownAt, reason: window.__pastelIntroEarly.reason, status: window.__pastelIntroEarly.status } : null,
      bodyLocked: document.body.classList.contains("intro-lock") || getComputedStyle(document.body).overflow === "hidden" || getComputedStyle(document.documentElement).overflow === "hidden", coverPresent: [...document.querySelectorAll(".pastel-intro-cover, #pastel-intro-early-poster")].some((node) => getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden"),
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

function assertCompletePlayback(state, { interrupted = false } = {}) {
  assert.equal(state.mounts, 1);
  assert.deepEqual(state.draws.map((draw) => draw.index), expectedFrames);
  const terminal = state.draws.at(-1);
  assert.equal(terminal.alphaPixels, 0);
  assert.ok(state.openedAt - terminal.at >= manifest.panelDelayMs, "Paper must wait at least 300 ms after the actual transparent terminal draw.");
  assert.ok(state.removedAt >= state.openedAt + manifest.panelDurationMs - 5, `Actual visible panel motion lasted ${(state.removedAt - state.openedAt).toFixed(2)}ms; requires ${manifest.panelDurationMs}ms (5ms observer allowance).`);
  if (!interrupted) {
    const intervals = state.draws.slice(2).map((draw, index) => draw.at - state.draws[index + 1].at).sort((a, b) => a - b);
    const p95 = intervals[Math.ceil(intervals.length * 0.95) - 1];
    assert.ok(p95 <= 50, `Normal active playback p95 must be <=50ms; observed ${p95.toFixed(2)}ms.`);
    assert.ok(intervals.at(-1) <= 100, `Normal active playback must not freeze >100ms; observed ${intervals.at(-1).toFixed(2)}ms.`);
  }
  if (state.viewportWidth === 390) {
    assert.ok(state.handoff, "Initial poster must hand off to a decoded F0.");
    for (const dimension of ["x", "y", "width", "height"]) assert.ok(Math.abs(state.handoff.poster[dimension] - state.handoff.canvas[dimension]) <= 1, `Poster-to-F0 ${dimension} changes by more than 1 CSS pixel.`);
  }
  if (manifest.schemaVersion === 2) {
    const lastVisible = state.draws.at(-2);
    assert.ok(lastVisible.alphaPixels > 0, "The previous frame must contain real ribbon alpha, not a premature blank frame.");
    assert.ok(lastVisible.alphaViewportTop >= lastVisible.viewportHeight + 16, `Real ribbon alpha must leave the viewport by 16px before terminal/panels; top=${lastVisible.alphaViewportTop}, height=${lastVisible.viewportHeight}.`);
  }
}

test("real invitation ribbon preserves every frame and restores access across loading failures and viewports", { timeout: 240_000 }, async (t) => {
  const artifactDir = process.env.RIBBON_QA_DIR;
  // Public motion acceptance runs the compiled entry, so Vite's dev transform
  // latency cannot consume the production preparation budget before React mounts.
  const useBuiltFixture = process.env.RIBBON_QA_BUILT !== "0";
  const existingFixture = process.env.RIBBON_QA_EXISTING_FIXTURE;
  const lanHost = process.env.RIBBON_QA_LAN_HOST;
  const listenHost = lanHost ? "0.0.0.0" : "127.0.0.1";
  let server;
  let browser;
  let temporaryRoot;
  t.after(async () => {
    await browser?.close();
    if (server && useBuiltFixture) await new Promise((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
    else await server?.close();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });
  if (useBuiltFixture) {
    temporaryRoot = artifactDir || existingFixture ? null : await mkdtemp(join(tmpdir(), "wedding-ribbon-qa-"));
    const outDir = existingFixture || join(artifactDir || temporaryRoot, "built-fixture");
    if (!existingFixture) await build({ root: projectRoot, logLevel: "silent", build: { outDir, emptyOutDir: false } });
    server = await preview({ root: projectRoot, logLevel: "silent", build: { outDir }, preview: { host: listenHost, port: 0, strictPort: false } });
  } else {
    server = await createServer({ root: projectRoot, logLevel: "silent", server: { host: "127.0.0.1", port: 0, strictPort: false } });
  }
  if (!useBuiltFixture) await server.listen();
  const address = server.httpServer.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://${lanHost || "127.0.0.1"}:${address.port}`;
  browser = await chromium.launch({ headless: true });
  if (artifactDir) await mkdir(artifactDir, { recursive: true });
  async function screenshot(page, name) {
    if (artifactDir) {
      const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const png = await page.screenshot({ path: join(artifactDir, `${name}.png`) });
      assert.equal(png.readUInt32BE(16), dimensions.width, "Screenshot pixels must match the actual viewport width.");
      assert.equal(png.readUInt32BE(20), dimensions.height, "Screenshot pixels must match the actual viewport height.");
    }
  }
  let currentScenario = "unknown";
  const scenarioFilter = process.env.RIBBON_QA_SCENARIO ? new RegExp(process.env.RIBBON_QA_SCENARIO) : null;
  const timingDiagnostic = process.env.RIBBON_QA_TIMING_DIAGNOSTIC === "1";
  const scenarioTest = (name, run) => t.test(name, { skip: Boolean(scenarioFilter && !scenarioFilter.test(name)) }, async () => { currentScenario = name; await run(); });
  async function newPage(options = {}) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, ...options });
    assert.equal(await page.evaluate(() => innerWidth), options.viewport?.width ?? 390, "Viewport setup must take effect before loading App.");
    await page.addInitScript(instrumentIntro, { frameNames: manifest.frames, terminalIndex: manifest.frames.length - 1, diagnostic: timingDiagnostic });
    const network = { responses: [], failures: [], errors: [] };
    page.on("response", (response) => { if (response.url().includes("/ribbon-sequence/")) network.responses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    page.on("requestfailed", (request) => network.failures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
    page.on("pageerror", (error) => network.errors.push(error.message));
    page.on("console", (message) => { if (["error", "warning"].includes(message.type())) network.errors.push(message.text()); });
    const originalClose = page.close.bind(page);
    page.close = async () => {
      if (artifactDir && !page.isClosed()) {
        const scenarioName = currentScenario.replace(/[^a-zA-Z0-9-]/g, "-");
        const evidence = await page.evaluate(() => {
          const state = { ...window.__ribbonQA };
          delete state.hero;
          delete state.heroSource;
          const { shownAt, deadlineAt, reason, status } = window.__pastelIntroEarly || {};
          return { state, early: { shownAt, deadlineAt, reason, status }, title: document.title, viewport: { width: innerWidth, height: innerHeight }, coverDOM: document.querySelector(".pastel-intro-cover")?.outerHTML, runtime: window.__weddingIntroEvidence };
        }).catch((error) => ({ evaluationError: error.message }));
        await writeFile(join(artifactDir, `scenario-${scenarioName}.json`), JSON.stringify({ scenario: currentScenario, fixture: useBuiltFixture ? "production-build" : "vite-development", existingFixture: existingFixture || null, ...network, ...evidence }, null, 2));
      }
      return originalClose();
    };
    return page;
  }

  await scenarioTest(`all ${manifest.frames.length} real frames precede paper opening; reload mounts again even with reduced motion`, async () => {
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
    await scenarioTest(`normal Pastel ${width}px plays the real ribbon across the actual viewport`, async () => {
      const page = await newPage({ viewport: { width, height: 900 }, reducedMotion: "no-preference" });
      try {
        await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.__ribbonQA.draws.length > 0);
        const initial = await page.evaluate(() => {
          const canvas = document.querySelector("canvas.pastel-intro-cover__ribbon");
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

  await scenarioTest("cold 400ms ribbon assets at 4MiB/s still complete every real frame before the cover opens", async () => {
    const page = await newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await page.route("**/ribbon-sequence/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      // Limit the real preparation phase after the dev main bundle arrives. A separately
      // tested slow main can legitimately exhaust the early fail-open deadline.
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: 4 * 1024 * 1024, uploadThroughput: 256 * 1024 });
      const state = await finalState(page);
      assertAccessible(state);
      assertCompletePlayback(state);
    } finally { await page.close(); }
  });

  for (const scenario of ["skip-loading", "fetch-failure", "fetch-timeout", "decode-failure"]) {
    await scenarioTest(scenario, async () => {
      const page = await newPage();
      const blocked = [];
      let requests = 0;
      let resolveFirstFrameRequest;
      const firstFrameRequest = new Promise((resolve) => { resolveFirstFrameRequest = resolve; });
      await page.route("**/ribbon-sequence/*.webp", (route) => {
        requests++;
        resolveFirstFrameRequest();
        if (scenario === "fetch-failure") return route.fulfill({ status: 503, body: "Synthetic frame failure" });
        if (scenario === "decode-failure") return route.fulfill({ status: 200, contentType: "image/webp", body: Buffer.from("invalid-webp-for-independent-decode-failure") });
        blocked.push(route);
      });
      try {
        await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.__ribbonQA.mounts > 0);
        if (scenario === "skip-loading") {
          await firstFrameRequest;
          assert.equal(await page.evaluate(() => Boolean(document.elementFromPoint(10, 10)?.closest("#pastel-intro-early-poster, .pastel-intro-cover"))), true, "The user must tap the actual topmost preparation cover.");
          await page.mouse.click(10, 10);
        }
        if (scenario === "fetch-timeout") {
          await page.waitForTimeout(1000);
          const poster = await page.locator(".pastel-intro-cover__poster").evaluate((image) => ({ loaded: image.complete && image.naturalWidth > 0, opacity: getComputedStyle(image).opacity, width: image.getBoundingClientRect().width }));
          assert.ok(poster.loaded && poster.opacity === "1" && poster.width > 100, "The exact tied poster must remain visible while preparation exhausts its budget.");
        }
        const state = await finalState(page);
        assertAccessible(state);
        assert.ok(requests > 0, "The scenario must reach actual frame loading.");
        assert.equal(state.draws.length, 0);
        assert.equal(state.openedAt, null);
        if (scenario === "fetch-timeout") {
          assert.ok(state.removedAt - state.early.shownAt >= 4_900, "The delayed fetch must exercise the timeout from the early cover's actual start.");
          assert.ok(state.removedAt - state.early.shownAt < 8_000, "Timeout must restore access within its bounded allowance.");
          await Promise.allSettled(blocked.splice(0).map((route) => route.abort()));
          await page.waitForTimeout(350);
          assert.equal(await page.locator(".pastel-intro-cover:visible, #pastel-intro-early-poster:visible").count(), 0, "Late preparation settlements must not remount the cover after fail-open.");
          assert.equal(await page.evaluate(() => window.__ribbonQA.draws.length), 0);
        }
      } finally {
        await Promise.allSettled(blocked.map((route) => route.abort()));
        await page.close();
      }
    });
  }

  await scenarioTest("skip during active playback cancels motion and restores actual vertical scrolling", async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ribbonQA.draws.length >= 5);
      await page.locator(".pastel-intro-cover").click({ position: { x: 10, y: 10 } });
      const state = await finalState(page);
      assertAccessible(state);
      const count = state.draws.length;
      assert.ok(count < manifest.frames.length, "Skip must interrupt an active sequence.");
      await page.waitForTimeout(350);
      assert.equal(await page.evaluate(() => window.__ribbonQA.draws.length), count, "No frame may draw after teardown.");
      await page.mouse.wheel(0, 500);
      await page.waitForFunction(() => scrollY > 100);
    } finally { await page.close(); }
  });

  await scenarioTest("half-open paper gap already reveals the same real hero pixels as the finished invitation", async () => {
    const calibratedSamples = [];
    for (const targetProgress of [0.25, 0.5, 0.75]) {
      const samplePage = await newPage();
      try {
        await samplePage.goto(baseUrl, { waitUntil: "domcontentloaded" });
        await samplePage.waitForFunction((target) => {
          const cover = document.querySelector(".pastel-intro-cover");
          if (!cover) return false;
          const progress = Number(getComputedStyle(cover).getPropertyValue("--pastel-intro-left-progress"));
          return progress >= target - 0.025 && progress <= target + 0.075;
        }, targetProgress);
        const sample = await samplePage.evaluate(() => {
          const cover = document.querySelector(".pastel-intro-cover");
          const left = cover?.querySelector(".pastel-intro-cover__panel--left");
          const right = cover?.querySelector(".pastel-intro-cover__panel--right");
          const style = getComputedStyle(cover);
          return {
            targetProgress: Number(style.getPropertyValue("--pastel-intro-left-progress")),
            leftTransform: left && getComputedStyle(left).transform,
            rightTransform: right && getComputedStyle(right).transform,
          };
        });
        await samplePage.evaluate(() => {
          Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
          Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        const pausedSample = await samplePage.evaluate(() => {
          const cover = document.querySelector(".pastel-intro-cover");
          const style = getComputedStyle(cover);
          return Number(style.getPropertyValue("--pastel-intro-left-progress"));
        });
        assert.match(sample.leftTransform, /^matrix3d\(/, "Each calibrated opening sample must retain the left out-of-plane turn.");
        assert.match(sample.rightTransform, /^matrix3d\(/, "Each calibrated opening sample must retain the right out-of-plane turn.");
        assert.ok(Math.abs(sample.targetProgress - pausedSample) <= 0.025, "The actual presentation clock must be frozen at the observed opening progress before the screenshot is captured.");
        await screenshot(samplePage, `panels-${Math.round(targetProgress * 100)}-open-390`);
        const postImageSample = await samplePage.evaluate(() => {
          const cover = document.querySelector(".pastel-intro-cover");
          return Number(getComputedStyle(cover).getPropertyValue("--pastel-intro-left-progress"));
        });
        assert.equal(postImageSample, pausedSample, "Screenshot encoding must not advance a hidden-panel presentation clock.");
        await samplePage.evaluate(() => {
          delete document.hidden;
          delete document.visibilityState;
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await samplePage.waitForFunction((before) => {
          const cover = document.querySelector(".pastel-intro-cover");
          return Number(getComputedStyle(cover).getPropertyValue("--pastel-intro-left-progress")) > before;
        }, pausedSample);
        calibratedSamples.push({ ...sample, pausedSample, postImageSample });
      } finally { await samplePage.close(); }
    }
    const page = await newPage();
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ribbonQA.openedAt !== null);
      await page.waitForTimeout(manifest.panelDurationMs / 2);
      const geometry = await page.evaluate(() => {
        const cover = document.querySelector(".pastel-intro-cover");
        const hero = document.querySelector(".pastel-hero-photo img");
        const left = cover?.querySelector(".pastel-intro-cover__panel--left");
        const right = cover?.querySelector(".pastel-intro-cover__panel--right");
        const heroRect = hero.getBoundingClientRect();
        const leftRect = left?.getBoundingClientRect();
        const rightRect = right?.getBoundingClientRect();
        const style = getComputedStyle(cover);
        const leftProgress = Number(style.getPropertyValue("--pastel-intro-left-progress"));
        const rightProgress = Number(style.getPropertyValue("--pastel-intro-right-progress"));
        const leftWidth = left?.offsetWidth;
        const rightWidth = right?.offsetWidth;
        return {
          coverPresent: Boolean(cover), background: cover && style.backgroundColor,
          leftRight: leftRect?.right, rightLeft: rightRect?.left,
          leftProgress, rightProgress, leftWidth, rightWidth,
          leftTransform: left && getComputedStyle(left).transform,
          rightTransform: right && getComputedStyle(right).transform,
          expectedLeftRight: leftWidth * (1 - leftProgress),
          expectedRightLeft: innerWidth - rightWidth * (1 - rightProgress),
          patch: { left: Math.round(heroRect.x + heroRect.width / 2 - 20), top: Math.round(Math.min(innerHeight - 50, heroRect.y + heroRect.height / 2 - 20)), width: 40, height: 40 },
        };
      });
      const halfOpen = await page.screenshot(artifactDir ? { path: join(artifactDir, "panels-half-open-390.png") } : {});
      const state = await finalState(page);
      const finished = await page.screenshot();
      const [halfPixels, finalPixels] = await Promise.all([halfOpen, finished].map((png) => sharp(png).extract(geometry.patch).removeAlpha().raw().toBuffer()));
      const meanDifference = halfPixels.reduce((total, value, index) => total + Math.abs(value - finalPixels[index]), 0) / halfPixels.length;
      if (artifactDir) await writeFile(join(artifactDir, "panel-gap-pixel-evidence.json"), JSON.stringify({ scenario: currentScenario, ...geometry, meanDifference }, null, 2));
      assert.equal(geometry.coverPresent, true, "The comparison must happen during panel motion, before overlay teardown.");
      assert.ok(calibratedSamples.every((sample, index) => Math.abs(sample.pausedSample - [0.25, 0.5, 0.75][index]) <= 0.075), "The review screenshots must be sampled within 7.5% of 25/50/75% opening progress.");
      if (artifactDir) await writeFile(join(artifactDir, "panel-progress-calibration.json"), JSON.stringify({ scenario: currentScenario, samples: calibratedSamples }, null, 2));
      assert.equal(geometry.background, "rgba(0, 0, 0, 0)", "The fixed overlay must not paint an opaque layer across the opening.");
      assert.match(geometry.leftTransform, /^matrix3d\(/, "The left paper must have an out-of-plane hinge transform.");
      assert.match(geometry.rightTransform, /^matrix3d\(/, "The right paper must have an out-of-plane hinge transform.");
      assert.ok(Math.abs(geometry.leftRight - geometry.expectedLeftRight) <= 1, "The left inner edge must follow its measured curve within 1px at 390px.");
      assert.ok(Math.abs(geometry.rightLeft - geometry.expectedRightLeft) <= 1, "The right inner edge must follow its measured curve within 1px at 390px.");
      assert.ok(geometry.leftRight < geometry.leftWidth && geometry.rightLeft > 390 - geometry.rightWidth, "Hinged panels must compress paper texture horizontally instead of translating as full-width panels.");
      assert.ok(geometry.leftRight < geometry.patch.left && geometry.rightLeft > geometry.patch.left + geometry.patch.width, "Both paper edges must have moved clear of the sampled center gap.");
      assert.ok(meanDifference <= 2, `The opening must reveal actual hero pixels before cover removal; mean pixel difference=${meanDifference.toFixed(2)}.`);
      assertAccessible(state);
      assertCompletePlayback(state);
    } finally { await page.close(); }
  });

  await scenarioTest("tall 390x1200 viewport completes exit; resizing during hold retains registration", async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ribbonQA.draws.length === 1);
      await page.setViewportSize({ width: 390, height: 1200 });
      const state = await finalState(page);
      assertAccessible(state);
      assertCompletePlayback(state);
    } finally { await page.close(); }
  });

  await scenarioTest("hidden then resumed document does not skip frames or open panels while hidden", async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ribbonQA.draws.length >= 5);
      // Synthetic document visibility tests the event contract; this is not an OS/iPhone backgrounding claim.
      const before = await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        return window.__ribbonQA.draws.length;
      });
      await page.waitForTimeout(1800);
      assert.equal(await page.evaluate(() => window.__ribbonQA.draws.length), before);
      assert.equal(await page.evaluate(() => window.__ribbonQA.openedAt), null);
      await page.evaluate(() => {
        delete document.hidden;
        delete document.visibilityState;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      const state = await finalState(page);
      assertAccessible(state);
      assertCompletePlayback(state, { interrupted: true });
    } finally { await page.close(); }
  });

  async function setHidden(page, hidden) {
    await page.evaluate((value) => {
      if (value) {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      } else {
        delete document.hidden;
        delete document.visibilityState;
      }
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  }

  await scenarioTest("boundary: preparation completed while hidden waits for visible start and preserves the 800ms visible poster hold", async () => {
    const page = await newPage();
    await page.addInitScript(() => {
      window.__qaDecodedWhileHidden = 0;
      const decode = window.createImageBitmap;
      window.createImageBitmap = async (...args) => {
        const bitmap = await decode(...args);
        if (document.hidden) window.__qaDecodedWhileHidden++;
        return bitmap;
      };
    });
    let hiddenAt;
    await page.route("**/ribbon-sequence/manifest.json", async (route) => {
      await setHidden(page, true);
      hiddenAt = await page.evaluate(() => performance.now());
      await route.continue();
    });
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__qaDecodedWhileHidden >= 3, null, { polling: 20 });
      await page.waitForTimeout(1000);
      const hiddenState = await page.evaluate(() => ({ draws: window.__ribbonQA.draws.length, status: window.__pastelIntroEarly.status, shownAt: window.__pastelIntroEarly.shownAt, decoded: window.__qaDecodedWhileHidden }));
      assert.equal(hiddenState.draws, 0, "Prepared frames must not start their scheduler or draw while hidden.");
      assert.equal(hiddenState.status, "poster");
      assert.ok(hiddenAt - hiddenState.shownAt < 600, "The fixture must hide before the 800ms hold has been consumed.");
      const resumedAt = await page.evaluate(() => performance.now());
      await setHidden(page, false);
      const state = await finalState(page);
      assertAccessible(state);
      assertCompletePlayback(state);
      const visibleHold = state.draws[1].at - hiddenState.shownAt - (resumedAt - hiddenAt);
      assert.ok(visibleHold >= 795, `The tied poster must remain visible for 800ms excluding hidden time (5ms measurement allowance); observed ${visibleHold}ms.`);
      assert.equal(state.early.reason, "finished");
      if (artifactDir) await writeFile(join(artifactDir, "hidden-preparation-hold.json"), JSON.stringify({ hiddenAt, resumedAt, hiddenState, firstDrawAt: state.draws[0].at, firstMovingFrameAt: state.draws[1].at, visibleHold, frames: state.draws.length, finalReason: state.early.reason }, null, 2));
    } finally { await page.close(); }
  });

  await scenarioTest("boundary: preparation near 4s then playback hide-resume keeps the completed preparation timer disarmed", async () => {
    const page = await newPage();
    await page.route("**/ribbon-sequence/manifest.json", async (route) => {
      const now = await page.evaluate(() => performance.now());
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 3800 - now)));
      await route.continue();
    });
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ribbonQA.draws.length >= 5, null, { timeout: 6000 });
      const firstDrawAt = await page.evaluate(() => window.__ribbonQA.draws[0].at);
      assert.ok(firstDrawAt >= 3800 && firstDrawAt < 5000, `The real preparation must finish near 4s but within 5s; observed ${firstDrawAt}ms.`);
      await setHidden(page, true);
      const count = await page.evaluate(() => window.__ribbonQA.draws.length);
      await page.waitForTimeout(1800);
      assert.equal(await page.evaluate(() => window.__ribbonQA.draws.length), count);
      await setHidden(page, false);
      const state = await finalState(page);
      assertAccessible(state);
      assertCompletePlayback(state, { interrupted: true });
      assert.equal(state.early.reason, "finished");
      assert.ok(state.removedAt - state.early.shownAt > 6800, "A late, ready sequence must continue beyond the expired initial wall-clock budget.");
    } finally { await page.close(); }
  });

  await scenarioTest("boundary: paper motion pauses while hidden and resumes its full visible duration", async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ribbonQA.openedAt !== null);
      await page.waitForTimeout(200);
      await setHidden(page, true);
      const progress = () => page.locator(".pastel-intro-cover").evaluate((cover) => ({ left: cover.style.getPropertyValue("--pastel-intro-left-progress"), right: cover.style.getPropertyValue("--pastel-intro-right-progress") }));
      const paused = await progress();
      await page.waitForTimeout(1800);
      assert.deepEqual(await progress(), paused, "Both panel transforms must remain unchanged while hidden.");
      await setHidden(page, false);
      const state = await finalState(page);
      assertAccessible(state);
      assertCompletePlayback(state);
      assert.ok(state.removedAt - state.openedAt >= manifest.panelDurationMs + 1800 - 5, "Hidden time must not consume visible panel motion.");
      assert.equal(state.early.reason, "finished");
    } finally { await page.close(); }
  });

  await scenarioTest("boundary: visible paper animation stall remains bounded by the playback watchdog", async () => {
    const page = await newPage();
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ribbonQA.openedAt !== null);
      await page.evaluate(() => { window.__qaOriginalRAF = window.requestAnimationFrame; window.requestAnimationFrame = () => 0; });
      await page.waitForFunction(() => !document.querySelector(".pastel-intro-cover"), null, { polling: 50, timeout: 8000 });
      await page.evaluate(() => { window.requestAnimationFrame = window.__qaOriginalRAF; delete window.__qaOriginalRAF; });
      const state = await finalState(page);
      assertAccessible(state);
      assert.equal(state.early.reason, "timeout", "A visible panel stall must be closed by the still-active playback watchdog.");
      assert.ok(state.removedAt - state.openedAt < 8000, "The panel phase must have a bounded runtime.");
    } finally { await page.close(); }
  });

  await scenarioTest("boundary: hero decode rejection fails preparation and restores the visible invitation", async () => {
    const page = await newPage();
    await page.addInitScript(() => {
      const original = HTMLImageElement.prototype.decode;
      window.__heroDecodeRejected = 0;
      HTMLImageElement.prototype.decode = function (...args) {
        if (this.matches(".pastel-hero-photo img")) {
          window.__heroDecodeRejected++;
          return Promise.reject(new DOMException("Independent synthetic hero decode failure", "EncodingError"));
        }
        return original.apply(this, args);
      };
    });
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const state = await finalState(page);
      assertAccessible(state);
      assert.ok(await page.evaluate(() => window.__heroDecodeRejected > 0), "The actual hero decode boundary must be exercised.");
      assert.equal(state.draws.length, 0, "Hero decode rejection must not be swallowed into successful ribbon preparation.");
      assert.equal(state.openedAt, null);
      assert.equal(state.early.reason, "asset-error");
      await page.mouse.wheel(0, 500);
      await page.waitForFunction(() => scrollY > 100);
    } finally { await page.close(); }
  });

  await scenarioTest("boundary: hero load failure dismisses the cover and unlocks readable content", async () => {
    const page = await newPage();
    let failedHeroRequests = 0;
    await page.addInitScript(() => {
      document.addEventListener("error", (event) => {
        if (event.target instanceof HTMLImageElement && event.target.closest(".pastel-hero-photo")) window.__qaHeroLoadError = true;
      }, true);
    });
    await page.route("**/assets/photos/pastel-hero-*.webp", (route) => {
      failedHeroRequests++;
      return route.fulfill({ status: 503, contentType: "text/plain", body: "Independent synthetic hero load failure" });
    });
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.querySelector(".pastel-invitation") && window.__pastelIntroEarly?.status === "consumed" && !document.querySelector(".pastel-intro-cover"), null, { timeout: 8000 });
      const state = await page.evaluate(() => {
        const hero = document.querySelector(".pastel-hero-photo img");
        const invitation = document.querySelector(".pastel-invitation");
        return { heroFailed: Boolean(window.__qaHeroLoadError) || Boolean(hero?.complete && hero.naturalWidth === 0), heroPresent: Boolean(hero), draws: window.__ribbonQA.draws.length, reason: window.__pastelIntroEarly.reason, opacity: getComputedStyle(invitation).opacity, locked: [document.documentElement, document.body].some((node) => getComputedStyle(node).overflow === "hidden"), contentHeight: invitation.scrollHeight };
      });
      if (artifactDir) await writeFile(join(artifactDir, "hero-load-failure-final-state.json"), JSON.stringify({ scenario: currentScenario, ...state }, null, 2));
      assert.ok(failedHeroRequests > 0 && state.heroFailed, "The real hero resource must have failed to load.");
      assert.equal(state.draws, 0);
      assert.equal(state.reason, "asset-error");
      assert.equal(state.opacity, "1");
      assert.equal(state.locked, false);
      assert.ok(state.contentHeight > 844, "The rest of the invitation must remain rendered and readable.");
      await page.mouse.wheel(0, 500);
      await page.waitForFunction(() => scrollY > 100);
    } finally { await page.close(); }
  });

  const bindingOptions = { skip: !lanHost };
  async function assertRealLan(page) {
    const context = await page.evaluate(() => ({ hostname: location.hostname, protocol: location.protocol, secure: isSecureContext, subtleType: typeof crypto.subtle }));
    assert.deepEqual(context, { hostname: lanHost, protocol: "http:", secure: false, subtleType: "undefined" }, "This must be a real LAN HTTP browser context with unavailable SubtleCrypto, not a mock.");
    return context;
  }

  if (!bindingOptions.skip) await scenarioTest("binding: real LAN HTTP shows the tied poster and completes playback without SubtleCrypto", async () => {
    const page = await newPage();
    await page.route("**/assets/index-*.js", async (route) => { await new Promise((resolve) => setTimeout(resolve, 900)); await route.continue(); });
    try {
      await page.goto(baseUrl, { waitUntil: "commit" });
      await page.waitForTimeout(400);
      const context = await assertRealLan(page);
      const poster = await page.locator("#pastel-intro-early-poster").evaluate((node) => ({ visible: getComputedStyle(node).display === "block", imageReady: node.querySelector("img").complete && node.querySelector("img").naturalWidth > 0, mainPending: document.querySelector("#root").childElementCount === 0 }));
      assert.deepEqual(poster, { visible: true, imageReady: true, mainPending: true });
      const state = await finalState(page);
      assertAccessible(state);
      assertCompletePlayback(state);
      if (artifactDir) await writeFile(join(artifactDir, "lan-http-context.json"), JSON.stringify({ context, poster, firstDrawAt: state.draws[0].at, frameCount: state.draws.length }, null, 2));
    } finally { await page.close(); }
  });

  if (!bindingOptions.skip) await scenarioTest("binding: manifest original-text mismatch fails open without late playback on LAN HTTP", async () => {
    const page = await newPage();
    let manifestRequests = 0;
    let frameRequests = 0;
    page.on("request", (request) => { if (/\/ribbon-sequence\/.*\.webp$/.test(request.url())) frameRequests++; });
    const originalText = await readFile(join(projectRoot, "public/assets/design/ribbon-sequence/manifest.json"), "utf8");
    await page.route("**/ribbon-sequence/manifest.json", async (route) => {
      manifestRequests++;
      // JSON meaning remains identical. Only exact source-text binding can reject this.
      await route.fulfill({ status: 200, contentType: "application/json", body: `${originalText} ` });
    });
    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await assertRealLan(page);
      const state = await finalState(page);
      assertAccessible(state);
      assert.equal(state.early.reason, "asset-error");
      assert.equal(state.draws.length, 0);
      assert.equal(frameRequests, 0, "A mismatched manifest must be rejected before loading any motion frame.");
      assert.equal(manifestRequests, 1);
      await page.waitForTimeout(1000);
      assert.equal(await page.evaluate(() => window.__ribbonQA.draws.length), 0);
      assert.equal(await page.locator(".pastel-intro-cover:visible, #pastel-intro-early-poster:visible").count(), 0);
      assert.equal(manifestRequests, 1, "No background retry may start a late cover after binding rejection.");
    } finally { await page.close(); }
  });

  await scenarioTest("binding: actual measured v2 curve preserves poster-to-F0 geometry, clears seam, and keeps its full controller lifetime", async () => {
    const syntheticUrl = `http://127.0.0.1:${address.port}`;
    const syntheticRoot = await mkdtemp(join(artifactDir || tmpdir(), "registration-input-"));
    const sequenceDir = join(syntheticRoot, "public/assets/design/ribbon-sequence");
    await mkdir(sequenceDir, { recursive: true });
    const firstBytes = await readFile(join(projectRoot, "public/assets/design/ribbon-sequence", manifest.frames[0]));
    const synthetic = {
      schemaVersion: 2, fps: 30, width: manifest.width, height: manifest.height,
      frames: manifest.frames.slice(0, 3), holdMs: 800, panelDelayMs: 600, panelDurationMs: 1400,
      releaseCompleteFrame: 1, registration: { x: manifest.width * 3 / 8, y: manifest.height * 3 / 8 }, rootYPx: [0, 0, 0],
      poster: { frameIndex: 0, sha256: createHash("sha256").update(firstBytes).digest("hex") },
      panelCurve: measuredPanelCurve,
    };
    const body = JSON.stringify(synthetic);
    await writeFile(join(sequenceDir, "manifest.json"), body);
    await writeFile(join(sequenceDir, manifest.frames[0]), firstBytes);
    const page = await newPage();
    await page.route("**/ribbon-sequence/manifest.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body }));
    await page.route("**/assets/index-*.js", async (route) => { await new Promise((resolve) => setTimeout(resolve, 900)); await route.continue(); });
    await page.route(`${syntheticUrl}/`, async (route) => {
      const response = await route.fetch();
      let html = await response.text();
      const earlyHead = /<style id="pastel-intro-early-style">[\s\S]*?<\/style>\s*<script id="pastel-intro-early-boot">[\s\S]*?<\/script>/;
      const match = html.match(earlyHead);
      assert.ok(match, "The real compiled entry must contain the production early style and boot script.");
      const originalCwd = process.cwd();
      let markup;
      try {
        // The actual production generator resolves its manifest from cwd. This synchronous
        // call supplies test-owned inputs without changing any repository product file.
        process.chdir(syntheticRoot);
        markup = createEarlyPosterMarkup();
      } finally { process.chdir(originalCwd); }
      html = html.replace(earlyHead, markup.styles);
      const start = html.indexOf('<div id="pastel-intro-early-poster"');
      const bodyEnd = html.indexOf("</body>", start);
      const end = html.lastIndexOf("</div>", bodyEnd) + 6;
      assert.ok(start >= 0 && end > start);
      html = html.slice(0, start) + markup.posterNode + html.slice(end);
      await route.fulfill({ response, body: html });
    });
    try {
      await page.goto(syntheticUrl, { waitUntil: "commit" });
      await page.waitForTimeout(400);
      const initial = await page.locator("#pastel-intro-early-poster img").evaluate((image) => ({ ready: image.complete && image.naturalWidth > 0, rootEmpty: document.querySelector("#root").childElementCount === 0 }));
      assert.deepEqual(initial, { ready: true, rootEmpty: true });
      await page.waitForFunction(() => window.__ribbonQA.handoff !== null);
      const handoff = await page.evaluate(() => window.__ribbonQA.handoff);
      const expected = { x: 390 / 2 - synthetic.registration.x * 390 / synthetic.width, y: 844 / 2 - synthetic.registration.y * 390 / synthetic.width, width: 390, height: synthetic.height * 390 / synthetic.width };
      for (const field of ["x", "y", "width", "height"]) {
        assert.ok(Math.abs(handoff.poster[field] - handoff.canvas[field]) <= 1, `Synthetic v2 handoff ${field} must remain within 1px.`);
        assert.ok(Math.abs(handoff.poster[field] - expected[field]) <= 1, `Generated poster ${field} must honor the noncenter registration.`);
        assert.ok(Math.abs(handoff.canvas[field] - expected[field]) <= 1, `Actual F0 canvas ${field} must honor the noncenter registration.`);
      }
      const freezePanels = () => page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        return performance.now();
      });
      const resumePanels = () => page.evaluate(() => {
        delete document.hidden;
        delete document.visibilityState;
        document.dispatchEvent(new Event("visibilitychange"));
        return performance.now();
      });
      await page.waitForFunction(() => {
        const cover = document.querySelector(".pastel-intro-cover");
        if (!cover) return false;
        const style = getComputedStyle(cover);
        const left = Number(style.getPropertyValue("--pastel-intro-left-progress"));
        const right = Number(style.getPropertyValue("--pastel-intro-right-progress"));
        return left > 0.2 && left < 0.8 && right > 0.2 && right < 0.8;
      });
      const midPauseAt = await freezePanels();
      const midOpen = await page.evaluate(() => {
        const cover = document.querySelector(".pastel-intro-cover");
        const style = getComputedStyle(cover);
        const seam = cover.querySelector(".pastel-intro-cover__seam");
        return {
          leftProgress: Number(style.getPropertyValue("--pastel-intro-left-progress")),
          rightProgress: Number(style.getPropertyValue("--pastel-intro-right-progress")),
          seamOpacity: Number(getComputedStyle(seam).opacity),
          coverPresent: Boolean(cover),
          openedAt: window.__ribbonQA.openedAt,
        };
      });
      const centerPatch = { left: 194, top: 0, width: 2, height: 24 };
      const midImage = await page.screenshot(artifactDir ? { path: join(artifactDir, "actual-v2-curve-mid-open.png") } : {});
      assert.equal(midOpen.seamOpacity, 0, "A fixed center seam must disappear as soon as panels open.");
      assert.equal(midOpen.coverPresent, true);
      const midResumeAt = await resumePanels();
      await page.waitForFunction(() => {
        const cover = document.querySelector(".pastel-intro-cover");
        if (!cover) return false;
        const style = getComputedStyle(cover);
        return Number(style.getPropertyValue("--pastel-intro-left-progress")) === 1
          && Number(style.getPropertyValue("--pastel-intro-right-progress")) === 1;
      });
      const fullyOpenBeforeDuration = await page.evaluate(() => ({
        elapsedMs: performance.now() - window.__ribbonQA.openedAt,
        coverPresent: Boolean(document.querySelector(".pastel-intro-cover")),
        leftProgress: Number(getComputedStyle(document.querySelector(".pastel-intro-cover")).getPropertyValue("--pastel-intro-left-progress")),
        rightProgress: Number(getComputedStyle(document.querySelector(".pastel-intro-cover")).getPropertyValue("--pastel-intro-right-progress")),
      }));
      fullyOpenBeforeDuration.effectiveElapsedMs = fullyOpenBeforeDuration.elapsedMs - (midResumeAt - midPauseAt);
      assert.ok(fullyOpenBeforeDuration.effectiveElapsedMs < synthetic.panelDurationMs - 50, "The measured curve must reach its zero-width state before the 1400ms controller lifetime ends.");
      assert.equal(fullyOpenBeforeDuration.coverPresent, true, "The cover must remain mounted through the elapsed 1400ms panel contract.");
      await freezePanels();
      await screenshot(page, "actual-v2-curve-zero-width-before-duration");
      await resumePanels();
      await page.waitForFunction(() => !document.querySelector(".pastel-intro-cover"));
      const finalImage = await page.screenshot(artifactDir ? { path: join(artifactDir, "actual-v2-curve-final-after-duration.png") } : {});
      const [midPixels, finalPixels] = await Promise.all([midImage, finalImage].map((png) => sharp(png).extract(centerPatch).removeAlpha().raw().toBuffer()));
      const centerMeanDifference = midPixels.reduce((total, value, index) => total + Math.abs(value - finalPixels[index]), 0) / midPixels.length;
      const completed = await page.evaluate(() => ({ removedAt: window.__ribbonQA.removedAt, openedAt: window.__ribbonQA.openedAt }));
      assert.ok(completed.removedAt - completed.openedAt >= synthetic.panelDurationMs - 5, "Cover removal must honor panelDurationMs even after the measured curve has reached progress=1.");
      assert.ok(centerMeanDifference <= 1, `The opening center must reveal the final hero without a residual seam; mean pixel difference=${centerMeanDifference.toFixed(3)}.`);
      if (artifactDir) await writeFile(join(artifactDir, "actual-v2-curve-evidence.json"), JSON.stringify({
        classification: "synthetic v2 manifest using checked-in measured panel curve; no cloth-physics acceptance",
        registration: synthetic.registration, expected, initial, handoff, centerPatch, centerMeanDifference,
        firstFullyOpenPoint: measuredPanelCurve.find((point) => point.progress === 1),
        midOpen, fullyOpenBeforeDuration, completed,
      }, null, 2));
      assertAccessible(await finalState(page));
    } finally { await page.close(); if (!artifactDir) await rm(syntheticRoot, { recursive: true, force: true }); }
  });

  let lifecycleBundle;
  async function lifecyclePage(strict) {
    if (!lifecycleBundle) {
      const componentPath = join(projectRoot, "src/intro/PastelIntroCover.jsx").replaceAll("\\", "/");
      const code = `
import { createElement, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PastelIntroCover } from ${JSON.stringify(componentPath)};
window.__qaLifecycle = { effects: 0, cleanups: 0 };
function LifecycleHarness() {
  const [mounted, setMounted] = useState(true);
  window.__qaMountCover = setMounted;
  useEffect(() => {
    window.__qaLifecycle.effects++;
    return () => { window.__qaLifecycle.cleanups++; };
  }, []);
  return createElement("main", { className: "app-shell" },
   createElement("div", { className: "invitation-stage" },
    createElement("article", { className: "invitation pastel-invitation", style: { minHeight: "2400px" } },
    createElement("div", { className: "pastel-hero-photo", style: { width: "340px", height: "425px" } },
      createElement("img", { src: "/assets/photos/pastel-hero-480.webp", alt: "QA lifecycle fixture", width: 340, height: 425 })),
    createElement("p", null, "Synthetic lifecycle fixture; no public content changes"))),
    mounted ? createElement(PastelIntroCover, { onFinish: () => setMounted(false) }) : null);
}
const root = createRoot(document.getElementById("root"));
root.render(window.__qaStrictMode ? createElement(StrictMode, null, createElement(LifecycleHarness)) : createElement(LifecycleHarness));
`;
      const result = await build({
        root: projectRoot, logLevel: "silent", publicDir: false,
        define: { "process.env.NODE_ENV": JSON.stringify("development") },
        resolve: { alias: { react: join(projectRoot, "node_modules/react"), "react-dom": join(projectRoot, "node_modules/react-dom") } },
        plugins: [{
          name: "independent-lifecycle-fixture",
          resolveId(id) { if (id === "virtual:qa-lifecycle") return "\0qa-lifecycle"; },
          load(id) { if (id === "\0qa-lifecycle") return code; },
        }],
        build: { write: false, minify: false, rollupOptions: { input: "virtual:qa-lifecycle", output: { inlineDynamicImports: true } } },
      });
      const output = Array.isArray(result) ? result[0].output : result.output;
      const entry = output.find((item) => item.type === "chunk" && item.isEntry);
      assert.ok(entry, "The lifecycle fixture must compile the actual React cover into an executable entry.");
      lifecycleBundle = entry.code;
      if (artifactDir) await writeFile(join(artifactDir, "qa-lifecycle-entry.js"), lifecycleBundle);
    }
    const page = await newPage();
    await page.addInitScript((enabled) => { window.__qaStrictMode = enabled; }, strict);
    const url = `http://127.0.0.1:${address.port}`;
    await page.route(`${url}/qa-lifecycle.js`, (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: lifecycleBundle }));
    await page.route(`${url}/`, async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      const entryScript = /<script\b[^>]*type="module"[^>]*src="[^"]+"[^>]*><\/script>/;
      assert.ok(entryScript.test(html), "The actual early poster and styles must be retained around the test-only entry.");
      await route.fulfill({ response, body: html.replace(entryScript, '<script type="module" src="/qa-lifecycle.js"></script>') });
    });
    return { page, url };
  }

  for (const phase of ["preparation", "playback"]) {
    await scenarioTest(`lifecycle: genuine cover unmount and remount during ${phase} cannot restart this page load`, async () => {
      const { page, url } = await lifecyclePage(false);
      const blocked = [];
      let frameRequests = 0;
      let manifestRequests = 0;
      let firstRequestResolve;
      const firstRequest = new Promise((resolve) => { firstRequestResolve = resolve; });
      page.on("request", (request) => { if (/\/ribbon-sequence\/.*\.webp$/.test(request.url())) { frameRequests++; firstRequestResolve(); } });
      page.on("request", (request) => { if (request.url().endsWith("/ribbon-sequence/manifest.json")) manifestRequests++; });
      if (phase === "preparation") await page.route("**/ribbon-sequence/*.webp", (route) => { blocked.push(route); });
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        if (phase === "preparation") await firstRequest;
        else await page.waitForFunction(() => window.__ribbonQA.draws.length >= 5);
        await page.evaluate(() => window.__qaMountCover(false));
        await page.waitForFunction(() => window.__pastelIntroEarly?.status === "consumed", null, { polling: 20, timeout: 1500 });
        const disposed = await page.evaluate(() => ({ reason: window.__pastelIntroEarly.reason, poster: Boolean(document.querySelector("#pastel-intro-early-poster")), locked: [document.documentElement, document.body].some((node) => getComputedStyle(node).overflow === "hidden"), draws: window.__ribbonQA.draws.length }));
        assert.equal(disposed.reason, "unmount");
        assert.equal(disposed.poster, false);
        assert.equal(disposed.locked, false);
        await Promise.allSettled(blocked.splice(0).map((route) => route.abort()));
        const requestsBeforeRemount = frameRequests;
        const manifestsBeforeRemount = manifestRequests;
        await page.evaluate(() => window.__qaMountCover(true));
        await page.waitForTimeout(350);
        const state = await finalState(page);
        assertAccessible(state);
        assert.equal(frameRequests, requestsBeforeRemount, "A genuine remount must not request a second motion sequence.");
        assert.equal(manifestRequests, manifestsBeforeRemount, "A genuine remount must not request another manifest.");
        assert.equal(state.draws.length, disposed.draws, "A genuine remount must not draw another frame on the consumed page load.");
        assert.equal(state.early.status, "consumed");
        assert.equal(state.early.reason, "unmount");
        if (artifactDir) await writeFile(join(artifactDir, `lifecycle-${phase}.json`), JSON.stringify({ disposed, requestsBeforeRemount, requestsAfterRemount: frameRequests, manifestsBeforeRemount, manifestsAfterRemount: manifestRequests, drawsAfterRemount: state.draws.length, finalReason: state.early.reason }, null, 2));
      } finally { await Promise.allSettled(blocked.map((route) => route.abort())); await page.close(); }
    });
  }

  await scenarioTest("lifecycle: development StrictMode replays effects once but runs one intro and permits a fresh reload", async () => {
    const { page, url } = await lifecyclePage(true);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ribbonQA.draws.length > 0);
      const effects = await page.evaluate(() => window.__qaLifecycle);
      assert.deepEqual(effects, { effects: 2, cleanups: 1 }, "The real development React StrictMode effect replay must actually occur.");
      const state = await finalState(page);
      const firstPlaybackTiming = timingDiagnostic ? await page.evaluate(() => window.__ribbonQA.timing) : undefined;
      assertAccessible(state);
      assertCompletePlayback(state);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__ribbonQA.draws.length > 0);
      const reload = await page.evaluate(() => ({ effects: window.__qaLifecycle, mounts: window.__ribbonQA.mounts, firstIndex: window.__ribbonQA.draws[0].index, status: window.__pastelIntroEarly.status }));
      assert.deepEqual(reload.effects, { effects: 2, cleanups: 1 });
      assert.equal(reload.mounts, 1);
      assert.equal(reload.firstIndex, 0);
      assert.equal(reload.status, "claimed");
      if (artifactDir) await writeFile(join(artifactDir, "lifecycle-strictmode-reload.json"), JSON.stringify({ firstLoadEffects: effects, firstLoadFrames: state.draws.length, firstPlaybackTiming, reload }, null, 2));
      await page.mouse.click(10, 10);
      assertAccessible(await finalState(page));
    } finally { await page.close(); }
  });

  for (const path of ["/admin", "/admin/guestbook", "/admin/content"]) {
    await scenarioTest(`${path} never mounts the early poster or animation`, async () => {
      const page = await newPage();
      let sequenceRequests = 0;
      page.on("request", (request) => { if (request.url().includes("/ribbon-sequence/")) sequenceRequests++; });
      try {
        await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
        assert.equal(await page.locator(".pastel-intro-cover:visible, #pastel-intro-early-poster:visible").count(), 0);
        assert.equal(await page.evaluate(() => window.__ribbonQA.mounts), 0);
        assert.equal(sequenceRequests, 0);
        assert.notEqual(await page.locator("body").evaluate((body) => getComputedStyle(body).overflow), "hidden");
      } finally { await page.close(); }
    });
  }

  for (const width of [360, 390, 430, 768, 1440]) {
    for (const variant of ["pastel", "quiet"]) {
      await scenarioTest(`${variant} ${width}px has no overflow and respects the intro exemption`, async () => {
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
