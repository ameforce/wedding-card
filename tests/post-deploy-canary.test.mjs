import assert from "node:assert/strict";
import test from "node:test";

import { runPostDeployCanary } from "../scripts/post-deploy-canary.mjs";

const BASE = "https://wdcard.enmsoftware.com/";

function json(payload, status = 200, headers = {}) {
  return Response.json(payload, { status, headers: { "x-robots-tag": "noindex, nofollow", ...headers } });
}

function fixture({ failUpdate = false, failDelete = false, authenticatedAdmin = false } = {}) {
  let row = null;
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || "GET";
    calls.push({ path: url.pathname, method, headers: options.headers });
    if (url.pathname === "/" && method === "GET") {
      return new Response(`<link rel="canonical" href="${BASE}"><template id="wedding-public-bootstrap"></template>`, {
        status: 200,
        headers: {
          "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
          "x-content-type-options": "nosniff",
          "x-robots-tag": "noindex, nofollow",
          "x-wedding-content-source": "cloudflare-published",
          "x-wedding-revision": "published",
        },
      });
    }
    if (url.pathname === "/api/content") return json({ revisionId: "published" });
    if (url.pathname === "/api/guestbook/admin/entries") {
      if (!authenticatedAdmin) return new Response(null, { status: 302, headers: { location: "https://access.example.test/" } });
      assert.equal(options.headers["cf-access-token"], "short-lived-token");
      return json({ entries: row ? [{ id: "internal", name: row.name, message: row.message }] : [] });
    }
    const body = JSON.parse(options.body);
    if (url.pathname === "/api/guestbook/entries" && method === "POST") {
      row = { name: body.name, message: body.message };
      return json({ retention: "permanent" }, 201);
    }
    if (url.pathname === "/api/guestbook/entries/unlock" && method === "POST") {
      return json({ entry: row });
    }
    if (url.pathname === "/api/guestbook/entries" && method === "PATCH") {
      if (failUpdate) return json({ code: "INTERNAL_ERROR" }, 500);
      row.message = body.message;
      return json({ updatedAt: "2026-08-18T00:00:00.000Z" });
    }
    if (url.pathname === "/api/guestbook/entries" && method === "DELETE") {
      if (failDelete) return json({ code: "INTERNAL_ERROR" }, 500);
      row = null;
      return json({ deleted: true });
    }
    throw new Error(`unexpected request: ${method} ${url.pathname}`);
  };
  const d1 = {
    async findByName(name) {
      return row?.name === name ? [{ ...row }] : [];
    },
    async deleteOwned(name, token) {
      assert.equal(row.name, name);
      assert.match(row.message, new RegExp(token));
      row = null;
    },
  };
  return { calls, d1, fetchImpl, getRow: () => row };
}

test("production canary covers public, guestbook, D1, Access denial, and exact cleanup without logging secrets", async () => {
  const { calls, d1, fetchImpl, getRow } = fixture();
  const log = [];
  const secret = "not-printed-secret";
  const result = await runPostDeployCanary({
    allowProductionWrite: true,
    allowD1AdminRead: true,
    d1,
    fetchImpl,
    idFactory: () => "12345678-abcd-ef00",
    logger: { info: (message) => log.push(message) },
    passwordFactory: () => secret,
  });
  assert.deepEqual(result, {
    adminVerification: "access-denied",
    publicVerified: true,
    guestbookLifecycleVerified: true,
    guestbookDeleteVerified: true,
    cleanupVerified: true,
  });
  assert.equal(getRow(), null);
  assert.equal(calls.some(({ path, method }) => path === "/api/guestbook/entries" && method === "DELETE"), true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(log.join("\n").includes(secret), false);
});

test("production canary verifies the authenticated admin list when a short-lived Access token is supplied", async () => {
  const { d1, fetchImpl, getRow } = fixture({ authenticatedAdmin: true });
  const result = await runPostDeployCanary({
    accessToken: "short-lived-token",
    allowProductionWrite: true,
    d1,
    fetchImpl,
    idFactory: () => "87654321-abcd-ef00",
    logger: { info() {} },
    passwordFactory: () => "another-secret",
  });
  assert.equal(result.adminVerification, "authenticated-admin");
  assert.equal(getRow(), null);
});

test("production canary always removes its owned row when an intermediate check fails", async () => {
  const { d1, fetchImpl, getRow } = fixture({ failUpdate: true });
  await assert.rejects(
    runPostDeployCanary({
      allowProductionWrite: true,
      allowD1AdminRead: true,
      d1,
      fetchImpl,
      idFactory: () => "abcdef12-3456-7890",
      logger: { info() {} },
      passwordFactory: () => "cleanup-secret",
    }),
    /PATCH \/api\/guestbook\/entries 실패/,
  );
  assert.equal(getRow(), null);
});

test("production canary falls back to exact owned-row cleanup when author deletion fails", async () => {
  const { d1, fetchImpl, getRow } = fixture({ failDelete: true });
  await assert.rejects(
    runPostDeployCanary({
      allowProductionWrite: true,
      allowD1AdminRead: true,
      d1,
      fetchImpl,
      idFactory: () => "deadbeef-3456-7890",
      logger: { info() {} },
      passwordFactory: () => "cleanup-delete-secret",
    }),
    /DELETE \/api\/guestbook\/entries 실패/,
  );
  assert.equal(getRow(), null);
});

test("production canary fails closed without explicit write and admin-read authorization", async () => {
  await assert.rejects(runPostDeployCanary({ allowProductionWrite: false }), /WEDDING_CANARY_ALLOW_PRODUCTION_WRITE=1/);
  await assert.rejects(runPostDeployCanary({
    allowProductionWrite: true,
    d1: {},
    fetchImpl: async () => { throw new Error("must not run"); },
  }), /WEDDING_CANARY_ACCESS_TOKEN/);
});
