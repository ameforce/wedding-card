import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("production CI deploys a Worker version without mutating Custom Domain routes", async () => {
  const workflow = await readFile(resolve(root, ".github/workflows/cloudflare.yml"), "utf8");

  assert.match(workflow, /npm run upload:cloudflare:version/);
  assert.match(workflow, /npm run deploy:cloudflare:version/);
  assert.doesNotMatch(workflow, /npm run deploy:cloudflare:built/);
  assert.match(workflow, /cloudflare-deployment-state\.mjs restore-if-changed/);
});
