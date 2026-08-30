import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDeploymentMatchesCommit,
  productionVersionId,
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
