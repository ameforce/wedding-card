import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";
import sharp from "sharp";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { accessFixture } from "./fixtures/media-upload.mjs";

// Built production UI -> actual browser XHR -> workerd -> real local D1/R2.
// Only synthetic test credentials and local disposable storage are used.
test("the production admin uploads 30 actual JPEGs through the native browser/workerd path", { timeout: 120_000 }, async () => {
  const access = await accessFixture();
  const root = fileURLToPath(new URL("../dist/client/", import.meta.url));
  const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
  const assets = async (request) => {
    let relative = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
    if (!relative || !path.extname(relative)) relative = "index.html";
    const target = path.resolve(root, relative);
    if (!target.startsWith(root)) return new Response(null, { status: 403 });
    try { return new Response(await readFile(target), { headers: { "content-type": mime[path.extname(target)] || "application/octet-stream" } }); }
    catch { return new Response(null, { status: 404 }); }
  };
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: fileURLToPath(new URL("../worker/index.js", import.meta.url)),
    compatibilityDate: "2026-08-17", bindings: access.env, d1Databases: ["GUESTBOOK_DB"], r2Buckets: ["WEDDING_MEDIA"],
    serviceBindings: { ASSETS: assets }, outboundService: () => Response.json(access.jwks), log: new Log(LogLevel.ERROR),
  }));
  let browser;
  try {
    const db = await mf.getD1Database("GUESTBOOK_DB");
    for (const name of ["0003_invitation_content.sql", "0004_invitation_media_quota.sql"]) {
      const source = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      await db.batch(source.split(";").map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)));
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { "cf-access-jwt-assertion": access.assertion } });
    const page = await context.newPage();
    const pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(new URL("/admin", await mf.ready).href);
    await page.getByText("사진", { exact: true }).click();
    const jpeg = await sharp({ create: { width: 640, height: 960, channels: 3, background: { r: 220, g: 225, b: 230 } } }).jpeg().toBuffer();
    await page.locator("input[type=file][multiple]").setInputFiles(Array.from({ length: 30 }, (_, index) => ({ name: `photo-${String(index).padStart(2, "0")}.jpg`, mimeType: "image/jpeg", buffer: jpeg })));
    await page.locator(".content-admin-upload-plan").waitFor();
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM invitation_media_sets_v2").first()).count, 0, "preflight must not reserve or upload anything");
    await page.getByRole("button", { name: "30장 업로드", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "30장의 사진을 선택 순서대로" }).waitFor({ timeout: 90_000 });
    const sets = await db.prepare("SELECT total_bytes, status FROM invitation_media_sets_v2").all();
    assert.equal(sets.results.length, 30); assert.ok(sets.results.every((set) => set.status === "stored"));
    const objects = await (await mf.getR2Bucket("WEDDING_MEDIA")).list();
    assert.equal(objects.objects.length, 90);
    assert.equal(objects.objects.reduce((sum, item) => sum + item.size, 0), sets.results.reduce((sum, item) => sum + item.total_bytes, 0));
    assert.deepEqual(pageErrors, []);
  } finally { await browser?.close(); await mf.dispose(); }
});
