import { appendFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKER_NAME = "wedding-card";
const DATABASE_NAME = "wedding-card-guestbook-db";
const COMMAND_TIMEOUT_MS = 60_000;
const WORKER_VERSION_ID = /^[0-9a-f-]{36}$/u;
const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function strictUtf8(chunks, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    throw new Error(`${label}가 UTF-8이 아닙니다.`, { cause: error });
  }
}

async function runWrangler(args, { cwd, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const executable = resolve(cwd, "node_modules", "wrangler", "bin", "wrangler.js");
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [executable, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
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
      reject(new Error(`Wrangler 명령이 ${timeoutMs}ms 안에 끝나지 않았습니다.`));
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
          reject(new Error(`Wrangler 명령이 exit ${code}로 실패했습니다: ${decodedStderr.trim() || "상세 오류 없음"}`));
          return;
        }
        resolvePromise({ stdout: decodedStdout, stderr: decodedStderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} JSON을 해석하지 못했습니다.`, { cause: error });
  }
}

export function productionVersionId(status) {
  invariant(Array.isArray(status?.versions), "Cloudflare deployment status에 versions가 없습니다.");
  invariant(status.versions.length === 1, "운영 트래픽이 단일 Worker 버전에 100% 배정되어 있지 않습니다.");
  const [version] = status.versions;
  invariant(version?.percentage === 100, "운영 Worker 버전의 트래픽 비율이 100%가 아닙니다.");
  invariant(typeof version.version_id === "string" && WORKER_VERSION_ID.test(version.version_id), "운영 Worker version ID 형식이 올바르지 않습니다.");
  return version.version_id;
}

export function assertDeploymentMatchesCommit(status, version, commitSha) {
  invariant(/^[0-9a-f]{40}$/.test(commitSha), "검증할 Git commit SHA는 40자리 소문자 hex여야 합니다.");
  const activeVersionId = productionVersionId(status);
  invariant(version?.id === activeVersionId, "조회한 Worker 버전이 현재 운영 버전과 다릅니다.");
  invariant(version?.annotations?.["workers/tag"] === commitSha, "운영 Worker tag가 Git commit SHA와 다릅니다.");
  invariant(version?.annotations?.["workers/message"] === `GitHub Actions ${commitSha}`, "운영 Worker message가 Git commit SHA와 다릅니다.");
  return activeVersionId;
}

function parseWranglerOutput(output, label) {
  invariant(typeof output === "string" && output.trim().length > 0, `${label}이 비어 있습니다.`);
  return output.trim().split(/\r?\n/u).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} ${index + 1}번째 레코드가 JSON이 아닙니다.`, { cause: error });
    }
  });
}

function exactlyOneOutputRecord(output, type, label) {
  const matches = parseWranglerOutput(output, label).filter((entry) => entry?.type === type);
  invariant(matches.length === 1, `${label}에 ${type} 레코드가 정확히 하나 있어야 합니다.`);
  return matches[0];
}

export function uploadedWorkerVersionId(output) {
  const upload = exactlyOneOutputRecord(output, "version-upload", "Wrangler 업로드 출력");
  invariant(upload.version === 1, "Wrangler 업로드 출력 schema version이 지원되지 않습니다.");
  invariant(upload.worker_name === WORKER_NAME, "Wrangler 업로드 대상 Worker가 다릅니다.");
  invariant(typeof upload.version_id === "string" && WORKER_VERSION_ID.test(upload.version_id), "Wrangler 업로드 Worker version ID 형식이 올바르지 않습니다.");
  return upload.version_id;
}

export function assertActiveVersionMatchesUpload(status, uploadedVersionId) {
  invariant(typeof uploadedVersionId === "string" && WORKER_VERSION_ID.test(uploadedVersionId), "업로드한 Worker version ID 형식이 올바르지 않습니다.");
  const activeVersionId = productionVersionId(status);
  invariant(activeVersionId === uploadedVersionId, "현재 운영 Worker version ID가 이번 업로드 결과와 다릅니다.");
  return activeVersionId;
}

async function readStatus(cwd) {
  const { stdout } = await runWrangler(["deployments", "status", "--name", WORKER_NAME, "--json"], { cwd });
  return parseJson(stdout, "deployment status");
}

async function readVersion(cwd, versionId) {
  const { stdout } = await runWrangler(["versions", "view", versionId, "--name", WORKER_NAME, "--json"], { cwd });
  return parseJson(stdout, "Worker version");
}

async function capture(cwd) {
  const previousWorkerVersion = productionVersionId(await readStatus(cwd));
  const { stdout } = await runWrangler(["d1", "time-travel", "info", DATABASE_NAME, "--json"], { cwd });
  const bookmark = parseJson(stdout, "D1 Time Travel")?.bookmark;
  invariant(typeof bookmark === "string" && bookmark.length > 0, "D1 Time Travel bookmark를 받지 못했습니다.");
  invariant(process.env.GITHUB_OUTPUT, "capture는 GitHub Actions의 GITHUB_OUTPUT에서만 실행할 수 있습니다.");
  await appendFile(process.env.GITHUB_OUTPUT, `previous_worker_version=${previousWorkerVersion}\nd1_bookmark=${bookmark}\n`, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Cloudflare recovery points\n\n- Previous Worker version: \`${previousWorkerVersion}\`\n- D1 Time Travel bookmark: \`${bookmark}\`\n`, "utf8");
  }
  console.log(`[cloudflare] 복구 지점 기록 완료: Worker ${previousWorkerVersion}`);
}

async function verify(cwd, commitSha, expectedVersionId) {
  invariant(typeof expectedVersionId === "string" && WORKER_VERSION_ID.test(expectedVersionId), "검증할 Worker version ID 형식이 올바르지 않습니다.");
  const status = await readStatus(cwd);
  const activeVersionId = assertActiveVersionMatchesUpload(status, expectedVersionId);
  assertDeploymentMatchesCommit(status, await readVersion(cwd, activeVersionId), commitSha);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `active_worker_version=${activeVersionId}\n`, "utf8");
  }
  console.log(`[cloudflare] 운영 버전 검증 완료: ${activeVersionId}, commit ${commitSha}`);
}

async function recordUploadedVersion(outputFile) {
  invariant(typeof outputFile === "string" && outputFile.length > 0, "Wrangler 업로드 출력 파일 경로가 필요합니다.");
  const uploadedVersionId = uploadedWorkerVersionId(await readFile(outputFile, "utf8"));
  invariant(process.env.GITHUB_OUTPUT, "record-upload는 GitHub Actions의 GITHUB_OUTPUT에서만 실행할 수 있습니다.");
  await appendFile(process.env.GITHUB_OUTPUT, `uploaded_worker_version=${uploadedVersionId}\n`, "utf8");
  console.log(`[cloudflare] 업로드 Worker version ID 기록 완료: ${uploadedVersionId}`);
}

export async function activeDeploymentIdentity(cwd = PROJECT_ROOT) {
  const status = await readStatus(cwd);
  const activeVersionId = productionVersionId(status);
  const version = await readVersion(cwd, activeVersionId);
  const commitSha = version?.annotations?.["workers/tag"];
  assertDeploymentMatchesCommit(status, version, commitSha);
  return { workerTag: commitSha, workerVersion: activeVersionId };
}

async function rollback(cwd, previousWorkerVersion, failedCommitSha) {
  invariant(/^[0-9a-f-]{36}$/.test(previousWorkerVersion), "롤백할 Worker version ID 형식이 올바르지 않습니다.");
  invariant(/^[0-9a-f]{40}$/.test(failedCommitSha), "실패한 Git commit SHA 형식이 올바르지 않습니다.");
  await runWrangler([
    "rollback",
    previousWorkerVersion,
    "--name",
    WORKER_NAME,
    "--yes",
    "--message",
    `Automatic rollback after GitHub Actions failure ${failedCommitSha}`,
  ], { cwd });
  const restoredVersion = productionVersionId(await readStatus(cwd));
  invariant(restoredVersion === previousWorkerVersion, "Worker 롤백 후 운영 version ID가 이전 버전과 다릅니다.");
  console.log(`[cloudflare] Worker 롤백 검증 완료: ${restoredVersion}`);
}

async function restoreIfChanged(cwd, previousWorkerVersion, failedCommitSha) {
  const activeVersion = productionVersionId(await readStatus(cwd));
  if (activeVersion === previousWorkerVersion) {
    console.log(`[cloudflare] 운영 버전이 변경되지 않아 롤백을 생략합니다: ${activeVersion}`);
    return;
  }
  await rollback(cwd, previousWorkerVersion, failedCommitSha);
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const cwd = PROJECT_ROOT;
  const [command, first, second] = process.argv.slice(2);
  const action = command === "capture"
    ? capture(cwd)
    : command === "verify"
      ? verify(cwd, first, second)
      : command === "record-upload"
        ? recordUploadedVersion(first)
        : command === "restore-if-changed"
          ? restoreIfChanged(cwd, first, second)
          : Promise.reject(new Error("사용법: cloudflare-deployment-state.mjs <capture|record-upload|verify|restore-if-changed> [...args]"));
  action.catch((error) => {
    console.error(`[cloudflare] 실패: ${error.message}`);
    process.exitCode = 1;
  });
}
