import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRenderDiagnostic,
  validateRenderEvidence,
  waitForWorkerVersion,
} from "../scripts/post-deploy-render-canary.mjs";

const BASE = "https://wdcard.enmsoftware.com/";
const TARGET_SHA = "a".repeat(40);
const STALE_SHA = "b".repeat(40);

function evidence(overrides = {}) {
  return {
    baseUrl: BASE,
    expectedRevision: "published-42",
    expectedWorkerTag: TARGET_SHA,
    expectedPaths: ["/api/media/invitation/id/pastel-hero/480.webp", "/api/media/invitation/id/pastel-hero/960.webp"],
    responseHeaders: {
      status: 200,
      source: "cloudflare-published",
      revision: "published-42",
      workerTag: TARGET_SHA,
      workerVersion: "version-target",
    },
    dom: {
      source: "cloudflare-published",
      revision: "published-42",
      src: "/api/media/invitation/id/pastel-hero/480.webp",
      currentSrc: "/api/media/invitation/id/pastel-hero/960.webp",
      naturalWidth: 960,
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

test("render canary accepts only the published revision and its decoded hero", () => {
  assert.equal(validateRenderEvidence(evidence()), true);
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
});

test("render canary waits for the custom domain to serve the exact Worker tag", async () => {
  const responses = [
    new Response("stale", {
      headers: { "x-wedding-worker-tag": STALE_SHA, "x-wedding-worker-version": "version-stale" },
    }),
    new Response("target", {
      headers: { "x-wedding-worker-tag": TARGET_SHA, "x-wedding-worker-version": "version-target" },
    }),
  ];
  const delays = [];
  const result = await waitForWorkerVersion({
    baseUrl: BASE,
    expectedTag: TARGET_SHA,
    fetchImpl: async () => responses.shift(),
    sleep: async (duration) => delays.push(duration),
    intervalMs: 25,
    logger: { info() {} },
    now: () => 123,
  });
  assert.equal(result.workerTag, TARGET_SHA);
  assert.equal(result.workerVersion, "version-target");
  assert.deepEqual(result.observations.map(({ tag }) => tag), [STALE_SHA, TARGET_SHA]);
  assert.deepEqual(delays, [25]);
});

test("render canary bounds version convergence failure and reports observed versions", async () => {
  await assert.rejects(waitForWorkerVersion({
    baseUrl: BASE,
    expectedTag: TARGET_SHA,
    fetchImpl: async () => new Response("stale", {
      headers: { "x-wedding-worker-tag": STALE_SHA, "x-wedding-worker-version": "version-stale" },
    }),
    sleep: async () => {},
    attempts: 2,
    logger: { info() {} },
    now: () => 123,
  }), new RegExp(`수렴하지 않았습니다.*${STALE_SHA}`));
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
  assert.match(diagnostic, /version-target/);
  assert.match(diagnostic, /ERR_FAILED/);
  assert.match(diagnostic, /503/);
  assert.match(diagnostic, /decode failed/);
});
