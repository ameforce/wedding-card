import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { activeDeploymentIdentity } from "./cloudflare-deployment-state.mjs";
import { PAPER_OPENING_DELAY_MS, PAPER_OPENING_DURATION_MS } from "../src/intro/opening-timing.js";

const DEFAULT_BASE_URL = "https://wdcard.enmsoftware.com/";
const HTTP_TIMEOUT_MS = 20_000;
const RENDER_TIMEOUT_MS = 30_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const VERSION_CONVERGENCE_ATTEMPTS = 12;
const VERSION_CONVERGENCE_INTERVAL_MS = 5_000;
const SCENARIO_CONVERGENCE_ATTEMPTS = 3;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const WORKER_VERSION_ID = /^[a-f0-9-]{36}$/u;
const BUNDLED_PASTEL_HERO = /^\/assets\/photos\/pastel-hero-(?:480|960)\.webp$/u;
const HTTP_ENTRY_CHROMIUM_ARGS = ["--disable-features=HttpsUpgrades"];
const HTTP_REDIRECT_PROBE_PATH = "/__wedding-canary__/http-redirect";
const HTTP_REDIRECT_PROBE_QUERY = "probe=path%2Fquery%20sentinel&encoding=%25";
const RIBBON_MANIFEST_PATH = "/assets/design/ribbon-sequence/manifest.json";
const SHA256 = /^[a-f0-9]{64}$/u;

class WorkerIdentityMismatchError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "WorkerIdentityMismatchError";
    this.code = "WORKER_IDENTITY_MISMATCH";
  }
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeBaseUrl(value) {
  const url = new URL(value || DEFAULT_BASE_URL);
  invariant(url.protocol === "https:", "운영 render canary URL은 HTTPS여야 합니다.");
  invariant(url.username === "" && url.password === "", "운영 render canary URL에 자격 증명을 넣을 수 없습니다.");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function pathname(value, baseUrl) {
  if (!value) return "";
  return new URL(value, baseUrl).pathname;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createRibbonExpectation(manifest, { manifestHash, frameHashes, packHash } = {}) {
  invariant(manifest && (manifest.schemaVersion === 1 || manifest.schemaVersion === 2), "리본 manifest schemaVersion이 올바르지 않습니다.");
  invariant(Number.isInteger(manifest.fps) && manifest.fps === 30, "리본 manifest는 30 fps여야 합니다.");
  invariant(Number.isInteger(manifest.width) && Number.isInteger(manifest.height), "리본 manifest canvas 크기가 없습니다.");
  invariant(Array.isArray(manifest.frames) && manifest.frames.length > 1, "리본 manifest frame 목록이 없습니다.");
  invariant(typeof manifestHash === "string" && SHA256.test(manifestHash), "리본 manifest SHA-256이 올바르지 않습니다.");
  invariant(frameHashes && typeof frameHashes === "object", "리본 frame SHA-256 목록이 없습니다.");
  const frames = manifest.frames.map((frame) => {
    invariant(typeof frame === "string" && /^[a-z0-9][a-z0-9_-]*\.webp$/iu.test(frame), "리본 frame 이름이 올바르지 않습니다.");
    invariant(typeof frameHashes[frame] === "string" && SHA256.test(frameHashes[frame]), `리본 frame SHA-256이 없습니다: ${frame}`);
    return frame;
  });
  const common = {
    schemaVersion: manifest.schemaVersion,
    manifestPath: RIBBON_MANIFEST_PATH,
    manifestHash,
    frames: Object.freeze(frames),
    frameHashes: Object.freeze({ ...frameHashes }),
    panelDelayMs: manifest.panelDelayMs,
    panelDurationMs: manifest.panelDurationMs,
    // Keep authored metadata distinct from the approved runtime pacing.
    paperOpening: Object.freeze({ delayMs: PAPER_OPENING_DELAY_MS, durationMs: PAPER_OPENING_DURATION_MS }),
    ...(manifest.framePack ? { framePack: Object.freeze({ ...manifest.framePack }) } : {}),
  };
  if (manifest.framePack) {
    invariant(SHA256.test(packHash || "") && packHash === manifest.framePack.sha256, "리본 묶음 파일의 SHA-256이 빌드 파일과 다릅니다.");
    invariant(manifest.framePack.file === `sequence-${packHash.slice(0, 12)}.bin`, "리본 묶음 파일 이름이 해시와 다릅니다.");
  }
  if (manifest.schemaVersion === 1) return Object.freeze({ ...common, transitional: true });

  invariant(manifest.fps === 30 && manifest.width >= 480 && manifest.width <= 960 && ((manifest.width % 3 === 0 && manifest.height * 3 === manifest.width * 2) || (manifest.width === 480 && manifest.height === 1920)), "v2 리본 manifest canvas가 올바르지 않습니다.");
  invariant(manifest.holdMs === 800 && manifest.panelDelayMs === 600 && manifest.panelDurationMs === 1400, "v2 리본 timing이 올바르지 않습니다.");
  invariant(Number.isInteger(manifest.releaseCompleteFrame) && manifest.releaseCompleteFrame >= 0 && manifest.releaseCompleteFrame < frames.length - 1, "v2 releaseCompleteFrame이 올바르지 않습니다.");
  invariant(manifest.registration && Number.isFinite(manifest.registration.x) && Number.isFinite(manifest.registration.y), "v2 registration이 올바르지 않습니다.");
  invariant(Array.isArray(manifest.rootYPx) && manifest.rootYPx.length === frames.length && manifest.rootYPx.slice(0, manifest.releaseCompleteFrame + 1).every((value) => value === 0), "v2 root track이 release 전에 이동합니다.");
  invariant(manifest.poster?.frameIndex === 0 && typeof manifest.poster.sha256 === "string" && SHA256.test(manifest.poster.sha256), "v2 F0 poster 계약이 올바르지 않습니다.");
  invariant(manifest.poster.sha256 === frameHashes[frames[0]], "v2 F0 poster SHA-256이 frame 0과 다릅니다.");
  invariant(Array.isArray(manifest.panelCurve) && manifest.panelCurve.length >= 2, "v2 measured panel curve가 없습니다.");
  let previousOffset = -1;
  let previousProgress = -1;
  let previousLeft = -1;
  let previousRight = -1;
  for (const point of manifest.panelCurve) {
    invariant(point && Number.isFinite(point.offset) && Number.isFinite(point.progress) && Number.isFinite(point.leftProgress) && Number.isFinite(point.rightProgress), "v2 panel curve point가 올바르지 않습니다.");
    invariant(point.offset > previousOffset && point.progress >= previousProgress && point.leftProgress >= previousLeft && point.rightProgress >= previousRight, "v2 panel curve가 단조롭지 않습니다.");
    previousOffset = point.offset;
    previousProgress = point.progress;
    previousLeft = point.leftProgress;
    previousRight = point.rightProgress;
  }
  invariant(manifest.panelCurve[0].offset === 0 && manifest.panelCurve[0].progress === 0 && manifest.panelCurve[0].leftProgress === 0 && manifest.panelCurve[0].rightProgress === 0, "v2 panel curve 시작점이 올바르지 않습니다.");
  invariant(manifest.panelCurve.at(-1).offset === 1 && manifest.panelCurve.at(-1).progress === 1 && manifest.panelCurve.at(-1).leftProgress === 1 && manifest.panelCurve.at(-1).rightProgress === 1, "v2 panel curve 종료점이 올바르지 않습니다.");
  return Object.freeze({
    ...common,
    transitional: false,
    holdMs: manifest.holdMs,
    releaseCompleteFrame: manifest.releaseCompleteFrame,
    registration: Object.freeze({ ...manifest.registration }),
    rootYPx: Object.freeze([...manifest.rootYPx]),
    poster: Object.freeze({ ...manifest.poster }),
    panelCurve: Object.freeze(manifest.panelCurve.map((point) => Object.freeze({ ...point }))),
  });
}

function validateCoverPlaybackEvidence(ribbonExpectation, intro) {
  invariant(intro?.earlyPoster?.present === true && intro.earlyPoster.observedBeforeMain === true, "first HTML tied poster 증거가 없습니다.");
  invariant(intro.earlyPoster.sha256 === ribbonExpectation.frameHashes[ribbonExpectation.frames[0]], "first HTML poster SHA-256이 build F0와 다릅니다.");
  invariant(Number.isFinite(intro.handoff?.claimedAt) && Number.isFinite(intro.handoff?.firstCanvasDrawAt) && intro.handoff.firstCanvasDrawAt <= intro.handoff.claimedAt && intro.handoff.lateMounts === 0, "early cover hand-off 또는 late mount 증거가 올바르지 않습니다.");
  const panelSample = intro.panelSamples?.find((sample) => (
    Number(sample.leftProgress) >= 0.2 && Number(sample.leftProgress) <= 0.8
      && Number(sample.rightProgress) >= 0.2 && Number(sample.rightProgress) <= 0.8
  ));
  invariant(panelSample, "안정적인 mid-open paper 표본이 없습니다.");
  const matrix3d = (transform, side) => {
    const match = typeof transform === "string" && transform.match(/^matrix3d\((.+)\)$/u);
    invariant(match, `${side} paper가 rotateY computed transform을 내놓지 않았습니다.`);
    const values = match[1].split(",").map((value) => Number(value.trim()));
    invariant(values.length === 16 && values.every(Number.isFinite) && Math.abs(values[2]) > 0.05 && Math.abs(values[8]) > 0.05, `${side} paper가 out-of-plane hinge가 아닙니다.`);
  };
  matrix3d(panelSample.leftTransform, "left");
  matrix3d(panelSample.rightTransform, "right");
  invariant(
    Number.isFinite(panelSample.leftInnerEdge) && Number.isFinite(panelSample.rightInnerEdge)
      && Number.isFinite(panelSample.leftOuterEdge) && Number.isFinite(panelSample.rightOuterEdge)
      && Number.isFinite(panelSample.leftWidth) && Number.isFinite(panelSample.rightWidth),
    "mid-open paper edge 측정값이 없습니다.",
  );
  const expectedLeftInnerEdge = panelSample.leftOuterEdge + panelSample.leftWidth * (1 - panelSample.leftProgress);
  const expectedRightInnerEdge = panelSample.rightOuterEdge - panelSample.rightWidth * (1 - panelSample.rightProgress);
  invariant(Math.abs(panelSample.leftInnerEdge - expectedLeftInnerEdge) <= 1 && Math.abs(panelSample.rightInnerEdge - expectedRightInnerEdge) <= 1, "hinged paper inner edge가 진행률에서 1px를 넘게 벗어났습니다.");
  invariant(intro.progressiveHero?.some((sample) => sample.coverPresent === true && sample.rootTransparent === true && Number(sample.opacity) > 0), "transparent root cover 아래 hero가 progressively revealed되었다는 증거가 없습니다.");
  invariant(intro.visibility?.hiddenPause === true && intro.visibility.noProgressWhileHidden === true && intro.visibility.resumed === true, "숨김/재개 presentation clock 증거가 없습니다.");
}

function validateV2RibbonPlaybackEvidence(ribbonExpectation, intro) {
  invariant(JSON.stringify(intro.panelConfig?.panelCurve) === JSON.stringify(ribbonExpectation.panelCurve), "v2 measured per-side panel curve config가 runtime에 로드되지 않았습니다.");
  const lastVisible = intro.draws.at(-2);
  invariant(lastVisible?.alphaPixels > 0, "v2 transparent terminal 전 previous visible frame이 없습니다.");
  invariant(Number.isFinite(lastVisible.alphaViewportTop) && Number.isFinite(lastVisible.viewportHeight) && lastVisible.alphaViewportTop >= lastVisible.viewportHeight + 16, "v2 ribbon root가 transparent terminal 전에 viewport 밖 16px로 나가지 않았습니다.");
  invariant(intro.panelSamples?.some((sample) => (
    Number(sample.leftProgress) >= 0.2 && Number(sample.leftProgress) <= 0.8
      && Number(sample.rightProgress) >= 0.2 && Number(sample.rightProgress) <= 0.8
      && sample.leftProgress !== sample.rightProgress
  )), "v2 measured per-side panel curve 또는 안정적인 mid-open 표본이 없습니다.");
}

export function validateRibbonPlaybackEvidence({ baseUrl, ribbonExpectation, intro, ribbonResponses }) {
  invariant(ribbonExpectation, "배포 리본 자산 기대값이 없습니다.");
  invariant(intro?.mounts === 1, `Pastel intro cover mount 수가 올바르지 않습니다: ${intro?.mounts ?? "missing"}`);
  invariant(Array.isArray(intro?.draws), "Pastel intro frame draw 증거가 없습니다.");
  invariant(intro.draws.length === ribbonExpectation.frames.length, `Pastel intro가 모든 frame을 재생하지 않았습니다: expected=${ribbonExpectation.frames.length} actual=${intro.draws.length}`);
  invariant(intro.draws.every((draw, index) => draw.index === index), "Pastel intro frame 순서 또는 중복 draw가 올바르지 않습니다.");
  const terminal = intro.draws.at(-1);
  invariant(terminal?.alphaPixels === 0, "투명 terminal frame이 canvas에 그려지지 않았습니다.");
  invariant(Number.isFinite(intro.panelsOpenedAt) && intro.panelsOpenedAt - terminal.at >= ribbonExpectation.paperOpening.delayMs, "paper panel이 transparent terminal frame 전에 열렸습니다.");
  invariant(Number.isFinite(intro.removedAt) && intro.removedAt >= intro.panelsOpenedAt + ribbonExpectation.paperOpening.durationMs - 5, "paper panel transition 완료 전에 intro cover가 제거되었습니다.");
  invariant(intro.coverPresent === false && intro.bodyLocked === false, "최종 intro cover 또는 body scroll lock이 남아 있습니다.");
  invariant(intro.finalHero?.sampledAfterCoverRemoved === true, "cover 제거 뒤 최종 hero computed-style sample이 없습니다.");
  invariant(Number(intro.finalHero.opacity) > 0 && intro.finalHero.display !== "none" && intro.finalHero.visibility === "visible", "cover 제거 뒤 hero가 표시 상태가 아닙니다.");
  validateCoverPlaybackEvidence(ribbonExpectation, intro);
  if (ribbonExpectation.schemaVersion === 2) validateV2RibbonPlaybackEvidence(ribbonExpectation, intro);

  const expectedAssets = new Map([
    [ribbonExpectation.manifestPath, { hash: ribbonExpectation.manifestHash, contentType: "application/json" }],
    ...(ribbonExpectation.framePack
      ? [[`${RIBBON_MANIFEST_PATH.slice(0, -"manifest.json".length)}${ribbonExpectation.framePack.file}`, { hash: ribbonExpectation.framePack.sha256, contentType: "application/octet-stream" }]]
      : ribbonExpectation.frames.map((frame) => [`${RIBBON_MANIFEST_PATH.slice(0, -"manifest.json".length)}${frame}`, { hash: ribbonExpectation.frameHashes[frame], contentType: "image/webp" }])),
  ]);
  for (const [assetPath, expected] of expectedAssets) {
    const responses = (ribbonResponses || []).filter((response) => pathname(response.url, baseUrl) === assetPath);
    invariant(responses.length > 0, `배포 리본 자산 응답이 없습니다: ${assetPath}`);
    for (const response of responses) {
      invariant(response.status === 200, `배포 리본 자산 HTTP 상태가 올바르지 않습니다: ${assetPath}=${response.status}`);
      invariant(response.contentType.includes(expected.contentType), `배포 리본 자산 Content-Type이 올바르지 않습니다: ${assetPath}=${response.contentType || "missing"}`);
      invariant(response.sha256 === expected.hash, `배포 리본 자산 SHA-256이 build 산출물과 다릅니다: ${assetPath}`);
    }
  }
  return true;
}

function expectedWorkerTag(value) {
  const tag = String(value || "").trim().toLowerCase();
  invariant(GIT_SHA.test(tag), "WEDDING_CANARY_EXPECTED_WORKER_TAG는 정확한 40자 Git SHA여야 합니다.");
  return tag;
}

function expectedWorkerVersion(value) {
  const version = String(value || "").trim().toLowerCase();
  invariant(WORKER_VERSION_ID.test(version), "WEDDING_CANARY_EXPECTED_WORKER_VERSION은 exact Worker version ID여야 합니다.");
  return version;
}

export async function resolveExpectedWorkerIdentity({
  expectedTag,
  expectedVersion,
  readActiveIdentity = activeDeploymentIdentity,
}) {
  const hasTag = Boolean(String(expectedTag || "").trim());
  const hasVersion = Boolean(String(expectedVersion || "").trim());
  invariant(hasTag === hasVersion, "expected Worker tag와 version ID는 함께 제공해야 합니다.");
  const identity = hasTag ? { workerTag: expectedTag, workerVersion: expectedVersion } : await readActiveIdentity();
  return {
    workerTag: expectedWorkerTag(identity.workerTag),
    workerVersion: expectedWorkerVersion(identity.workerVersion),
  };
}

export async function waitForWorkerVersion({
  baseUrl,
  expectedTag,
  expectedVersion,
  fetchImpl = globalThis.fetch,
  logger = console,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  attempts = VERSION_CONVERGENCE_ATTEMPTS,
  intervalMs = VERSION_CONVERGENCE_INTERVAL_MS,
  timeoutMs = VERSION_PROBE_TIMEOUT_MS,
  now = Date.now,
}) {
  const targetTag = expectedWorkerTag(expectedTag);
  const targetVersion = expectedWorkerVersion(expectedVersion);
  invariant(Number.isInteger(attempts) && attempts > 0, "Worker version probe 횟수가 올바르지 않습니다.");
  const observations = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const probeUrl = new URL(baseUrl);
    probeUrl.searchParams.set("workerVersionProbe", `${attempt}-${now()}`);
    try {
      const response = await fetchImpl(probeUrl, {
        redirect: "error",
        headers: {
          accept: "text/html",
          "cache-control": "no-cache",
          pragma: "no-cache",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const observation = {
        attempt,
        status: response.status,
        tag: response.headers.get("x-wedding-worker-tag") || "missing",
        version: response.headers.get("x-wedding-worker-version") || "missing",
      };
      observations.push(observation);
      if (response.status === 200 && observation.tag === targetTag && observation.version === targetVersion) {
        logger.info(`[production-render-canary] custom-domain version 수렴: attempt=${attempt} tag=${targetTag} version=${targetVersion}`);
        return { workerTag: targetTag, workerVersion: targetVersion, observations };
      }
    } catch (error) {
      observations.push({ attempt, error: error.message });
    }
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error(`커스텀 도메인이 배포 Worker tag=${targetTag}, version=${targetVersion}로 수렴하지 않았습니다. observations=${JSON.stringify(observations)}`);
}

function httpEntryUrls(baseUrl) {
  const httpsUrl = new URL(baseUrl);
  invariant(httpsUrl.protocol === "https:", "HTTP 진입 검증의 기준 URL은 HTTPS여야 합니다.");
  invariant(httpsUrl.username === "" && httpsUrl.password === "", "HTTP 진입 검증 URL에 자격 증명을 넣을 수 없습니다.");
  httpsUrl.hash = "";
  const httpUrl = new URL(httpsUrl);
  httpUrl.protocol = "http:";
  return { httpUrl, httpsUrl };
}

export function createHttpRedirectProbeUrl(baseUrl) {
  const probeUrl = new URL(baseUrl);
  invariant(probeUrl.protocol === "https:", "HTTP 리디렉션 probe의 기준 URL은 HTTPS여야 합니다.");
  probeUrl.pathname = HTTP_REDIRECT_PROBE_PATH;
  probeUrl.search = HTTP_REDIRECT_PROBE_QUERY;
  probeUrl.hash = "";
  return probeUrl;
}

function createVerifiedHttpEntry(baseUrl, redirectProbe) {
  const entry = httpEntryUrls(baseUrl);
  const verifiedOrigin = new URL(redirectProbe.httpsUrl).origin;
  invariant(entry.httpsUrl.origin === verifiedOrigin, "HTTP 진입 render 시나리오의 HTTPS origin이 검증된 리디렉션 origin과 다릅니다.");
  return {
    httpUrl: entry.httpUrl.href,
    httpsUrl: entry.httpsUrl.href,
    redirectProbe,
  };
}

async function observeHttpEntryRedirect({
  baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = HTTP_TIMEOUT_MS,
  attempt = 1,
}) {
  const { httpUrl, httpsUrl } = httpEntryUrls(baseUrl);
  const methods = ["GET", "HEAD"];
  const observations = [];

  for (const method of methods) {
    let response;
    try {
      response = await fetchImpl(httpUrl, {
        method,
        redirect: "manual",
        headers: {
          accept: "text/html",
          "cache-control": "no-cache",
          pragma: "no-cache",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      observations.push({ attempt, method, error: error.message });
      const failure = new Error(`원시 HTTP ${method} 진입 요청이 실패했습니다: ${error.message}; observations=${formatHttpRedirectObservations(observations)}`, { cause: error });
      failure.httpRedirectObservations = observations;
      throw failure;
    }

    const observation = {
      attempt,
      method,
      status: response.status,
      location: response.headers.get("location") || "",
      workerTag: response.headers.get("x-wedding-worker-tag") || "missing",
      workerVersion: response.headers.get("x-wedding-worker-version") || "missing",
    };
    await response.body?.cancel().catch(() => {});
    observations.push(observation);
  }

  return { httpUrl: httpUrl.href, httpsUrl: httpsUrl.href, observations };
}

function assertHttpEntryRedirectBehavior({ observations, httpsUrl }) {
  for (const observation of observations) {
    invariant(observation.status === 308, `원시 HTTP ${observation.method} 진입이 HTTPS 서버 리디렉션 대신 HTTP ${observation.status}를 반환했습니다.`);
    invariant(observation.location === httpsUrl, `원시 HTTP ${observation.method} Location이 HTTPS 기준 URL의 경로 또는 쿼리를 보존하지 않았습니다: ${observation.location || "missing"}`);
  }
}

function assertHttpEntryRedirect({ observations, httpsUrl, targetTag, targetVersion }) {
  assertHttpEntryRedirectBehavior({ observations, httpsUrl });
  for (const observation of observations) {
    invariant(observation.workerTag === targetTag, `원시 HTTP ${observation.method} 리디렉션 Worker tag가 배포 SHA와 다릅니다: ${observation.workerTag}`);
    invariant(observation.workerVersion === targetVersion, `원시 HTTP ${observation.method} 리디렉션 Worker version ID가 활성 버전과 다릅니다: ${observation.workerVersion}`);
  }
}

function formatHttpRedirectObservations(observations) {
  return JSON.stringify(observations.map(({ attempt, method, status, location, workerTag, workerVersion, error }) => ({
    attempt,
    method,
    status,
    location,
    workerTag,
    workerVersion,
    error,
  })));
}

export async function verifyHttpEntryRedirect({
  baseUrl,
  expectedTag,
  expectedVersion,
  fetchImpl = globalThis.fetch,
  timeoutMs = HTTP_TIMEOUT_MS,
}) {
  const targetTag = expectedWorkerTag(expectedTag);
  const targetVersion = expectedWorkerVersion(expectedVersion);
  const result = await observeHttpEntryRedirect({ baseUrl, fetchImpl, timeoutMs });
  try {
    assertHttpEntryRedirect({ ...result, targetTag, targetVersion });
  } catch (error) {
    throw new Error(`${error.message}; observations=${formatHttpRedirectObservations(result.observations)}`, { cause: error });
  }
  return result;
}

export async function waitForHttpEntryRedirect({
  baseUrl,
  expectedTag,
  expectedVersion,
  fetchImpl = globalThis.fetch,
  logger = console,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  attempts = VERSION_CONVERGENCE_ATTEMPTS,
  intervalMs = VERSION_CONVERGENCE_INTERVAL_MS,
  timeoutMs = HTTP_TIMEOUT_MS,
}) {
  const targetTag = expectedWorkerTag(expectedTag);
  const targetVersion = expectedWorkerVersion(expectedVersion);
  invariant(Number.isInteger(attempts) && attempts > 0, "HTTP 리디렉션 probe 횟수가 올바르지 않습니다.");
  const observations = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let result;
    try {
      result = await observeHttpEntryRedirect({ baseUrl, fetchImpl, timeoutMs, attempt });
    } catch (error) {
      observations.push(...(error.httpRedirectObservations || []));
      throw new Error(`${error.message}; allObservations=${formatHttpRedirectObservations(observations)}`, { cause: error });
    }
    observations.push(...result.observations);
    for (const observation of result.observations) {
      if (observation.workerTag !== targetTag || observation.workerVersion !== targetVersion) continue;
      try {
        assertHttpEntryRedirectBehavior({ observations: [observation], httpsUrl: result.httpsUrl });
      } catch (error) {
        throw new Error(`${error.message}; observations=${formatHttpRedirectObservations(observations)}`, { cause: error });
      }
    }
    const identityMatches = result.observations.every((observation) => (
      observation.workerTag === targetTag && observation.workerVersion === targetVersion
    ));
    if (identityMatches) {
      try {
        assertHttpEntryRedirect({ ...result, targetTag, targetVersion });
      } catch (error) {
        throw new Error(`${error.message}; observations=${formatHttpRedirectObservations(observations)}`, { cause: error });
      }
      return { ...result, observations };
    }
    if (attempt < attempts) {
      logger.info(`[production-render-canary] raw HTTP Worker identity 재수렴 대기: attempt=${attempt}`);
      await sleep(intervalMs);
    }
  }
  throw new Error(`원시 HTTP edge가 배포 Worker tag=${targetTag}, version=${targetVersion}로 수렴하지 않았습니다. observations=${formatHttpRedirectObservations(observations)}`);
}

export function createRenderScenarioConfigs(httpEntry) {
  invariant(httpEntry && typeof httpEntry.httpUrl === "string" && typeof httpEntry.httpsUrl === "string", "HTTP 진입 render 시나리오에 검증된 URL이 필요합니다.");
  const httpUrl = new URL(httpEntry.httpUrl);
  const httpsUrl = new URL(httpEntry.httpsUrl);
  invariant(httpUrl.protocol === "http:" && httpsUrl.protocol === "https:", "HTTP 진입 render 시나리오 URL의 프로토콜이 올바르지 않습니다.");
  invariant(
    httpUrl.hostname === httpsUrl.hostname
      && httpUrl.port === httpsUrl.port
      && httpUrl.pathname === httpsUrl.pathname
      && httpUrl.search === httpsUrl.search,
    "HTTP 진입 render 시나리오 URL이 HTTPS 대상과 다릅니다.",
  );
  return [
    { name: "http-entry", entryUrl: httpUrl.href },
    { name: "warm-cache", warm: true },
    { name: "cold-400ms", latencyMs: 400 },
  ];
}

function expectedHeroPaths(document, baseUrl) {
  const hero = document?.photos?.pastel?.hero;
  invariant(typeof hero?.src === "string" && hero.src, "공개 콘텐츠에 Pastel hero src가 없습니다.");
  const paths = new Set([pathname(hero.src, baseUrl)]);
  if (typeof hero.srcSet === "string") {
    for (const candidate of hero.srcSet.split(",")) {
      const source = candidate.trim().split(/\s+/u)[0];
      if (source) paths.add(pathname(source, baseUrl));
    }
  }
  return [...paths];
}

export function validateRenderEvidence({
  baseUrl,
  expectedWorkerTag: targetWorkerTag,
  expectedWorkerVersion: targetWorkerVersion,
  expectedRevision,
  expectedPaths,
  responseHeaders,
  dom,
  observations,
  requests,
  consoleErrors,
  pageErrors,
}) {
  invariant(responseHeaders.status === 200, `HTML document 응답이 HTTP ${responseHeaders.status}입니다.`);
  invariant(responseHeaders.workerTag === targetWorkerTag, `HTML Worker tag가 배포 SHA와 다릅니다: ${responseHeaders.workerTag || "missing"}`);
  invariant(responseHeaders.workerVersion === targetWorkerVersion, `HTML Worker version ID가 활성 버전과 다릅니다: ${responseHeaders.workerVersion || "missing"}`);
  invariant(responseHeaders.source === "cloudflare-published", `HTML bootstrap source가 published가 아닙니다: ${responseHeaders.source || "missing"}`);
  invariant(responseHeaders.revision === expectedRevision, "HTML bootstrap revision 헤더가 /api/content와 다릅니다.");
  invariant(dom.source === "cloudflare-published", `렌더링 source가 published가 아닙니다: ${dom.source || "missing"}`);
  invariant(dom.revision === expectedRevision, "렌더링 revision이 /api/content와 다릅니다.");
  invariant(dom.ready === true && dom.naturalWidth > 0, "Pastel hero가 decode 완료 상태로 표시되지 않았습니다.");

  const visibilitySamples = [
    ...observations,
    {
      src: dom.src,
      currentSrc: dom.currentSrc,
      opacity: dom.opacity,
      ready: dom.ready,
      sample: "final-dom",
    },
  ];
  const observedPaths = visibilitySamples
    .flatMap((entry) => [entry.src, entry.currentSrc])
    .filter(Boolean)
    .map((value) => pathname(value, baseUrl));
  const requestPaths = requests.map((value) => pathname(value, baseUrl));
  invariant(!observedPaths.some((value) => BUNDLED_PASTEL_HERO.test(value)), "published 세션에서 bundled hero가 DOM에 관찰되었습니다.");
  invariant(!requestPaths.some((value) => BUNDLED_PASTEL_HERO.test(value)), "published 세션에서 bundled hero가 네트워크로 요청되었습니다.");
  invariant(Number(dom.opacity) > 0, "최종 hero가 표시 상태가 아닙니다.");
  const firstVisible = visibilitySamples.find((entry) => Number(entry.opacity) > 0 && entry.ready);
  invariant(firstVisible, "표시 가능한 hero 증거가 없습니다.");
  invariant(expectedPaths.includes(pathname(firstVisible.currentSrc || firstVisible.src, baseUrl)), "표시된 hero가 현재 published 이미지가 아닙니다.");
  invariant(expectedPaths.includes(pathname(dom.currentSrc || dom.src, baseUrl)), "최종 hero가 현재 published 이미지가 아닙니다.");
  invariant(consoleErrors.length === 0, `브라우저 console 오류가 발생했습니다: ${consoleErrors.join(" | ")}`);
  invariant(pageErrors.length === 0, `브라우저 page 오류가 발생했습니다: ${pageErrors.join(" | ")}`);
  return true;
}

export function formatRenderDiagnostic({
  name,
  responseHeaders,
  dom,
  observations = [],
  requests = [],
  requestFailures = [],
  responseFailures = [],
  consoleErrors = [],
  pageErrors = [],
  intro = null,
  ribbonResponses = [],
}) {
  return JSON.stringify({
    scenario: name,
    response: responseHeaders || null,
    dom: dom || null,
    observations: observations.slice(-10),
    requests: requests.slice(-10),
    requestFailures: requestFailures.slice(-10),
    responseFailures: responseFailures.slice(-10),
    consoleErrors: consoleErrors.slice(-10),
    pageErrors: pageErrors.slice(-10),
    intro,
    ribbonResponses: ribbonResponses.slice(-10),
  });
}

export function validateRenderScenario({ name, ...renderEvidence }) {
  try {
    validateRenderEvidence(renderEvidence);
    if (renderEvidence.ribbonExpectation) validateRibbonPlaybackEvidence(renderEvidence);
    return true;
  } catch (error) {
    const diagnostic = formatRenderDiagnostic({ name, ...renderEvidence });
    throw new Error(`[${name}] ${error.message}; diagnostics=${diagnostic}`, { cause: error });
  }
}

async function expectedPublication(fetchImpl, baseUrl) {
  const response = await fetchImpl(new URL("/api/content", baseUrl), {
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  invariant(response.status === 200, `공개 콘텐츠 API 응답이 HTTP ${response.status}입니다.`);
  const payload = await response.json();
  invariant(typeof payload.revisionId === "string" && payload.revisionId, "공개 콘텐츠 revision이 없습니다.");
  return {
    revisionId: payload.revisionId,
    expectedPaths: expectedHeroPaths(payload.document, baseUrl),
  };
}

async function installHeroObserver(page) {
  await page.addInitScript(() => {
    window.__weddingHeroObservations = [];
    let last = "";
    const record = () => {
      const image = document.querySelector(".pastel-hero-photo img");
      if (!image) return;
      const button = image.closest(".photo-button");
      const entry = {
        src: image.getAttribute("src") || "",
        currentSrc: image.currentSrc || "",
        opacity: getComputedStyle(image).opacity,
        ready: button?.classList.contains("is-image-ready") === true,
      };
      const serialized = JSON.stringify(entry);
      if (serialized !== last) {
        last = serialized;
        window.__weddingHeroObservations.push(entry);
      }
    };
    const start = () => {
      new MutationObserver(() => requestAnimationFrame(record)).observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ["class", "src", "srcset", "style"],
      });
      record();
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  });
}

async function installIntroObserver(page) {
  await page.addInitScript(() => {
    const byteIndexes = new WeakMap();
    const packedBuffers = new WeakSet();
    let framePack;
    const packOffsets = new Map();
    const blobIndexes = new WeakMap();
    const bitmapIndexes = new WeakMap();
    const evidence = window.__weddingIntroEvidence = {
      draws: [], mounts: 0, mountedAt: null, panelsOpenedAt: null, removedAt: null,
      earlyPoster: { present: false, observedBeforeMain: false, sha256: "" },
      handoff: { claimedAt: null, firstCanvasDrawAt: null, lateMounts: 0 },
      panelSamples: [], progressiveHero: [],
      visibility: { hiddenPause: false, noProgressWhileHidden: false, resumed: false },
    };
    const digest = async (bytes) => {
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
    };
    const readPosterBytes = async (source) => {
      if (source.startsWith("data:")) {
        const match = /^data:image\/webp;base64,([A-Za-z0-9+/]*={0,2})$/u.exec(source);
        if (!match) throw new Error("Unsupported inline ribbon poster encoding.");
        // Embedded bytes are not a network connection under connect-src 'self'.
        return Uint8Array.from(atob(match[1]), (character) => character.charCodeAt(0));
      }
      const response = await fetch(source);
      return response.arrayBuffer();
    };
    const recordEarlyPoster = (image) => {
      if (!image || evidence.earlyPoster.present) return;
      evidence.earlyPoster = {
        present: true,
        observedBeforeMain: !document.querySelector(".pastel-intro-cover"),
        sha256: "",
      };
      void readPosterBytes(image.currentSrc || image.src).then(digest)
        .then((hash) => { evidence.earlyPoster.sha256 = hash; })
        .catch((error) => { evidence.earlyPoster.error = error.message; });
    };
    const recordPanelConfig = (response, payload) => {
      if (new URL(response.url, location.href).pathname !== "/assets/design/ribbon-sequence/manifest.json") return;
      framePack = payload?.framePack;
      packOffsets.clear();
      let offset = 0;
      framePack?.lengths?.forEach((length, index) => { packOffsets.set(offset, index); offset += length; });
      evidence.panelConfig = {
        schemaVersion: payload?.schemaVersion,
        panelCurve: payload?.panelCurve,
      };
    };
    const originalArrayBuffer = Response.prototype.arrayBuffer;
    const originalText = Response.prototype.text;
    const originalJson = Response.prototype.json;
    Response.prototype.arrayBuffer = async function (...args) {
      const bytes = await originalArrayBuffer.apply(this, args);
      const match = this.url.match(/\/ribbon-sequence\/frame-(\d+)-[^/]+\.webp$/u);
      if (match) byteIndexes.set(bytes, Number(match[1]));
      if (framePack && this.url.split("/").at(-1) === framePack.file) packedBuffers.add(bytes);
      return bytes;
    };
    Response.prototype.text = async function (...args) {
      const payload = await originalText.apply(this, args);
      try { recordPanelConfig(this, JSON.parse(payload)); } catch { /* manifest validation owns malformed JSON */ }
      return payload;
    };
    Response.prototype.json = async function (...args) {
      const payload = await originalJson.apply(this, args);
      recordPanelConfig(this, payload);
      return payload;
    };
    const OriginalBlob = window.Blob;
    window.Blob = class extends OriginalBlob {
      constructor(parts, options) {
        super(parts, options);
        if (parts?.[0] && byteIndexes.has(parts[0])) blobIndexes.set(this, byteIndexes.get(parts[0]));
        const first = parts?.[0];
        if (ArrayBuffer.isView(first) && packedBuffers.has(first.buffer) && packOffsets.has(first.byteOffset)) blobIndexes.set(this, packOffsets.get(first.byteOffset));
      }
    };
    const originalCreateImageBitmap = window.createImageBitmap.bind(window);
    window.createImageBitmap = async (blob, ...args) => {
      const bitmap = await originalCreateImageBitmap(blob, ...args);
      if (blobIndexes.has(blob)) bitmapIndexes.set(bitmap, blobIndexes.get(blob));
      return bitmap;
    };
    const originalDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
      const result = originalDrawImage.call(this, source, ...args);
      // The full-size center draw completes the frame after its two edge slices.
      if (args.length === 4 && this.canvas.matches(".pastel-intro-cover__ribbon")) {
        const index = bitmapIndexes.get(source);
        let alphaPixels = null;
        if (index !== undefined) {
          const pixels = this.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
          alphaPixels = 0;
          for (let offset = 3; offset < pixels.length; offset += 4) if (pixels[offset]) alphaPixels += 1;
        }
        const draw = { index, at: performance.now(), alphaPixels };
        evidence.draws.push(draw);
        if (index === 0 && evidence.handoff.firstCanvasDrawAt === null) evidence.handoff.firstCanvasDrawAt = draw.at;
        if (index !== undefined && index >= 0) {
          let alphaTop = null;
          if (alphaPixels > 0) {
            const pixels = this.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
            for (let offset = 3; offset < pixels.length; offset += 4) {
              if (pixels[offset]) { alphaTop = Math.floor((offset - 3) / 4 / this.canvas.width); break; }
            }
          }
          queueMicrotask(() => {
            const rect = this.canvas.getBoundingClientRect();
            draw.alphaViewportTop = alphaTop === null ? null : rect.top + alphaTop * rect.height / this.canvas.height;
            draw.viewportHeight = innerHeight;
          });
        }
      }
      return result;
    };
    let mountedCover;
    let previousPanelSample = "";
    const recordPanelAndHero = (cover) => {
      if (!cover) return;
      const style = getComputedStyle(cover);
      const left = cover.querySelector(".pastel-intro-cover__panel--left");
      const right = cover.querySelector(".pastel-intro-cover__panel--right");
      const leftRect = left?.getBoundingClientRect();
      const rightRect = right?.getBoundingClientRect();
      const leftProgress = Number(style.getPropertyValue("--pastel-intro-left-progress").trim());
      const rightProgress = Number(style.getPropertyValue("--pastel-intro-right-progress").trim());
      const panelSample = {
        at: performance.now(), leftProgress, rightProgress,
        leftTransform: left ? getComputedStyle(left).transform : "none",
        rightTransform: right ? getComputedStyle(right).transform : "none",
        viewportWidth: innerWidth,
        leftWidth: left?.offsetWidth ?? null,
        rightWidth: right?.offsetWidth ?? null,
        leftOuterEdge: leftRect?.left ?? null,
        rightOuterEdge: rightRect?.right ?? null,
        leftInnerEdge: leftRect?.right ?? null,
        rightInnerEdge: rightRect?.left ?? null,
      };
      const serialized = JSON.stringify(panelSample);
      if (serialized !== previousPanelSample) {
        previousPanelSample = serialized;
        evidence.panelSamples.push(panelSample);
      }
      if (leftProgress > 0 && leftProgress < 1 && rightProgress > 0 && rightProgress < 1) {
        if (evidence.panelsOpenedAt === null) evidence.panelsOpenedAt = performance.now();
        const hero = document.querySelector(".pastel-hero-photo img");
        const background = style.backgroundColor;
        evidence.progressiveHero.push({
          at: performance.now(), coverPresent: true,
          rootTransparent: background === "transparent" || background === "rgba(0, 0, 0, 0)",
          opacity: hero ? getComputedStyle(hero).opacity : "0",
        });
      }
    };
    const observe = () => {
      const earlyPoster = document.querySelector("#pastel-intro-early-poster img");
      recordEarlyPoster(earlyPoster);
      const earlyCover = document.querySelector("#pastel-intro-early-poster");
      if (earlyCover?.dataset.handoff === "claimed" && evidence.handoff.claimedAt === null) evidence.handoff.claimedAt = performance.now();
      const cover = document.querySelector(".pastel-intro-cover");
      if (cover && cover !== mountedCover) {
        if (evidence.handoff.firstCanvasDrawAt !== null) evidence.handoff.lateMounts += 1;
        mountedCover = cover;
        evidence.mounts += 1;
        evidence.mountedAt = performance.now();
      }
      if (mountedCover && !cover && evidence.removedAt === null) evidence.removedAt = performance.now();
      if (cover?.classList.contains("pastel-intro-cover--opening-panels") && evidence.panelsOpenedAt === null) {
        evidence.panelsOpenedAt = performance.now();
      }
      recordPanelAndHero(cover);
    };
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) evidence.visibility.hiddenPause = true;
      else if (evidence.visibility.hiddenPause) evidence.visibility.resumed = true;
    });
    new MutationObserver(observe).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "data-handoff"] });
    document.addEventListener("load", observe, true);
    observe();
  });
}

function recordRibbonResponse(response, records, tasks, isCurrent = () => true) {
  let responsePath = "";
  try {
    responsePath = new URL(response.url()).pathname;
  } catch {
    return;
  }
  const sequenceDirectory = RIBBON_MANIFEST_PATH.slice(0, -"manifest.json".length);
  const isFramePack = responsePath.startsWith(sequenceDirectory)
    && /^sequence-[a-f0-9]{12}\.bin$/u.test(responsePath.slice(sequenceDirectory.length));
  if (responsePath !== RIBBON_MANIFEST_PATH && !responsePath.startsWith(`${sequenceDirectory}frame-`) && !isFramePack) return;
  tasks.push((async () => {
    try {
      const bytes = await response.body();
      if (!isCurrent()) return;
      records.push({
        url: response.url(),
        status: response.status(),
        contentType: response.headers()["content-type"] || "",
        sha256: sha256(bytes),
      });
    } catch (error) {
      if (!isCurrent()) return;
      records.push({ url: response.url(), status: response.status(), contentType: response.headers()["content-type"] || "", sha256: "", error: error.message });
    }
  })());
}

async function readRenderState(page) {
  return page.evaluate(() => {
    const root = document.querySelector("main[data-content-source]");
    const image = document.querySelector(".pastel-hero-photo img");
    const coverPresent = Boolean(document.querySelector(".pastel-intro-cover"));
    const heroStyle = image ? getComputedStyle(image) : null;
    return {
      dom: {
        source: root?.dataset.contentSource || "",
        revision: root?.dataset.contentRevision || "",
        src: image?.getAttribute("src") || "",
        currentSrc: image?.currentSrc || "",
        naturalWidth: image?.naturalWidth || 0,
        opacity: image ? getComputedStyle(image).opacity : "",
        ready: image?.closest(".photo-button")?.classList.contains("is-image-ready") === true,
      },
      observations: window.__weddingHeroObservations || [],
      intro: {
        ...(window.__weddingIntroEvidence || {}),
        coverPresent,
        bodyLocked: document.body.classList.contains("intro-lock"),
        finalHero: {
          sampledAfterCoverRemoved: !coverPresent,
          opacity: heroStyle?.opacity || "",
          display: heroStyle?.display || "",
          visibility: heroStyle?.visibility || "",
        },
      },
    };
  });
}

async function tapReadyRibbon(page) {
  const button = page.locator(".pastel-intro-cover__start");
  await button.waitFor({ timeout: RENDER_TIMEOUT_MS });
  const frameCount = await page.evaluate(() => window.__weddingIntroEvidence?.draws?.length);
  invariant(frameCount === 1, `방문자 탭 전에 리본이 움직였습니다: ${frameCount ?? "missing"}`);
  await button.click({ position: { x: 10, y: 10 } });
}

export async function collectScenario({
  name,
  browser,
  baseUrl,
  expectedWorkerTag: targetWorkerTag,
  expectedWorkerVersion: targetWorkerVersion,
  entryUrl,
  latencyMs = 0,
  warm = false,
  ribbonExpectation,
}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  if (latencyMs > 0) {
    await context.route("**/*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      await route.continue();
    });
  }
  const page = await context.newPage();
  const requests = [];
  const requestFailures = [];
  const responseFailures = [];
  const consoleErrors = [];
  const pageErrors = [];
  const ribbonResponses = [];
  const ribbonResponseTasks = [];
  const requestEpochs = new WeakMap();
  let ribbonResponseEpoch = 0;
  page.on("request", (request) => {
    requests.push(request.url());
    requestEpochs.set(request, ribbonResponseEpoch);
  });
  page.on("requestfailed", (request) => requestFailures.push(`${request.failure()?.errorText || "unknown"} ${request.url()}`));
  page.on("response", (response) => {
    if (response.status() >= 400) responseFailures.push(`${response.status()} ${response.url()}`);
    const responseEpoch = requestEpochs.get(response.request()) ?? ribbonResponseEpoch;
    recordRibbonResponse(response, ribbonResponses, ribbonResponseTasks, () => responseEpoch === ribbonResponseEpoch);
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installHeroObserver(page);
  await installIntroObserver(page);

  let response;
  let evidence = { dom: null, observations: [] };
  let responseHeaders = null;
  try {
    response = await page.goto(entryUrl || baseUrl.href, { waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS });
    if (entryUrl) {
      const redirectRequest = response?.request().redirectedFrom();
      invariant(redirectRequest?.url() === entryUrl, "HTTP 진입 브라우저 탐색에서 원시 HTTP 요청을 관찰하지 못했습니다.");
      const redirectResponse = await redirectRequest.response();
      invariant(redirectResponse?.status() === 308, `HTTP 진입 브라우저 탐색의 서버 리디렉션이 HTTP ${redirectResponse?.status() || "missing"}입니다.`);
    }
    invariant(page.url() === baseUrl.href, `공개 초대장 최종 URL이 HTTPS 기준 URL과 다릅니다: ${page.url()}`);
    if (warm) {
      if (ribbonExpectation) {
        await tapReadyRibbon(page);
        // Warm-cache must first finish the same published cover that a visitor
        // sees. Reloading at DOMContentLoaded aborts its frame fetches and
        // would turn this scenario into another cold request set.
        await page.waitForFunction((frameCount) => {
          const intro = window.__weddingIntroEvidence;
          return intro?.draws?.length === frameCount && intro.removedAt !== null
            && !document.querySelector(".pastel-intro-cover") && !document.body.classList.contains("intro-lock");
        }, ribbonExpectation.frames.length, { timeout: RENDER_TIMEOUT_MS });
        await Promise.allSettled(ribbonResponseTasks);
      }
      requests.length = 0;
      requestFailures.length = 0;
      responseFailures.length = 0;
      consoleErrors.length = 0;
      pageErrors.length = 0;
      // A warm scenario is judged only from its reload.  A response body that
      // completes after this reset belongs to the initial navigation too.
      ribbonResponseEpoch += 1;
      ribbonResponses.length = 0;
      ribbonResponseTasks.length = 0;
      response = await page.reload({ waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS });
    }
    invariant(response, "공개 초대장 document 응답을 받지 못했습니다.");
    const headers = response.headers();
    responseHeaders = {
      status: response.status(),
      source: headers["x-wedding-content-source"] || "",
      revision: headers["x-wedding-revision"] || "",
      workerTag: headers["x-wedding-worker-tag"] || "",
      workerVersion: headers["x-wedding-worker-version"] || "",
    };
    invariant(responseHeaders.status === 200, `HTML document 응답이 HTTP ${responseHeaders.status}입니다.`);
    if (responseHeaders.workerTag !== targetWorkerTag) {
      throw new WorkerIdentityMismatchError(`HTML Worker tag가 배포 SHA와 다릅니다: ${responseHeaders.workerTag || "missing"}`);
    }
    if (responseHeaders.workerVersion !== targetWorkerVersion) {
      throw new WorkerIdentityMismatchError(`HTML Worker version ID가 활성 버전과 다릅니다: ${responseHeaders.workerVersion || "missing"}`);
    }
    await page.waitForFunction(() => {
      const root = document.querySelector("main[data-content-source='cloudflare-published']");
      const image = document.querySelector(".pastel-hero-photo.is-image-ready img");
      return Boolean(root && image?.complete && image.naturalWidth > 0);
    }, null, { timeout: RENDER_TIMEOUT_MS });
    if (ribbonExpectation) {
      await tapReadyRibbon(page);
      await page.waitForFunction((frameCount) => {
        const intro = window.__weddingIntroEvidence;
        return intro?.draws?.length >= Math.min(3, frameCount - 2) && intro.draws.length < frameCount - 1;
      }, ribbonExpectation.frames.length, { timeout: RENDER_TIMEOUT_MS });
      const hiddenState = await page.evaluate(() => {
        const intro = window.__weddingIntroEvidence;
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        return { draws: intro.draws.length, panelsOpenedAt: intro.panelsOpenedAt };
      });
      await page.waitForTimeout(250);
      await page.evaluate((before) => {
        const intro = window.__weddingIntroEvidence;
        intro.visibility.noProgressWhileHidden = intro.draws.length === before.draws && intro.panelsOpenedAt === before.panelsOpenedAt;
        delete document.hidden;
        delete document.visibilityState;
        document.dispatchEvent(new Event("visibilitychange"));
      }, hiddenState);
    }
    if (ribbonExpectation) {
      await page.waitForFunction((frameCount) => {
        const intro = window.__weddingIntroEvidence;
        return intro?.draws?.length === frameCount && intro.removedAt !== null
          && !document.querySelector(".pastel-intro-cover") && !document.body.classList.contains("intro-lock");
      }, ribbonExpectation.frames.length, { timeout: RENDER_TIMEOUT_MS });
      await page.waitForTimeout(0);
    } else await page.waitForTimeout(250);
    await Promise.allSettled(ribbonResponseTasks);
    evidence = await readRenderState(page);
    return {
      responseHeaders,
      ...evidence,
      requests,
      requestFailures,
      responseFailures,
      consoleErrors,
      pageErrors,
      ribbonResponses,
    };
  } catch (error) {
    await Promise.allSettled(ribbonResponseTasks);
    try {
      evidence = await readRenderState(page);
    } catch {
      evidence = { dom: null, observations: [] };
    }
    const diagnostic = formatRenderDiagnostic({
      name,
      responseHeaders,
      ...evidence,
      requestFailures,
      responseFailures,
      consoleErrors,
      pageErrors,
      ribbonResponses,
    });
    const WrappedError = error?.code === "WORKER_IDENTITY_MISMATCH" ? WorkerIdentityMismatchError : Error;
    throw new WrappedError(`[${name}] ${error.message}; diagnostics=${diagnostic}`, { cause: error });
  } finally {
    await context.close();
  }
}

export async function collectScenarioWithVersionConvergence({
  scenario,
  browser,
  baseUrl,
  expectedWorkerTag: targetWorkerTag,
  expectedWorkerVersion: targetWorkerVersion,
  fetchImpl = globalThis.fetch,
  logger = console,
  collectScenarioImpl = collectScenario,
  waitForWorkerVersionImpl = waitForWorkerVersion,
  attempts = SCENARIO_CONVERGENCE_ATTEMPTS,
}) {
  invariant(Number.isInteger(attempts) && attempts > 0, "렌더 시나리오 수렴 재시도 횟수가 올바르지 않습니다.");
  const identityFailures = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await collectScenarioImpl({
        ...scenario,
        browser,
        baseUrl,
        expectedWorkerTag: targetWorkerTag,
        expectedWorkerVersion: targetWorkerVersion,
      });
    } catch (error) {
      const identityMismatch = error?.code === "WORKER_IDENTITY_MISMATCH";
      if (!identityMismatch) throw error;
      identityFailures.push({ attempt, error: error.message });
      if (attempt >= attempts) {
        throw new Error(`[${scenario.name}] 브라우저 문서가 배포 Worker로 수렴하지 않았습니다. identityFailures=${JSON.stringify(identityFailures)}`, { cause: error });
      }
      logger.info(`[production-render-canary] ${scenario.name} 문서가 이전 Worker를 관찰해 재수렴합니다: attempt=${attempt}`);
      try {
        await waitForWorkerVersionImpl({
          baseUrl,
          expectedTag: targetWorkerTag,
          expectedVersion: targetWorkerVersion,
          fetchImpl,
          logger,
        });
      } catch (probeError) {
        throw new Error(`[${scenario.name}] Worker 재수렴 probe가 실패했습니다. identityFailures=${JSON.stringify(identityFailures)}; probeError=${probeError.message}`, { cause: probeError });
      }
    }
  }
  throw new Error(`[${scenario.name}] 렌더 시나리오 수렴 상태가 올바르지 않습니다.`);
}

export async function runPostDeployRenderCanary({
  baseUrl = process.env.WEDDING_CANARY_BASE_URL || DEFAULT_BASE_URL,
  expectedTag = process.env.WEDDING_CANARY_EXPECTED_WORKER_TAG,
  expectedVersion = process.env.WEDDING_CANARY_EXPECTED_WORKER_VERSION,
  browserType = chromium,
  fetchImpl = globalThis.fetch,
  logger = console,
  readActiveIdentity = activeDeploymentIdentity,
  ribbonExpectation,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const {
    workerTag: targetWorkerTag,
    workerVersion: targetWorkerVersion,
  } = await resolveExpectedWorkerIdentity({ expectedTag, expectedVersion, readActiveIdentity });
  const convergence = await waitForWorkerVersion({
    baseUrl: normalizedBaseUrl,
    expectedTag: targetWorkerTag,
    expectedVersion: targetWorkerVersion,
    fetchImpl,
    logger,
  });
  const redirectProbe = await waitForHttpEntryRedirect({
    baseUrl: createHttpRedirectProbeUrl(normalizedBaseUrl),
    expectedTag: targetWorkerTag,
    expectedVersion: targetWorkerVersion,
    fetchImpl,
    logger,
  });
  logger.info(`[production-render-canary] raw HTTP redirect 통과: GET=308 HEAD=308 tag=${targetWorkerTag} version=${targetWorkerVersion}`);
  const httpEntry = createVerifiedHttpEntry(normalizedBaseUrl, redirectProbe);
  const expected = await expectedPublication(fetchImpl, normalizedBaseUrl);
  const browser = await browserType.launch({ headless: true, args: HTTP_ENTRY_CHROMIUM_ARGS });
  try {
    const scenarioConfigs = createRenderScenarioConfigs(httpEntry);
    const scenarios = [];
    for (const config of scenarioConfigs) {
      const evidence = await collectScenarioWithVersionConvergence({
        scenario: { ...config, ribbonExpectation },
        browser,
        baseUrl: normalizedBaseUrl,
        expectedWorkerTag: targetWorkerTag,
        expectedWorkerVersion: targetWorkerVersion,
        fetchImpl,
        logger,
      });
      validateRenderScenario({
        name: config.name,
        baseUrl: normalizedBaseUrl,
        expectedWorkerTag: targetWorkerTag,
        expectedWorkerVersion: targetWorkerVersion,
        expectedRevision: expected.revisionId,
        expectedPaths: expected.expectedPaths,
        ribbonExpectation,
        ...evidence,
      });
      scenarios.push(config.name);
      logger.info(`[production-render-canary] ${config.name} 통과: revision=${expected.revisionId} version=${evidence.responseHeaders.workerVersion}`);
    }
    return {
      revisionId: expected.revisionId,
      workerTag: targetWorkerTag,
      workerVersion: convergence.workerVersion,
      httpEntry,
      scenarios,
    };
  } finally {
    await browser.close();
  }
}

async function readBuiltRibbonExpectation() {
  const { readFile } = await import("node:fs/promises");
  const directory = new URL("../dist/client/assets/design/ribbon-sequence/", import.meta.url);
  const manifestBytes = await readFile(new URL("manifest.json", directory));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const frameHashes = Object.fromEntries(await Promise.all(manifest.frames.map(async (frame) => [
    frame,
    sha256(await readFile(new URL(frame, directory))),
  ])));
  const packHash = manifest.framePack ? sha256(await readFile(new URL(manifest.framePack.file, directory))) : undefined;
  return createRibbonExpectation(manifest, { manifestHash: sha256(manifestBytes), frameHashes, packHash });
}

const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  readBuiltRibbonExpectation().then((ribbonExpectation) => runPostDeployRenderCanary({ ribbonExpectation })).catch((error) => {
    console.error(`[production-render-canary] 실패: ${error.message}`);
    process.exitCode = 1;
  });
}
