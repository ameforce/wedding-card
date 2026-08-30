import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const DEFAULT_BASE_URL = "https://wdcard.enmsoftware.com/";
const HTTP_TIMEOUT_MS = 20_000;
const RENDER_TIMEOUT_MS = 30_000;
const BUNDLED_PASTEL_HERO = /^\/assets\/photos\/pastel-hero-(?:480|960)\.webp$/u;

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
  expectedRevision,
  expectedPaths,
  responseHeaders,
  dom,
  observations,
  requests,
  consoleErrors,
  pageErrors,
}) {
  invariant(responseHeaders.source === "cloudflare-published", `HTML bootstrap source가 published가 아닙니다: ${responseHeaders.source || "missing"}`);
  invariant(responseHeaders.revision === expectedRevision, "HTML bootstrap revision 헤더가 /api/content와 다릅니다.");
  invariant(dom.source === "cloudflare-published", `렌더링 source가 published가 아닙니다: ${dom.source || "missing"}`);
  invariant(dom.revision === expectedRevision, "렌더링 revision이 /api/content와 다릅니다.");
  invariant(dom.ready === true && dom.naturalWidth > 0, "Pastel hero가 decode 완료 상태로 표시되지 않았습니다.");

  const observedPaths = observations
    .flatMap((entry) => [entry.src, entry.currentSrc])
    .filter(Boolean)
    .map((value) => pathname(value, baseUrl));
  const requestPaths = requests.map((value) => pathname(value, baseUrl));
  invariant(!observedPaths.some((value) => BUNDLED_PASTEL_HERO.test(value)), "published 세션에서 bundled hero가 DOM에 관찰되었습니다.");
  invariant(!requestPaths.some((value) => BUNDLED_PASTEL_HERO.test(value)), "published 세션에서 bundled hero가 네트워크로 요청되었습니다.");
  const firstVisible = observations.find((entry) => Number(entry.opacity) > 0 && entry.ready);
  invariant(firstVisible, "최초로 표시된 hero 관찰값이 없습니다.");
  invariant(expectedPaths.includes(pathname(firstVisible.currentSrc || firstVisible.src, baseUrl)), "최초로 표시된 hero가 현재 published 이미지가 아닙니다.");
  invariant(expectedPaths.includes(pathname(dom.currentSrc || dom.src, baseUrl)), "최종 hero가 현재 published 이미지가 아닙니다.");
  invariant(consoleErrors.length === 0, `브라우저 console 오류가 발생했습니다: ${consoleErrors.join(" | ")}`);
  invariant(pageErrors.length === 0, `브라우저 page 오류가 발생했습니다: ${pageErrors.join(" | ")}`);
  return true;
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

async function collectScenario({ browser, baseUrl, latencyMs = 0, warm = false }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  if (latencyMs > 0) {
    await context.route("**/*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
      await route.continue();
    });
  }
  const page = await context.newPage();
  const requests = [];
  const consoleErrors = [];
  const pageErrors = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installHeroObserver(page);

  let response = await page.goto(baseUrl.href, { waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS });
  if (warm) {
    requests.length = 0;
    consoleErrors.length = 0;
    pageErrors.length = 0;
    response = await page.reload({ waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS });
  }
  invariant(response, "공개 초대장 document 응답을 받지 못했습니다.");
  await page.waitForFunction(() => {
    const root = document.querySelector("main[data-content-source='cloudflare-published']");
    const image = document.querySelector(".pastel-hero-photo.is-image-ready img");
    return Boolean(root && image?.complete && image.naturalWidth > 0);
  }, null, { timeout: RENDER_TIMEOUT_MS });
  await page.waitForTimeout(250);
  const evidence = await page.evaluate(() => {
    const root = document.querySelector("main[data-content-source]");
    const image = document.querySelector(".pastel-hero-photo img");
    return {
      dom: {
        source: root?.dataset.contentSource || "",
        revision: root?.dataset.contentRevision || "",
        src: image?.getAttribute("src") || "",
        currentSrc: image?.currentSrc || "",
        naturalWidth: image?.naturalWidth || 0,
        ready: image?.closest(".photo-button")?.classList.contains("is-image-ready") === true,
      },
      observations: window.__weddingHeroObservations || [],
    };
  });
  const result = {
    responseHeaders: {
      source: response.headers()["x-wedding-content-source"] || "",
      revision: response.headers()["x-wedding-revision"] || "",
    },
    ...evidence,
    requests,
    consoleErrors,
    pageErrors,
  };
  await context.close();
  return result;
}

export async function runPostDeployRenderCanary({
  baseUrl = process.env.WEDDING_CANARY_BASE_URL || DEFAULT_BASE_URL,
  browserType = chromium,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const expected = await expectedPublication(fetchImpl, normalizedBaseUrl);
  const browser = await browserType.launch({ headless: true });
  try {
    const scenarios = [
      ["warm-cache", await collectScenario({ browser, baseUrl: normalizedBaseUrl, warm: true })],
      ["cold-400ms", await collectScenario({ browser, baseUrl: normalizedBaseUrl, latencyMs: 400 })],
    ];
    for (const [name, evidence] of scenarios) {
      validateRenderEvidence({
        baseUrl: normalizedBaseUrl,
        expectedRevision: expected.revisionId,
        expectedPaths: expected.expectedPaths,
        ...evidence,
      });
      logger.info(`[production-render-canary] ${name} 통과: revision=${expected.revisionId}`);
    }
    return { revisionId: expected.revisionId, scenarios: scenarios.map(([name]) => name) };
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
