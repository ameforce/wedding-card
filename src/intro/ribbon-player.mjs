const SEQUENCE_PREFIX = "/assets/design/ribbon-sequence/";
const MAX_PREFETCH_BYTES = 24 * 1024 * 1024;
const MAX_DECODED_FRAMES = 4;
const MAX_INFLIGHT_DECODES = 2;

function abortError() {
  return new DOMException("Ribbon sequence loading was cancelled.", "AbortError");
}

function finiteInteger(value, minimum, maximum, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Invalid ribbon manifest ${name}.`);
  }
  return value;
}

function currentBaseUrl(baseUrl) {
  return baseUrl || globalThis.location?.href || "http://localhost/";
}

export function resolveSequenceUrl(value, baseUrl) {
  const base = new URL(currentBaseUrl(baseUrl));
  const url = new URL(value, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(SEQUENCE_PREFIX)) {
    throw new TypeError("Ribbon sequence URLs must be same-origin paths under the sequence directory.");
  }
  return url;
}

export function validateRibbonManifest(value, { manifestUrl, baseUrl } = {}) {
  const resolvedManifest = resolveSequenceUrl(manifestUrl || `${SEQUENCE_PREFIX}manifest.json`, baseUrl);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Ribbon manifest must be an object.");
  if (value.schemaVersion !== 1) throw new TypeError("Unsupported ribbon manifest schema version.");

  const fps = finiteInteger(value.fps, 1, 60, "fps");
  const width = finiteInteger(value.width, 1, 4096, "width");
  const height = finiteInteger(value.height, 1, 4096, "height");
  const holdMs = finiteInteger(value.holdMs, 0, 10_000, "holdMs");
  const panelDelayMs = finiteInteger(value.panelDelayMs, 0, 5_000, "panelDelayMs");
  const panelDurationMs = finiteInteger(value.panelDurationMs, 1, 5_000, "panelDurationMs");
  if (!Array.isArray(value.frames) || value.frames.length < 2 || value.frames.length > 300) {
    throw new TypeError("Ribbon manifest must include between 2 and 300 frames.");
  }
  const frameNames = value.frames.map((frame) => {
    if (typeof frame !== "string" || !/^[a-z0-9][a-z0-9_-]*\.webp$/i.test(frame)) {
      throw new TypeError("Ribbon frame names must be local WebP filenames.");
    }
    const frameUrl = new URL(frame, resolvedManifest);
    if (frameUrl.origin !== resolvedManifest.origin || !frameUrl.pathname.startsWith(SEQUENCE_PREFIX)) {
      throw new TypeError("Ribbon frame escaped the sequence directory.");
    }
    return frameUrl.toString();
  });
  const releaseFrame = finiteInteger(value.releaseFrame, 0, frameNames.length - 1, "releaseFrame");

  return Object.freeze({
    schemaVersion: 1,
    fps,
    width,
    height,
    frames: Object.freeze(frameNames),
    holdMs,
    releaseFrame,
    panelDelayMs,
    panelDurationMs,
  });
}

export async function loadRibbonManifest(manifestUrl = `${SEQUENCE_PREFIX}manifest.json`, { fetchImpl = globalThis.fetch, signal, baseUrl } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required to load the ribbon manifest.");
  const resolved = resolveSequenceUrl(manifestUrl, baseUrl);
  const response = await fetchImpl(resolved.toString(), { signal, credentials: "same-origin", cache: "no-cache" });
  if (!response?.ok) throw new Error(`Ribbon manifest request failed (${response?.status ?? "network"}).`);
  return validateRibbonManifest(await response.json(), { manifestUrl: resolved.toString(), baseUrl: resolved.toString() });
}

export function ribbonTimeline(manifest, elapsedMs) {
  const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  const frameMs = 1000 / manifest.fps;
  const motionElapsed = Math.max(0, elapsed - manifest.holdMs);
  const frameIndex = Math.min(manifest.frames.length - 1, Math.floor(motionElapsed / frameMs));
  // Keep the transparent terminal frame visible for one 30 fps interval before moving the paper.
  const finalRenderedAtMs = manifest.holdMs + manifest.frames.length * frameMs;
  const panelsAtMs = finalRenderedAtMs + manifest.panelDelayMs;
  const finishAtMs = panelsAtMs + manifest.panelDurationMs;
  return {
    frameIndex,
    releaseStarted: frameIndex >= manifest.releaseFrame,
    panelsOpen: elapsed >= panelsAtMs,
    finished: elapsed >= finishAtMs,
    finalRenderedAtMs,
    panelsAtMs,
    finishAtMs,
  };
}

export function createSequentialRibbonScheduler(manifest, { startedAt = 0 } = {}) {
  const frameMs = 1000 / manifest.fps;
  let nextIndex = 1;
  let nextDueAt = startedAt + manifest.holdMs + frameMs;
  let stopped = false;
  return {
    dueFrame(now) {
      if (stopped || nextIndex >= manifest.frames.length || now < nextDueAt - 0.01) return null;
      return nextIndex;
    },
    markDrawn(index, now) {
      if (stopped || index !== nextIndex) throw new Error("Ribbon frames must be drawn once in sequence.");
      nextIndex += 1;
      // Keep the original cadence through ordinary rAF quantization. Only a genuinely late decode
      // rebases time, so we extend smoothly without catch-up skips or an accumulated 25 fps drift.
      nextDueAt = now - nextDueAt > frameMs ? now + frameMs : nextDueAt + frameMs;
      return nextIndex >= manifest.frames.length;
    },
    stop() { stopped = true; },
    get nextFrameIndex() { return nextIndex; },
    get completed() { return stopped || nextIndex >= manifest.frames.length; },
  };
}

export function assertRibbonFrameDimensions(frame, manifest) {
  const width = Number.isFinite(frame?.width) ? frame.width : frame?.naturalWidth;
  const height = Number.isFinite(frame?.height) ? frame.height : frame?.naturalHeight;
  if (width !== manifest.width || height !== manifest.height) {
    throw new Error(`Ribbon frame dimensions ${width}x${height} do not match manifest ${manifest.width}x${manifest.height}.`);
  }
}

export function createFinalFrameGate({
  panelDelayMs,
  panelDurationMs,
  requestPaint = globalThis.requestAnimationFrame,
  cancelPaint = globalThis.cancelAnimationFrame,
  schedule = globalThis.setTimeout,
  cancelSchedule = globalThis.clearTimeout,
  onPanelsOpen,
  onFinish,
}) {
  let stopped = false;
  let terminalDrawn = false;
  let paintId = 0;
  let openId = 0;
  let finishId = 0;
  return {
    markTerminalDrawn() {
      if (stopped || terminalDrawn) return;
      terminalDrawn = true;
      paintId = requestPaint(() => {
        paintId = 0;
        if (stopped) return;
        openId = schedule(() => {
          openId = 0;
          if (stopped) return;
          onPanelsOpen?.();
          finishId = schedule(() => {
            finishId = 0;
            if (!stopped) onFinish?.();
          }, panelDurationMs);
        }, panelDelayMs);
      });
    },
    cancel() {
      if (stopped) return;
      stopped = true;
      if (paintId) cancelPaint(paintId);
      if (openId) cancelSchedule(openId);
      if (finishId) cancelSchedule(finishId);
    },
  };
}

export function createFrameStallGate({
  timeoutMs,
  schedule = globalThis.setTimeout,
  cancelSchedule = globalThis.clearTimeout,
  onTimeout,
}) {
  let stopped = false;
  let timeoutId = null;
  return {
    begin() {
      if (stopped || timeoutId !== null) return;
      timeoutId = schedule(() => {
        timeoutId = null;
        if (!stopped) onTimeout?.();
      }, timeoutMs);
    },
    clear() {
      if (timeoutId === null) return;
      cancelSchedule(timeoutId);
      timeoutId = null;
    },
    cancel() {
      if (stopped) return;
      stopped = true;
      if (timeoutId !== null) cancelSchedule(timeoutId);
      timeoutId = null;
    },
  };
}

async function browserDecode(bytes) {
  const blob = new Blob([bytes], { type: "image/webp" });
  if (typeof globalThis.createImageBitmap === "function") return globalThis.createImageBitmap(blob);
  if (typeof globalThis.Image !== "function") throw new Error("This browser cannot decode ribbon frames.");
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  image.src = objectUrl;
  try {
    if (typeof image.decode === "function") await image.decode();
    else await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("Ribbon frame decode failed."));
    });
    image.__ribbonDispose = () => URL.revokeObjectURL(objectUrl);
    return image;
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function disposeFrame(frame) {
  if (typeof frame?.close === "function") frame.close();
  else frame?.__ribbonDispose?.();
}

export function createRibbonFrameLoader(manifest, {
  fetchFrame = async (url, signal) => {
    const response = await fetch(url, { signal, credentials: "same-origin" });
    if (!response.ok) throw new Error(`Ribbon frame request failed (${response.status}).`);
    return response.arrayBuffer();
  },
  decodeFrame = browserDecode,
  concurrency = 4,
  maxPrefetchBytes = MAX_PREFETCH_BYTES,
  maxDecodedFrames = MAX_DECODED_FRAMES,
  maxInFlightDecodes = MAX_INFLIGHT_DECODES,
} = {}) {
  finiteInteger(concurrency, 1, 8, "frame loader concurrency");
  finiteInteger(maxPrefetchBytes, 1, MAX_PREFETCH_BYTES, "frame prefetch byte limit");
  finiteInteger(maxDecodedFrames, 1, 8, "decoded frame limit");
  finiteInteger(maxInFlightDecodes, 1, 4, "in-flight decode limit");

  const controller = new AbortController();
  const bytes = new Map();
  const decoded = new Map();
  const decoding = new Map();
  let prefetchPromise;
  let cancelled = false;
  let byteCount = 0;
  let inflightDecodes = 0;

  const checkLive = () => {
    if (cancelled || controller.signal.aborted) throw abortError();
  };
  const touch = (index, frame) => {
    decoded.delete(index);
    decoded.set(index, frame);
    while (decoded.size > maxDecodedFrames) {
      const [staleIndex, staleFrame] = decoded.entries().next().value;
      decoded.delete(staleIndex);
      disposeFrame(staleFrame);
    }
  };
  const prefetch = () => {
    if (prefetchPromise) return prefetchPromise;
    let cursor = 0;
    const worker = async () => {
      while (true) {
        checkLive();
        const index = cursor;
        cursor += 1;
        if (index >= manifest.frames.length) return;
        const frameBytes = await fetchFrame(manifest.frames[index], controller.signal);
        checkLive();
        if (!(frameBytes instanceof ArrayBuffer)) throw new TypeError("Ribbon frame loader expected an ArrayBuffer.");
        byteCount += frameBytes.byteLength;
        if (byteCount > maxPrefetchBytes) throw new RangeError("Ribbon sequence exceeds its compressed prefetch budget.");
        bytes.set(index, frameBytes);
      }
    };
    prefetchPromise = Promise.all(Array.from({ length: Math.min(concurrency, manifest.frames.length) }, worker)).then(() => undefined);
    return prefetchPromise;
  };
  const getFrame = async (index) => {
    finiteInteger(index, 0, manifest.frames.length - 1, "frame index");
    await prefetch();
    checkLive();
    if (decoded.has(index)) {
      const existing = decoded.get(index);
      touch(index, existing);
      return existing;
    }
    if (!decoding.has(index)) {
      if (inflightDecodes >= maxInFlightDecodes) {
        throw new RangeError("Ribbon frame decode capacity is busy.");
      }
      inflightDecodes += 1;
      decoding.set(index, Promise.resolve(decodeFrame(bytes.get(index), manifest.frames[index]))
        .then((frame) => {
          try {
            checkLive();
          } catch (error) {
            disposeFrame(frame);
            throw error;
          }
          touch(index, frame);
          return frame;
        })
        .finally(() => {
          inflightDecodes -= 1;
          decoding.delete(index);
        }));
    }
    return decoding.get(index);
  };
  return {
    prefetch,
    getFrame,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      controller.abort();
      bytes.clear();
      for (const frame of decoded.values()) disposeFrame(frame);
      decoded.clear();
    },
    get cancelled() { return cancelled; },
    get prefetchedBytes() { return byteCount; },
  };
}
