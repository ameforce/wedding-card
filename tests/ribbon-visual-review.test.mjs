import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { createVisualReview, parseByteRange } from "../scripts/ribbon/serve-visual-review.mjs";
import * as player from "../src/intro/ribbon-player.mjs";

const hash = (data) => createHash("sha256").update(data).digest("hex");
const sequence = "/assets/design/ribbon-sequence/";
const appPath = new URL("../scripts/ribbon/visual-review.mjs", import.meta.url);
const htmlPath = new URL("../scripts/ribbon/visual-review.html", import.meta.url);

function rawManifest(frame0 = Buffer.from("diagnostic WebP byte fixture")) {
  return { schemaVersion: 2, fps: 30, width: 960, height: 640,
    frames: Array.from({ length: 6 }, (_, i) => `frame-${i}.webp`),
    holdMs: 800, panelDelayMs: 600, panelDurationMs: 1400, releaseCompleteFrame: 1,
    registration: { x: 480, y: 320 }, rootYPx: [0, 0, 100, 200, 300, 400],
    poster: { frameIndex: 0, sha256: hash(frame0) }, panelCurve: [
      { offset: 0, progress: 0, leftProgress: 0, rightProgress: 0 },
      { offset: 1, progress: 1, leftProgress: 1, rightProgress: 1 },
    ] };
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ribbon-review-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("ribbon-review-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  const build = path.join(directory, "build");
  await mkdir(path.join(build, sequence), { recursive: true });
  const index = Buffer.from("<!doctype html><title>Diagnostic invitation fixture</title>");
  const video = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 251));
  const frame0 = Buffer.from("diagnostic WebP byte fixture");
  const manifest = rawManifest(frame0);
  await writeFile(path.join(build, "index.html"), index);
  await writeFile(path.join(build, sequence, "manifest.json"), JSON.stringify(manifest));
  for (const [i, name] of manifest.frames.entries()) {
    await writeFile(path.join(build, sequence, name), i === 0 ? frame0 : Buffer.from(`diagnostic WebP frame ${i}`));
  }
  const reference = path.join(directory, "private-original.mp4");
  await writeFile(reference, video);
  return { directory, build, reference, index, video, frame0, manifest };
}

async function listen(t, options) {
  const review = await createVisualReview(options);
  review.server.listen(0, "127.0.0.1");
  await once(review.server, "listening");
  t.after(async () => {
    review.server.closeAllConnections();
    await new Promise((resolve) => review.server.close(resolve));
  });
  const port = review.server.address().port;
  const request = (route, { method = "GET", headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: route, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end();
  });
  return { ...review, request };
}

test("review freezes build, reference and local player bytes with independently matching hashes", async (t) => {
  const f = await fixture(t);
  const { request, binding } = await listen(t, { ...f, referenceStart: 1.25 });
  const expected = new Map();
  for (const record of binding.files) {
    const response = await request(record.route);
    assert.equal(response.status, 200, record.route);
    assert.equal(hash(response.bytes), record.sha256, record.route);
    assert.equal(response.bytes.length, record.bytes, record.route);
    expected.set(record.route, response.bytes);
  }
  await writeFile(path.join(f.build, "index.html"), "changed invitation");
  await writeFile(path.join(f.build, sequence, "frame-0.webp"), "changed frame");
  await writeFile(f.reference, "changed original");
  for (const route of ["/index.html", `${sequence}frame-0.webp`, "/__review/reference.mp4"]) {
    assert.deepEqual((await request(route)).bytes, expected.get(route));
  }
  assert.deepEqual((await request("/?reviewReplay=17")).bytes, f.index);
  assert.deepEqual(JSON.parse((await request("/__review/config.json")).bytes), { referenceStart: 1.25 });
  const playerBytes = await readFile(new URL("../src/intro/ribbon-player.mjs", import.meta.url));
  assert.deepEqual((await request("/__review/player.mjs")).bytes, playerBytes);
  assert.equal(binding.files.filter(({ route }) => route.endsWith(".mp4")).length, 1);
  assert.equal((await request("/private-original.mp4")).status, 404);
  assert.equal((await request("/__review/binding.json")).status, 404);
});

test("review serves the verified binary frame pack and rejects stale bytes", async (t) => {
  const f = await fixture(t);
  const frames = await Promise.all(f.manifest.frames.map((name) => readFile(path.join(f.build, sequence, name))));
  const packed = Buffer.concat(frames);
  const digest = hash(packed);
  const file = `sequence-${digest.slice(0, 12)}.bin`;
  f.manifest.framePack = { file, sha256: digest, lengths: frames.map((frame) => frame.length) };
  await writeFile(path.join(f.build, sequence, file), packed);
  await writeFile(path.join(f.build, sequence, "manifest.json"), JSON.stringify(f.manifest));
  const { request } = await listen(t, f);
  const result = await request(`${sequence}${file}`);
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-type"], "application/octet-stream");
  assert.deepEqual(result.bytes, packed);
  await writeFile(path.join(f.build, sequence, file), Buffer.alloc(packed.length));
  await assert.rejects(createVisualReview(f), /frame pack does not match/);
});

test("review MP4 supports exact GET, HEAD and single byte ranges for native video clients", async (t) => {
  const f = await fixture(t);
  const { request } = await listen(t, f);
  const full = await request("/__review/reference.mp4");
  assert.equal(full.status, 200);
  assert.equal(full.headers["content-type"], "video/mp4");
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.deepEqual(full.bytes, f.video);
  for (const [range, start, end] of [["bytes=0-1", 0, 1], ["bytes=500-", 500, 1023],
    ["bytes=-9", 1015, 1023], ["bytes=1000-9999", 1000, 1023], ["bytes=-9999", 0, 1023]]) {
    for (const method of ["GET", "HEAD"]) {
      const r = await request("/__review/reference.mp4", { method, headers: { Range: range } });
      assert.equal(r.status, 206);
      assert.equal(r.headers["content-range"], `bytes ${start}-${end}/1024`);
      assert.equal(Number(r.headers["content-length"]), end - start + 1);
      assert.deepEqual(r.bytes, method === "HEAD" ? Buffer.alloc(0) : f.video.subarray(start, end + 1));
    }
  }
  const head = await request("/__review/reference.mp4", { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.bytes.length, 0);
  assert.equal(Number(head.headers["content-length"]), f.video.length);
  for (const range of ["bytes=1024-", "bytes=9-2", "bytes=-0", "bytes=-", "items=0-9", "bytes=0-1,5-6"]) {
    const r = await request("/__review/reference.mp4", { headers: { Range: range } });
    assert.equal(r.status, 416, range); assert.equal(r.headers["content-range"], "bytes */1024");
  }
});

test("unknown routes, malformed encodings and mutation methods fail without filesystem effects", async (t) => {
  const f = await fixture(t);
  const { request } = await listen(t, f);
  for (const route of ["/missing", "/api/admin/content", "/__review/../private-original.mp4", "/%2e%2e%2fprivate-original.mp4"]) {
    assert.equal((await request(route)).status, 404, route);
  }
  assert.equal((await request("/%zz")).status, 400);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const r = await request("/index.html", { method });
    assert.equal(r.status, 405); assert.equal(r.headers.allow, "GET, HEAD");
  }
  const r = await request("/__review/");
  assert.equal(r.status, 200);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.match(r.headers["x-robots-tag"], /noindex/);
  assert.deepEqual(await readFile(path.join(f.build, "index.html")), f.index);
});

test("review creation rejects a stale poster hash, missing frame, invalid schema and bad reference start", async (t) => {
  const f = await fixture(t);
  const manifestPath = path.join(f.build, sequence, "manifest.json");
  await writeFile(manifestPath, JSON.stringify({ ...f.manifest, poster: { frameIndex: 0, sha256: "0".repeat(64) } }));
  await assert.rejects(createVisualReview(f), /poster hash/);
  await writeFile(manifestPath, JSON.stringify({ ...f.manifest, frames: [...f.manifest.frames, "missing.webp"], rootYPx: [...f.manifest.rootYPx, 500] }));
  await assert.rejects(createVisualReview(f), /Missing built frame/);
  await writeFile(manifestPath, JSON.stringify({ ...f.manifest, schemaVersion: 1 }));
  await assert.rejects(createVisualReview(f), /schema-version-2/);
  await writeFile(manifestPath, JSON.stringify(f.manifest));
  for (const referenceStart of [-1, Infinity, NaN]) {
    await assert.rejects(createVisualReview({ ...f, referenceStart }), /nonnegative/);
  }
  assert.equal(parseByteRange("bytes=0-", 0), null);
});

// This DOM fixture executes the actual review module with the actual scheduler,
// manifest validator and root-exit helper. Image decoding and browser surfaces
// are replaced explicitly; its results never constitute visual acceptance.
async function uiFixture({ source, deferred, initialMode = "ribbon", onDraw } = {}) {
  const html = await readFile(htmlPath, "utf8");
  const nodes = {};
  const draws = [];
  const events = {};
  const raf = [];
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) {
    const attrs = new Map();
    nodes[id] = { id, style: {}, value: "", disabled: true, hidden: false, textContent: "", attrs,
      setAttribute(name, value) { attrs.set(name, value); },
      hasAttribute(name) { return name === "src" ? Boolean(this.src) : attrs.has(name); },
      removeAttribute(name) { attrs.delete(name); if (name === "src") this.src = ""; },
      addEventListener(name, callback) { this[`on${name}`] = callback; },
      getBoundingClientRect() { return { width: 390, height: 700 }; },
    };
  }
  Object.assign(nodes.mode, { value: initialMode }); Object.assign(nodes.speed, { value: "1" });
  Object.assign(nodes.zoom, { value: "1" });
  nodes.invitation.hidden = true; nodes["full-link"].hidden = true;
  Object.assign(nodes.reference, { playbackRate: 1, currentTime: 0, paused: true,
    pause() { this.paused = true; }, play() { this.paused = false; return Promise.resolve(); } });
  let syntheticAlpha = 0;
  const canvasOperations = [];
  nodes.ribbon.getContext = () => ({
    clearRect(...bounds) { syntheticAlpha = 0; canvasOperations.push({ type: "clear", bounds }); },
    drawImage(frame) {
      syntheticAlpha = frame.alpha; canvasOperations.push({ type: "draw", frame: frame.index, alpha: frame.alpha });
      draws.push(frame.index); onDraw?.(frame.index);
    },
  });
  const classes = new Set();
  const document = { hidden: false, getElementById: (id) => nodes[id],
    querySelector: () => ({ classList: { toggle(name) { if (classes.has(name)) { classes.delete(name); return false; } classes.add(name); return true; } } }),
    addEventListener: (name, callback) => { events[name] = callback; } };
  const manifest = player.validateRibbonManifest(rawManifest(), { baseUrl: "http://localhost/" });
  let active = 0, maxActive = 0, cancelled = false;
  const loader = { async getFrame(index) {
    active += 1; maxActive = Math.max(maxActive, active);
    try { if (deferred) await deferred(index); return { index, width: 960, height: 640, alpha: index === manifest.frames.length - 1 ? 0 : 255 }; }
    finally { active -= 1; }
  }, cancel() { cancelled = true; } };
  const dependency = { ...player, loadRibbonManifest: async () => manifest, createRibbonFrameLoader: () => loader };
  let body = source ?? await readFile(appPath, "utf8");
  body = body.replace(/^import \{([^}]+)\} from "\/__review\/player\.mjs";/,
    "const {$1} = __player;");
  let reloadCalls = 0;
  const context = vm.createContext({ document, window: { location: { reload() { reloadCalls += 1; } }, addEventListener: (name, callback) => { events[name] = callback; } },
    __player: dependency, requestAnimationFrame: (callback) => { raf.push(callback); },
    fetch: async () => ({ ok: true, json: async () => ({ referenceStart: 1.25 }) }), console });
  await new vm.Script(`(async () => {${body}\n})()`).runInContext(context);
  assert.equal(nodes.restart.disabled, false, nodes.status.textContent);
  return { nodes, draws, events, raf, document, manifest, canvasOperations, get syntheticAlpha() { return syntheticAlpha; },
    get maxActive() { return maxActive; }, get cancelled() { return cancelled; }, get reloadCalls() { return reloadCalls; },
    async tick(now) { const callback = raf.shift(); assert.ok(callback); await callback(now); },
  };
}

test("full invitation replay resets quarter-speed reference and remains a real public-page reload", async () => {
  const ui = await uiFixture();
  ui.nodes.speed.value = "0.25"; ui.nodes.speed.onchange();
  assert.equal(ui.nodes.reference.playbackRate, .25);
  ui.nodes.mode.value = "full"; ui.nodes.mode.onchange();
  await ui.nodes.restart.onclick();
  assert.equal(ui.nodes.reference.playbackRate, 1);
  assert.match(ui.nodes.invitation.src, /^\/\?reviewReplay=\d+$/);
  assert.equal(ui.nodes.reference.currentTime, 1.25);
  assert.equal(ui.nodes["full-link"].hidden, false);
  const first = ui.nodes.invitation.src;
  await ui.nodes.restart.onclick();
  assert.notEqual(ui.nodes.invitation.src, first);
  ui.nodes.mode.value = "ribbon"; ui.nodes.mode.onchange();
  await ui.nodes.restart.onclick();
  assert.equal(ui.nodes.reference.playbackRate, .25, "ribbon-only speed selection survives mode switching");
});

test("normal and quarter-speed ribbon samples draw every frame once using the product scheduler", async () => {
  for (const speed of [1, .25]) {
    const ui = await uiFixture();
    ui.nodes.speed.value = String(speed); ui.nodes.speed.onchange();
    await ui.nodes.restart.onclick();
    for (let tick = 0; tick <= Math.ceil(1200 / speed / (1000 / 60)); tick += 1) await ui.tick(tick * 1000 / 60);
    assert.deepEqual(ui.draws, [0, 0, 1, 2, 3, 4, 5]);
    assert.equal(ui.nodes.pause.disabled, true);
    assert.match(ui.nodes.status.textContent, /마쳤습니다/);
    assert.equal(ui.maxActive, 1);
    const expected = player.calculateRootTranslation(ui.manifest, 5, { width: 390, height: 700 });
    assert.equal(ui.nodes.ribbon.style.transform, `translateY(${expected.y}px) scale(1)`);
  }
});

test("rapid seeks discard stale decode results and preserve a single active decoder", async () => {
  let release;
  const ui = await uiFixture({ deferred: (index) => index === 2 ? new Promise((resolve) => { release = resolve; }) : undefined });
  ui.nodes.seek.value = "2";
  const first = ui.nodes.seek.oninput();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(typeof release, "function");
  ui.nodes.seek.value = "4";
  const second = ui.nodes.seek.oninput();
  release(); await Promise.all([first, second]);
  assert.deepEqual(ui.draws, [0, 4]);
  assert.equal(ui.maxActive, 1);
  assert.equal(ui.nodes.seek.value, 4);
  ui.events.pagehide({ persisted: false }); assert.equal(ui.cancelled, true);
});

test("pause and hidden-document handling prevent elapsed-time jumps on resume", async () => {
  const ui = await uiFixture();
  await ui.nodes.restart.onclick();
  await ui.tick(0); await ui.tick(400);
  ui.nodes.pause.onclick(); await ui.tick(50_000);
  assert.deepEqual(ui.draws, [0, 0]);
  ui.nodes.pause.onclick(); await ui.tick(50_010); await ui.tick(50_410); await ui.tick(50_444);
  assert.deepEqual(ui.draws, [0, 0, 1]);
  ui.document.hidden = true; ui.events.visibilitychange();
  await ui.tick(100_000); assert.deepEqual(ui.draws, [0, 0, 1]);
  ui.document.hidden = false; ui.nodes.pause.onclick(); await ui.tick(100_010);
  assert.deepEqual(ui.draws, [0, 0, 1]);
});

test("browser-restored full mode is synchronized with the visible canvas and invitation", async () => {
  const ui = await uiFixture({ initialMode: "full" });
  const full = ui.nodes.mode.value === "full";
  assert.equal(ui.nodes.ribbon.hidden, full);
  assert.equal(ui.nodes.invitation.hidden, !full);
  assert.equal(ui.nodes["full-link"].hidden, !full);
  assert.equal(ui.nodes["zoom-label"].hidden, full);
  await ui.nodes.restart.onclick();
  assert.equal(ui.nodes.invitation.hidden, ui.nodes.mode.value !== "full");
});

test("reviewer zoom preserves the selected original frame and remains hidden in full mode", async () => {
  const ui = await uiFixture();
  ui.nodes.seek.value = "2"; await ui.nodes.seek.oninput();
  const originalDraws = [...ui.draws];
  const root = player.calculateRootTranslation(ui.manifest, 2, { width: 390, height: 700 });
  for (const zoom of [1, 2, 3, 1]) {
    ui.nodes.zoom.value = String(zoom); ui.nodes.zoom.onchange();
    assert.equal(ui.nodes.ribbon.style.transform, `translateY(${root.y}px) scale(${zoom})`);
    assert.deepEqual(ui.draws, originalDraws);
    assert.equal(ui.nodes.seek.value, 2);
  }
  ui.nodes.mode.value = "full"; ui.nodes.mode.onchange();
  assert.equal(ui.nodes["zoom-label"].hidden, true);
  ui.nodes.mode.value = "ribbon"; ui.nodes.mode.onchange();
  assert.equal(ui.nodes["zoom-label"].hidden, false);
});

test("history-cache restoration reloads the immutable review after cancelling its decoder", async () => {
  const ui = await uiFixture();
  ui.events.pagehide({ persisted: true });
  assert.equal(ui.cancelled, true);
  ui.events.pageshow({ persisted: true });
  assert.equal(ui.reloadCalls, 1);
  ui.events.pageshow({ persisted: false });
  assert.equal(ui.reloadCalls, 1);
});

test("async decode preserves elapsed playback time at normal and quarter speed", async (t) => {
  const results = [];
  const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
  for (const speed of [1, .25]) for (const delayTicks of [0, 1, 2]) {
    let tickIndex = -1, now = 0, pendingDecode;
    const actual = [], reference = [], ticks = [];
    const ui = await uiFixture({
      deferred: (frame) => frame > 0 && delayTicks > 0
        ? new Promise((resolve) => { pendingDecode = { resolve, dueTick: tickIndex + delayTicks }; }) : undefined,
      onDraw: (frame) => { if (frame > 0) actual.push({ frame, timeMs: Number(now.toFixed(3)) }); },
    });
    ui.nodes.speed.value = String(speed); ui.nodes.speed.onchange();
    await ui.nodes.restart.onclick();
    // Independent clock driver: the product scheduler sees elapsed active time,
    // including decode latency. It has the identical synthetic decode budget.
    const scheduler = player.createSequentialRibbonScheduler(ui.manifest);
    let referencePending;
    for (tickIndex = 0; tickIndex < 1200; tickIndex += 1) {
      now = tickIndex * 1000 / 60;
      ticks.push(ui.tick(now)); await flush();
      if (pendingDecode?.dueTick <= tickIndex) {
        const current = pendingDecode; pendingDecode = undefined; current.resolve(); await flush();
      }
      if (referencePending?.dueTick <= tickIndex) {
        reference.push({ frame: referencePending.frame, timeMs: Number(now.toFixed(3)) });
        scheduler.markDrawn(referencePending.frame, now * speed); referencePending = undefined;
      } else if (!referencePending) {
        const frame = scheduler.dueFrame(now * speed);
        if (frame !== null) {
          if (delayTicks === 0) {
            reference.push({ frame, timeMs: Number(now.toFixed(3)) }); scheduler.markDrawn(frame, now * speed);
          } else referencePending = { frame, dueTick: tickIndex + delayTicks };
        }
      }
      if (ui.nodes.pause.disabled && scheduler.completed) break;
    }
    await Promise.all(ticks);
    assert.deepEqual(actual.map(({ frame }) => frame), [1, 2, 3, 4, 5]);
    assert.equal(ui.maxActive, 1);
    const extraDelayMs = Number((actual.at(-1).timeMs - reference.at(-1).timeMs).toFixed(3));
    results.push({ speed, decodeLatencyTicks: delayTicks, refreshMs: 1000 / 60, actual, reference, extraDelayMs });
  }
  t.diagnostic(JSON.stringify({ uiSha256: hash(await readFile(appPath)), timing: results }));
  for (const result of results) {
    assert.ok(result.extraDelayMs <= 1000 / 60 + .001,
      `speed=${result.speed}, decode=${result.decodeLatencyTicks} rAF ticks: accumulated excess ${result.extraDelayMs}ms`);
  }
});

test("synthetic terminal clears the canvas only after the previous visible frame exits", async () => {
  const ui = await uiFixture();
  const penultimate = ui.manifest.frames.length - 2;
  ui.nodes.seek.value = String(penultimate); await ui.nodes.seek.oninput();
  assert.equal(ui.syntheticAlpha, 255);
  const viewport = { width: 390, height: 700 };
  assert.equal(player.ribbonFrameExitedViewport(ui.manifest, penultimate, viewport, { top: 0 }), true);
  const translation = player.calculateRootTranslation(ui.manifest, penultimate, viewport);
  assert.equal(ui.nodes.ribbon.style.transform, `translateY(${translation.y}px) scale(1)`);
  ui.nodes.seek.value = String(penultimate + 1); await ui.nodes.seek.oninput();
  assert.equal(ui.syntheticAlpha, 0);
  assert.deepEqual(ui.canvasOperations.slice(-2), [
    { type: "clear", bounds: [0, 0, 960, 640] }, { type: "draw", frame: penultimate + 1, alpha: 0 },
  ]);
  assert.equal(ui.nodes.seek.value, penultimate + 1);
  assert.equal(ui.nodes.pause.disabled, true);
});
