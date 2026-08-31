import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_ADMIN_DESTINATIONS,
  verifyCloudflareAccess,
} from "../scripts/verify-cloudflare-access.mjs";

function json(result, { status = 200, success = true } = {}) {
  return Response.json({ result, success }, { status });
}

function accessFetch({ destinations = REQUIRED_ADMIN_DESTINATIONS, policies = [{ decision: "allow" }] } = {}) {
  return async (request) => {
    const url = new URL(request);
    if (url.pathname.endsWith("/access/apps")) {
      return json([{
        id: "admin-app",
        type: "self_hosted",
        destinations: destinations.map((uri) => ({ type: "public", uri })),
      }]);
    }
    if (url.pathname.endsWith("/access/apps/admin-app/policies")) return json(policies);
    return json([], { status: 404, success: false });
  };
}

test("accepts one Access application that protects the exact admin root and existing admin paths", async () => {
  const result = await verifyCloudflareAccess({
    accountId: "account",
    apiToken: "token",
    fetchImpl: accessFetch(),
  });

  assert.equal(result.applicationId, "admin-app");
  assert.deepEqual(result.requiredDestinations, REQUIRED_ADMIN_DESTINATIONS);
});

test("fails closed when the exact admin root is not protected", async () => {
  await assert.rejects(
    verifyCloudflareAccess({
      accountId: "account",
      apiToken: "token",
      fetchImpl: accessFetch({ destinations: REQUIRED_ADMIN_DESTINATIONS.filter((uri) => !uri.endsWith("/admin")) }),
    }),
    /일치 0개/,
  );
});

test("fails closed when the shared administrator application has no allow policy", async () => {
  await assert.rejects(
    verifyCloudflareAccess({
      accountId: "account",
      apiToken: "token",
      fetchImpl: accessFetch({ policies: [{ decision: "deny" }] }),
    }),
    /허용 정책이 없습니다/,
  );
});

test("fails closed when the shared administrator application has a bypass policy", async () => {
  await assert.rejects(
    verifyCloudflareAccess({
      accountId: "account",
      apiToken: "token",
      fetchImpl: accessFetch({ policies: [{ decision: "allow" }, { decision: "bypass" }] }),
    }),
    /인증을 우회하는 정책/,
  );
});

test("fails closed on an Access API error", async () => {
  await assert.rejects(
    verifyCloudflareAccess({
      accountId: "account",
      apiToken: "token",
      fetchImpl: async () => json([], { status: 403, success: false }),
    }),
    /조회에 실패했습니다 \(403\)/,
  );
});
