const SEQUENCE_PREFIX = "/assets/design/ribbon-sequence/";
const MAX_PREFETCH_BYTES = 4 * 1024 * 1024;
const MAX_DECODED_FRAMES = 4;
const MAX_INFLIGHT_DECODES = 2;
const MAX_MANAGED_PIXEL_BYTES = 32 * 1024 * 1024;
const V2_DEFAULT_CANVAS = Object.freeze({ width: 960, height: 640, fps: 30 });

function abortError() {
  return new DOMException("Ribbon sequence loading was cancelled.", "AbortError");
}

function finiteInteger(value, minimum, maximum, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`Invalid ribbon manifest ${name}.`);
  }
  return value;
}

function finiteNumber(value, minimum, maximum, name) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`Invalid ribbon manifest ${name}.`);
  }
  return value;
}

function exactKeys(value, keys, name) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`Invalid ribbon manifest ${name} fields.`);
  }
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

function validateFrames(value, resolvedManifest) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 300) {
    throw new TypeError("Ribbon manifest must include between 2 and 300 frames.");
  }
  return value.map((frame) => {
    if (typeof frame !== "string" || !/^[a-z0-9][a-z0-9_-]*\.webp$/i.test(frame)) {
      throw new TypeError("Ribbon frame names must be local WebP filenames.");
    }
    const frameUrl = new URL(frame, resolvedManifest);
    if (frameUrl.origin !== resolvedManifest.origin || !frameUrl.pathname.startsWith(SEQUENCE_PREFIX)) {
      throw new TypeError("Ribbon frame escaped the sequence directory.");
    }
    return frameUrl.toString();
  });
}

function validateV1Manifest(value, resolvedManifest) {
  const fps = finiteInteger(value.fps, 1, 60, "fps");
  const width = finiteInteger(value.width, 1, 4096, "width");
  const height = finiteInteger(value.height, 1, 4096, "height");
  const holdMs = finiteInteger(value.holdMs, 0, 10_000, "holdMs");
  const panelDelayMs = finiteInteger(value.panelDelayMs, 0, 5_000, "panelDelayMs");
  const panelDurationMs = finiteInteger(value.panelDurationMs, 1, 5_000, "panelDurationMs");
  const frames = validateFrames(value.frames, resolvedManifest);
  const releaseFrame = finiteInteger(value.releaseFrame, 0, frames.length - 1, "releaseFrame");
  return Object.freeze({
    schemaVersion: 1, fps, width, height, frames: Object.freeze(frames), holdMs, releaseFrame, panelDelayMs, panelDurationMs,
  });
}

function validatePanelCurve(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 64) {
    throw new TypeError("Ribbon manifest panelCurve must have between 2 and 64 measured points.");
  }
  let previousOffset = -1;
  let previousProgress = -1;
  let previousLeftProgress = -1;
  let previousRightProgress = -1;
  const curve = value.map((point) => {
    if (!point || typeof point !== "object" || Array.isArray(point)) throw new TypeError("Invalid ribbon manifest panelCurve point.");
    exactKeys(point, ["offset", "progress", "leftProgress", "rightProgress"], "panelCurve point");
    const offset = finiteNumber(point.offset, 0, 1, "panelCurve offset");
    const progress = finiteNumber(point.progress, 0, 1, "panelCurve progress");
    const leftProgress = finiteNumber(point.leftProgress, 0, 1, "panelCurve leftProgress");
    const rightProgress = finiteNumber(point.rightProgress, 0, 1, "panelCurve rightProgress");
    if (offset <= previousOffset || progress < previousProgress || leftProgress < previousLeftProgress || rightProgress < previousRightProgress) {
      throw new TypeError("Ribbon manifest panelCurve must be monotonic.");
    }
    previousOffset = offset;
    previousProgress = progress;
    previousLeftProgress = leftProgress;
    previousRightProgress = rightProgress;
    return Object.freeze({ offset, progress, leftProgress, rightProgress });
  });
  if (curve[0].offset !== 0 || curve[0].progress !== 0 || curve[0].leftProgress !== 0 || curve[0].rightProgress !== 0
    || curve.at(-1).offset !== 1 || curve.at(-1).progress !== 1 || curve.at(-1).leftProgress !== 1 || curve.at(-1).rightProgress !== 1) {
    throw new TypeError("Ribbon manifest panelCurve must be normalized from 0 to 1.");
  }
  return Object.freeze(curve);
}

function validateV2Manifest(value, resolvedManifest) {
  exactKeys(value, [
    "schemaVersion", "fps", "width", "height", "frames", "holdMs", "panelDelayMs", "panelDurationMs",
    "releaseCompleteFrame", "registration", "rootYPx", "poster", "panelCurve",
  ], "v2");
  const width = finiteInteger(value.width, 480, V2_DEFAULT_CANVAS.width, "width");
  const height = finiteInteger(value.height, 320, V2_DEFAULT_CANVAS.height, "height");
  if (value.fps !== V2_DEFAULT_CANVAS.fps || width % 3 !== 0 || height * 3 !== width * 2) {
    throw new TypeError("Ribbon v2 requires the default 960x640 canvas or one uniformly downscaled 3:2 canvas at 30 fps.");
  }
  if (value.holdMs !== 800 || value.panelDelayMs !== 600 || value.panelDurationMs !== 1400) {
    throw new TypeError("Ribbon v2 requires the approved hold and measured panel timings.");
  }
  const frames = validateFrames(value.frames, resolvedManifest);
  const releaseCompleteFrame = finiteInteger(value.releaseCompleteFrame, 0, frames.length - 2, "releaseCompleteFrame");
  if (!value.registration || typeof value.registration !== "object" || Array.isArray(value.registration)) throw new TypeError("Invalid ribbon manifest registration.");
  exactKeys(value.registration, ["x", "y"], "registration");
  const registration = Object.freeze({
    x: finiteNumber(value.registration.x, 0, width, "registration.x"),
    y: finiteNumber(value.registration.y, 0, height, "registration.y"),
  });
  if (!Array.isArray(value.rootYPx) || value.rootYPx.length !== frames.length) throw new TypeError("Ribbon v2 rootYPx must match its frame count.");
  let previousRootY = 0;
  const rootYPx = value.rootYPx.map((rootY, index) => {
    const parsed = finiteNumber(rootY, 0, 100_000, "rootYPx");
    if (index <= releaseCompleteFrame && parsed !== 0) throw new TypeError("Ribbon v2 root motion cannot start before complete release.");
    if (parsed < previousRootY || parsed - previousRootY > height) {
      throw new TypeError("Ribbon v2 rootYPx must be continuous and downward-only.");
    }
    previousRootY = parsed;
    return parsed;
  });
  if (!value.poster || typeof value.poster !== "object" || Array.isArray(value.poster)) throw new TypeError("Invalid ribbon manifest poster.");
  exactKeys(value.poster, ["frameIndex", "sha256"], "poster");
  const poster = Object.freeze({
    frameIndex: finiteInteger(value.poster.frameIndex, 0, frames.length - 1, "poster.frameIndex"),
    sha256: typeof value.poster.sha256 === "string" && /^[a-f0-9]{64}$/i.test(value.poster.sha256)
      ? value.poster.sha256.toLowerCase()
      : (() => { throw new TypeError("Invalid ribbon manifest poster.sha256."); })(),
  });
  if (poster.frameIndex !== 0) throw new TypeError("Ribbon v2 poster must be frame 0.");
  return Object.freeze({
    schemaVersion: 2, fps: V2_DEFAULT_CANVAS.fps, width, height,
    frames: Object.freeze(frames), holdMs: 800, panelDelayMs: 600, panelDurationMs: 1400,
    releaseCompleteFrame, registration, rootYPx: Object.freeze(rootYPx), poster, panelCurve: validatePanelCurve(value.panelCurve),
  });
}

export function validateRibbonManifest(value, { manifestUrl, baseUrl } = {}) {
  const resolvedManifest = resolveSequenceUrl(manifestUrl || `${SEQUENCE_PREFIX}manifest.json`, baseUrl);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Ribbon manifest must be an object.");
  if (value.schemaVersion === 1) return validateV1Manifest(value, resolvedManifest);
  if (value.schemaVersion === 2) return validateV2Manifest(value, resolvedManifest);
  throw new TypeError("Unsupported ribbon manifest schema version.");
}

async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable for ribbon manifest verification.");
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function loadRibbonManifest(manifestUrl = `${SEQUENCE_PREFIX}manifest.json`, {
  fetchImpl = globalThis.fetch, signal, baseUrl, expectedDigest, expectedText,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required to load the ribbon manifest.");
  if (expectedDigest !== undefined && (typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/i.test(expectedDigest))) {
    throw new TypeError("Expected ribbon manifest digest must be a SHA-256 hex string.");
  }
  if (expectedText !== undefined && typeof expectedText !== "string") {
    throw new TypeError("Expected ribbon manifest text must be a string.");
  }
  const resolved = resolveSequenceUrl(manifestUrl, baseUrl);
  const response = await fetchImpl(resolved.toString(), { signal, credentials: "same-origin", cache: "no-cache" });
  if (!response?.ok) throw new Error(`Ribbon manifest request failed (${response?.status ?? "network"}).`);
  const body = await response.text();
  if (expectedText !== undefined && body !== expectedText) {
    throw new Error("Ribbon manifest text does not match the early poster.");
  }
  if (expectedDigest && await sha256Hex(body) !== expectedDigest.toLowerCase()) {
    throw new Error("Ribbon manifest digest does not match the early poster.");
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TypeError("Ribbon manifest response is not valid JSON.");
  }
  return validateRibbonManifest(parsed, { manifestUrl: resolved.toString(), baseUrl: resolved.toString() });
}

// v1 is only a transitional renderer. This helper prevents a cover from
// treating its legacy `releaseFrame` as proof of the v2 physical release.
export function getRibbonReleaseCompleteFrame(manifest) {
  if (manifest?.schemaVersion === 2) return manifest.releaseCompleteFrame;
  if (manifest?.schemaVersion === 1) return manifest.releaseFrame;
  throw new TypeError("A validated ribbon manifest is required.");
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
    releaseStarted: manifest.schemaVersion === 2
      ? frameIndex > getRibbonReleaseCompleteFrame(manifest)
      : frameIndex >= getRibbonReleaseCompleteFrame(manifest),
    panelsOpen: elapsed >= panelsAtMs,
    finished: elapsed >= finishAtMs,
    finalRenderedAtMs,
    panelsAtMs,
    finishAtMs,
  };
}

function v2ViewportGeometry(manifest, { width, height }) {
  if (manifest?.schemaVersion !== 2) throw new TypeError("Ribbon root motion requires a v2 manifest.");
  const actualWidth = finiteNumber(width, 1, 20_000, "viewport width");
  const actualHeight = finiteNumber(height, 1, 20_000, "viewport height");
  return {
    width: actualWidth,
    height: actualHeight,
    scale: actualWidth / manifest.width,
    canvasTop: actualHeight / 2 - manifest.registration.y * (actualWidth / manifest.width),
  };
}

function exitProgress(manifest, index) {
  const lastVisibleFrame = manifest.frames.length - 2;
  if (index <= manifest.releaseCompleteFrame) return 0;
  return Math.min(1, (index - manifest.releaseCompleteFrame) / Math.max(1, lastVisibleFrame - manifest.releaseCompleteFrame));
}

// The authored track stays in fixed-canvas pixels. Only the final, screen-specific
// exit distance is added, and it completes on the last visible frame before the
// transparent terminal frame. No frame is cropped, normalized, or re-registered.
export function calculateRootTranslation(manifest, index, viewport) {
  finiteInteger(index, 0, manifest?.frames?.length - 1, "frame index");
  if (manifest?.schemaVersion !== 2) return Object.freeze({ x: 0, y: 0 });
  const geometry = v2ViewportGeometry(manifest, viewport);
  if (index <= manifest.releaseCompleteFrame) return Object.freeze({ x: 0, y: 0 });
  const authoredY = manifest.rootYPx[index] * geometry.scale;
  const requiredExitY = geometry.height / 2 + manifest.registration.y * geometry.scale + 16;
  // The correction reaches the viewport-dependent exit distance on the last
  // visible frame; transparent F(n) is never used to hide an on-screen ribbon.
  const targetY = requiredExitY * exitProgress(manifest, index);
  const correction = Math.max(0, targetY - authoredY);
  return Object.freeze({ x: 0, y: authoredY + correction });
}

// `alphaBounds` is the real decoded frame bbox in fixed-canvas pixels. Call this
// for the previous visible frame, not the transparent terminal frame.
export function ribbonFrameExitedViewport(manifest, index, viewport, alphaBounds) {
  if (!alphaBounds || typeof alphaBounds !== "object") return false;
  const geometry = v2ViewportGeometry(manifest, viewport);
  const top = finiteNumber(alphaBounds.top, 0, manifest.height, "alphaBounds.top");
  const translation = calculateRootTranslation(manifest, index, viewport);
  return geometry.canvasTop + top * geometry.scale + translation.y >= geometry.height + 16;
}

// The paper opens about its outer edge. Under the orthographic projection used
// by the cover, the visible horizontal span is cos(theta); setting it to
// (1 - measuredProgress) preserves the measured inner-edge curve exactly.
export function calculatePanelHingeTurn(progress) {
  const normalizedProgress = finiteNumber(progress, 0, 1, "panel progress");
  const radians = Math.acos(1 - normalizedProgress);
  return Object.freeze({
    progress: normalizedProgress,
    radians,
    degrees: radians * (180 / Math.PI),
    projectedWidthRatio: 1 - normalizedProgress,
  });
}

export function createSequentialRibbonScheduler(manifest, { startedAt = 0 } = {}) {
  const frameMs = 1000 / manifest.fps;
  // A rounded animation timestamp may fall just below its fractional 30 fps
  // deadline. Allow at most 1 ms so it does not wait an entire extra refresh.
  const timestampRoundingMs = 1;
  let nextIndex = 1;
  let nextDueAt = startedAt + manifest.holdMs + frameMs;
  let stopped = false;
  let pausedAt = null;
  return {
    dueFrame(now) {
      if (stopped || pausedAt !== null || nextIndex >= manifest.frames.length || now < nextDueAt - timestampRoundingMs) return null;
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
    pause(now) {
      if (stopped || pausedAt !== null) return;
      pausedAt = finiteNumber(now, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "pause time");
    },
    resume(now) {
      if (stopped || pausedAt === null) return;
      const resumedAt = finiteNumber(now, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "resume time");
      if (resumedAt < pausedAt) throw new RangeError("Ribbon playback time cannot move backwards.");
      nextDueAt += resumedAt - pausedAt;
      pausedAt = null;
    },
    stop() { stopped = true; },
    get nextFrameIndex() { return nextIndex; },
    get completed() { return stopped || nextIndex >= manifest.frames.length; },
    get paused() { return pausedAt !== null; },
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
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  onPanelsOpen,
  onFinish,
}) {
  let stopped = false;
  let terminalDrawn = false;
  let paintId = 0;
  let openId = 0;
  let finishId = 0;
  let phase = "idle";
  let paused = false;
  let remainingMs = 0;
  let deadlineAt = 0;
  const openPanels = () => {
    openId = 0;
    if (stopped || paused) return;
    phase = "opening";
    onPanelsOpen?.();
    remainingMs = panelDurationMs;
    deadlineAt = now() + remainingMs;
    finishId = schedule(finish, panelDurationMs);
  };
  const finish = () => {
    finishId = 0;
    if (stopped || paused) return;
    phase = "finished";
    onFinish?.();
  };
  const afterPaint = () => {
    paintId = 0;
    if (stopped || paused) return;
    phase = "delay";
    remainingMs = panelDelayMs;
    deadlineAt = now() + remainingMs;
    openId = schedule(openPanels, panelDelayMs);
  };
  return {
    markTerminalDrawn() {
      if (stopped || terminalDrawn) return;
      terminalDrawn = true;
      phase = "paint";
      paintId = requestPaint(afterPaint);
    },
    pause(at = now()) {
      if (stopped || paused || phase === "idle" || phase === "finished") return;
      paused = true;
      if (phase === "paint") {
        if (paintId) cancelPaint(paintId);
        paintId = 0;
        return;
      }
      const pausedAt = finiteNumber(at, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "pause time");
      // The next resume supplies a fresh presentation-clock value. Keep only
      // the delay that was active at the pause boundary; wall-clock time while
      // the document is hidden cannot advance the intro.
      remainingMs = Math.max(0, deadlineAt - pausedAt);
      if (phase === "delay" && openId) cancelSchedule(openId);
      if (phase === "opening" && finishId) cancelSchedule(finishId);
      openId = 0;
      finishId = 0;
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      if (phase === "paint") {
        paintId = requestPaint(afterPaint);
      } else if (phase === "delay") {
        openId = schedule(openPanels, remainingMs);
      } else if (phase === "opening") {
        finishId = schedule(finish, remainingMs);
      }
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

// The first poster is decoded first, then frames 1 and 2 decode together. This
// keeps the published poster byte-identical to F0 while staying within the
// two-decode window.
export async function loadInitialRibbonFrames(loader, manifest) {
  if (!loader || typeof loader.getFrame !== "function") throw new TypeError("A ribbon frame loader is required.");
  const first = await loader.getFrame(0);
  const following = await Promise.all(
    [1, 2].filter((index) => index < manifest.frames.length).map((index) => loader.getFrame(index)),
  );
  return Object.freeze([first, ...following]);
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
  concurrency = 8,
  maxPrefetchBytes = MAX_PREFETCH_BYTES,
  maxDecodedFrames = MAX_DECODED_FRAMES,
  maxInFlightDecodes = MAX_INFLIGHT_DECODES,
} = {}) {
  finiteInteger(concurrency, 1, 8, "frame loader concurrency");
  finiteInteger(maxPrefetchBytes, 1, MAX_PREFETCH_BYTES, "frame prefetch byte limit");
  finiteInteger(maxDecodedFrames, 1, 8, "decoded frame limit");
  finiteInteger(maxInFlightDecodes, 1, 4, "in-flight decode limit");
  const managedPixelBytes = manifest.width * manifest.height * 4 * (maxDecodedFrames + maxInFlightDecodes + 1);
  if (managedPixelBytes > MAX_MANAGED_PIXEL_BYTES) {
    throw new RangeError("Ribbon frame surfaces exceed the managed 32 MiB pixel budget.");
  }

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
    get managedPixelBytes() { return managedPixelBytes; },
  };
}
