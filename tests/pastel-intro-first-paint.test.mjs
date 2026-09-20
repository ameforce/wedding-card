import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import sharp from "sharp";
import { createServer } from "vite";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const sequenceManifest = JSON.parse(await readFile(join(projectRoot, "public/assets/design/ribbon-sequence/manifest.json"), "utf8"));
const expectedF0Hash = createHash("sha256").update(await readFile(join(projectRoot, "public/assets/design/ribbon-sequence", sequenceManifest.frames[0]))).digest("hex");

test("loading runtime cover CSS cannot recolor the still-visible initial paper", { timeout: 90_000 }, async (t) => {
  const server = await createServer({ root: projectRoot, logLevel: "silent", server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const css = await readFile(join(projectRoot, "src/intro/pastel-intro.css"), "utf8");
  for (const width of [360, 390, 430, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    // Hold the controller out of the experiment. Introduce its exact stylesheet
    // independently, as Vite does before the controller claims the poster.
    await page.route("**/src/main.jsx*", (route) => route.abort());
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "load" });
    await page.locator("#pastel-intro-early-poster img").evaluate((img) => img.decode());
    const before = await page.screenshot();
    await page.addStyleTag({ content: css });
    const after = await page.screenshot();
    const surface = await page.locator("#pastel-intro-early-poster .pastel-intro-cover__panel--right").evaluate((panel) => {
      const shade = getComputedStyle(panel, "::after");
      return { content: shade.content, opacity: shade.opacity, background: shade.backgroundColor };
    });
    if (process.env.RIBBON_QA_DIR) {
      await mkdir(process.env.RIBBON_QA_DIR, { recursive: true });
      await writeFile(join(process.env.RIBBON_QA_DIR, `paper-before-css-${width}.png`), before);
      await writeFile(join(process.env.RIBBON_QA_DIR, `paper-after-css-${width}.png`), after);
      await writeFile(join(process.env.RIBBON_QA_DIR, `paper-css-${width}.json`), JSON.stringify(surface, null, 2));
    }
    assert.equal(surface.content, "none", `${width}px: runtime shading must not create a layer on the initial poster: ${JSON.stringify(surface)}`);
    assert.deepEqual(await sharp(after).raw().toBuffer(), await sharp(before).raw().toBuffer(), `${width}px: loading runtime CSS must preserve every initial-cover pixel`);
    await page.close();
  }
});

test("cold first paint shows the tied poster before the delayed main bundle and motion assets", { timeout: 20_000 }, async (t) => {
  const server = await createServer({ root: projectRoot, logLevel: "silent", server: { host: "127.0.0.1", port: 0, strictPort: false } });
  let browser;
  let page;
  t.after(async () => { await page?.unrouteAll({ behavior: "wait" }); await browser?.close(); await server.close(); });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const diagnostics = { scenario: "cold-main-3000ms-motion-blocked-390x844", responses: [], failures: [], errors: [], mainRequested: false, mainReleased: false };
  page.on("response", (response) => diagnostics.responses.push({ url: new URL(response.url()).pathname, status: response.status() }));
  page.on("requestfailed", (request) => diagnostics.failures.push({ url: new URL(request.url()).pathname, error: request.failure()?.errorText }));
  page.on("pageerror", (error) => diagnostics.errors.push(error.message));
  await page.route("**/src/main.jsx*", async (route) => {
    diagnostics.mainRequested = true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    diagnostics.mainReleased = true;
    await route.continue().catch(() => {});
  });
  await page.route(/\/ribbon-sequence\/.*\.webp(?:\?.*)?$/, (route) => {
    // Permit only the real tied F0. Playback resources cannot supply the first paint.
    return /\/frame-0+-/.test(route.request().url()) ? route.continue() : route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "commit" });
  await page.waitForTimeout(700);
  diagnostics.visual = await page.evaluate(async () => {
    const poster = document.querySelector("#pastel-intro-early-poster");
    const rect = poster?.getBoundingClientRect();
    const style = poster && getComputedStyle(poster);
    const images = poster ? [...poster.querySelectorAll("img")].map((img) => ({ loaded: img.complete && img.naturalWidth > 0, width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height })) : [];
    const image = poster?.querySelector("img");
    const digest = image?.complete && image.naturalWidth > 0 ? await crypto.subtle.digest("SHA-256", await (await fetch(image.currentSrc)).arrayBuffer()) : null;
    const posterSHA256 = digest ? [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("") : null;
    return { at: performance.now(), posterPresent: Boolean(poster), posterSHA256, rootChildren: document.querySelector("#root")?.childElementCount, rect: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, style: style && { display: style.display, visibility: style.visibility, opacity: style.opacity }, images, bodyLocked: getComputedStyle(document.body).overflow === "hidden" || getComputedStyle(document.documentElement).overflow === "hidden", html: document.body.innerHTML.replace(/src="data:[^"]*"/g, 'src="[inline-data-omitted]"').slice(0, 2000) };
  });
  if (process.env.RIBBON_QA_DIR) {
    await mkdir(process.env.RIBBON_QA_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.RIBBON_QA_DIR, "first-paint-700ms.png") });
    await writeFile(join(process.env.RIBBON_QA_DIR, "first-paint.json"), JSON.stringify(diagnostics, null, 2));
  }
  console.log(JSON.stringify(diagnostics));
  assert.equal(diagnostics.mainRequested, true, "Scenario must delay an actual main-bundle request.");
  assert.equal(diagnostics.mainReleased, false, "Evidence must precede main-bundle release.");
  assert.equal(diagnostics.visual.posterPresent, true, "A tied ribbon poster must be present before the main bundle; blank paper fails acceptance.");
  assert.equal(diagnostics.visual.style.visibility, "visible");
  assert.equal(diagnostics.visual.style.opacity, "1");
  assert.notEqual(diagnostics.visual.style.display, "none");
  assert.ok(diagnostics.visual.images.some((img) => img.loaded && img.width > 100 && img.height > 50), "The tied F0 must be decoded and visibly sized before main.");
  assert.equal(diagnostics.visual.posterSHA256, expectedF0Hash, "The initial image must contain the exact current F0 bytes, not an unrelated tied pose.");
  assert.ok(Math.abs(diagnostics.visual.rect.width - 390) <= 1 && Math.abs(diagnostics.visual.rect.height - 844) <= 1, "The cover must fill the true viewport.");
  assert.equal(diagnostics.visual.bodyLocked, true, "The early cover must own the temporary scroll lock.");
});

test("early poster exemptions and tap-to-skip work while the main bundle is still delayed", { timeout: 60_000 }, async (t) => {
  const server = await createServer({ root: projectRoot, logLevel: "silent", server: { host: "127.0.0.1", port: 0, strictPort: false } });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  for (const suffix of ["/?capture=1", "/?variant=quiet", "/admin", "/admin/guestbook", "/admin/content"]) {
    await t.test(`pre-main exemption ${suffix}`, async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      let release;
      const delayed = new Promise((resolve) => { release = resolve; });
      await page.route("**/src/main.jsx*", async (route) => { await delayed; await route.continue().catch(() => {}); });
      try {
        await page.goto(`${baseUrl}${suffix}`, { waitUntil: "commit" });
        await page.waitForTimeout(150);
        assert.equal(await page.locator("#pastel-intro-early-poster:visible, .pastel-intro-cover:visible").count(), 0, `${suffix} must not flash a cover before React mounts.`);
        assert.equal(await page.evaluate(() => [document.documentElement, document.body].some((element) => getComputedStyle(element).overflow === "hidden")), false, `${suffix} must never acquire the early scroll lock.`);
      } finally {
        release();
        await page.unrouteAll({ behavior: "wait" });
        await page.close();
      }
    });
  }
  await t.test("pre-main tap removes poster and suppresses a later React remount", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route("**/src/main.jsx*", async (route) => { await new Promise((resolve) => setTimeout(resolve, 3000)); await route.continue().catch(() => {}); });
    try {
      await page.goto(baseUrl, { waitUntil: "commit" });
      await page.locator("#pastel-intro-early-poster").click({ position: { x: 10, y: 10 }, timeout: 1500 });
      await page.waitForFunction(() => !document.querySelector("#pastel-intro-early-poster"), null, { timeout: 1000 });
      assert.equal(await page.evaluate(() => [document.documentElement, document.body].some((element) => getComputedStyle(element).overflow === "hidden")), false);
      await page.waitForFunction(() => document.querySelector(".pastel-hero-photo img")?.complete, null, { timeout: 10_000 });
      assert.equal(await page.locator("#pastel-intro-early-poster:visible, .pastel-intro-cover:visible").count(), 0, "A skip before main must persist through the React handoff for this load.");
    } finally { await page.unrouteAll({ behavior: "wait" }); await page.close(); }
  });
});

test("the handoff reuses the inline early-paper bytes when the public paper URL is blocked", { timeout: 30_000 }, async (t) => {
  const server = await createServer({ root: projectRoot, logLevel: "silent", server: { host: "127.0.0.1", port: 0, strictPort: false } });
  let browser;
  let page;
  let releaseMain = () => {};
  t.after(async () => { await page?.unrouteAll({ behavior: "wait" }); await browser?.close(); await server.close(); });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const mainGate = new Promise((resolve) => { releaseMain = resolve; });
  await page.route("**/src/main.jsx*", async (route) => { await mainGate; await route.continue().catch(() => {}); });
  let blockedPaperRequests = 0;
  await page.route("**/assets/design/intro-paper-ivory.webp*", async (route) => {
    blockedPaperRequests += 1;
    await route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`, { waitUntil: "commit" });
  await page.waitForSelector("#pastel-intro-early-poster:visible");
  const earlyPixels = await page.screenshot();
  releaseMain();
  await page.waitForFunction(() => document.querySelector(".pastel-intro-cover") && document.querySelector("#pastel-intro-early-poster")?.dataset.handoff === "claimed");
  const handoffProgress = await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    const cover = document.querySelector(".pastel-intro-cover");
    return Number(getComputedStyle(cover).getPropertyValue("--pastel-intro-left-progress"));
  });
  const handoff = await page.evaluate(() => {
    const panel = document.querySelector(".pastel-intro-cover__panel--left");
    return {
      paperImage: panel && getComputedStyle(panel, "::before").backgroundImage,
      rootPaperImage: getComputedStyle(document.documentElement).getPropertyValue("--pastel-intro-paper-image"),
    };
  });
  const handoffPixels = await page.screenshot();
  const [earlyPaper, handoffPaper] = await Promise.all([earlyPixels, handoffPixels].map((png) => sharp(png).extract({ left: 8, top: 8, width: 40, height: 120 }).removeAlpha().raw().toBuffer()));
  const meanDifference = earlyPaper.reduce((sum, value, index) => sum + Math.abs(value - handoffPaper[index]), 0) / earlyPaper.length;
  assert.match(handoff.paperImage, /^url\("?data:image\/webp;base64,/u, "The React paper face must inherit the early poster's inline bytes.");
  assert.match(handoff.rootPaperImage, /^url\("?data:image\/webp;base64,/u);
  assert.equal(blockedPaperRequests, 0, "The first cover and its handoff must not request a second paper image.");
  assert.ok(handoffProgress <= 0.025, "The paper patch must be compared before panel opening changes its face lighting.");
  assert.ok(meanDifference <= 1, `The blocked-paper handoff changes the same paper patch by ${meanDifference.toFixed(3)} mean channel value.`);
});
