import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MANIFEST_SCHEMA_VERSION = 1;
const DEPLOYMENT_SOURCE_TARGETS = [
  "migrations",
  "package-lock.json",
  "package.json",
  "scripts/check-d1-migrations.mjs",
  "scripts/cloudflare-artifact.mjs",
  "scripts/cloudflare-deployment-state.mjs",
  "scripts/post-deploy-render-canary.mjs",
  "scripts/post-deploy-canary.mjs",
  "scripts/verify-cloudflare-access.mjs",
  "worker/index.js",
  "wrangler.jsonc",
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function portablePath(value) {
  return value.split(sep).join("/");
}

function comparePath(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

async function sha256(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function inventoryFiles(scanRoot, pathRoot = scanRoot) {
  const files = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const metadata = await lstat(path);
      invariant(!metadata.isSymbolicLink(), `배포 산출물에 symbolic link를 포함할 수 없습니다: ${path}`);
      if (metadata.isDirectory()) {
        await walk(path);
      } else if (metadata.isFile()) {
        files.push({
          path: portablePath(relative(pathRoot, path)),
          bytes: metadata.size,
          sha256: await sha256(path),
        });
      } else {
        throw new Error(`배포 산출물에 일반 파일이 아닌 항목이 있습니다: ${path}`);
      }
    }
  }

  await walk(scanRoot);
  return files.sort(comparePath);
}

async function inventorySourceTargets(sourceRoot, sourceTargets) {
  const files = [];
  for (const target of [...sourceTargets].sort()) {
    const path = resolve(sourceRoot, target);
    const metadata = await lstat(path);
    invariant(!metadata.isSymbolicLink(), `배포 입력에 symbolic link를 포함할 수 없습니다: ${target}`);
    if (metadata.isDirectory()) {
      files.push(...await inventoryFiles(path, sourceRoot));
    } else if (metadata.isFile()) {
      files.push({
        path: portablePath(relative(sourceRoot, path)),
        bytes: metadata.size,
        sha256: await sha256(path),
      });
    } else {
      throw new Error(`배포 입력에 일반 파일이 아닌 항목이 있습니다: ${target}`);
    }
  }
  const sorted = files.sort(comparePath);
  invariant(new Set(sorted.map((file) => file.path)).size === sorted.length, "배포 입력 target이 중복됩니다.");
  return sorted;
}

function checksumDocument(manifest) {
  const entries = [
    ...manifest.files.map((file) => ({ ...file, path: `dist/client/${file.path}` })),
    ...manifest.sources,
  ].sort(comparePath);
  for (const entry of entries) {
    invariant(!/[\r\n]/.test(entry.path), `배포 checksum 경로에 줄바꿈을 포함할 수 없습니다: ${entry.path}`);
  }
  return `${entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`;
}

export async function createArtifactManifest({
  clientRoot,
  checksumPath,
  manifestPath,
  sourceRoot,
  sourceTargets = [],
}) {
  const files = await inventoryFiles(clientRoot);
  invariant(files.length > 0, "검증할 Cloudflare 정적 산출물이 없습니다.");
  const manifest = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    root: "client",
    files,
    sources: sourceRoot ? await inventorySourceTargets(sourceRoot, sourceTargets) : [],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (checksumPath) await writeFile(checksumPath, checksumDocument(manifest), "utf8");
  return manifest;
}

export async function verifyArtifactManifest({
  clientRoot,
  checksumPath,
  manifestPath,
  sourceRoot,
  sourceTargets = [],
}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  invariant(manifest?.schema_version === MANIFEST_SCHEMA_VERSION, "배포 산출물 manifest schema가 올바르지 않습니다.");
  invariant(manifest?.root === "client", "배포 산출물 manifest root가 올바르지 않습니다.");
  invariant(Array.isArray(manifest?.files) && manifest.files.length > 0, "배포 산출물 manifest에 파일이 없습니다.");
  invariant(Array.isArray(manifest?.sources), "배포 산출물 manifest의 source 목록이 올바르지 않습니다.");
  const actualFiles = await inventoryFiles(clientRoot);
  invariant(JSON.stringify(actualFiles) === JSON.stringify(manifest.files), "검증된 Cloudflare 정적 산출물과 승격 대상의 digest가 다릅니다.");
  const actualSources = sourceRoot ? await inventorySourceTargets(sourceRoot, sourceTargets) : [];
  invariant(JSON.stringify(actualSources) === JSON.stringify(manifest.sources), "검증된 Cloudflare 배포 입력과 승격 대상의 digest가 다릅니다.");
  if (checksumPath) {
    invariant(await readFile(checksumPath, "utf8") === checksumDocument(manifest), "Cloudflare checksum 문서가 manifest와 다릅니다.");
  }
  return manifest;
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const clientRoot = resolve(root, "dist", "client");
  const checksumPath = resolve(root, "dist", "cloudflare-artifact.sha256");
  const manifestPath = resolve(root, "dist", "cloudflare-artifact-manifest.json");
  const command = process.argv[2];
  const operation = command === "create"
    ? createArtifactManifest({
      clientRoot,
      checksumPath,
      manifestPath,
      sourceRoot: root,
      sourceTargets: DEPLOYMENT_SOURCE_TARGETS,
    })
    : command === "verify"
      ? verifyArtifactManifest({
        clientRoot,
        checksumPath,
        manifestPath,
        sourceRoot: root,
        sourceTargets: DEPLOYMENT_SOURCE_TARGETS,
      })
      : Promise.reject(new Error("사용법: cloudflare-artifact.mjs <create|verify>"));
  operation
    .then((manifest) => {
      console.log(`[cloudflare-artifact] ${command} 통과: ${manifest.files.length}개 파일`);
    })
    .catch((error) => {
      console.error(`[cloudflare-artifact] 실패: ${error.message}`);
      process.exitCode = 1;
    });
}
