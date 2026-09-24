import assert from "node:assert/strict";
import test from "node:test";
import { createCloudflareContentAdapter } from "../src/admin-content/content-client.js";
const id = "00000000-0000-4000-8000-000000000001";
const file = new File([new Uint8Array([1, 2, 3, 4])], "photo.jpg", { type: "image/jpeg" });
const variant = new File([new Uint8Array([9, 9, 9])], "variant.webp", { type: "image/webp" });
const prepared = { file, small: variant, large: variant, totalBytes: 10 };
const uploadArguments = { slot: "pastel-gallery-new", file, prepared, alt: "", position: "50% 50%" };
const responseFor = (path) => path.endsWith("/usage") ? { remainingBytes: 1000 }
  : path.endsWith("/uploads") ? { uploads: [{ mediaId: id }] }
    : path.endsWith("/complete") ? { photo: { src: `/api/media/invitation/${id}/pastel-gallery-new/480.webp`, alt: "" }, usage: { usedBytes: 10 } }
      : { stored: true };

test("native photo client reserves once and sends three unframed immutable bodies with progress", async () => {
  const sent = []; const jsonRequests = []; const progress = [];
  class Xhr {
    constructor() { this.upload = {}; }
    open(method, path) { this.method = method; this.path = path; this.headers = {}; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) { sent.push({ method: this.method, path: this.path, body, headers: this.headers });
      this.upload.onprogress({ lengthComputable: true, loaded: body.size, total: body.size });
      this.status = 200; this.responseText = JSON.stringify({ stored: true }); this.onload(); }
  }
  const adapter = createCloudflareContentAdapter({ xhrImpl: Xhr, fetchImpl: async (path, options) => {
    jsonRequests.push({ path, options }); return Response.json(responseFor(path));
  } });
  const result = await adapter.uploadPhoto({ ...uploadArguments, onProgress: (event) => progress.push(event) });
  assert.equal(result.photo.alt, "");
  assert.deepEqual(sent.map((entry) => entry.method), ["PUT", "PUT", "PUT"]);
  assert.deepEqual(sent.map((entry) => entry.path.split("/").at(-1)), ["original", "small", "large"]);
  assert.equal(sent[0].body, file);
  assert.equal(sent[1].body, variant);
  const reservation = jsonRequests.find((entry) => entry.path.endsWith("/uploads"));
  assert.deepEqual(JSON.parse(reservation.options.body).photos[0].sizes, { original: 4, small: 3, large: 3 });
  assert.equal(jsonRequests.filter((entry) => entry.path.endsWith("/uploads")).length, 1);
  assert.equal(progress.at(-1).loaded, 10); assert.equal(progress.at(-1).total, 10);
});

test("camera images are decoded once, resized to 480/960, and the bitmap is released", async (t) => {
  const oldBitmap = globalThis.createImageBitmap; const oldDocument = globalThis.document;
  let opens = 0; let closes = 0; const canvases = [];
  t.after(() => { globalThis.createImageBitmap = oldBitmap; globalThis.document = oldDocument; });
  globalThis.createImageBitmap = async () => { opens += 1; return { width: 6336, height: 9504, close() { closes += 1; } }; };
  globalThis.document = { createElement() {
    const canvas = { width: 0, height: 0, getContext() { return { drawImage() {} }; }, toBlob(callback) { callback(variant); } };
    canvases.push(canvas); return canvas;
  } };
  const adapter = createCloudflareContentAdapter({ fetchImpl: async (path) => Response.json(responseFor(path)) });
  const item = await adapter.preparePhoto(file);
  assert.equal(opens, 1); assert.equal(closes, 1); assert.equal(item.totalBytes, 10);
  assert.deepEqual(canvases.map(({ width, height }) => [width, height]), [[480, 720], [960, 1440]]);
  globalThis.document.createElement = () => ({ getContext() { return { drawImage() {} }; }, toBlob(callback) { callback(new Blob(["x"], { type: "image/png" })); } });
  await assert.rejects(adapter.preparePhoto(file), /WebP/); assert.equal(closes, 2);
});

test("HTTP failures preserve status, safe request IDs and edge reference instead of generic errors", async () => {
  for (const requestId of [id, "not-a-uuid"]) {
    class Xhr {
      constructor() { this.upload = {}; }
      open() {} setRequestHeader() {}
      getResponseHeader() { return "abc123-ICN"; }
      send() { this.status = 400; this.responseText = JSON.stringify({ code: "INVALID_MEDIA", message: "사진을 확인해 주세요.", requestId }); this.onload(); }
    }
    const adapter = createCloudflareContentAdapter({ xhrImpl: Xhr, fetchImpl: async (path) => Response.json(responseFor(path)) });
    await assert.rejects(adapter.uploadPhoto(uploadArguments), (error) => {
      assert.equal(error.status, 400); assert.equal(error.code, "INVALID_MEDIA");
      assert.equal(error.requestId, requestId === id ? id : null); assert.equal(error.rayId, "abc123-ICN"); return true;
    });
  }
  const offline = createCloudflareContentAdapter({ xhrImpl: null, fetchImpl: async () => new Response("edge failure", { status: 503 }) });
  await assert.rejects(offline.uploadPhoto(uploadArguments), /HTTP 503/);
});

test("transient immutable PUT retries keep the same reservation and do not duplicate uploads", async () => {
  let starts = 0; let attempts = 0;
  const adapter = createCloudflareContentAdapter({ xhrImpl: null, fetchImpl: async (path) => {
    if (path.endsWith("/uploads")) starts += 1;
    if (path.endsWith("/original") && attempts++ === 0) return new Response("edge failure", { status: 503 });
    return Response.json(responseFor(path));
  } });
  await adapter.uploadPhoto(uploadArguments);
  assert.equal(starts, 1); assert.equal(attempts, 2);
});
