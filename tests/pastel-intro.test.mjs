import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRibbonFrameDimensions,
  createFinalFrameGate,
  createFrameStallGate,
  createRibbonFrameLoader,
  createSequentialRibbonScheduler,
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

test("ribbon manifest accepts only bounded same-origin sequence assets", () => {
  const manifest = validateRibbonManifest(rawManifest, manifestOptions);
  assert.equal(manifest.frames[0], "https://example.test/assets/design/ribbon-sequence/frame-000.webp");
  assert.throws(() => validateRibbonManifest({ ...rawManifest, frames: ["../escape.webp", "frame-001.webp"] }, manifestOptions));
  assert.throws(() => validateRibbonManifest({ ...rawManifest, releaseFrame: 3 }, manifestOptions));
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
