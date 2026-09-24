import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium, webkit } from "playwright";
const browserType = process.env.WEDDING_QA_BROWSER === "webkit" ? webkit : chromium;
import { createServer } from "vite";
import { reorderGallery } from "../src/admin-content/gallery-order.js";
import { normalizePhotoPresentation } from "../src/photo-presentation.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
test("arbitrary insertion is immutable and retains every photo, including cross-row moves", () => {
  for (const count of [1, 2, 4, 5, 8, 30]) {
    const photos = Array.from({ length: count }, (_, index) => ({ src: `photo-${index}` }));
    for (let from = 0; from < count; from++) for (let to = 0; to < count; to++) {
      const reordered = reorderGallery(photos, photos[from].src, photos[to].src);
      assert.equal(reordered[to], photos[from]);
      assert.equal(new Set(reordered).size, count);
      assert.deepEqual(reordered.filter((photo) => photo !== photos[from]), photos.filter((photo) => photo !== photos[from]));
      assert.deepEqual(photos.map((photo) => photo.src), Array.from({ length: count }, (_, index) => `photo-${index}`));
    }
    assert.equal(reorderGallery(photos, "external", photos[0].src), photos);
    assert.equal(reorderGallery(photos, photos[0].src, "stale"), photos);
  }
});
test("automatic presentation preserves legacy crops but never borrows another photo description", () => {
  assert.deepEqual(normalizePhotoPresentation({ src: "new" }), { src: "new", alt: "웨딩 사진", position: "50% 50%" });
  assert.equal(normalizePhotoPresentation({ position: "50% 58%", alt: "기존 설명" }).position, "50% 58%");
  assert.equal(normalizePhotoPresentation({ position: "101% 50%", alt: "x".repeat(301) }).position, "50% 50%");
});

test("real admin drag, keyboard, upload and explicit publication preserve the public layout", { timeout: 120000 }, async () => {
  const server = await createServer({ root: projectRoot, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await browserType.launch({ headless: true }).catch(async (error) => { await server.close(); throw error; });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const openPhotos = async () => {
    await page.waitForSelector(".content-admin-status.is-review");
    await page.locator("summary").filter({ hasText: /^사진$/ }).click();
    await page.waitForSelector(".content-admin-gallery-tile");
  };
  const sources = (owner, selector) => owner.locator(`${selector} img`).evaluateAll((images) => images.map((image) => image.getAttribute("src")));
  try {
    await page.goto(`${base}/admin`);
    await openPhotos();
    assert.equal(await page.getByText("현재 사진 대체 텍스트", { exact: true }).count(), 0);
    assert.equal(await page.getByText("초점 위치", { exact: true }).count(), 0);
    const tiles = page.locator(".content-admin-gallery-tile");
    const original = await sources(page, ".content-admin-gallery-tile");
    assert.equal(original.length, 4);
    await page.getByRole("button", { name: "갤러리 1 뒤로 이동", exact: true }).click();
    assert.equal(await tiles.nth(1).getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "갤러리 2 앞으로 이동", exact: true }).click();
    assert.deepEqual(await sources(page, ".content-admin-gallery-tile"), original);
    const external = await page.evaluateHandle(() => new DataTransfer());
    await tiles.first().dispatchEvent("drop", { dataTransfer: external });
    assert.deepEqual(await sources(page, ".content-admin-gallery-tile"), original);
    await external.dispose();
    const rectangles = await tiles.evaluateAll((items) => items.map((item) => { const r = item.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width }; }));
    assert.equal(rectangles[0].y, rectangles[2].y);
    assert.ok(rectangles[2].x > rectangles[0].x);
    assert.ok(rectangles[3].width > rectangles[0].width * 2.9);
    await tiles.nth(0).dragTo(tiles.nth(3));
    const reordered = [...original.slice(1), original[0]];
    assert.deepEqual(await sources(page, ".content-admin-gallery-tile"), reordered);
    await page.waitForFunction((expected) => {
      const doc = document.querySelector(".content-admin-preview iframe")?.contentDocument;
      return JSON.stringify([...doc.querySelectorAll(".pastel-gallery-item img")].map((img) => img.getAttribute("src"))) === JSON.stringify(expected);
    }, reordered);
    const visitor = await context.newPage();
    await visitor.goto(`${base}/?capture=1`);
    await visitor.waitForSelector(".pastel-gallery-item");
    assert.deepEqual(await sources(visitor, ".pastel-gallery-item"), original);
    await page.getByRole("button", { name: "임시 적용", exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector(".content-admin-status")?.textContent.includes("임시 적용했습니다"));
    await page.reload();
    await openPhotos();
    assert.deepEqual(await sources(page, ".content-admin-gallery-tile"), reordered);
    await tiles.nth(0).focus();
    await page.keyboard.press("Alt+ArrowRight");
    assert.deepEqual((await sources(page, ".content-admin-gallery-tile")).slice(0, 2), [reordered[1], reordered[0]]);
    await page.keyboard.press("Alt+ArrowLeft");
    assert.deepEqual(await sources(page, ".content-admin-gallery-tile"), reordered);
    const image = await readFile(new URL("../public/assets/photos/pastel-hero-480.webp", import.meta.url));
    await page.locator(".content-admin-photo-card.is-hero input[type=file]").setInputFiles({ name: "new-photo.webp", mimeType: "image/webp", buffer: image });
    await page.waitForFunction(() => document.querySelector(".content-admin-status")?.textContent.includes("새 사진을 편집본"));
    await page.getByRole("button", { name: "임시 적용", exact: true }).first().click();
    await page.waitForFunction(() => document.querySelector(".content-admin-status")?.textContent.includes("임시 적용했습니다"));
    await visitor.reload();
    await visitor.waitForSelector(".pastel-gallery-item");
    assert.deepEqual(await sources(visitor, ".pastel-gallery-item"), original);
    await page.getByRole("button", { name: "게시", exact: true }).first().click();
    await page.getByRole("button", { name: "게시하기", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".content-admin-status")?.textContent.includes("로컬 공개본을 갱신"));
    await visitor.reload();
    await visitor.waitForSelector(".pastel-gallery-item");
    assert.deepEqual(await sources(visitor, ".pastel-gallery-item"), reordered);
    for (const width of [360, 390, 430, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Admin overflow at ${width}px`);
      const widths = await tiles.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().width));
      assert.ok(widths[3] > widths[0] * 2.9, `Actual 3+1 layout at ${width}px`);
    }
    if (process.env.WEDDING_GALLERY_QA_DIR) {
      await mkdir(process.env.WEDDING_GALLERY_QA_DIR, { recursive: true });
      await page.locator(".content-admin-gallery-layout").screenshot({ path: `${process.env.WEDDING_GALLERY_QA_DIR}/admin-gallery-layout.png` });
    }
    while (await tiles.count() > 1) {
      await tiles.first().click();
      await page.getByRole("button", { name: "갤러리 1 목록에서 제거", exact: true }).click();
    }
    assert.equal(await page.getByRole("button", { name: "갤러리 1 목록에서 제거", exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("intro suppresses native tap tint, keeps keyboard focus and opens paper without a hold", { timeout: 30000 }, async (t) => {
  const server = await createServer({ root: projectRoot, logLevel: "silent", server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const browser = await browserType.launch({ headless: true }).catch(async (error) => { await server.close(); throw error; });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await page.addInitScript(() => {
    window.__openingTiming = {};
    const original = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      const result = original.apply(this, args);
      if (args.length === 5 && this.canvas.matches(".pastel-intro-cover__ribbon")) {
        const pixels = this.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
        let top = null;
        for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) { top = Math.floor((index - 3) / 4 / this.canvas.width); break; }
        const at = performance.now();
        window.__openingTiming.lastDraw = at;
        queueMicrotask(() => {
          const rect = this.canvas.getBoundingClientRect();
          if (top !== null && window.__openingTiming.exit === undefined && rect.top + top * rect.height / this.canvas.height >= innerHeight + 16) window.__openingTiming.exit = at;
        });
      }
      return result;
    };
    document.addEventListener("pastel-intro-paper-opening", () => { window.__openingTiming.paper = performance.now(); });
    document.addEventListener("pastel-intro-opened", () => { window.__openingTiming.opened = performance.now(); });
  });
  try {
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    const start = page.locator(".pastel-intro-cover__start");
    await start.waitFor();
    for (const selector of ["#pastel-intro-early-poster", ".pastel-intro-cover", ".pastel-intro-cover__start"]) {
      const style = await page.locator(selector).evaluate((element) => ({
        supportsHighlight: CSS.supports("-webkit-tap-highlight-color", "transparent"),
        highlight: getComputedStyle(element).getPropertyValue("-webkit-tap-highlight-color"),
        selection: getComputedStyle(element).getPropertyValue("-webkit-user-select") || getComputedStyle(element).userSelect,
      }));
      if (style.supportsHighlight) assert.equal(style.highlight, "rgba(0, 0, 0, 0)");
      else assert.equal(browserType.name(), "webkit", "Only the desktop WebKit port lacks this mobile CSS property");
      assert.equal(style.selection, "none");
    }
    assert.match(await page.locator("#pastel-intro-early-style").textContent(), /-webkit-tap-highlight-color:transparent/);
    assert.match(await readFile(new URL("../src/intro/pastel-intro.css", import.meta.url), "utf8"), /-webkit-tap-highlight-color: transparent/);
    await page.keyboard.press("Tab");
    await start.focus();
    assert.equal(await start.evaluate((button) => getComputedStyle(button).outlineStyle), "none");
    assert.equal(await start.locator("span").evaluate((span) => getComputedStyle(span).outlineStyle), "solid");
    await start.tap();
    await page.waitForFunction(() => Number.isFinite(window.__openingTiming.opened));
    const timing = await page.evaluate(() => window.__openingTiming);
    assert.ok(timing.paper - timing.exit >= 0 && timing.paper - timing.exit < 180, "No invisible-tail idle hold");
    assert.ok(timing.opened - timing.paper >= 780 && timing.opened - timing.paper < 1100, "800ms visible paper lifetime");
    await page.waitForSelector(".pastel-intro-cover", { state: "detached" });
    assert.equal(await page.locator(".pastel-intro-cover").count(), 0);
    assert.equal(await page.evaluate(() => document.body.classList.contains("intro-lock")), false);
    const input = page.locator('input:not([type]), input[type="text"]').first();
    await input.evaluate((element) => { element.value = "selection"; element.focus(); element.setSelectionRange(1, 4); });
    assert.deepEqual(await input.evaluate((element) => [element.selectionStart, element.selectionEnd]), [1, 4]);
    t.diagnostic(`${browserType.name()}: ribbon-to-paper ${(timing.paper - timing.exit).toFixed(1)}ms, paper ${(timing.opened - timing.paper).toFixed(1)}ms`);
  } finally {
    await browser.close();
    await server.close();
  }
});
