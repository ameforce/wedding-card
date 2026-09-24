import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import sharp from "sharp";
import { weddingContent } from "../../../src/content.js";
import { createContentDocument } from "../../../src/admin-content/content-document.js";
const document = createContentDocument(weddingContent);
const output = "artifacts/qa/media-20260924";
await mkdir(output, { recursive: true });
const image = await sharp({ create: { width: 96, height: 144, channels: 3, background: { r: 200, g: 210, b: 220 } } }).jpeg().toBuffer();
const webp = await sharp(image).webp().toBuffer();
const mediaId = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
let media = [1, 2, 3].map((index) => ({ mediaId: mediaId(index), slot: "pastel-gallery-new", kind: "photo", totalBytes: 10 * 1024 ** 2,
  createdAt: "2026-09-24T12:00:00.000Z", previewUrl: `/api/media/invitation/${mediaId(index)}/pastel-gallery-new/480.webp`, references: { published: index === 3, draft: false, archivedRevisions: [] } }));
let remaining = 100 * 1024 ** 2; let starts = 0; let active = 0; let peak = 0; let rejectAuth = false;
const removals = []; const uploads = []; const errors = [];
const usage = () => ({ usedBytes: media.length * 10 * 1024 ** 2, remainingBytes: remaining, limitBytes: 2 * 1024 ** 3, percent: 1 });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/media/**", (route) => route.fulfill({ status: 200, contentType: "image/webp", body: webp }));
  await page.route("**/api/content", (route) => route.fulfill({ json: { document, revisionId: "published-test" } }));
  await page.route("**/api/admin/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (rejectAuth) return route.fulfill({ status: 401, json: { code: "ADMIN_AUTH_REQUIRED", message: "다시 로그인해 주세요." } });
    if (path.endsWith("/content")) return route.fulfill({ json: { draftRevisionId: "draft-test", publishedRevisionId: "published-test", draft: { document }, published: { document }, history: [] } });
    if (path.endsWith("/usage")) return route.fulfill({ json: usage() });
    if (path.endsWith("/list")) return route.fulfill({ json: { media, usage: usage() } });
    if (path.endsWith("/delete")) { const { mediaId } = request.postDataJSON(); removals.push(mediaId); media = media.filter((item) => item.mediaId !== mediaId); return route.fulfill({ json: { freedBytes: 10 * 1024 ** 2, usage: usage() } }); }
    if (path.endsWith("/uploads")) {
      starts += 1; const { photos } = request.postDataJSON();
      uploads.push(...photos.map((item, index) => ({ mediaId: mediaId(100 + index), ...item })));
      return route.fulfill({ status: 201, json: { uploads: uploads.map(({ mediaId }) => ({ mediaId })), usage: usage() } });
    }
    if (request.method() === "PUT") {
      active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 150)); active -= 1;
      return route.fulfill({ json: { stored: true } });
    }
    if (path.endsWith("/complete")) {
      const id = path.split("/").at(-2);
      return route.fulfill({ status: 201, json: { photo: { src: `/api/media/invitation/${id}/pastel-gallery-new/480.webp`, srcSet: "", sizes: "", alt: "", position: "50% 50%" }, usage: usage() } });
    }
    return route.fulfill({ json: { cancelled: true } });
  });
  await page.goto("http://127.0.0.1:4187/admin");
  await page.getByText("저장된 미디어", { exact: true }).click();
  await page.locator(".content-admin-media-list").waitFor();
  assert.equal(await page.locator(".content-admin-media-list input:disabled").count(), 1);
  for (const width of [360, 390, 430, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator(".content-admin-media-list").scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `horizontal overflow at ${width}`);
    await page.screenshot({ path: `${output}/media-${width}.png` });
  }
  await page.getByLabel("삭제 가능한 미디어 전체 선택").check();
  await page.getByRole("button", { name: "선택한 2개 삭제" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(await dialog.locator(".content-admin-delete-selection li").count(), 2);
  assert.ok(await dialog.evaluate((element) => element.contains(document.activeElement)));
  await page.screenshot({ path: `${output}/bulk-confirm-1440.png` });
  await dialog.getByRole("button", { name: /삭제/ }).last().click();
  await page.getByRole("status").filter({ hasText: "2개를 삭제하고" }).waitFor();
  assert.deepEqual(removals, [mediaId(1), mediaId(2)]);
  assert.equal(await page.locator(".content-admin-media-list input:disabled").count(), 1);
  await page.getByText("사진", { exact: true }).click();
  const fileInput = page.locator("input[type=file][multiple]");
  const selectedFiles = ["DSC02586.jpg", "KSJ_0056.jpg", "SOM01535 0.jpg"].map((name) => ({ name, mimeType: "image/jpeg", buffer: image }));
  await fileInput.setInputFiles(selectedFiles);
  await page.locator(".content-admin-upload-plan").waitFor();
  assert.equal(starts, 0, "selection must not upload automatically");
  await page.locator(".content-admin-upload-plan").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/upload-preflight-1440.png` });
  remaining = 0;
  await page.getByRole("button", { name: "3장 업로드", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "공간이 부족합니다" }).waitFor();
  assert.equal(starts, 0, "final quota recheck must block every upload");
  remaining = 100 * 1024 ** 2;
  await page.getByRole("button", { name: "3장 업로드", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "3장의 사진을 선택 순서대로" }).waitFor();
  assert.equal(peak, 3); assert.equal(starts, 1);
  const photoSources = await page.locator(".content-admin-photo-card > img").evaluateAll((images) => images.map((image) => image.getAttribute("src")));
  assert.deepEqual(photoSources.slice(-3), [100, 101, 102].map((index) => `/api/media/invitation/${mediaId(index)}/pastel-gallery-new/480.webp`));
  assert.ok(uploads.every((item) => item.sizes.original === image.byteLength && item.sizes.small > 0 && item.sizes.large > 0));
  rejectAuth = true;
  await fileInput.setInputFiles(selectedFiles);
  await page.getByRole("heading", { name: "관리자 인증이 필요합니다" }).waitFor();
  assert.equal(await page.locator("input[type=file]").count(), 0);
  assert.equal(starts, 1);
  assert.deepEqual(errors, []);
  const report = { passed: true, widths: [360, 390, 430, 768, 1440], maximumParallelRequests: peak, bulkDeleted: removals.length,
    publishedProtected: true, noUploadOnSelection: true, quotaBlockedBeforeUpload: true, preservedSelectionOrder: true, authenticationFailClosed: true, pageErrors: errors };
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
