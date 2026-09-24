import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.js";
import { mediaFixture, metadata } from "./fixtures/media-upload.mjs";

const LIMIT = 2 * 1024 ** 3;
const rows = (db, table = "invitation_media_sets_v2") => db.sqlite.prepare(`SELECT * FROM ${table}`).all();

function occupy(db, bytes) {
  const insert = db.sqlite.prepare("INSERT INTO invitation_media_sets_v2 VALUES (?, 'pastel-gallery-new', ?, 'stored', ?, ?)");
  while (bytes > 0) {
    const size = Math.min(bytes, 128 * 1024 ** 2);
    insert.run(crypto.randomUUID(), size, new Date().toISOString(), new Date().toISOString()); bytes -= size;
  }
}

test("photo selection reserves exact original+variants atomically in real SQLite", async (t) => {
  const { begin, db, bucket, call } = await mediaFixture(t);
  const { response, payload } = await begin([metadata(), metadata()]);
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.equal(payload.uploads.length, 2);
  assert.equal(payload.usage.usedBytes, 24);
  assert.equal(rows(db).length, 2);
  assert.equal(rows(db, "invitation_media_uploads_v1").length, 2);
  assert.equal(bucket.objects.size, 0);
  for (const item of payload.uploads) assert.equal((await call(`/api/admin/media/uploads/${item.mediaId}`, { method: "DELETE" })).status, 200);
  assert.equal(rows(db).length, 0);
  assert.equal(rows(db, "invitation_media_uploads_v1").length, 0);
});

test("over-capacity selections reserve nothing, including variants and concurrent callers", async (t) => {
  const { begin, db, call, bucket } = await mediaFixture(t);
  await call("/api/admin/media/usage");
  occupy(db, LIMIT - 23);
  const before = rows(db).length;
  const rejected = await begin([metadata(), metadata()]);
  assert.equal(rejected.response.status, 507);
  assert.equal(rows(db).length, before);
  assert.equal(rows(db, "invitation_media_uploads_v1").length, 0);
  const raced = await Promise.all([begin(), begin()]);
  assert.deepEqual(raced.map((result) => result.response.status).sort(), [201, 507]);
  assert.equal(rows(db).reduce((sum, row) => sum + row.total_bytes, 0), LIMIT - 11);
  assert.equal(bucket.objects.size, 0);
});

test("an exact-capacity selection succeeds, one byte more is refused", async (t) => {
  const { begin, db, call } = await mediaFixture(t);
  await call("/api/admin/media/usage"); occupy(db, LIMIT - 12);
  assert.equal((await begin()).response.status, 201);
  assert.equal((await begin([metadata({ sizes: { original: 1, small: 1, large: 1 } })])).response.status, 507);
});

test("binary upload forwards the native body unchanged and finalization is idempotent", async (t) => {
  const { begin, db, env, request, bucket, complete, put } = await mediaFixture(t);
  const id = (await begin()).payload.uploads[0].mediaId;
  assert.equal((await complete(id)).status, 409);
  const original = request(`/api/admin/media/uploads/${id}/original`, { method: "PUT", body: new Uint8Array(4), headers: { "content-type": "image/jpeg", "content-length": "4" } });
  const nativeBody = original.body;
  assert.equal((await worker.fetch(original, env)).status, 200);
  assert.equal(bucket.bodies[0], nativeBody);
  await put(id, "original", new Uint8Array([9, 9, 9, 9]), "image/jpeg");
  const key = `invitation/${id}/pastel-gallery-new/original.jpg`;
  assert.deepEqual(bucket.objects.get(key).bytes, new Uint8Array(4), "retry must not replace immutable data");
  await put(id, "small", new Uint8Array(3), "image/webp");
  await put(id, "large", new Uint8Array(5), "image/webp");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await complete(id); assert.equal(response.status, 201);
    const payload = await response.json(); assert.equal(payload.photo.alt, ""); assert.equal(payload.usage.usedBytes, 12);
  }
  assert.equal(rows(db)[0].status, "stored");
  assert.equal((await put(id, "original", new Uint8Array(4), "image/jpeg")).status, 409);
});

test("malformed metadata, MIME and length are rejected before R2 writes", async (t) => {
  const { begin, bucket, call } = await mediaFixture(t);
  for (const invalid of [metadata({ sizes: { original: 0, small: 3, large: 5 } }), metadata({ originalType: "text/html" }), metadata({ slot: `pastel-gallery-${"1".repeat(40)}` })]) {
    assert.equal((await begin([invalid])).response.status, 400);
  }
  const id = (await begin()).payload.uploads[0].mediaId;
  for (const [headers, expected] of [[{ "content-type": "image/jpeg" }, 411], [{ "content-length": "3", "content-type": "image/jpeg" }, 400], [{ "content-length": "4", "content-type": "text/html" }, 400]]) {
    assert.equal((await call(`/api/admin/media/uploads/${id}/original`, { method: "PUT", body: new Uint8Array(4), headers })).status, expected);
  }
  assert.equal(bucket.objects.size, 0);
  assert.equal((await call(`/api/admin/media/uploads/${id}/unknown`, { method: "PUT", body: "x" })).status, 404);
});

test("failed or ambiguous uploads retain quota; stale cleanup removes session and objects", async (t) => {
  const { begin, db, bucket, put, call } = await mediaFixture(t);
  const id = (await begin()).payload.uploads[0].mediaId;
  await put(id, "original", new Uint8Array(4), "image/jpeg");
  const cancelled = await call(`/api/admin/media/uploads/${id}`, { method: "DELETE" });
  assert.equal((await cancelled.json()).cancelled, false);
  assert.equal(rows(db)[0].total_bytes, 12);
  const deleting = () => call("/api/admin/media/delete", { method: "POST", body: JSON.stringify({ mediaId: id }) });
  assert.equal((await deleting()).status, 409);
  db.sqlite.prepare("UPDATE invitation_media_sets_v2 SET created_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", id);
  const originalDelete = bucket.delete;
  bucket.delete = async () => { throw new Error("synthetic R2 unavailable"); };
  assert.equal((await deleting()).status, 503);
  assert.equal(rows(db).length, 1, "failed physical delete must retain accounting");
  bucket.delete = originalDelete;
  assert.equal((await deleting()).status, 200);
  assert.equal(rows(db).length, 0);
  assert.equal(rows(db, "invitation_media_uploads_v1").length, 0);
  assert.equal(bucket.objects.size, 0);
});

test("native endpoints fail closed on missing Access and cross-origin requests", async (t) => {
  const { call, bucket, begin } = await mediaFixture(t);
  assert.equal((await call("/api/admin/media/uploads", { method: "POST", body: JSON.stringify({ photos: [metadata()] }), headers: { "cf-access-jwt-assertion": "" } })).status, 401);
  assert.equal((await call("/api/admin/media/uploads", { method: "POST", body: "{}", headers: { origin: "https://evil.example" } })).status, 403);
  const id = (await begin()).payload.uploads[0].mediaId;
  assert.equal((await call(`/api/admin/media/uploads/${id}/complete`, { method: "POST", body: "{}", headers: { "cf-access-jwt-assertion": "" } })).status, 401);
  assert.equal(bucket.objects.size, 0);
});

test("bulk confirmation cannot cascade an archived revision that was not approved", async (t) => {
  const { begin, fill, complete, db, call, bucket } = await mediaFixture(t);
  const id = (await begin()).payload.uploads[0].mediaId;
  await fill(id); await complete(id);
  const document = JSON.stringify({ photos: { pastel: { gallery: [{ src: `/api/media/invitation/${id}/pastel-gallery-new/480.webp` }] } } });
  db.sqlite.prepare("INSERT INTO invitation_revisions VALUES (?, ?, 'archived', ?, 'test', ?)").run("new-unapproved-revision", document, "2026-01-01", "2026-01-01");
  const refused = await call("/api/admin/media/delete", { method: "POST", body: JSON.stringify({ mediaId: id, deleteRevisions: true, expectedRevisionIds: ["previously-approved"] }) });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "MEDIA_REFERENCED");
  assert.equal(bucket.objects.size, 3);
  assert.equal(rows(db, "invitation_revisions").length, 1);
  const approved = await call("/api/admin/media/delete", { method: "POST", body: JSON.stringify({ mediaId: id, deleteRevisions: true, expectedRevisionIds: ["new-unapproved-revision"] }) });
  assert.equal(approved.status, 200);
  assert.equal(rows(db, "invitation_revisions").length, 0);
  assert.equal(rows(db).length, 0);
});

test("batch reservations support 90MiB originals and reject originals over the existing ceiling", async (t) => {
  const { begin, db } = await mediaFixture(t);
  const large = metadata({ sizes: { original: 90 * 1024 ** 2, small: 2 * 1024 ** 2, large: 4 * 1024 ** 2 } });
  assert.equal((await begin([large])).response.status, 201);
  assert.equal(rows(db)[0].total_bytes, 96 * 1024 ** 2);
  large.sizes.original += 1;
  assert.equal((await begin([large])).response.status, 400);
});
