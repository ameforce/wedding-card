export const PHOTO_UPLOAD_CONCURRENCY = 3;

export function assertMediaCapacity(usage, requiredBytes) {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new Error("선택한 파일 용량을 계산하지 못했습니다.");
  if (usage?.localReview === true) return;
  if (!Number.isSafeInteger(usage?.remainingBytes) || usage.remainingBytes < 0) {
    throw new Error("남은 저장 공간을 확인하지 못했습니다. 새로고침 후 다시 시도해 주세요.");
  }
  if (requiredBytes > usage.remainingBytes) {
    throw Object.assign(new Error("선택한 사진 전체를 저장할 공간이 부족합니다. 아무 사진도 업로드하지 않았습니다."), {
      code: "MEDIA_STORAGE_LIMIT", status: 507, requiredBytes, remainingBytes: usage.remainingBytes,
    });
  }
}

export async function settleWithConcurrency(items, operation, { concurrency = PHOTO_UPLOAD_CONCURRENCY, shouldStop = () => false } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("병렬 작업 수가 올바르지 않습니다.");
  const results = new Array(items.length);
  let cursor = 0;
  let stopped = false;
  const run = async () => {
    while (!stopped && cursor < items.length) {
      const index = cursor++;
      try { results[index] = { status: "fulfilled", value: await operation(items[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; if (shouldStop(reason)) stopped = true; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return Array.from(results, (result) => result || { status: "skipped" });
}

export async function preparePhotoSelection(adapter, files, onProgress) {
  if (!files.length) throw new Error("사진을 선택해 주세요.");
  const originalBytes = files.reduce((total, file) => total + file.size, 0);
  assertMediaCapacity(await adapter.getMediaUsage(), originalBytes);
  const prepared = [];
  for (const [index, file] of files.entries()) {
    onProgress?.({ phase: "optimize", index: index + 1, count: files.length, fileName: file.name });
    // Decode one camera image at a time; retain only file references and WebPs.
    try { prepared.push(await adapter.preparePhoto(file)); }
    catch (error) { error.message = `${file.name}: ${error.message}`; throw error; }
  }
  const totalBytes = prepared.reduce((total, item) => total + item.totalBytes, 0);
  const usage = await adapter.getMediaUsage();
  assertMediaCapacity(usage, totalBytes);
  return { prepared, originalBytes, totalBytes, usage };
}

export async function uploadPhotoSelection(adapter, selection, { position, onProgress, onAuthError } = {}) {
  const { prepared, totalBytes } = selection;
  assertMediaCapacity(await adapter.getMediaUsage(), totalBytes);
  const sessions = await adapter.beginPhotoUploads(prepared, { slot: "pastel-gallery-new", alt: "", position });
  if (sessions.length !== prepared.length) throw new Error("업로드 예약 결과가 올바르지 않습니다.");
  const loaded = prepared.map(() => 0);
  let completed = 0;
  const results = await settleWithConcurrency(prepared, async (item, index) => {
    try {
      return await adapter.uploadPhoto({ slot: "pastel-gallery-new", file: item.file, prepared: item,
        sessionId: sessions[index].mediaId, alt: "", position,
        onProgress: (event) => {
          loaded[index] = Math.max(loaded[index], Math.min(item.totalBytes, event.loaded || 0));
          onProgress?.({ phase: "upload", fileName: item.file.name, index: completed, completed, count: prepared.length,
            loaded: loaded.reduce((sum, bytes) => sum + bytes, 0), total: totalBytes });
        },
      });
    } finally {
      completed += 1;
      onProgress?.({ phase: "upload", fileName: item.file.name, index: completed, completed, count: prepared.length,
        loaded: loaded.reduce((sum, bytes) => sum + bytes, 0), total: totalBytes });
    }
  }, { shouldStop: (error) => {
    const stop = error?.code === "ADMIN_AUTH_REQUIRED" || error?.status === 401;
    if (stop) onAuthError?.(error);
    return stop;
  } });
  // Only never-started reservations may be cancelled immediately. An uncertain
  // in-flight write remains accounted for until the stored-media stale cleanup.
  await settleWithConcurrency(sessions.filter((_, index) => results[index].status !== "fulfilled"),
    (session) => adapter.cancelPhotoUpload(session.mediaId).catch(() => {}));
  return results;
}
