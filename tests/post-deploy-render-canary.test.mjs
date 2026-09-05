import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import { weddingContent } from "../src/content.js";
import { createContentDocument } from "../src/admin-content/content-document.js";

import {
  collectScenario,
  collectScenarioWithVersionConvergence,
  createRibbonExpectation,
  createHttpRedirectProbeUrl,
  createRenderScenarioConfigs,
  formatRenderDiagnostic,
  resolveExpectedWorkerIdentity,
  runPostDeployRenderCanary,
  validateRenderEvidence,
  validateRibbonPlaybackEvidence,
  validateRenderScenario,
  verifyHttpEntryRedirect,
  waitForHttpEntryRedirect,
  waitForWorkerVersion,
} from "../scripts/post-deploy-render-canary.mjs";

const BASE = "https://wdcard.enmsoftware.com/";
const TARGET_SHA = "a".repeat(40);
const STALE_SHA = "b".repeat(40);
const TARGET_VERSION = "11111111-2222-3333-4444-555555555555";
const STALE_VERSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const projectRoot = new URL("..", import.meta.url);
const ribbonExpectation = createRibbonExpectation({
  schemaVersion: 1,
  fps: 30,
  width: 960,
  height: 640,
  frames: ["frame-000-test.webp", "frame-001-test.webp"],
  panelDelayMs: 300,
  panelDurationMs: 1200,
}, {
  manifestHash: HASH_A,
  frameHashes: { "frame-000-test.webp": HASH_B, "frame-001-test.webp": HASH_B },
});

function ribbonPlaybackEvidence(overrides = {}) {
  const terminalAt = 1_000;
  return {
    baseUrl: BASE,
    ribbonExpectation,
    intro: {
      mounts: 1,
      draws: [{ index: 0, at: 900, alphaPixels: 1 }, { index: 1, at: terminalAt, alphaPixels: 0 }],
      panelsOpenedAt: terminalAt + 300,
      removedAt: terminalAt + 1_500,
      coverPresent: false,
      bodyLocked: false,
      finalHero: { sampledAfterCoverRemoved: true, opacity: "1", display: "block", visibility: "visible" },
    },
    ribbonResponses: [
      { url: `${BASE}assets/design/ribbon-sequence/manifest.json`, status: 200, contentType: "application/json", sha256: HASH_A },
      { url: `${BASE}assets/design/ribbon-sequence/frame-000-test.webp`, status: 200, contentType: "image/webp", sha256: HASH_B },
      { url: `${BASE}assets/design/ribbon-sequence/frame-001-test.webp`, status: 200, contentType: "image/webp", sha256: HASH_B },
    ],
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    baseUrl: BASE,
    expectedRevision: "published-42",
    expectedWorkerTag: TARGET_SHA,
    expectedWorkerVersion: TARGET_VERSION,
    expectedPaths: ["/api/media/invitation/id/pastel-hero/480.webp", "/api/media/invitation/id/pastel-hero/960.webp"],
    responseHeaders: {
      status: 200,
      source: "cloudflare-published",
      revision: "published-42",
      workerTag: TARGET_SHA,
      workerVersion: TARGET_VERSION,
    },
    dom: {
      source: "cloudflare-published",
      revision: "published-42",
      src: "/api/media/invitation/id/pastel-hero/480.webp",
      currentSrc: "/api/media/invitation/id/pastel-hero/960.webp",
      naturalWidth: 960,
      opacity: "1",
      ready: true,
    },
    observations: [
      { src: "/api/media/invitation/id/pastel-hero/480.webp", currentSrc: "", opacity: "0", ready: false },
      { src: "/api/media/invitation/id/pastel-hero/480.webp", currentSrc: "/api/media/invitation/id/pastel-hero/960.webp", opacity: "1", ready: true },
    ],
    requests: [
      `${BASE}assets/index.js`,
      `${BASE}api/media/invitation/id/pastel-hero/960.webp`,
    ],
    consoleErrors: [],
    pageErrors: [],
    ...overrides,
  };
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function localRibbonExpectation() {
  const directory = new URL("../public/assets/design/ribbon-sequence/", import.meta.url);
  const manifestBytes = await readFile(new URL("manifest.json", directory));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const frameHashes = Object.fromEntries(await Promise.all(manifest.frames.map(async (frame) => [
    frame,
    hashBytes(await readFile(new URL(frame, directory))),
  ])));
  return createRibbonExpectation(manifest, { manifestHash: hashBytes(manifestBytes), frameHashes });
}

function localPublishedWorkerPlugin(document) {
  const payload = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    source: "cloudflare-published",
    revisionId: "local-published-42",
    publishedAt: "2026-09-05T00:00:00.000Z",
    document,
  })).toString("base64url");
  const bootstrap = `<template id="wedding-public-bootstrap" data-schema-version="1">${payload}</template>`;
  const heroPrefix = "/api/media/invitation/local-published/pastel-hero/";
  return {
    name: "local-published-render-canary",
    transform(code, id) {
      if (id.replaceAll("\\", "/").endsWith("/src/admin-content/content-client.js")) {
        return code.replace("return import.meta.env?.DEV === true;", "return false;");
      }
      return null;
    },
    transformIndexHtml(html) {
      return html.replace("<!-- WEDDING_PUBLIC_BOOTSTRAP -->", bootstrap);
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        response.setHeader("x-wedding-content-source", "cloudflare-published");
        response.setHeader("x-wedding-revision", "local-published-42");
        response.setHeader("x-wedding-worker-tag", TARGET_SHA);
        response.setHeader("x-wedding-worker-version", TARGET_VERSION);
        const path = request.url?.split("?", 1)[0] || "";
        if (!path.startsWith(heroPrefix)) return next();
        const asset = path.endsWith("/960.webp") ? "pastel-hero-960.webp" : "pastel-hero-480.webp";
        try {
          const bytes = await readFile(new URL(`../public/assets/photos/${asset}`, import.meta.url));
          response.statusCode = 200;
          response.setHeader("content-type", "image/webp");
          response.end(bytes);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}

test("local published Worker canary proves every hash and excludes first-navigation ribbon records from warm evidence", { timeout: 60_000 }, async (t) => {
  const document = createContentDocument(weddingContent);
  document.photos.pastel.hero = {
    ...document.photos.pastel.hero,
    src: "/api/media/invitation/local-published/pastel-hero/480.webp",
    srcSet: "/api/media/invitation/local-published/pastel-hero/480.webp 480w, /api/media/invitation/local-published/pastel-hero/960.webp 960w",
  };
  const ribbon = await localRibbonExpectation();
  const server = await createServer({
    root: fileURLToPath(projectRoot),
    logLevel: "silent",
    plugins: [localPublishedWorkerPlugin(document)],
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    await server.close();
  });
  await server.listen();
  const address = server.httpServer.address();
  assert.equal(typeof address, "object");
  const baseUrl = new URL(`http://127.0.0.1:${address.port}/`);
  browser = await chromium.launch({ headless: true });

  const result = await collectScenario({
    name: "local-warm-ribbon",
    browser,
    baseUrl,
    expectedWorkerTag: TARGET_SHA,
    expectedWorkerVersion: TARGET_VERSION,
    warm: true,
    ribbonExpectation: ribbon,
  });

  assert.equal(result.ribbonResponses.length, ribbon.frames.length + 1, "Warm scenario must discard initial-navigation ribbon responses.");
  assert.ok(result.ribbonResponses.every((response) => response.status === 200));
  assert.equal(validateRenderScenario({
    name: "local-warm-ribbon",
    baseUrl,
    expectedWorkerTag: TARGET_SHA,
    expectedWorkerVersion: TARGET_VERSION,
    expectedRevision: "local-published-42",
    expectedPaths: [
      "/api/media/invitation/local-published/pastel-hero/480.webp",
      "/api/media/invitation/local-published/pastel-hero/960.webp",
    ],
    ribbonExpectation: ribbon,
    ...result,
  }), true);
});

test("render canary accepts only the published revision and its decoded hero", () => {
  assert.equal(validateRenderEvidence(evidence()), true);
});

test("render canary rejects intro fail-open, stale assets, and incorrect production asset responses", () => {
  assert.equal(validateRibbonPlaybackEvidence(ribbonPlaybackEvidence()), true);
  assert.throws(() => validateRibbonPlaybackEvidence(ribbonPlaybackEvidence({
    intro: { ...ribbonPlaybackEvidence().intro, draws: [], panelsOpenedAt: null, removedAt: 1000 },
  })), /모든 frame을 재생하지/);
  assert.throws(() => validateRibbonPlaybackEvidence(ribbonPlaybackEvidence({
    ribbonResponses: ribbonPlaybackEvidence().ribbonResponses.map((entry) => (
      entry.url.endsWith("manifest.json") ? { ...entry, sha256: HASH_B } : entry
    )),
  })), /SHA-256/);
  assert.throws(() => validateRibbonPlaybackEvidence(ribbonPlaybackEvidence({
    ribbonResponses: ribbonPlaybackEvidence().ribbonResponses.map((entry) => (
      entry.url.endsWith("frame-001-test.webp") ? { ...entry, status: 503, contentType: "text/html" } : entry
    )),
  })), /HTTP 상태/);
  assert.throws(() => validateRenderScenario({
    name: "cold-400ms",
    ...evidence(),
    ...ribbonPlaybackEvidence({
      intro: { ...ribbonPlaybackEvidence().intro, draws: [], panelsOpenedAt: null, removedAt: 1000 },
    }),
  }), /\[cold-400ms\].*모든 frame을 재생하지/);
  assert.throws(() => validateRibbonPlaybackEvidence(ribbonPlaybackEvidence({
    ribbonResponses: ribbonPlaybackEvidence().ribbonResponses.map((entry) => (
      entry.url.endsWith("frame-001-test.webp") ? { ...entry, contentType: "text/html" } : entry
    )),
  })), /Content-Type/);
});

test("render canary samples final computed visibility after CSS-only transitions", () => {
  assert.equal(validateRenderEvidence(evidence({
    observations: [
      { src: "/api/media/invitation/id/pastel-hero/480.webp", currentSrc: "/api/media/invitation/id/pastel-hero/960.webp", opacity: "0", ready: true },
    ],
  })), true);
  assert.throws(() => validateRenderEvidence(evidence({
    dom: { ...evidence().dom, opacity: "0" },
    observations: [
      { src: "/api/media/invitation/id/pastel-hero/480.webp", currentSrc: "/api/media/invitation/id/pastel-hero/960.webp", opacity: "0", ready: true },
    ],
  })), /최종 hero가 표시 상태/);
  assert.throws(() => validateRenderEvidence(evidence({
    dom: { ...evidence().dom, opacity: "0" },
    observations: [
      { src: "/api/media/invitation/id/pastel-hero/480.webp", currentSrc: "/api/media/invitation/id/pastel-hero/960.webp", opacity: "1", ready: true },
    ],
  })), /최종 hero가 표시 상태/);
});

test("render validation failures name the scenario and preserve diagnostics", () => {
  assert.throws(() => validateRenderScenario({
    name: "cold-400ms",
    ...evidence({
      observations: [],
      requests: [`${BASE}assets/photos/pastel-hero-480.webp`],
      requestFailures: ["net::ERR_FAILED https://example.test/hero.webp"],
    }),
  }), (error) => {
    assert.match(error.message, /^\[cold-400ms\]/);
    assert.match(error.message, /diagnostics=/);
    assert.match(error.message, /ERR_FAILED/);
    assert.match(error.message, /assets\/photos\/pastel-hero-480\.webp/);
    return true;
  });
});

test("render canary rejects any bundled hero observation or request", () => {
  assert.throws(() => validateRenderEvidence(evidence({
    observations: [{ src: "/assets/photos/pastel-hero-480.webp", currentSrc: "", opacity: "1", ready: true }],
  })), /bundled hero가 DOM/);
  assert.throws(() => validateRenderEvidence(evidence({
    requests: [`${BASE}assets/photos/pastel-hero-960.webp`],
  })), /bundled hero가 네트워크/);
});

test("render canary rejects revision drift and browser errors", () => {
  assert.throws(() => validateRenderEvidence(evidence({
    dom: { ...evidence().dom, revision: "stale" },
  })), /렌더링 revision/);
  assert.throws(() => validateRenderEvidence(evidence({
    consoleErrors: ["bootstrap failed"],
  })), /console 오류/);
  assert.throws(() => validateRenderEvidence(evidence({
    responseHeaders: { ...evidence().responseHeaders, workerTag: STALE_SHA },
  })), /Worker tag/);
  assert.throws(() => validateRenderEvidence(evidence({
    responseHeaders: { ...evidence().responseHeaders, workerVersion: STALE_VERSION },
  })), /version ID/);
});

test("render canary waits for the custom domain to serve the exact Worker tag", async () => {
  const responses = [
    new Response("stale", {
      headers: { "x-wedding-worker-tag": STALE_SHA, "x-wedding-worker-version": STALE_VERSION },
    }),
    new Response("same tag, stale version", {
      headers: { "x-wedding-worker-tag": TARGET_SHA, "x-wedding-worker-version": STALE_VERSION },
    }),
    new Response("target", {
      headers: { "x-wedding-worker-tag": TARGET_SHA, "x-wedding-worker-version": TARGET_VERSION },
    }),
  ];
  const delays = [];
  const result = await waitForWorkerVersion({
    baseUrl: BASE,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    fetchImpl: async () => responses.shift(),
    sleep: async (duration) => delays.push(duration),
    intervalMs: 25,
    logger: { info() {} },
    now: () => 123,
  });
  assert.equal(result.workerTag, TARGET_SHA);
  assert.equal(result.workerVersion, TARGET_VERSION);
  assert.deepEqual(result.observations.map(({ tag }) => tag), [STALE_SHA, TARGET_SHA, TARGET_SHA]);
  assert.deepEqual(result.observations.map(({ version }) => version), [STALE_VERSION, STALE_VERSION, TARGET_VERSION]);
  assert.deepEqual(delays, [25, 25]);
});

test("render canary bounds version convergence failure and reports observed versions", async () => {
  await assert.rejects(waitForWorkerVersion({
    baseUrl: BASE,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    fetchImpl: async () => new Response("stale", {
      headers: { "x-wedding-worker-tag": TARGET_SHA, "x-wedding-worker-version": STALE_VERSION },
    }),
    sleep: async () => {},
    attempts: 2,
    logger: { info() {} },
    now: () => 123,
  }), new RegExp(`수렴하지 않았습니다.*${STALE_VERSION}`));
});

test("raw HTTP entry requires server 308 with the exact HTTPS path, query, and Worker identity", async () => {
  const entry = "https://wdcard.enmsoftware.com/invitation?source=canary&campaign=fall";
  const requests = [];
  const result = await verifyHttpEntryRedirect({
    baseUrl: entry,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    fetchImpl: async (url, options) => {
      requests.push({ url: url.href, options });
      return new Response(null, {
        status: 308,
        headers: {
          location: entry,
          "x-wedding-worker-tag": TARGET_SHA,
          "x-wedding-worker-version": TARGET_VERSION,
        },
      });
    },
  });
  assert.equal(result.httpUrl, "http://wdcard.enmsoftware.com/invitation?source=canary&campaign=fall");
  assert.equal(result.httpsUrl, entry);
  assert.deepEqual(requests.map(({ url, options }) => ({ url, method: options.method, redirect: options.redirect })), [
    { url: result.httpUrl, method: "GET", redirect: "manual" },
    { url: result.httpUrl, method: "HEAD", redirect: "manual" },
  ]);
  assert.deepEqual(result.observations.map(({ attempt, method, status, location, workerTag, workerVersion }) => ({ attempt, method, status, location, workerTag, workerVersion })), [
    { attempt: 1, method: "GET", status: 308, location: entry, workerTag: TARGET_SHA, workerVersion: TARGET_VERSION },
    { attempt: 1, method: "HEAD", status: 308, location: entry, workerTag: TARGET_SHA, workerVersion: TARGET_VERSION },
  ]);
});

test("raw HTTP convergence retries stale identity until GET and HEAD both expose the deployed Worker", async () => {
  const entry = "https://wdcard.enmsoftware.com/invitation?source=canary";
  const delays = [];
  let requestCount = 0;
  const result = await waitForHttpEntryRedirect({
    baseUrl: entry,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    attempts: 2,
    intervalMs: 25,
    sleep: async (duration) => delays.push(duration),
    logger: { info() {} },
    fetchImpl: async (url) => {
      requestCount += 1;
      const stale = requestCount <= 2;
      const location = new URL(url);
      location.protocol = "https:";
      return new Response(null, {
        status: 308,
        headers: {
          location: location.href,
          "x-wedding-worker-tag": stale ? STALE_SHA : TARGET_SHA,
          "x-wedding-worker-version": stale ? STALE_VERSION : TARGET_VERSION,
        },
      });
    },
  });
  assert.deepEqual(delays, [25]);
  assert.equal(result.httpUrl, "http://wdcard.enmsoftware.com/invitation?source=canary");
  assert.equal(result.httpsUrl, entry);
  assert.deepEqual(result.observations.map(({ attempt, method, status, location, workerTag, workerVersion }) => ({ attempt, method, status, location, workerTag, workerVersion })), [
    { attempt: 1, method: "GET", status: 308, location: entry, workerTag: STALE_SHA, workerVersion: STALE_VERSION },
    { attempt: 1, method: "HEAD", status: 308, location: entry, workerTag: STALE_SHA, workerVersion: STALE_VERSION },
    { attempt: 2, method: "GET", status: 308, location: entry, workerTag: TARGET_SHA, workerVersion: TARGET_VERSION },
    { attempt: 2, method: "HEAD", status: 308, location: entry, workerTag: TARGET_SHA, workerVersion: TARGET_VERSION },
  ]);
});

test("raw HTTP convergence retries mixed GET and HEAD identities until both are current", async () => {
  const entry = "https://wdcard.enmsoftware.com/";
  const delays = [];
  let attempt = 0;
  const result = await waitForHttpEntryRedirect({
    baseUrl: entry,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    attempts: 2,
    intervalMs: 25,
    sleep: async (duration) => delays.push(duration),
    logger: { info() {} },
    fetchImpl: async (_url, options) => {
      if (options.method === "GET") attempt += 1;
      const current = attempt === 2 || options.method === "GET";
      return new Response(null, {
        status: 308,
        headers: {
          location: entry,
          "x-wedding-worker-tag": current ? TARGET_SHA : STALE_SHA,
          "x-wedding-worker-version": current ? TARGET_VERSION : STALE_VERSION,
        },
      });
    },
  });
  assert.deepEqual(delays, [25]);
  assert.deepEqual(result.observations.map(({ attempt: observedAttempt, method, workerTag }) => ({ attempt: observedAttempt, method, workerTag })), [
    { attempt: 1, method: "GET", workerTag: TARGET_SHA },
    { attempt: 1, method: "HEAD", workerTag: STALE_SHA },
    { attempt: 2, method: "GET", workerTag: TARGET_SHA },
    { attempt: 2, method: "HEAD", workerTag: TARGET_SHA },
  ]);
});

test("raw HTTP convergence rejects a current GET 200 even when HEAD is still stale", async () => {
  const delays = [];
  const methods = [];
  await assert.rejects(waitForHttpEntryRedirect({
    baseUrl: BASE,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    attempts: 2,
    sleep: async (duration) => delays.push(duration),
    logger: { info() {} },
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      const currentGet = options.method === "GET";
      return new Response(null, {
        status: currentGet ? 200 : 308,
        headers: {
          location: BASE,
          "x-wedding-worker-tag": currentGet ? TARGET_SHA : STALE_SHA,
          "x-wedding-worker-version": currentGet ? TARGET_VERSION : STALE_VERSION,
        },
      });
    },
  }), (error) => {
    assert.match(error.message, /HTTP 200/);
    assert.match(error.message, new RegExp(TARGET_SHA));
    assert.match(error.message, new RegExp(STALE_SHA));
    return true;
  });
  assert.deepEqual(methods, ["GET", "HEAD"]);
  assert.deepEqual(delays, []);
});

test("raw HTTP convergence fails immediately for a bad redirect from the exact deployed Worker", async () => {
  const delays = [];
  const methods = [];
  await assert.rejects(waitForHttpEntryRedirect({
    baseUrl: BASE,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    attempts: 2,
    sleep: async (duration) => delays.push(duration),
    logger: { info() {} },
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      return new Response(null, {
        status: 200,
        headers: {
          "x-wedding-worker-tag": TARGET_SHA,
          "x-wedding-worker-version": TARGET_VERSION,
        },
      });
    },
  }), (error) => {
    assert.match(error.message, /HTTP 200/);
    assert.match(error.message, new RegExp(TARGET_SHA));
    assert.match(error.message, new RegExp(TARGET_VERSION));
    return true;
  });
  assert.deepEqual(methods, ["GET", "HEAD"]);
  assert.deepEqual(delays, []);
});

test("raw HTTP convergence fails immediately for a bad Location from the exact deployed Worker", async () => {
  const entry = "https://wdcard.enmsoftware.com/invitation?source=canary";
  const delays = [];
  const methods = [];
  await assert.rejects(waitForHttpEntryRedirect({
    baseUrl: entry,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    attempts: 2,
    sleep: async (duration) => delays.push(duration),
    logger: { info() {} },
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      return new Response(null, {
        status: 308,
        headers: {
          location: "https://wdcard.enmsoftware.com/invitation?source=other",
          "x-wedding-worker-tag": TARGET_SHA,
          "x-wedding-worker-version": TARGET_VERSION,
        },
      });
    },
  }), /경로 또는 쿼리를 보존하지/);
  assert.deepEqual(methods, ["GET", "HEAD"]);
  assert.deepEqual(delays, []);
});

test("raw HTTP convergence exhausts missing or stale identity with complete observations", async () => {
  const delays = [];
  await assert.rejects(waitForHttpEntryRedirect({
    baseUrl: BASE,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    attempts: 2,
    intervalMs: 25,
    sleep: async (duration) => delays.push(duration),
    logger: { info() {} },
    fetchImpl: async () => new Response(null, {
      status: 200,
      headers: { "x-wedding-worker-tag": STALE_SHA, "x-wedding-worker-version": STALE_VERSION },
    }),
  }), (error) => {
    assert.match(error.message, /수렴하지 않았습니다/);
    assert.match(error.message, new RegExp(STALE_SHA));
    assert.match(error.message, new RegExp(STALE_VERSION));
    assert.match(error.message, /"attempt":2/);
    assert.match(error.message, /"method":"HEAD"/);
    return true;
  });
  assert.deepEqual(delays, [25]);
});

test("raw HTTP convergence preserves prior observations when a later network request fails", async () => {
  let getCount = 0;
  const delays = [];
  await assert.rejects(waitForHttpEntryRedirect({
    baseUrl: BASE,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    attempts: 2,
    intervalMs: 25,
    sleep: async (duration) => delays.push(duration),
    logger: { info() {} },
    fetchImpl: async (_url, options) => {
      if (options.method === "GET") getCount += 1;
      if (getCount === 2 && options.method === "GET") throw new Error("network timeout");
      return new Response(null, {
        status: 200,
        headers: { "x-wedding-worker-tag": STALE_SHA, "x-wedding-worker-version": STALE_VERSION },
      });
    },
  }), (error) => {
    assert.match(error.message, /network timeout/);
    assert.match(error.message, new RegExp(STALE_SHA));
    assert.match(error.message, new RegExp(STALE_VERSION));
    assert.match(error.message, /"attempt":2,"method":"GET"/);
    return true;
  });
  assert.deepEqual(delays, [25]);
});

test("HTTP redirect probe uses a dedicated non-root path and encoded query", () => {
  const probe = createHttpRedirectProbeUrl(BASE);
  assert.equal(probe.href, "https://wdcard.enmsoftware.com/__wedding-canary__/http-redirect?probe=path%2Fquery%20sentinel&encoding=%25");
});

test("raw HTTP entry rejects a browser-style upgrade result, bad Location, stale identity, and request failure", async () => {
  const entry = "https://wdcard.enmsoftware.com/invitation?source=canary";
  const redirect = (overrides = {}) => async () => new Response(null, {
    status: 308,
    headers: {
      location: entry,
      "x-wedding-worker-tag": TARGET_SHA,
      "x-wedding-worker-version": TARGET_VERSION,
      ...overrides,
    },
  });
  const verify = (fetchImpl) => verifyHttpEntryRedirect({
    baseUrl: entry,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    fetchImpl,
  });

  await assert.rejects(verify(async () => new Response(null, { status: 200 })), /HTTPS 서버 리디렉션 대신 HTTP 200/);
  await assert.rejects(verify(async () => new Response(null, { status: 301 })), /HTTPS 서버 리디렉션 대신 HTTP 301/);
  await assert.rejects(verify(redirect({ location: "https://wdcard.enmsoftware.com/other?source=canary" })), /경로 또는 쿼리를 보존하지/);
  await assert.rejects(verify(redirect({ location: "https://wdcard.enmsoftware.com/invitation?source=other" })), /경로 또는 쿼리를 보존하지/);
  await assert.rejects(verify(redirect({ location: "https://other.example/invitation?source=canary" })), /경로 또는 쿼리를 보존하지/);
  await assert.rejects(verify(redirect({ location: "http://wdcard.enmsoftware.com/invitation?source=canary" })), /경로 또는 쿼리를 보존하지/);
  await assert.rejects(verify(redirect({ "x-wedding-worker-version": STALE_VERSION })), /version ID/);
  await assert.rejects(verify(async () => { throw new DOMException("timeout", "TimeoutError"); }), /원시 HTTP GET 진입 요청이 실패했습니다: timeout/);
});

test("raw HTTP entry rejects a bad HEAD response and stale SHA after GET passes", async () => {
  const entry = "https://wdcard.enmsoftware.com/";
  const verify = (fetchImpl) => verifyHttpEntryRedirect({
    baseUrl: entry,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    fetchImpl,
  });
  const response = (method, overrides = {}) => new Response(null, {
    status: overrides.status || 308,
    headers: {
      location: entry,
      "x-wedding-worker-tag": TARGET_SHA,
      "x-wedding-worker-version": TARGET_VERSION,
      ...overrides.headers,
    },
  });

  await assert.rejects(verify(async (_url, options) => response(options.method, {
    status: options.method === "HEAD" ? 200 : 308,
  })), /원시 HTTP HEAD 진입이 HTTPS 서버 리디렉션 대신 HTTP 200/);
  await assert.rejects(verify(async (_url, options) => response(options.method, {
    headers: options.method === "HEAD" ? { "x-wedding-worker-tag": STALE_SHA } : {},
  })), /원시 HTTP HEAD 리디렉션 Worker tag가 배포 SHA와 다릅니다/);
});

test("render scenarios retain warm and cold coverage and add the verified raw HTTP entry", () => {
  const configs = createRenderScenarioConfigs({
    httpUrl: "http://wdcard.enmsoftware.com/?source=canary",
    httpsUrl: "https://wdcard.enmsoftware.com/?source=canary",
  });
  assert.deepEqual(configs, [
    { name: "http-entry", entryUrl: "http://wdcard.enmsoftware.com/?source=canary" },
    { name: "warm-cache", warm: true },
    { name: "cold-400ms", latencyMs: 400 },
  ]);
});

test("standalone render canary verifies raw HTTP before exercising the HTTP browser entry", async () => {
  const fetches = [];
  const navigations = [];
  const launchOptions = [];
  const logs = [];
  const documentResponse = (navigationUrl) => ({
    status: () => 200,
    headers: () => ({
      "x-wedding-content-source": "cloudflare-published",
      "x-wedding-revision": "published-42",
      "x-wedding-worker-tag": TARGET_SHA,
      "x-wedding-worker-version": TARGET_VERSION,
    }),
    request: () => ({
      redirectedFrom: () => navigationUrl.startsWith("http://") ? {
        url: () => navigationUrl,
        response: async () => ({ status: () => 308 }),
      } : null,
    }),
  });
  const page = {
    on() {},
    async addInitScript() {},
    async goto(url) {
      navigations.push(url);
      return documentResponse(url);
    },
    async reload() { return documentResponse(BASE); },
    url: () => BASE,
    async waitForFunction() {},
    async waitForTimeout() {},
    async evaluate() {
      const { dom, observations } = evidence();
      return { dom, observations };
    },
  };
  const browserType = {
    async launch(options) {
      launchOptions.push(options);
      return {
        async newContext() {
          return {
            async route() {},
            async newPage() { return page; },
            async close() {},
          };
        },
        async close() {},
      };
    },
  };
  const result = await runPostDeployRenderCanary({
    baseUrl: BASE,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    browserType,
    logger: { info: (message) => logs.push(message) },
    fetchImpl: async (url, options) => {
      fetches.push({ url: url.href, method: options.method || "GET", redirect: options.redirect });
      if (url.protocol === "http:") {
        const location = new URL(url);
        location.protocol = "https:";
        return new Response(null, {
          status: 308,
          headers: {
            location: location.href,
            "x-wedding-worker-tag": TARGET_SHA,
            "x-wedding-worker-version": TARGET_VERSION,
          },
        });
      }
      if (url.pathname === "/api/content") {
        return new Response(JSON.stringify({
          revisionId: "published-42",
          document: {
            photos: {
              pastel: {
                hero: {
                  src: "/api/media/invitation/id/pastel-hero/480.webp",
                  srcSet: "/api/media/invitation/id/pastel-hero/480.webp 480w, /api/media/invitation/id/pastel-hero/960.webp 960w",
                },
              },
            },
          },
        }));
      }
      return new Response(null, {
        status: 200,
        headers: {
          "x-wedding-worker-tag": TARGET_SHA,
          "x-wedding-worker-version": TARGET_VERSION,
        },
      });
    },
  });

  assert.deepEqual(result.scenarios, ["http-entry", "warm-cache", "cold-400ms"]);
  const httpFetches = fetches.filter(({ url }) => url.startsWith("http://"));
  assert.deepEqual(httpFetches.map(({ method, redirect }) => ({ method, redirect })), [
    { method: "GET", redirect: "manual" },
    { method: "HEAD", redirect: "manual" },
  ]);
  assert.deepEqual(httpFetches.map(({ url }) => url), [
    "http://wdcard.enmsoftware.com/__wedding-canary__/http-redirect?probe=path%2Fquery%20sentinel&encoding=%25",
    "http://wdcard.enmsoftware.com/__wedding-canary__/http-redirect?probe=path%2Fquery%20sentinel&encoding=%25",
  ]);
  assert.deepEqual(navigations, ["http://wdcard.enmsoftware.com/", BASE, BASE]);
  assert.deepEqual(launchOptions, [{ headless: true, args: ["--disable-features=HttpsUpgrades"] }]);
  assert.ok(logs.some((message) => message === `[production-render-canary] raw HTTP redirect 통과: GET=308 HEAD=308 tag=${TARGET_SHA} version=${TARGET_VERSION}`));
});

test("standalone render canary rejects a sentinel redirect that collapses to the root URL", async () => {
  let browserLaunched = false;
  await assert.rejects(runPostDeployRenderCanary({
    baseUrl: BASE,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    browserType: {
      async launch() {
        browserLaunched = true;
        assert.fail("root-only HTTP redirect must fail before browser launch");
      },
    },
    logger: { info() {} },
    fetchImpl: async (url) => {
      if (url.protocol === "http:") {
        return new Response(null, {
          status: 308,
          headers: {
            location: BASE,
            "x-wedding-worker-tag": TARGET_SHA,
            "x-wedding-worker-version": TARGET_VERSION,
          },
        });
      }
      return new Response(null, {
        status: 200,
        headers: {
          "x-wedding-worker-tag": TARGET_SHA,
          "x-wedding-worker-version": TARGET_VERSION,
        },
      });
    },
  }), /경로 또는 쿼리를 보존하지/);
  assert.equal(browserLaunched, false);
});

test("standalone render canary rejects a sentinel redirect that preserves the path but drops the query", async () => {
  let browserLaunched = false;
  await assert.rejects(runPostDeployRenderCanary({
    baseUrl: BASE,
    expectedTag: TARGET_SHA,
    expectedVersion: TARGET_VERSION,
    browserType: {
      async launch() {
        browserLaunched = true;
        assert.fail("query-dropping HTTP redirect must fail before browser launch");
      },
    },
    logger: { info() {} },
    fetchImpl: async (url) => {
      if (url.protocol === "http:") {
        return new Response(null, {
          status: 308,
          headers: {
            location: "https://wdcard.enmsoftware.com/__wedding-canary__/http-redirect",
            "x-wedding-worker-tag": TARGET_SHA,
            "x-wedding-worker-version": TARGET_VERSION,
          },
        });
      }
      return new Response(null, {
        status: 200,
        headers: {
          "x-wedding-worker-tag": TARGET_SHA,
          "x-wedding-worker-version": TARGET_VERSION,
        },
      });
    },
  }), /경로 또는 쿼리를 보존하지/);
  assert.equal(browserLaunched, false);
});

test("each browser scenario retries only Worker identity drift after bounded re-convergence", async () => {
  let collections = 0;
  let convergenceChecks = 0;
  const result = await collectScenarioWithVersionConvergence({
    scenario: { name: "cold-400ms", latencyMs: 400 },
    browser: {},
    baseUrl: new URL(BASE),
    expectedWorkerTag: TARGET_SHA,
    expectedWorkerVersion: TARGET_VERSION,
    logger: { info() {} },
    collectScenarioImpl: async () => {
      collections += 1;
      if (collections === 1) {
        const error = new Error(`[cold-400ms] HTML Worker tag가 배포 SHA와 다릅니다: ${STALE_SHA}; diagnostics={}`);
        error.code = "WORKER_IDENTITY_MISMATCH";
        throw error;
      }
      return evidence();
    },
    waitForWorkerVersionImpl: async ({ expectedTag, expectedVersion }) => {
      convergenceChecks += 1;
      assert.equal(expectedTag, TARGET_SHA);
      assert.equal(expectedVersion, TARGET_VERSION);
    },
  });
  assert.equal(result.responseHeaders.workerVersion, TARGET_VERSION);
  assert.equal(collections, 2);
  assert.equal(convergenceChecks, 1);

  await assert.rejects(collectScenarioWithVersionConvergence({
    scenario: { name: "warm-cache", warm: true },
    browser: {},
    baseUrl: new URL(BASE),
    expectedWorkerTag: TARGET_SHA,
    expectedWorkerVersion: TARGET_VERSION,
    logger: { info() {} },
    collectScenarioImpl: async () => { throw new Error('hero decode failed; diagnostics={"consoleErrors":["HTML Worker tag가 unavailable"]}'); },
    waitForWorkerVersionImpl: async () => assert.fail("non-identity failures must not retry"),
  }), /hero decode failed/);
});

test("scenario re-convergence preserves the browser identity diagnostics when the probe fails", async () => {
  const identityError = new Error('[cold-400ms] HTML Worker version ID가 활성 버전과 다릅니다; diagnostics={"response":503,"network":"ERR"}');
  identityError.code = "WORKER_IDENTITY_MISMATCH";
  await assert.rejects(collectScenarioWithVersionConvergence({
    scenario: { name: "cold-400ms", latencyMs: 400 },
    browser: {},
    baseUrl: new URL(BASE),
    expectedWorkerTag: TARGET_SHA,
    expectedWorkerVersion: TARGET_VERSION,
    logger: { info() {} },
    collectScenarioImpl: async () => { throw identityError; },
    waitForWorkerVersionImpl: async () => { throw new Error("custom domain Worker가 수렴하지 않았습니다"); },
  }), (error) => {
    assert.match(error.message, /cold-400ms/);
    assert.match(error.message, /response/);
    assert.match(error.message, /503/);
    assert.match(error.message, /network/);
    assert.match(error.message, /ERR/);
    assert.match(error.message, /custom domain Worker가 수렴하지 않았습니다/);
    return true;
  });
});

test("standalone render canary reads the exact active identity when CI inputs are absent", async () => {
  const identity = await resolveExpectedWorkerIdentity({
    readActiveIdentity: async () => ({ workerTag: TARGET_SHA, workerVersion: TARGET_VERSION }),
  });
  assert.deepEqual(identity, { workerTag: TARGET_SHA, workerVersion: TARGET_VERSION });
  await assert.rejects(resolveExpectedWorkerIdentity({
    expectedTag: TARGET_SHA,
    readActiveIdentity: async () => assert.fail("partial explicit identity must not query the control plane"),
  }), /함께 제공/);
});

test("render timeout diagnostics retain the response, DOM, and network failure boundary", () => {
  const diagnostic = formatRenderDiagnostic({
    name: "cold-400ms",
    responseHeaders: evidence().responseHeaders,
    dom: { ...evidence().dom, ready: false, opacity: "0" },
    observations: evidence().observations,
    requestFailures: ["net::ERR_FAILED https://example.test/hero.webp"],
    responseFailures: ["503 https://example.test/api/content"],
    consoleErrors: ["content failed"],
    pageErrors: ["decode failed"],
  });
  assert.match(diagnostic, /cold-400ms/);
  assert.match(diagnostic, new RegExp(TARGET_VERSION));
  assert.match(diagnostic, /ERR_FAILED/);
  assert.match(diagnostic, /503/);
  assert.match(diagnostic, /decode failed/);
});
