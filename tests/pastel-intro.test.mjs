import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  assertRibbonFrameDimensions,
  calculatePanelHingeTurn,
  calculateRootTranslation,
  createFinalFrameGate,
  createFrameStallGate,
  createRibbonFrameLoader,
  createSequentialRibbonScheduler,
  loadInitialRibbonFrames,
  loadRibbonManifest,
  ribbonFrameExitedViewport,
  ribbonTimeline,
  validateRibbonManifest,
} from "../src/intro/ribbon-player.mjs";

const rawManifest = {
  schemaVersion: 1,
  fps: 30,
  width: 960,
  height: 640,
  frames: ["frame-000.webp", "frame-001.webp", "frame-002.webp"],
  holdMs: 600,
  releaseFrame: 1,
  panelDelayMs: 300,
  panelDurationMs: 1200,
};
const manifestOptions = {
  baseUrl: "https://example.test/",
  manifestUrl: "https://example.test/assets/design/ribbon-sequence/manifest.json",
};

const rawV2Manifest = {
  schemaVersion: 2,
  fps: 30,
  width: 960,
  height: 640,
  frames: ["frame-000.webp", "frame-001.webp", "frame-002.webp", "frame-003.webp", "frame-004.webp"],
  holdMs: 800,
  panelDelayMs: 600,
  panelDurationMs: 1400,
  releaseCompleteFrame: 1,
  registration: { x: 480, y: 320 },
  rootYPx: [0, 0, 50, 100, 200],
  poster: { frameIndex: 0, sha256: "a".repeat(64) },
  panelCurve: [
    { offset: 0, progress: 0, leftProgress: 0, rightProgress: 0 },
    { offset: 0.45, progress: 0.12, leftProgress: 0.14, rightProgress: 0.1 },
    { offset: 1, progress: 1, leftProgress: 1, rightProgress: 1 },
  ],
};

function packedFixture() {
  const frames = rawV2Manifest.frames.map((_, i) => new Uint8Array(20 + i).fill(i + 1));
  const packed = Buffer.concat(frames);
  const sha256 = createHash("sha256").update(packed).digest("hex");
  const raw = { ...rawV2Manifest, framePack: { file: `sequence-${sha256.slice(0, 12)}.bin`, sha256, lengths: frames.map((frame) => frame.length) } };
  return { frames, raw, packed: packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) };
}

test("the fixed tall release canvas preserves registration and the decoded memory budget", () => {
  const manifest = validateRibbonManifest({ ...rawV2Manifest, width: 480, height: 1920, registration: { x: 240, y: 960 } }, manifestOptions);
  const loader = createRibbonFrameLoader(manifest);
  assert.equal(loader.managedPixelBytes, 480 * 1920 * 4 * 7);
  assert.ok(loader.managedPixelBytes < 32 * 1024 * 1024);
  assert.deepEqual(manifest.registration, { x: 240, y: 960 });
  assert.throws(() => validateRibbonManifest({ ...rawV2Manifest, height: 1920 }, manifestOptions));
  loader.cancel();
});

test("one verified frame pack supplies exact frames with shared compressed storage", async () => {
  const fixture = packedFixture();
  const manifest = validateRibbonManifest(fixture.raw, manifestOptions);
  const requests = [];
  const loader = createRibbonFrameLoader(manifest, {
    fetchFrame: async (url) => { requests.push(url); return fixture.packed; },
    decodeFrame: async (bytes) => bytes,
  });
  for (let i = 0; i < fixture.frames.length; i++) {
    const decoded = await loader.getFrame(i);
    assert.deepEqual([...decoded], [...fixture.frames[i]]);
    assert.equal(decoded.buffer, fixture.packed);
  }
  assert.deepEqual(requests, [manifest.framePack.url]);
  assert.equal(loader.prefetchedBytes, fixture.packed.byteLength);
  loader.cancel();
});

test("frame pack validation rejects path escapes, malformed tables and budget overflow", () => {
  const { raw } = packedFixture();
  for (const framePack of [
    { ...raw.framePack, file: "../other.bin" },
    { ...raw.framePack, lengths: [20] },
    { ...raw.framePack, lengths: [20, 20, 20, 20, -1] },
    { ...raw.framePack, lengths: [4194304, 20, 20, 20, 20] },
    { ...raw.framePack, extra: true },
  ]) assert.throws(() => validateRibbonManifest({ ...raw, framePack }, manifestOptions));
});

test("a corrupt or truncated frame pack never reaches the decoder", async () => {
  const fixture = packedFixture();
  const manifest = validateRibbonManifest(fixture.raw, manifestOptions);
  const corrupt = fixture.packed.slice(0);new Uint8Array(corrupt)[20] ^= 1;
  for (const packed of [corrupt, fixture.packed.slice(1)]) {
    let decoded = false;
    const loader = createRibbonFrameLoader(manifest, { fetchFrame: async () => packed, decodeFrame: async () => { decoded = true; } });
    await assert.rejects(loader.getFrame(0), /mismatch/);
    assert.equal(decoded, false);
    loader.cancel();
  }
});

test("skip during a frame pack request cancels late playback preparation", async () => {
  const fixture = packedFixture();
  let finish;
  const loader = createRibbonFrameLoader(validateRibbonManifest(fixture.raw, manifestOptions), {
    fetchFrame: () => new Promise((resolve) => { finish = resolve; }),
    decodeFrame: async () => { throw new Error("must not decode"); },
  });
  const pending = loader.getFrame(0);
  loader.cancel();finish(fixture.packed);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(loader.prefetchedBytes, 0);
});

test("ribbon manifest accepts only bounded same-origin sequence assets", () => {
  const manifest = validateRibbonManifest(rawManifest, manifestOptions);
  assert.equal(manifest.frames[0], "https://example.test/assets/design/ribbon-sequence/frame-000.webp");
  assert.throws(() => validateRibbonManifest({ ...rawManifest, frames: ["../escape.webp", "frame-001.webp"] }, manifestOptions));
  assert.throws(() => validateRibbonManifest({ ...rawManifest, releaseFrame: 3 }, manifestOptions));
});

test("manifest loader verifies a single response body against the early-poster digest when supplied", async () => {
  const body = JSON.stringify(rawManifest);
  const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const digest = [...new Uint8Array(digestBytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
  const fetchImpl = async () => new Response(body, { status: 200 });
  const loaded = await loadRibbonManifest(manifestOptions.manifestUrl, { fetchImpl, baseUrl: manifestOptions.baseUrl, expectedDigest: digest });
  assert.equal(loaded.schemaVersion, 1);
  const textLoaded = await loadRibbonManifest(manifestOptions.manifestUrl, { fetchImpl, baseUrl: manifestOptions.baseUrl, expectedText: body });
  assert.equal(textLoaded.schemaVersion, 1);
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  try {
    const insecureTextLoaded = await loadRibbonManifest(manifestOptions.manifestUrl, { fetchImpl, baseUrl: manifestOptions.baseUrl, expectedText: body });
    assert.equal(insecureTextLoaded.schemaVersion, 1);
  } finally {
    Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
  }
  await assert.rejects(
    loadRibbonManifest(manifestOptions.manifestUrl, { fetchImpl, baseUrl: manifestOptions.baseUrl, expectedText: `${body} ` }),
    /text does not match/,
  );
  await assert.rejects(
    loadRibbonManifest(manifestOptions.manifestUrl, { fetchImpl, baseUrl: manifestOptions.baseUrl, expectedDigest: "b".repeat(64) }),
    /digest does not match/,
  );
});

test("v2 manifest locks the authored canvas, timing, poster and root-track contract", () => {
  const manifest = validateRibbonManifest(rawV2Manifest, manifestOptions);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.holdMs, 800);
  assert.equal(manifest.releaseCompleteFrame, 1);
  assert.equal(manifest.poster.frameIndex, 0);
  assert.throws(() => validateRibbonManifest({ ...rawV2Manifest, holdMs: 799 }, manifestOptions));
  assert.throws(() => validateRibbonManifest({ ...rawV2Manifest, rootYPx: [1, 0, 50, 100, 200] }, manifestOptions), /cannot start/);
  assert.throws(() => validateRibbonManifest({
    ...rawV2Manifest,
    panelCurve: [
      { offset: 0, progress: 0, leftProgress: 0, rightProgress: 0 },
      { offset: 1, progress: 0.9, leftProgress: 1, rightProgress: 1 },
    ],
  }, manifestOptions), /normalized/);
  assert.throws(() => validateRibbonManifest({ ...rawV2Manifest, unexpected: true }, manifestOptions), /fields/);
  assert.doesNotThrow(() => validateRibbonManifest({
    ...rawV2Manifest,
    width: 480,
    height: 320,
    registration: { x: 240, y: 160 },
  }, manifestOptions));
  assert.throws(() => validateRibbonManifest({ ...rawV2Manifest, width: 800, height: 640 }, manifestOptions), /bounded 3:2 canvas/);
});

test("v2 root motion is zero before release and the final visible frame leaves every required viewport", () => {
  const manifest = validateRibbonManifest(rawV2Manifest, manifestOptions);
  for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    assert.deepEqual(calculateRootTranslation(manifest, 0, viewport), { x: 0, y: 0 });
    assert.deepEqual(calculateRootTranslation(manifest, 1, viewport), { x: 0, y: 0 });
    const finalVisible = calculateRootTranslation(manifest, 3, viewport);
    assert.ok(finalVisible.y > 0);
    assert.equal(ribbonFrameExitedViewport(manifest, 3, viewport, { left: 0, top: 0, width: 960, height: 640 }), true);
  }
  assert.deepEqual(
    calculateRootTranslation(manifest, 3, { width: 1440, height: 900 }),
    calculateRootTranslation(manifest, 3, { width: 430, height: 900 }),
    "Desktop root motion must use the centered invitation width rather than stretching to the viewport.",
  );
});

test("v2 root path remains continuous and does not apply frame normalization", () => {
  const manifest = validateRibbonManifest(rawV2Manifest, manifestOptions);
  const viewport = { width: 480, height: 800 };
  const positions = [0, 1, 2, 3, 4].map((index) => calculateRootTranslation(manifest, index, viewport).y);
  assert.deepEqual(positions.slice(0, 2), [0, 0]);
  assert.ok(positions.every((value, index) => index === 0 || value >= positions[index - 1]));
  assert.throws(() => validateRibbonManifest({ ...rawV2Manifest, rootYPx: [0, 0, 50, 800, 801] }, manifestOptions), /continuous/);
});

test("paper turn maps measured progress to an outer-hinge angle and orthographic horizontal compression", () => {
  const closed = calculatePanelHingeTurn(0);
  const half = calculatePanelHingeTurn(0.5);
  const open = calculatePanelHingeTurn(1);
  assert.deepEqual(closed, { progress: 0, radians: 0, degrees: 0, projectedWidthRatio: 1 });
  assert.ok(Math.abs(half.degrees - 60) < 1e-9);
  assert.ok(Math.abs(half.projectedWidthRatio - 0.5) < 1e-12);
  assert.ok(Math.abs(open.degrees - 90) < 1e-9);
  assert.equal(open.projectedWidthRatio, 0);
  assert.throws(() => calculatePanelHingeTurn(1.01), /panel progress/);
});

test("paper panels wait for a displayed terminal transparent frame plus the manifest delay", () => {
  const manifest = validateRibbonManifest(rawManifest, manifestOptions);
  const final = ribbonTimeline(manifest, 600 + 3 * (1000 / 30));
  assert.equal(final.frameIndex, 2);
  assert.equal(final.panelsOpen, false);
  const opening = ribbonTimeline(manifest, final.panelsAtMs);
  assert.equal(opening.panelsOpen, true);
  assert.equal(opening.finished, false);
  assert.equal(ribbonTimeline(manifest, opening.finishAtMs).finished, true);
});

test("panel opening starts only after the terminal canvas draw has crossed a paint frame", () => {
  const calls = [];
  const timers = [];
  let paint;
  const gate = createFinalFrameGate({
    panelDelayMs: 300,
    panelDurationMs: 1200,
    requestPaint: (callback) => { paint = callback; return 11; },
    cancelPaint: () => calls.push("cancel-paint"),
    schedule: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    cancelSchedule: () => calls.push("cancel-timer"),
    onPanelsOpen: () => calls.push("open"),
    onFinish: () => calls.push("finish"),
  });

  gate.markTerminalDrawn();
  assert.deepEqual(calls, []);
  assert.equal(timers.length, 0);
  paint();
  assert.equal(timers[0].delay, 300);
  timers[0].callback();
  assert.deepEqual(calls, ["open"]);
  assert.equal(timers[1].delay, 1200);
  timers[1].callback();
  assert.deepEqual(calls, ["open", "finish"]);
});

test("panel gate pauses hidden-document time and resumes its remaining presentation delay", () => {
  const timers = [];
  const cancelled = [];
  let paint;
  let clock = 0;
  const gate = createFinalFrameGate({
    panelDelayMs: 600,
    panelDurationMs: 1400,
    requestPaint: (callback) => { paint = callback; return 10; },
    cancelPaint: (id) => cancelled.push(`paint:${id}`),
    schedule: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    cancelSchedule: (id) => cancelled.push(`timer:${id}`),
    now: () => clock,
  });
  gate.markTerminalDrawn();
  paint();
  clock = 250;
  gate.pause(clock);
  assert.deepEqual(cancelled, ["timer:1"]);
  clock = 20_000;
  gate.resume();
  assert.equal(timers[1].delay, 350);
});

test("decoded frame dimensions must exactly match the manifest canvas", () => {
  const manifest = validateRibbonManifest(rawManifest, manifestOptions);
  assert.doesNotThrow(() => assertRibbonFrameDimensions({ width: 960, height: 640 }, manifest));
  assert.throws(() => assertRibbonFrameDimensions({ width: 959, height: 640 }, manifest), /do not match/);
});

test("sequential scheduler draws every deformation once in order without catch-up skips", () => {
  const manifest = validateRibbonManifest({
    ...rawManifest,
    frames: ["frame-000.webp", "frame-001.webp", "frame-002.webp", "frame-003.webp"],
  }, manifestOptions);
  const scheduler = createSequentialRibbonScheduler(manifest, { startedAt: 0 });
  const frameMs = 1000 / manifest.fps;
  const drawn = [0];

  assert.equal(scheduler.dueFrame(manifest.holdMs), null);
  assert.equal(scheduler.dueFrame(manifest.holdMs + frameMs), 1);
  drawn.push(scheduler.dueFrame(700));
  scheduler.markDrawn(1, 700); // Slow decode makes this frame late.
  assert.equal(scheduler.dueFrame(700), null);
  assert.equal(scheduler.dueFrame(700 + frameMs), 2);
  drawn.push(scheduler.dueFrame(820));
  scheduler.markDrawn(2, 820);
  assert.equal(scheduler.dueFrame(820), null);
  drawn.push(scheduler.dueFrame(820 + frameMs));
  scheduler.markDrawn(3, 820 + frameMs);

  assert.deepEqual(drawn, [0, 1, 2, 3]);
  assert.equal(scheduler.completed, true);
  assert.equal(scheduler.dueFrame(20_000), null);
});

test("normal render-grid quantization preserves the 30 fps clock instead of rebasing every frame", () => {
  const manifest = validateRibbonManifest({
    ...rawManifest,
    frames: ["frame-000.webp", "frame-001.webp", "frame-002.webp", "frame-003.webp"],
  }, manifestOptions);
  const scheduler = createSequentialRibbonScheduler(manifest, { startedAt: 0 });
  const draws = [];
  for (let now = 0; now <= 800; now += 10) {
    const frameIndex = scheduler.dueFrame(now);
    if (frameIndex !== null) {
      draws.push({ frameIndex, now });
      scheduler.markDrawn(frameIndex, now);
    }
  }
  assert.deepEqual(draws, [
    { frameIndex: 1, now: 640 },
    { frameIndex: 2, now: 670 },
    { frameIndex: 3, now: 700 },
  ]);
});

test("sequential scheduler pauses inactive-tab elapsed time without a wall-clock jump", () => {
  const manifest = validateRibbonManifest({ ...rawManifest, frames: ["frame-000.webp", "frame-001.webp", "frame-002.webp"] }, manifestOptions);
  const scheduler = createSequentialRibbonScheduler(manifest, { startedAt: 0 });
  scheduler.pause(620);
  assert.equal(scheduler.dueFrame(20_000), null);
  scheduler.resume(20_000);
  assert.equal(scheduler.dueFrame(20_000), null);
  assert.equal(scheduler.dueFrame(20_000 + (1000 / 30)), 1);
});

test("rounded browser animation timestamps retain an even 30 fps cadence", () => {
  const manifest = validateRibbonManifest(rawManifest, manifestOptions);
  for (const refreshHz of [60, 120]) {
    for (const quantumMs of [0.1, 1]) {
      for (const phaseMs of [0, 0.025, 0.05]) {
        const scheduler = createSequentialRibbonScheduler(manifest, { startedAt: phaseMs });
        const draws = [];
        for (let tick = 0; tick < refreshHz * 4; tick += 1) {
          // Browser timestamp rounding can put an otherwise due refresh just
          // below a 1000/30 deadline. No decoding delay is present in this case.
          const now = Math.round((tick * 1000 / refreshHz + phaseMs) / quantumMs) * quantumMs;
          const index = scheduler.dueFrame(now);
          if (index === null) continue;
          draws.push({ index, now });
          scheduler.markDrawn(index, now);
        }
        assert.deepEqual(draws.map(({ index }) => index), manifest.frames.slice(1).map((_, index) => index + 1));
        for (let index = 1; index < draws.length; index += 1) {
          const gap = draws[index].now - draws[index - 1].now;
          assert.ok(Math.abs(gap - 1000 / 30) <= quantumMs + 1e-8, `${refreshHz}Hz phase ${phaseMs} quantum ${quantumMs}: uneven interval ${gap}`);
        }
      }
    }
  }
});

test("timestamp rounding never admits a frame more than 1 ms early", () => {
  const manifest = validateRibbonManifest(rawManifest, manifestOptions);
  const scheduler = createSequentialRibbonScheduler(manifest, { startedAt: 0 });
  const firstDue = manifest.holdMs + 1000 / manifest.fps;
  assert.equal(scheduler.dueFrame(firstDue - 1.01), null);
  assert.equal(scheduler.dueFrame(firstDue - 1), 1);
  scheduler.markDrawn(1, firstDue - 1);
  assert.equal(scheduler.dueFrame(firstDue - 1), null);
  assert.equal(scheduler.dueFrame(firstDue + 1000 / manifest.fps - 1.01), null);
});

test("terminal scheduler state stops frame work before the panel gate takes ownership", () => {
  const manifest = validateRibbonManifest({ ...rawManifest, frames: ["frame-000.webp", "frame-001.webp"] }, manifestOptions);
  const scheduler = createSequentialRibbonScheduler(manifest, { startedAt: 0 });
  const terminalIndex = scheduler.dueFrame(manifest.holdMs + (1000 / manifest.fps));
  assert.equal(terminalIndex, 1);
  assert.equal(scheduler.markDrawn(terminalIndex, 700), true);
  assert.equal(scheduler.dueFrame(2_000), null);
});

test("a stalled due frame fails open only after the bounded stall policy expires", () => {
  const calls = [];
  let pending;
  const gate = createFrameStallGate({
    timeoutMs: 1500,
    schedule: (callback, delay) => {
      pending = { callback, delay };
      return 7;
    },
    cancelSchedule: () => calls.push("cleared"),
    onTimeout: () => calls.push("fallback"),
  });
  gate.begin();
  gate.begin();
  assert.equal(pending.delay, 1500);
  assert.deepEqual(calls, []);
  pending.callback();
  assert.deepEqual(calls, ["fallback"]);
});

test("frame loader bounds decoded frames and releases evicted bitmap resources", async () => {
  const manifest = validateRibbonManifest(rawManifest, manifestOptions);
  const closed = [];
  const loader = createRibbonFrameLoader(manifest, {
    fetchFrame: async () => new ArrayBuffer(12),
    decodeFrame: async (_bytes, url) => ({ url, close: () => closed.push(url) }),
    maxDecodedFrames: 2,
  });
  await loader.getFrame(0);
  await loader.getFrame(1);
  await loader.getFrame(2);
  assert.equal(closed.length, 1);
  loader.cancel();
  assert.equal(closed.length, 3);
});

test("initial ribbon preparation keeps F0 as the poster and decodes the first three frames", async () => {
  const manifest = validateRibbonManifest(rawV2Manifest, manifestOptions);
  const decoded = [];
  const loader = createRibbonFrameLoader(manifest, {
    fetchFrame: async () => new ArrayBuffer(12),
    decodeFrame: async (_bytes, url) => {
      decoded.push(url);
      return { width: 960, height: 640, close() {} };
    },
  });
  const initial = await loadInitialRibbonFrames(loader, manifest);
  assert.equal(initial.length, 3);
  assert.equal(decoded.length, 3);
  assert.equal(loader.managedPixelBytes, 960 * 640 * 4 * 7);
  loader.cancel();
});

test("frame loader rejects a decoded-frame window that exceeds the 32 MiB managed pixel budget", () => {
  const oversized = validateRibbonManifest({
    ...rawManifest,
    width: 2048,
    height: 1024,
  }, manifestOptions);
  assert.throws(() => createRibbonFrameLoader(oversized), /32 MiB/);
});

test("frame prefetch uses eight bounded network requests while decode and bitmap limits stay separate", async () => {
  const manifest = validateRibbonManifest({
    ...rawManifest,
    frames: Array.from({ length: 16 }, (_value, index) => `frame-${String(index).padStart(3, "0")}.webp`),
    releaseFrame: 8,
  }, manifestOptions);
  let active = 0;
  let peak = 0;
  const loader = createRibbonFrameLoader(manifest, {
    fetchFrame: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return new ArrayBuffer(8);
    },
  });
  await loader.prefetch();
  assert.equal(peak, 8);
  loader.cancel();
});

test("cancelling a frame loader prevents late network work from producing a drawable", async () => {
  const manifest = validateRibbonManifest(rawManifest, manifestOptions);
  const loader = createRibbonFrameLoader(manifest, {
    fetchFrame: (_url, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }),
    decodeFrame: async () => ({ close() {} }),
  });
  const pending = loader.getFrame(0);
  loader.cancel();
  await assert.rejects(pending, { name: "AbortError" });
});

test("frame loader caps simultaneous decodes instead of collecting an unbounded decode backlog", async () => {
  const manifest = validateRibbonManifest(rawManifest, manifestOptions);
  const decodeResolvers = [];
  const loader = createRibbonFrameLoader(manifest, {
    fetchFrame: async () => new ArrayBuffer(8),
    decodeFrame: () => new Promise((resolve) => decodeResolvers.push(resolve)),
    maxInFlightDecodes: 2,
  });
  await loader.prefetch();
  const first = loader.getFrame(0);
  const second = loader.getFrame(1);
  await assert.rejects(loader.getFrame(2), /capacity is busy/);
  decodeResolvers.splice(0).forEach((resolve) => resolve({ width: 960, height: 640, close() {} }));
  await Promise.all([first, second]);
  loader.cancel();
});

test("one failed frame rejects the complete prefetch instead of leaving an incomplete cover", async () => {
  const manifest = validateRibbonManifest(rawManifest, manifestOptions);
  const loader = createRibbonFrameLoader(manifest, {
    fetchFrame: async (url) => {
      if (url.endsWith("frame-001.webp")) throw new Error("missing");
      return new ArrayBuffer(8);
    },
  });
  await assert.rejects(loader.prefetch(), /missing/);
});
