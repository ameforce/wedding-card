import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const DEFAULT_BASE_URL = "https://wdcard.enmsoftware.com/";
const DEFAULT_DATABASE = "wedding-card-guestbook-db";
const CANARY_NAME_PREFIX = "QA-canary-";
const CANARY_MESSAGE_PREFIX = "[자동 배포 검증]";
const HTTP_TIMEOUT_MS = 20_000;
const WRANGLER_TIMEOUT_MS = 60_000;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeBaseUrl(value) {
  const url = new URL(value || DEFAULT_BASE_URL);
  invariant(url.protocol === "https:", "운영 canary URL은 HTTPS여야 합니다.");
  invariant(url.username === "" && url.password === "", "운영 canary URL에 자격 증명을 넣을 수 없습니다.");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function makeCanaryIdentity({ idFactory = randomUUID, passwordFactory } = {}) {
  const token = String(idFactory()).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16);
  invariant(token.length >= 8, "canary 식별자는 영문 소문자와 숫자 8자 이상이어야 합니다.");
  const password = passwordFactory ? passwordFactory() : randomBytes(18).toString("base64url");
  invariant(typeof password === "string" && password.length >= 12 && password.length <= 72, "canary 비밀번호는 12~72자여야 합니다.");
  return {
    token,
    name: `${CANARY_NAME_PREFIX}${token}`,
    password,
    createdMessage: `${CANARY_MESSAGE_PREFIX} 생성 ${token}`,
    updatedMessage: `${CANARY_MESSAGE_PREFIX} 수정 ${token}`,
  };
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function strictUtf8(chunks, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    throw new Error(`${label}가 UTF-8이 아닙니다.`, { cause: error });
  }
}

async function spawnUtf8(executable, args, { cwd, env = process.env, timeoutMs = WRANGLER_TIMEOUT_MS } = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: { ...env, NO_COLOR: "1" },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Wrangler D1 명령이 ${timeoutMs}ms 안에 끝나지 않았습니다.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        const decodedStdout = strictUtf8(stdout, "Wrangler stdout");
        const decodedStderr = strictUtf8(stderr, "Wrangler stderr");
        if (code !== 0) {
          reject(new Error(`Wrangler D1 명령이 exit ${code}로 실패했습니다: ${decodedStderr.trim() || "상세 오류 없음"}`));
          return;
        }
        resolvePromise({ stdout: decodedStdout, stderr: decodedStderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function d1Rows(stdout) {
  const payload = JSON.parse(stdout);
  invariant(Array.isArray(payload) && payload.length > 0, "Wrangler D1 JSON 응답 형식이 올바르지 않습니다.");
  const failed = payload.find((item) => item?.success === false);
  invariant(!failed, "Wrangler D1 쿼리가 실패했습니다.");
  return Array.isArray(payload[0]?.results) ? payload[0].results : [];
}

export function createWranglerD1Client({
  cwd = resolve(fileURLToPath(new URL("..", import.meta.url))),
  database = DEFAULT_DATABASE,
  runner = spawnUtf8,
} = {}) {
  const wrangler = resolve(cwd, "node_modules", "wrangler", "bin", "wrangler.js");

  async function execute(command) {
    invariant(command.length <= 2_000, "D1 canary SQL이 허용 길이를 초과했습니다.");
    const { stdout } = await runner(process.execPath, [
      wrangler,
      "d1",
      "execute",
      database,
      "--remote",
      "--yes",
      "--json",
      "--command",
      command,
    ], { cwd });
    return d1Rows(stdout);
  }

  return {
    async findByName(name) {
      return await execute(
        `SELECT id, name, message, created_at, updated_at FROM guestbook_entries WHERE name = ${sqlLiteral(name)} LIMIT 2`,
      );
    },
    async deleteOwned(name, token) {
      await execute(
        `DELETE FROM guestbook_entries WHERE name = ${sqlLiteral(name)} AND instr(message, ${sqlLiteral(token)}) > 0`,
      );
    },
  };
}

async function expectJson(response, expectedStatus, label) {
  const payload = await response.json().catch(() => ({}));
  invariant(response.status === expectedStatus, `${label} 실패: HTTP ${response.status}, code=${payload.code || "UNKNOWN"}`);
  return payload;
}

function assertOwnedRows(rows, identity, expectedMessage) {
  invariant(rows.length === 1, `D1 canary 행은 정확히 1개여야 하지만 ${rows.length}개입니다.`);
  const [row] = rows;
  invariant(row.name === identity.name, "D1 canary 이름이 일치하지 않습니다.");
  invariant(row.message === expectedMessage, "D1 canary 메시지가 일치하지 않습니다.");
  invariant(row.message.includes(identity.token), "D1 canary 소유권 표식이 없습니다.");
}

async function verifyPublicInvitation(fetchImpl, baseUrl) {
  const response = await fetchImpl(baseUrl, {
    redirect: "error",
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  invariant(response.status === 200, `공개 초대장 응답이 HTTP ${response.status}입니다.`);
  const robots = response.headers.get("x-robots-tag") || "";
  invariant(/noindex/i.test(robots) && /nofollow/i.test(robots), "공개 초대장의 X-Robots-Tag가 검색 차단 계약을 충족하지 않습니다.");
  invariant((response.headers.get("x-content-type-options") || "").toLowerCase() === "nosniff", "공개 초대장의 nosniff 헤더가 없습니다.");
  const csp = response.headers.get("content-security-policy") || "";
  invariant(/frame-ancestors\s+'self'/i.test(csp), "공개 초대장의 frame-ancestors CSP가 없습니다.");
  invariant(response.headers.get("x-wedding-content-source") === "cloudflare-published", "공개 초대장 HTML이 published bootstrap을 사용하지 않습니다.");
  const htmlRevision = response.headers.get("x-wedding-revision") || "";
  invariant(htmlRevision, "공개 초대장 HTML의 revision 헤더가 없습니다.");
  const html = await response.text();
  invariant(html.includes("https://wdcard.enmsoftware.com/"), "공개 초대장 canonical URL을 확인하지 못했습니다.");
  invariant(html.includes('id="wedding-public-bootstrap"'), "공개 초대장 HTML bootstrap을 확인하지 못했습니다.");

  const contentResponse = await fetchImpl(new URL("/api/content", baseUrl), {
    redirect: "error",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  invariant(contentResponse.status === 200, `공개 콘텐츠 API 응답이 HTTP ${contentResponse.status}입니다.`);
  invariant(/noindex/i.test(contentResponse.headers.get("x-robots-tag") || ""), "공개 콘텐츠 API의 검색 차단 헤더가 없습니다.");
  const content = await contentResponse.json();
  invariant(content.revisionId === htmlRevision, "공개 초대장 HTML과 콘텐츠 API revision이 다릅니다.");
}

async function requestGuestbook(fetchImpl, baseUrl, path, method, payload, expectedStatus) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method,
    redirect: "error",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: baseUrl.origin,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return await expectJson(response, expectedStatus, `${method} ${path}`);
}

async function verifyAdminBoundary(fetchImpl, baseUrl, identity, accessToken) {
  const headers = { accept: "application/json" };
  if (accessToken) headers["cf-access-token"] = accessToken;
  const response = await fetchImpl(new URL("/api/guestbook/admin/entries", baseUrl), {
    redirect: "manual",
    headers,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });

  if (!accessToken) {
    invariant([302, 401, 403].includes(response.status), `비인증 관리자 API가 예상과 달리 HTTP ${response.status}를 반환했습니다.`);
    return "access-denied";
  }

  const payload = await expectJson(response, 200, "인증된 관리자 방명록 조회");
  const matching = Array.isArray(payload.entries)
    ? payload.entries.filter((entry) => entry.name === identity.name)
    : [];
  invariant(matching.length === 1, "관리자 방명록에서 canary 행을 정확히 1개 찾지 못했습니다.");
  invariant(matching[0].message === identity.updatedMessage, "관리자 방명록의 canary 메시지가 수정 결과와 다릅니다.");
  invariant(!JSON.stringify(matching[0]).includes("password"), "관리자 방명록 응답에 비밀번호 정보가 포함되었습니다.");
  return "authenticated-admin";
}

export async function verifyGuestbookDeleteUi(baseUrl, identity, {
  chromiumImpl = chromium,
  expectedWorkerTag = process.env.WEDDING_CANARY_EXPECTED_WORKER_TAG || "",
  expectedWorkerVersion = process.env.WEDDING_CANARY_EXPECTED_WORKER_VERSION || "",
} = {}) {
  const browser = await chromiumImpl.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  let deleteRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "DELETE" && new URL(request.url()).pathname === "/api/guestbook/entries") deleteRequests += 1;
  });

  try {
    const documentResponse = await page.goto(baseUrl.href, { waitUntil: "networkidle", timeout: HTTP_TIMEOUT_MS });
    invariant(documentResponse?.status() === 200, `삭제 UI 문서 응답이 HTTP ${documentResponse?.status() ?? "NONE"}입니다.`);
    invariant(expectedWorkerTag, "삭제 UI 검증에 기대 Worker tag가 없습니다.");
    invariant(expectedWorkerVersion, "삭제 UI 검증에 기대 Worker version이 없습니다.");
    invariant(documentResponse.headers()["x-wedding-worker-tag"] === expectedWorkerTag, "삭제 UI 문서의 Worker tag가 배포 SHA와 다릅니다.");
    invariant(documentResponse.headers()["x-wedding-worker-version"] === expectedWorkerVersion, "삭제 UI 문서의 Worker version이 활성 버전과 다릅니다.");
    const guestbook = page.locator(".guestbook-section");
    await guestbook.getByRole("button", { name: "내 글 수정", exact: true }).click();
    await guestbook.getByLabel("이름", { exact: true }).fill(identity.name);
    await guestbook.getByLabel(/비밀번호/).fill(identity.password);
    await guestbook.getByRole("button", { name: "내 글 불러오기", exact: true }).click();

    const deleteButton = guestbook.getByRole("button", { name: "삭제", exact: true });
    await deleteButton.waitFor({ state: "visible" });
    await deleteButton.click();
    const dialog = page.getByRole("dialog", { name: "이 방명록을 삭제할까요?" });
    await dialog.waitFor({ state: "visible" });
    invariant(deleteRequests === 0, "삭제 확인 전 DELETE 요청이 발생했습니다.");
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    invariant(deleteRequests === 0, "삭제 취소 후 DELETE 요청이 발생했습니다.");

    await deleteButton.click();
    const deleteResponse = page.waitForResponse(
      (response) => response.request().method() === "DELETE" && new URL(response.url()).pathname === "/api/guestbook/entries",
      { timeout: HTTP_TIMEOUT_MS },
    );
    await page.getByRole("button", { name: "삭제하기", exact: true }).click();
    const response = await deleteResponse;
    invariant(response.status() === 200, `브라우저 삭제 요청이 HTTP ${response.status()}를 반환했습니다.`);
    await guestbook.getByRole("button", { name: "비공개로 전하기", exact: true }).waitFor({ state: "visible" });
    invariant(deleteRequests === 1, `삭제 확인 후 DELETE 요청이 ${deleteRequests}회 발생했습니다.`);
  } finally {
    await browser.close();
  }
}

export async function runPostDeployCanary({
  allowProductionWrite = process.env.WEDDING_CANARY_ALLOW_PRODUCTION_WRITE === "1",
  allowD1AdminRead = process.env.WEDDING_CANARY_ALLOW_D1_ADMIN_READ === "1",
  accessToken = process.env.WEDDING_CANARY_ACCESS_TOKEN || "",
  baseUrl = process.env.WEDDING_CANARY_BASE_URL || DEFAULT_BASE_URL,
  d1 = createWranglerD1Client({ database: process.env.WEDDING_CANARY_D1_DATABASE || DEFAULT_DATABASE }),
  fetchImpl = globalThis.fetch,
  idFactory,
  logger = console,
  passwordFactory,
  expectedWorkerTag = process.env.WEDDING_CANARY_EXPECTED_WORKER_TAG || "",
  expectedWorkerVersion = process.env.WEDDING_CANARY_EXPECTED_WORKER_VERSION || "",
  verifyGuestbookDelete = verifyGuestbookDeleteUi,
} = {}) {
  invariant(allowProductionWrite, "운영 합성 데이터 생성을 승인하려면 WEDDING_CANARY_ALLOW_PRODUCTION_WRITE=1이 필요합니다.");
  invariant(accessToken || allowD1AdminRead, "완전한 관리자 조회에는 WEDDING_CANARY_ACCESS_TOKEN이 필요합니다. D1 대체 검증은 WEDDING_CANARY_ALLOW_D1_ADMIN_READ=1로 명시해야 합니다.");
  const url = normalizeBaseUrl(baseUrl);
  const identity = makeCanaryIdentity({ idFactory, passwordFactory });
  let primaryError;
  let result;

  try {
    logger.info("[canary] 공개 초대장과 보안 헤더 확인");
    await verifyPublicInvitation(fetchImpl, url);

    const beforeRows = await d1.findByName(identity.name);
    invariant(beforeRows.length === 0, "생성 전 동일한 canary 이름이 이미 존재합니다. 실제 데이터 보호를 위해 중단합니다.");

    logger.info("[canary] 방명록 생성·본인 인증·수정 확인");
    await requestGuestbook(fetchImpl, url, "/api/guestbook/entries", "POST", {
      name: identity.name,
      password: identity.password,
      message: identity.createdMessage,
    }, 201);
    const unlocked = await requestGuestbook(fetchImpl, url, "/api/guestbook/entries/unlock", "POST", {
      name: identity.name,
      password: identity.password,
    }, 200);
    invariant(unlocked.entry?.message === identity.createdMessage, "방명록 최초 본인 인증 결과가 생성 메시지와 다릅니다.");
    await requestGuestbook(fetchImpl, url, "/api/guestbook/entries", "PATCH", {
      name: identity.name,
      password: identity.password,
      message: identity.updatedMessage,
    }, 200);
    const unlockedAfterUpdate = await requestGuestbook(fetchImpl, url, "/api/guestbook/entries/unlock", "POST", {
      name: identity.name,
      password: identity.password,
    }, 200);
    invariant(unlockedAfterUpdate.entry?.message === identity.updatedMessage, "방명록 수정 후 본인 인증 결과가 수정 메시지와 다릅니다.");

    logger.info("[canary] D1 저장 결과와 관리자 경계 확인");
    assertOwnedRows(await d1.findByName(identity.name), identity, identity.updatedMessage);
    const adminVerification = await verifyAdminBoundary(fetchImpl, url, identity, accessToken);
    logger.info("[canary] 실제 브라우저 삭제 취소·확인과 잔여 0 확인");
    await verifyGuestbookDelete(url, identity, {
      expectedWorkerTag,
      expectedWorkerVersion,
    });
    invariant((await d1.findByName(identity.name)).length === 0, "작성자 삭제 후 D1 행이 남아 있습니다.");
    result = { adminVerification, publicVerified: true, guestbookLifecycleVerified: true, guestbookDeleteVerified: true };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError;
  try {
    logger.info("[canary] 합성 방명록 행 정리 및 잔여 0 확인");
    const rows = await d1.findByName(identity.name);
    if (rows.length > 0) {
      invariant(rows.length === 1, "정리 대상 canary 이름으로 여러 행이 조회되어 삭제를 중단합니다.");
      invariant(rows[0].name === identity.name && rows[0].message?.includes(identity.token), "정리 대상이 이 실행에서 만든 canary 행임을 증명하지 못했습니다.");
      await d1.deleteOwned(identity.name, identity.token);
    }
    invariant((await d1.findByName(identity.name)).length === 0, "canary 정리 후 행이 남아 있습니다.");
  } catch (error) {
    cleanupError = error;
  }

  if (cleanupError) {
    throw new AggregateError([primaryError, cleanupError].filter(Boolean), `운영 canary 정리에 실패했습니다: ${cleanupError.message}`);
  }
  if (primaryError) throw primaryError;

  logger.info("[canary] 통과: 합성 데이터 잔여 0");
  return { ...result, cleanupVerified: true };
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  runPostDeployCanary().catch((error) => {
    console.error(`[canary] 실패: ${error.message}`);
    process.exitCode = 1;
  });
}
