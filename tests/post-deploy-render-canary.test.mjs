import assert from "node:assert/strict";
import test from "node:test";

import { validateRenderEvidence } from "../scripts/post-deploy-render-canary.mjs";

const BASE = "https://wdcard.enmsoftware.com/";

function evidence(overrides = {}) {
  return {
    baseUrl: BASE,
    expectedRevision: "published-42",
    expectedPaths: ["/api/media/invitation/id/pastel-hero/480.webp", "/api/media/invitation/id/pastel-hero/960.webp"],
    responseHeaders: { source: "cloudflare-published", revision: "published-42" },
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
});
