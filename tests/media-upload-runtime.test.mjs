import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { accessFixture, metadata } from "./fixtures/media-upload.mjs";

// Exercise the real workerd, D1 and R2 bindings rather than permissive mocks.
test("workerd accepts three concurrent native 90MiB originals and completes all objects", { timeout: 120_000 }, async () => {
  const access = await accessFixture();
  const mf = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.ERROR), workers: [{ name: "media-test", modules: true, scriptPath: fileURLToPath(new URL("../worker/index.js", import.meta.url)),
    compatibilityDate: "2026-08-17", bindings: access.env,
    d1Databases: ["GUESTBOOK_DB"], r2Buckets: ["WEDDING_MEDIA"],
    outboundService: () => Response.json(access.jwks),
  }] }));
  try {
    const db = await mf.getD1Database("GUESTBOOK_DB");
    for (const name of ["0003_invitation_content.sql", "0004_invitation_media_quota.sql"]) {
      const source = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      await db.batch(source.split(";").map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)));
    }
    const headers = { origin: "https://example.test", "cf-access-jwt-assertion": access.assertion, "content-type": "application/json" };
    const call = (path, options) => mf.dispatchFetch(`https://example.test${path}`, { ...options, headers: { ...headers, ...options?.headers } });
    const sizes = { original: 90 * 1024 ** 2, small: 32, large: 64 };
    const reserved = await call("/api/admin/media/uploads", { method: "POST", body: JSON.stringify({ photos: Array.from({ length: 3 }, () => metadata({ sizes })) }) });
    assert.equal(reserved.status, 201, await reserved.clone().text());
    const { uploads } = await reserved.json();
    const source = new Blob([new Uint8Array(sizes.original)]);
    const completed = await Promise.all(uploads.map(async ({ mediaId }) => {
      for (const part of ["original", "small", "large"]) {
        const body = part === "original" ? source : new Blob([new Uint8Array(sizes[part])]);
        const response = await call(`/api/admin/media/uploads/${mediaId}/${part}`, {
          method: "PUT", body, headers: { "content-type": part === "original" ? "image/jpeg" : "image/webp", "content-length": String(body.size) },
        });
        assert.equal(response.status, 200, await response.text());
      }
      const response = await call(`/api/admin/media/uploads/${mediaId}/complete`, { method: "POST", body: "{}" });
      assert.equal(response.status, 201, await response.clone().text());
      return response.json();
    }));
    assert.equal(completed.length, 3);
    const usage = await (await call("/api/admin/media/usage")).json();
    assert.equal(usage.usedBytes, 3 * (sizes.original + sizes.small + sizes.large));
    // Deleting our local test objects also checks real D1 mutation-guard metadata.
    for (const { mediaId } of uploads) {
      const deleted = await call("/api/admin/media/delete", { method: "POST", body: JSON.stringify({ mediaId }) });
      assert.equal(deleted.status, 200, await deleted.clone().text());
    }
    assert.equal((await (await call("/api/admin/media/usage")).json()).usedBytes, 0);
  } finally { await mf.dispose(); }
});
