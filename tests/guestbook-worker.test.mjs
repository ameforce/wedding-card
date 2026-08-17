import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker, { __test } from "../worker/index.js";

function request(path, init = {}) {
  return new Request(`https://example.test${path}`, {
    ...init,
    headers: {
      origin: "https://example.test",
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function database() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      let values = [];
      return {
        bind(...nextValues) {
          values = nextValues;
          return this;
        },
        async run() {
          if (sql.startsWith("INSERT")) {
            const [id, name, message, passwordHash, createdAt, updatedAt] = values;
            rows.set(id, { id, name, message, password_hash: passwordHash, created_at: createdAt, updated_at: updatedAt });
          } else if (sql.startsWith("UPDATE")) {
            const [message, updatedAt, id] = values;
            rows.set(id, { ...rows.get(id), message, updated_at: updatedAt });
          }
          return { success: true };
        },
        async first() {
          return rows.get(values[0]) || null;
        },
        async all() {
          return { results: [...rows.values()] };
        },
      };
    },
  };
}

test("password verifiers are salted PBKDF2 values and reject the wrong password", async () => {
  const first = await __test.hashPassword("correct horse");
  const second = await __test.hashPassword("correct horse");
  assert.notEqual(first, second);
  assert.equal(first.includes("correct horse"), false);
  assert.equal(await __test.verifyPassword("correct horse", first), true);
  assert.equal(await __test.verifyPassword("wrong horse", first), false);
});

test("worker source never logs guestbook payloads, passwords, messages, or hashes", async () => {
  const source = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error|debug)\s*\(/);
  assert.doesNotMatch(source, /JSON\.stringify\([^)]*password_hash/);
});

test("public guestbook has no list endpoint and fails closed without D1", async () => {
  const listResponse = await worker.fetch(request("/api/guestbook/entries", { method: "GET" }), {});
  assert.equal(listResponse.status, 405);

  const createResponse = await worker.fetch(request("/api/guestbook/entries", {
    method: "POST",
    body: JSON.stringify({ name: "하객", password: "eightchars", message: "축하합니다" }),
  }), {});
  assert.equal(createResponse.status, 503);
  assert.equal((await createResponse.json()).code, "GUESTBOOK_UNAVAILABLE");
});

test("authors can create, unlock, and edit only with the matching name and password", async () => {
  const db = database();
  const env = { GUESTBOOK_DB: db };
  const createResponse = await worker.fetch(request("/api/guestbook/entries", {
    method: "POST",
    body: JSON.stringify({ name: "하객", password: "eightchars", message: "축하합니다" }),
  }), env);
  assert.equal(createResponse.status, 201);
  const { id, retention } = await createResponse.json();
  assert.equal(retention, "permanent");
  const stored = db.rows.get(id);
  assert.equal(stored.message, "축하합니다");
  assert.equal(stored.password_hash.includes("eightchars"), false);

  const denied = await worker.fetch(request(`/api/guestbook/entries/${id}/unlock`, {
    method: "POST",
    body: JSON.stringify({ name: "하객", password: "wrongpass" }),
  }), env);
  assert.equal(denied.status, 401);

  const unlocked = await worker.fetch(request(`/api/guestbook/entries/${id}/unlock`, {
    method: "POST",
    body: JSON.stringify({ name: "하객", password: "eightchars" }),
  }), env);
  assert.equal(unlocked.status, 200);
  assert.equal((await unlocked.json()).entry.message, "축하합니다");

  const updated = await worker.fetch(request(`/api/guestbook/entries/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "하객", password: "eightchars", message: "두 분 행복하세요" }),
  }), env);
  assert.equal(updated.status, 200);
  assert.equal(db.rows.get(id).message, "두 분 행복하세요");
});

test("guestbook accepts a four-character password and rejects shorter values", async () => {
  const db = database();
  const env = { GUESTBOOK_DB: db };

  const rejected = await worker.fetch(request("/api/guestbook/entries", {
    method: "POST",
    body: JSON.stringify({ name: "하객", password: "abc", message: "축하합니다" }),
  }), env);
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, "INVALID_PASSWORD");

  const accepted = await worker.fetch(request("/api/guestbook/entries", {
    method: "POST",
    body: JSON.stringify({ name: "하객", password: "abcd", message: "축하합니다" }),
  }), env);
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).retention, "permanent");
});

test("administrator list fails closed without trusted upstream identity", async () => {
  const response = await worker.fetch(request("/api/guestbook/admin/entries", { method: "GET" }), {
    GUESTBOOK_DB: database(),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "ADMIN_AUTH_UNAVAILABLE");
});

test("administrator list requires an asserted allowlisted identity", async () => {
  const db = database();
  db.rows.set("entry-id", {
    id: "entry-id",
    name: "하객",
    message: "비공개 메시지",
    password_hash: "not returned",
    created_at: "2026-08-17T00:00:00.000Z",
    updated_at: "2026-08-17T00:00:00.000Z",
  });
  const env = {
    GUESTBOOK_DB: db,
    GUESTBOOK_AUTH_MODE: "trusted-email-header",
    GUESTBOOK_AUTH_EMAIL_HEADER: "x-authenticated-email",
    GUESTBOOK_AUTH_ASSERTION_HEADER: "x-authenticated-assertion",
    GUESTBOOK_ADMIN_EMAILS: "groom@example.test,bride@example.test",
  };
  const denied = await worker.fetch(request("/api/guestbook/admin/entries", { method: "GET" }), env);
  assert.equal(denied.status, 401);

  const allowed = await worker.fetch(request("/api/guestbook/admin/entries", {
    method: "GET",
    headers: {
      "x-authenticated-email": "bride@example.test",
      "x-authenticated-assertion": "verified-by-upstream",
    },
  }), env);
  assert.equal(allowed.status, 200);
  const payload = await allowed.json();
  assert.deepEqual(payload.entries, [{
    id: "entry-id",
    name: "하객",
    message: "비공개 메시지",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
  }]);
  assert.equal(JSON.stringify(payload).includes("password_hash"), false);
});

test("administrator allowlist fails closed unless exactly two distinct deployment emails are configured", async () => {
  const env = {
    GUESTBOOK_DB: database(),
    GUESTBOOK_AUTH_MODE: "trusted-email-header",
    GUESTBOOK_AUTH_EMAIL_HEADER: "x-authenticated-email",
    GUESTBOOK_AUTH_ASSERTION_HEADER: "x-authenticated-assertion",
    GUESTBOOK_ADMIN_EMAILS: "groom@example.test,bride@example.test,extra@example.test",
  };
  const response = await worker.fetch(request("/api/guestbook/admin/entries", {
    method: "GET",
    headers: {
      "x-authenticated-email": "groom@example.test",
      "x-authenticated-assertion": "verified-by-upstream",
    },
  }), env);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "ADMIN_AUTH_REQUIRED");
});
