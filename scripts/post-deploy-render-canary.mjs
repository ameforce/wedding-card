import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { activeDeploymentIdentity } from "./cloudflare-deployment-state.mjs";

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
  });
}

export function validateRenderScenario({ name, ...renderEvidence }) {
  try {
    return validateRenderEvidence(renderEvidence);
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

async function readRenderState(page) {
  return page.evaluate(() => {
    const root = document.querySelector("main[data-content-source]");
    const image = document.querySelector(".pastel-hero-photo img");
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
    };
  });
}

async function collectScenario({
  name,
  browser,
  baseUrl,
  expectedWorkerTag: targetWorkerTag,
  expectedWorkerVersion: targetWorkerVersion,
  latencyMs = 0,
  warm = false,
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
  page.on("request", (request) => requests.push(request.url()));
  page.on("requestfailed", (request) => requestFailures.push(`${request.failure()?.errorText || "unknown"} ${request.url()}`));
  page.on("response", (response) => {
    if (response.status() >= 400) responseFailures.push(`${response.status()} ${response.url()}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installHeroObserver(page);

  let response;
  let evidence = { dom: null, observations: [] };
  let responseHeaders = null;
  try {
    response = await page.goto(baseUrl.href, { waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS });
    if (warm) {
      requests.length = 0;
      requestFailures.length = 0;
      responseFailures.length = 0;
      consoleErrors.length = 0;
      pageErrors.length = 0;
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
    await page.waitForTimeout(250);
    evidence = await readRenderState(page);
    return {
      responseHeaders,
      ...evidence,
      requests,
      requestFailures,
      responseFailures,
      consoleErrors,
      pageErrors,
    };
  } catch (error) {
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
  const expected = await expectedPublication(fetchImpl, normalizedBaseUrl);
  const browser = await browserType.launch({ headless: true });
  try {
    const scenarioConfigs = [
      { name: "warm-cache", warm: true },
      { name: "cold-400ms", latencyMs: 400 },
    ];
    const scenarios = [];
    for (const config of scenarioConfigs) {
      const evidence = await collectScenarioWithVersionConvergence({
        scenario: config,
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
        ...evidence,
      });
      scenarios.push(config.name);
      logger.info(`[production-render-canary] ${config.name} 통과: revision=${expected.revisionId} version=${evidence.responseHeaders.workerVersion}`);
    }
    return {
      revisionId: expected.revisionId,
      workerTag: targetWorkerTag,
      workerVersion: convergence.workerVersion,
      scenarios,
    };
  } finally {
    await browser.close();
  }
}

const isCli = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isCli) {
  runPostDeployRenderCanary().catch((error) => {
    console.error(`[production-render-canary] 실패: ${error.message}`);
    process.exitCode = 1;
  });
}
