import assert from "node:assert/strict";
import test from "node:test";

import {
  assertActiveVersionMatchesUpload,
  assertDeploymentMatchesCommit,
  productionVersionId,
  uploadedWorkerVersionId,
} from "../scripts/cloudflare-deployment-state.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "11111111-2222-3333-4444-555555555555";

function status(percentage = 100) {
  return { versions: [{ version_id: VERSION, percentage }] };
}

test("production state requires one version with 100 percent traffic", () => {
  assert.equal(productionVersionId(status()), VERSION);
  assert.throws(() => productionVersionId({ versions: [] }), /단일 Worker 버전/);
  assert.throws(() => productionVersionId(status(90)), /100%/);
  assert.throws(() => productionVersionId({ versions: [{ version_id: "unsafe\noutput=value", percentage: 100 }] }), /형식/);
});

test("deployment verification binds the active version tag and message to the exact commit", () => {
  assert.equal(assertDeploymentMatchesCommit(status(), {
    id: VERSION,
    annotations: {
      "workers/tag": SHA,
      "workers/message": `GitHub Actions ${SHA}`,
    },
  }, SHA), VERSION);
});

test("deployment verification rejects a different tag, message, or version", () => {
  assert.throws(() => assertDeploymentMatchesCommit(status(), {
    id: VERSION,
    annotations: { "workers/tag": "different", "workers/message": `GitHub Actions ${SHA}` },
  }, SHA), /tag/);
  assert.throws(() => assertDeploymentMatchesCommit(status(), {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    annotations: { "workers/tag": SHA, "workers/message": `GitHub Actions ${SHA}` },
  }, SHA), /현재 운영 버전/);
});

test("upload identity is read only from Wrangler structured output", () => {
  const output = JSON.stringify({
    type: "version-upload",
    version: 1,
    worker_name: "wedding-card",
    worker_tag: null,
    version_id: VERSION,
  });
  assert.equal(uploadedWorkerVersionId(output), VERSION);
  assert.throws(() => uploadedWorkerVersionId(""), /비어/);
  assert.throws(() => uploadedWorkerVersionId("{not-json"), /JSON/);
  assert.throws(() => uploadedWorkerVersionId(JSON.stringify({ ...JSON.parse(output), version_id: "not-a-version" })), /형식/);
  assert.throws(() => uploadedWorkerVersionId(`${output}\n${output}`), /정확히 하나/);
});

test("active deployment must retain the exact uploaded ID", () => {
  assert.equal(assertActiveVersionMatchesUpload(status(), VERSION), VERSION);
  assert.throws(() => assertActiveVersionMatchesUpload({
    versions: [{ version_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", percentage: 100 }],
  }, VERSION), /이번 업로드 결과/);
});
