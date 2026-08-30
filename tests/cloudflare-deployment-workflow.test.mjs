import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createArtifactManifest,
  verifyArtifactManifest,
} from "../scripts/cloudflare-artifact.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("production CI deploys a Worker version without mutating Custom Domain routes", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/cloudflare.yml"), "utf8");
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const deployJob = workflow.split(/^ {2}deploy:/m)[1] ?? "";

  assert.match(workflow, /- ['"]hotfix\/\*\*['"]/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /node scripts\/cloudflare-artifact\.mjs create/);
  assert.equal((deployJob.match(/sha256sum --strict --check dist\/cloudflare-artifact\.sha256/g) || []).length, 2);
  assert.match(workflow, /npm run upload:cloudflare:version/);
  assert.match(workflow, /--no-bundle/);
  assert.match(workflow, /npm run deploy:cloudflare:version/);
  assert.doesNotMatch(workflow, /npm run deploy:cloudflare:built/);
  assert.doesNotMatch(deployJob, /npm run build/);
  assert.doesNotMatch(deployJob, /^ {4}env:\s*\n\s+CLOUDFLARE_API_TOKEN:/m);
  assert.doesNotMatch(deployJob, /Install locked dependencies[\s\S]{0,300}CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /cloudflare-deployment-state\.mjs restore-if-changed/);
  assert.match(deployJob, /npx playwright install --with-deps chromium/);
  assert.match(deployJob, /npm run canary:production/);
  assert.match(deployJob, /WEDDING_CANARY_EXPECTED_WORKER_TAG: \$\{\{ github\.sha \}\}/);
  assert.match(deployJob, /WEDDING_CANARY_EXPECTED_WORKER_VERSION: \$\{\{ steps\.active-version\.outputs\.active_worker_version \}\}/);

  const artifactSource = await readFile(resolve(root, "scripts/cloudflare-artifact.mjs"), "utf8");
  assert.match(artifactSource, /scripts\/post-deploy-render-canary\.mjs/);
  assert.equal(packageJson.scripts["deploy:cloudflare:verified"], undefined);
});

test("Cloudflare artifact manifest rejects changed or additional build files", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "wedding-card-artifact-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const clientRoot = resolve(temporaryRoot, "client");
  const sourceRoot = resolve(temporaryRoot, "source");
  const checksumPath = resolve(temporaryRoot, "artifact.sha256");
  const manifestPath = resolve(temporaryRoot, "manifest.json");
  await mkdir(resolve(clientRoot, "assets"), { recursive: true });
  await mkdir(resolve(sourceRoot, "migrations"), { recursive: true });
  await writeFile(resolve(clientRoot, "index.html"), "verified", "utf8");
  await writeFile(resolve(clientRoot, "assets", "app.js"), "trusted", "utf8");
  await writeFile(resolve(sourceRoot, "worker.js"), "worker", "utf8");
  await writeFile(resolve(sourceRoot, "migrations", "0001.sql"), "CREATE TABLE safe (id TEXT);", "utf8");

  const manifestOptions = {
    clientRoot,
    checksumPath,
    manifestPath,
    sourceRoot,
    sourceTargets: ["worker.js", "migrations"],
  };
  const manifest = await createArtifactManifest(manifestOptions);
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.sources.length, 2);
  assert.match(await readFile(checksumPath, "utf8"), /^[a-f0-9]{64} {2}dist\/client\/assets\/app\.js/m);
  await verifyArtifactManifest(manifestOptions);

  await writeFile(resolve(clientRoot, "assets", "app.js"), "tampered", "utf8");
  await assert.rejects(
    verifyArtifactManifest(manifestOptions),
    /digest가 다릅니다/,
  );

  await writeFile(resolve(clientRoot, "assets", "app.js"), "trusted", "utf8");
  await writeFile(resolve(clientRoot, "unexpected.js"), "extra", "utf8");
  await assert.rejects(
    verifyArtifactManifest(manifestOptions),
    /digest가 다릅니다/,
  );

  await rm(resolve(clientRoot, "unexpected.js"));
  await writeFile(resolve(sourceRoot, "worker.js"), "changed worker", "utf8");
  await assert.rejects(
    verifyArtifactManifest(manifestOptions),
    /배포 입력과 승격 대상의 digest가 다릅니다/,
  );
});
