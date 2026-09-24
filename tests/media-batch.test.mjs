import assert from "node:assert/strict";
import test from "node:test";
import { assertMediaCapacity, settleWithConcurrency, preparePhotoSelection, uploadPhotoSelection } from "../src/admin-content/media-batch.js";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usage = (remainingBytes) => ({ remainingBytes, usedBytes: 0, limitBytes: remainingBytes });
const files = Array.from({ length: 6 }, (_, index) => new File([new Uint8Array(10)], `${index}.jpg`, { type: "image/jpeg" }));
const prepared = files.map((file) => ({ file, small: new Blob(["abc"]), large: new Blob(["defgh"]), totalBytes: 18 }));
const selection = { prepared, totalBytes: 108 };

test("capacity checks are exact and fail closed when remaining capacity is unknown", () => {
  assert.doesNotThrow(() => assertMediaCapacity(usage(12), 12));
  assert.throws(() => assertMediaCapacity(usage(11), 12), (error) => error.code === "MEDIA_STORAGE_LIMIT");
  for (const invalid of [null, {}, usage(NaN), usage(-1)]) assert.throws(() => assertMediaCapacity(invalid, 1));
  assert.doesNotThrow(() => assertMediaCapacity({ localReview: true }, 999));
});

test("the worker pool overlaps requests, caps at three, and preserves input order", async () => {
  let active = 0; let maximum = 0;
  const completed = [];
  const results = await settleWithConcurrency(files, async (_, index) => {
    active += 1; maximum = Math.max(maximum, active);
    await delay((3 - index % 3) * 5);
    active -= 1; completed.push(index); return index;
  });
  assert.equal(maximum, 3);
  assert.notDeepEqual(completed, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(results.map((result) => result.value), [0, 1, 2, 3, 4, 5]);
});

test("preflight sums derivatives, serializes image decoding and rejects before beginning uploads", async () => {
  let preparing = 0; let peak = 0; let starts = 0;
  const adapter = { async getMediaUsage() { return usage(100); },
    async preparePhoto(file) { preparing += 1; peak = Math.max(peak, preparing); await delay(1); preparing -= 1; return prepared[files.indexOf(file)]; },
    async beginPhotoUploads() { starts += 1; },
  };
  await assert.rejects(preparePhotoSelection(adapter, files), (error) => error.requiredBytes === 108 && error.code === "MEDIA_STORAGE_LIMIT");
  assert.equal(peak, 1); assert.equal(starts, 0);
  adapter.getMediaUsage = async () => usage(108);
  const exact = await preparePhotoSelection(adapter, files);
  assert.equal(exact.originalBytes, 60); assert.equal(exact.totalBytes, 108);
  adapter.getMediaUsage = async () => usage(59);
  adapter.preparePhoto = async () => { throw new Error("must not decode when originals already overflow"); };
  await assert.rejects(preparePhotoSelection(adapter, files), (error) => error.code === "MEDIA_STORAGE_LIMIT");
});

test("final quota recheck prevents every network upload after another tab consumes capacity", async () => {
  let starts = 0;
  const adapter = { async getMediaUsage() { return usage(107); }, async beginPhotoUploads() { starts += 1; } };
  await assert.rejects(uploadPhotoSelection(adapter, selection), (error) => error.code === "MEDIA_STORAGE_LIMIT");
  assert.equal(starts, 0);
});

test("auth failure stops queued photos without losing in-flight successes or selection order", async () => {
  const sent = []; const cancelled = []; const progress = []; let authenticationErrors = 0;
  const adapter = {
    async getMediaUsage() { return usage(108); },
    async beginPhotoUploads(items) { return items.map((_, index) => ({ mediaId: `id-${index}` })); },
    async uploadPhoto({ file, onProgress }) {
      const index = files.indexOf(file); sent.push(index);
      if (index === 0) throw Object.assign(new Error("sign in"), { status: 401 });
      await delay(index === 1 ? 15 : 5);
      onProgress({ loaded: 18, total: 18 });
      return { photo: { src: String(index) } };
    },
    async cancelPhotoUpload(id) { cancelled.push(id); },
  };
  const results = await uploadPhotoSelection(adapter, selection, { onProgress: (event) => progress.push(event), onAuthError: () => { authenticationErrors += 1; } });
  assert.deepEqual(sent, [0, 1, 2]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "fulfilled", "fulfilled", "skipped", "skipped", "skipped"]);
  assert.deepEqual(results.filter((result) => result.status === "fulfilled").map((result) => result.value.photo.src), ["1", "2"]);
  assert.deepEqual(cancelled, ["id-0", "id-3", "id-4", "id-5"]);
  assert.equal(authenticationErrors, 1);
  assert.equal(progress.at(-1).completed, 3);
  for (let index = 1; index < progress.length; index += 1) assert.ok(progress[index].loaded >= progress[index - 1].loaded);
});
