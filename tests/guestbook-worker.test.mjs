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

function base64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Buffer.from(bytes).toString("base64url");
}

async function accessFixture(email = "bride@example.test") {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const kid = crypto.randomUUID();
  const teamOrigin = "https://wedding-test.cloudflareaccess.com";
  const audience = "wedding-access-audience";
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const now = Math.floor(Date.now() / 1000);
  const claims = base64Url(JSON.stringify({
    iss: teamOrigin,
    aud: [audience],
    email,
    iat: now - 5,
    exp: now + 300,
  }));
  const input = `${header}.${claims}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(input));
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return {
    assertion: `${input}.${base64Url(signature)}`,
    jwks: { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] },
    env: {
      ADMIN_AUTH_MODE: "cloudflare-access-jwt",
      ACCESS_TEAM_DOMAIN: "wedding-test.cloudflareaccess.com",
      ACCESS_AUD: audience,
      WEDDING_ADMIN_EMAILS: "groom@example.test,bride@example.test",
    },
  };
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
            const [id, name, message, messageSearch, passwordHash, createdAt, updatedAt] = values;
            if ([...rows.values()].some((entry) => entry.name === name)) throw new Error("UNIQUE constraint failed");
            rows.set(id, {
              id,
              name,
              message,
              message_search: messageSearch,
              password_hash: passwordHash,
              created_at: createdAt,
              updated_at: updatedAt,
              auth_failure_count: 0,
              auth_window_started_at_ms: 0,
              auth_locked_until_ms: 0,
            });
          } else if (sql.startsWith("UPDATE guestbook_entries SET message_search")) {
            const [messageSearch, id, expectedMessage] = values;
            const entry = rows.get(id);
            if (entry?.message === expectedMessage && entry.message_search == null) {
              rows.set(id, { ...entry, message_search: messageSearch });
            }
          } else if (sql.startsWith("UPDATE guestbook_entries SET message")) {
            const [message, messageSearch, updatedAt, id] = values;
            rows.set(id, { ...rows.get(id), message, message_search: messageSearch, updated_at: updatedAt });
          } else if (sql.startsWith("UPDATE guestbook_entries SET auth_failure_count = 0")) {
            const [id] = values;
            rows.set(id, {
              ...rows.get(id),
              auth_failure_count: 0,
              auth_window_started_at_ms: 0,
              auth_locked_until_ms: 0,
            });
          }
          return { success: true };
        },
        async first() {
          if (sql.startsWith("SELECT COUNT(*) AS total")) {
            let entries = [...rows.values()];
            if (sql.includes("name LIKE")) {
              const needles = values.slice(0, 3).map((value) => String(value).replaceAll("%", "").replaceAll("\\", "").toLowerCase());
              entries = entries.filter((entry) => entry.name.toLowerCase().includes(needles[0])
                || entry.message.toLowerCase().includes(needles[1])
                || String(entry.message_search || "").toLowerCase().includes(needles[2]));
            }
            return { total: entries.length };
          }
          if (sql.startsWith("UPDATE guestbook_entries SET auth_failure_count = CASE")) {
            const [expiredBefore, maximumFailures, , now, , , lockedUntil, id] = values;
            const entry = rows.get(id);
            const startsNewWindow = entry.auth_window_started_at_ms === 0
              || entry.auth_window_started_at_ms <= expiredBefore;
            const failureCount = startsNewWindow
              ? 1
              : Math.min(entry.auth_failure_count + 1, maximumFailures);
            const next = {
              ...entry,
              auth_failure_count: failureCount,
              auth_window_started_at_ms: startsNewWindow ? now : entry.auth_window_started_at_ms,
              auth_locked_until_ms: !startsNewWindow && failureCount >= maximumFailures
                ? lockedUntil
                : entry.auth_locked_until_ms,
            };
            rows.set(id, next);
            return {
              auth_failure_count: next.auth_failure_count,
              auth_locked_until_ms: next.auth_locked_until_ms,
            };
          }
          return rows.get(values[0]) || null;
        },
        async all() {
          if (sql.includes("WHERE message_search IS NULL")) {
            return { results: [...rows.values()].filter((entry) => entry.message_search == null).slice(0, 100) };
          }
          if (sql.includes("WHERE name = ?")) {
            return { results: [...rows.values()].filter((entry) => entry.name === values[0]).slice(0, 2) };
          }
          if (sql.includes("ORDER BY created_at DESC, id DESC")) {
            let entries = [...rows.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
            let valueIndex = 0;
            if (sql.includes("name LIKE")) {
              const needles = values.slice(valueIndex, valueIndex + 3).map((value) => String(value).replaceAll("%", "").replaceAll("\\", "").toLowerCase());
              valueIndex += 3;
              entries = entries.filter((entry) => entry.name.toLowerCase().includes(needles[0])
                || entry.message.toLowerCase().includes(needles[1])
                || String(entry.message_search || "").toLowerCase().includes(needles[2]));
            }
            if (sql.includes("created_at >= ?")) {
              const cutoff = values[valueIndex];
              valueIndex += 1;
              entries = entries.filter((entry) => entry.created_at >= cutoff);
            }
            if (sql.includes("(created_at < ? OR (created_at = ? AND id < ?))")) {
              const [createdAt, , id] = values.slice(valueIndex, valueIndex + 3);
              entries = entries.filter((entry) => entry.created_at < createdAt || (entry.created_at === createdAt && entry.id < id));
            }
            return { results: entries.slice(0, Number(values.at(-1))) };
          }
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
  assert.match(first, /^pbkdf2-sha256\$100000\$/);
  assert.equal(first.includes("correct horse"), false);
  assert.equal(await __test.verifyPassword("correct horse", first), true);
  assert.equal(await __test.verifyPassword("wrong horse", first), false);
});

test("password verifier metadata never asks workerd to exceed its PBKDF2 limit", async () => {
  assert.equal(__test.PASSWORD_ITERATIONS, 100_000);
  assert.equal(__test.MAX_PASSWORD_ITERATIONS, 100_000);
  const verifier = await __test.hashPassword("correct horse");
  const unsupported = verifier.replace("$100000$", "$600000$");
  assert.equal(await __test.verifyPassword("correct horse", unsupported), false);
});

test("credential verification has a bounded per-isolate concurrency ceiling", async () => {
  assert.equal(typeof __test.withCredentialVerificationSlot, "function");
  const releases = [];
  const active = Array.from({ length: 4 }, () => __test.withCredentialVerificationSlot(
    () => new Promise((resolve) => releases.push(resolve)),
  ));
  await assert.rejects(
    __test.withCredentialVerificationSlot(async () => true),
    (error) => error?.status === 429 && error?.code === "RATE_LIMITED",
  );
  releases.forEach((release) => release(true));
  assert.deepEqual(await Promise.all(active), [true, true, true, true]);
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
  const createPayload = await createResponse.json();
  assert.equal("id" in createPayload, false);
  const { retention } = createPayload;
  assert.equal(retention, "permanent");
  const [id] = db.rows.keys();
  const stored = db.rows.get(id);
  assert.equal(stored.message, "축하합니다");
  assert.equal(stored.password_hash.includes("eightchars"), false);

  const denied = await worker.fetch(request("/api/guestbook/entries/unlock", {
    method: "POST",
    body: JSON.stringify({ name: "하객", password: "wrongpass" }),
  }), env);
  assert.equal(denied.status, 401);

  const deniedUpdate = await worker.fetch(request("/api/guestbook/entries", {
    method: "PATCH",
    body: JSON.stringify({ name: "하객", password: "wrongpass", message: "변조 시도" }),
  }), env);
  assert.equal(deniedUpdate.status, 401);
  assert.equal(db.rows.get(id).message, "축하합니다");

  const unlocked = await worker.fetch(request("/api/guestbook/entries/unlock", {
    method: "POST",
    body: JSON.stringify({ name: "하객", password: "eightchars" }),
  }), env);
  assert.equal(unlocked.status, 200);
  const unlockedPayload = await unlocked.json();
  assert.equal(unlockedPayload.entry.message, "축하합니다");
  assert.equal("id" in unlockedPayload.entry, false);

  const updated = await worker.fetch(request("/api/guestbook/entries", {
    method: "PATCH",
    body: JSON.stringify({ name: "하객", password: "eightchars", message: "두 분 행복하세요" }),
  }), env);
  assert.equal(updated.status, 200);
  assert.equal(db.rows.get(id).message, "두 분 행복하세요");
});

test("duplicate normalized names are rejected and authentication failures stay generic", async () => {
  const db = database();
  const env = { GUESTBOOK_DB: db };
  const first = await worker.fetch(request("/api/guestbook/entries", {
    method: "POST",
    body: JSON.stringify({ name: "A하객", password: "first-pass", message: "첫 메시지" }),
  }), env);
  assert.equal(first.status, 201);

  const duplicate = await worker.fetch(request("/api/guestbook/entries", {
    method: "POST",
    body: JSON.stringify({ name: "  Ａ하객  ", password: "second-pass", message: "두 번째 메시지" }),
  }), env);
  assert.equal(duplicate.status, 409);
  const duplicatePayload = await duplicate.json();
  assert.equal(duplicatePayload.code, "ENTRY_NAME_IN_USE");
  assert.match(duplicatePayload.message, /소속이나 별칭/);

  const missingName = await worker.fetch(request("/api/guestbook/entries/unlock", {
    method: "POST",
    body: JSON.stringify({ name: "없는 하객", password: "first-pass" }),
  }), env);
  const wrongPassword = await worker.fetch(request("/api/guestbook/entries/unlock", {
    method: "POST",
    body: JSON.stringify({ name: "A하객", password: "wrong-pass" }),
  }), env);
  assert.equal(missingName.status, 401);
  assert.equal(wrongPassword.status, 401);
  assert.deepEqual(await missingName.json(), await wrongPassword.json());
});

test("unsafe legacy duplicate names fail closed instead of selecting an entry", async () => {
  const db = database();
  const verifier = await __test.hashPassword("shared-pass");
  for (const id of ["legacy-one", "legacy-two"]) {
    db.rows.set(id, {
      id,
      name: "동명이인",
      message: id,
      password_hash: verifier,
      created_at: "2026-08-17T00:00:00.000Z",
      updated_at: "2026-08-17T00:00:00.000Z",
    });
  }
  const response = await worker.fetch(request("/api/guestbook/entries/unlock", {
    method: "POST",
    body: JSON.stringify({ name: "동명이인", password: "shared-pass" }),
  }), { GUESTBOOK_DB: db });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    code: "ENTRY_AUTH_FAILED",
    message: "이름 또는 비밀번호를 확인해 주세요.",
  });
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

test("embedded null characters are rejected before a guestbook write", async () => {
  const db = database();
  const env = { GUESTBOOK_DB: db };

  const invalidName = await worker.fetch(request("/api/guestbook/entries", {
    method: "POST",
    body: JSON.stringify({ name: "\u0000", password: "abcd", message: "축하합니다" }),
  }), env);
  assert.equal(invalidName.status, 400);
  assert.equal((await invalidName.json()).code, "INVALID_NAME");

  const invalidMessage = await worker.fetch(request("/api/guestbook/entries", {
    method: "POST",
    body: JSON.stringify({ name: "하객", password: "abcd", message: "축하\u0000합니다" }),
  }), env);
  assert.equal(invalidMessage.status, 400);
  assert.equal((await invalidMessage.json()).code, "INVALID_MESSAGE");
  assert.equal(db.rows.size, 0);
});

test("oversized chunked bodies consume the caller budget and stop at the byte ceiling", async () => {
  const chunks = [4_096, 4_096, 1, 4_096].map((size) => new Uint8Array(size).fill(0x20));
  let chunkIndex = 0;
  let cancelled = false;
  let limiterCalls = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (chunkIndex >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[chunkIndex]);
      chunkIndex += 1;
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  const response = await worker.fetch(new Request("https://example.test/api/guestbook/entries", {
    method: "POST",
    duplex: "half",
    headers: {
      origin: "https://example.test",
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.40",
    },
    body,
  }), {
    GUESTBOOK_DB: database(),
    REQUIRE_GUESTBOOK_RATE_LIMIT: "1",
    GUESTBOOK_RATE_LIMITER: {
      async limit() {
        limiterCalls += 1;
        return { success: true };
      },
    },
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "BODY_TOO_LARGE");
  assert.equal(limiterCalls, 1);
  assert.equal(cancelled, true);
  assert.equal(chunkIndex, 3);
});

test("production guestbook writes fail closed without the rate limiter and never use plaintext names as keys", async () => {
  const db = database();
  const missing = await worker.fetch(request("/api/guestbook/entries", {
    method: "POST",
    body: JSON.stringify({ name: "하객", password: "abcd", message: "축하합니다" }),
  }), { GUESTBOOK_DB: db, REQUIRE_GUESTBOOK_RATE_LIMIT: "1" });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, "RATE_LIMIT_UNAVAILABLE");

  const createKeys = [];
  for (const ip of ["203.0.113.10", "203.0.113.11"]) {
    const response = await worker.fetch(request("/api/guestbook/entries", {
      method: "POST",
      headers: { "cf-connecting-ip": ip },
      body: JSON.stringify({ name: `하객-${ip}`, password: "abcd", message: "축하합니다" }),
    }), {
      GUESTBOOK_DB: db,
      REQUIRE_GUESTBOOK_RATE_LIMIT: "1",
      GUESTBOOK_RATE_LIMITER: {
        async limit({ key }) {
          createKeys.push(key);
          return { success: false };
        },
      },
    });
    assert.equal(response.status, 429);
  }
  assert.equal(createKeys[0] === createKeys[1], false);
  assert.match(createKeys[0], /^caller:[a-f0-9]{64}$/);
  assert.equal(createKeys.some((key) => key.includes("203.0.113")), false);

  let observedKey = "";
  const limited = await worker.fetch(request("/api/guestbook/entries/unlock", {
    method: "POST",
    body: JSON.stringify({ name: "비공개 하객 이름", password: "abcd" }),
  }), {
    GUESTBOOK_DB: db,
    REQUIRE_GUESTBOOK_RATE_LIMIT: "1",
    GUESTBOOK_RATE_LIMITER: {
      async limit({ key }) {
        observedKey = key;
        return { success: false };
      },
    },
  });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, "RATE_LIMITED");
  assert.equal(observedKey.includes("비공개 하객 이름"), false);
  assert.match(observedKey, /^caller:[a-f0-9]{64}$/);
});

test("different names share caller and authentication budgets before D1 work", async () => {
  const counts = new Map();
  const limiter = {
    async limit({ key }) {
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      return { success: count <= 30 };
    },
  };
  let limited = 0;
  for (let index = 0; index < 31; index += 1) {
    const response = await worker.fetch(request("/api/guestbook/entries/unlock", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.41" },
      body: JSON.stringify({ name: `공격자-${index}`, password: "1234" }),
    }), {
      GUESTBOOK_DB: database(),
      REQUIRE_GUESTBOOK_RATE_LIMIT: "1",
      GUESTBOOK_RATE_LIMITER: limiter,
      GUESTBOOK_CREDENTIAL_RATE_LIMITER: { async limit() { return { success: true }; } },
    });
    if (response.status === 429) limited += 1;
  }
  assert.equal(limited > 0, true);
  assert.equal([...counts.keys()].filter((key) => key.startsWith("caller:")).length, 1);
  assert.equal(counts.has("authentication:global"), true);
});

test("unlock and update share one privacy-preserving credential budget", async () => {
  const credentialKeys = [];
  const env = {
    GUESTBOOK_DB: database(),
    REQUIRE_GUESTBOOK_RATE_LIMIT: "1",
    GUESTBOOK_RATE_LIMITER: { async limit() { return { success: true }; } },
    GUESTBOOK_CREDENTIAL_RATE_LIMITER: {
      async limit({ key }) {
        credentialKeys.push(key);
        return { success: true };
      },
    },
  };
  const unlock = await worker.fetch(request("/api/guestbook/entries/unlock", {
    method: "POST",
    body: JSON.stringify({ name: "같은 하객", password: "1234" }),
  }), env);
  const update = await worker.fetch(request("/api/guestbook/entries", {
    method: "PATCH",
    body: JSON.stringify({ name: "같은 하객", password: "1234", message: "수정" }),
  }), env);
  assert.equal(unlock.status, 401);
  assert.equal(update.status, 401);
  assert.equal(credentialKeys.length, 2);
  assert.equal(credentialKeys[0], credentialKeys[1]);
  assert.match(credentialKeys[0], /^credential:[a-f0-9]{64}$/);
  assert.equal(credentialKeys[0].includes("같은 하객"), false);
});

test("five failed guesses lock an existing four-character credential across edge buckets", async () => {
  const db = database();
  const env = {
    GUESTBOOK_DB: db,
    REQUIRE_GUESTBOOK_RATE_LIMIT: "1",
    GUESTBOOK_RATE_LIMITER: { async limit() { return { success: true }; } },
    GUESTBOOK_CREDENTIAL_RATE_LIMITER: { async limit() { return { success: true }; } },
  };
  const created = await worker.fetch(request("/api/guestbook/entries", {
    method: "POST",
    body: JSON.stringify({ name: "네자리 하객", password: "1234", message: "축하합니다" }),
  }), env);
  assert.equal(created.status, 201);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await worker.fetch(request("/api/guestbook/entries/unlock", {
      method: "POST",
      headers: { "cf-connecting-ip": `203.0.113.${50 + attempt}` },
      body: JSON.stringify({ name: "네자리 하객", password: `000${attempt}` }),
    }), env);
    assert.equal([401, 429].includes(failed.status), true);
  }

  const locked = await worker.fetch(request("/api/guestbook/entries/unlock", {
    method: "POST",
    headers: { "cf-connecting-ip": "198.51.100.99" },
    body: JSON.stringify({ name: "네자리 하객", password: "1234" }),
  }), env);
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).code, "RATE_LIMITED");
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
  const fixture = await accessFixture();
  const env = { GUESTBOOK_DB: db, ...fixture.env };
  const denied = await worker.fetch(request("/api/guestbook/admin/entries", { method: "GET" }), env);
  assert.equal(denied.status, 401);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const allowed = await worker.fetch(request("/api/guestbook/admin/entries", {
      method: "GET",
      headers: { "cf-access-jwt-assertion": fixture.assertion },
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
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("administrator list supports search, bounded limits, counts, and opaque keyset cursors", async () => {
  const db = database();
  for (let index = 0; index < 55; index += 1) {
    const suffix = String(index).padStart(2, "0");
    db.rows.set(`entry-${suffix}`, {
      id: `entry-${suffix}`,
      name: index === 23 ? "특별 하객" : `하객 ${suffix}`,
      message: index === 23 ? "특별한 축하 메시지" : index === 24 ? "ＡＢＣ 축하" : `축하 메시지 ${suffix}`,
      password_hash: "not returned",
      created_at: `2026-08-${String(31 - Math.floor(index / 2)).padStart(2, "0")}T${String(23 - (index % 2)).padStart(2, "0")}:00:00.000Z`,
      updated_at: `2026-08-31T00:00:00.000Z`,
    });
  }
  const fixture = await accessFixture();
  const env = { GUESTBOOK_DB: db, ...fixture.env };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  const headers = { "cf-access-jwt-assertion": fixture.assertion };
  try {
    const first = await worker.fetch(request("/api/guestbook/admin/entries?limit=20", { method: "GET", headers }), env);
    const firstPayload = await first.json();
    assert.equal(firstPayload.count, 55);
    assert.equal(firstPayload.totalCount, 55);
    assert.equal(typeof firstPayload.refreshedAt, "string");
    assert.equal(firstPayload.entries.length, 20);
    assert.equal(firstPayload.hasMore, true);
    assert.equal(typeof firstPayload.nextCursor, "string");

    const second = await worker.fetch(request(`/api/guestbook/admin/entries?limit=20&cursor=${encodeURIComponent(firstPayload.nextCursor)}`, { method: "GET", headers }), env);
    const secondPayload = await second.json();
    assert.equal(secondPayload.entries.length, 20);
    assert.equal(secondPayload.entries.some((entry) => firstPayload.entries.some((firstEntry) => firstEntry.id === entry.id)), false);

    const searched = await worker.fetch(request("/api/guestbook/admin/entries?q=%ED%8A%B9%EB%B3%84&limit=10", { method: "GET", headers }), env);
    const searchedPayload = await searched.json();
    assert.equal(searchedPayload.count, 1);
    assert.equal(searchedPayload.entries[0].name, "특별 하객");

    const compatibilitySearch = await worker.fetch(request("/api/guestbook/admin/entries?q=%EF%BC%A1%EF%BC%A2%EF%BC%A3&limit=10", { method: "GET", headers }), env);
    const compatibilityPayload = await compatibilitySearch.json();
    assert.equal(compatibilityPayload.count, 1);
    assert.equal(compatibilityPayload.entries[0].message, "ＡＢＣ 축하");

    const normalizedCompatibilitySearch = await worker.fetch(request("/api/guestbook/admin/entries?q=ABC&limit=10", { method: "GET", headers }), env);
    const normalizedCompatibilityPayload = await normalizedCompatibilitySearch.json();
    assert.equal(normalizedCompatibilityPayload.count, 1);
    assert.equal(normalizedCompatibilityPayload.entries[0].message, "ＡＢＣ 축하");

    const invalidCursor = await worker.fetch(request("/api/guestbook/admin/entries?cursor=broken&limit=20", { method: "GET", headers }), env);
    assert.equal(invalidCursor.status, 400);
    assert.equal((await invalidCursor.json()).code, "INVALID_CURSOR");

    const overlongQuery = await worker.fetch(request(`/api/guestbook/admin/entries?q=${"a".repeat(51)}`, { method: "GET", headers }), env);
    assert.equal(overlongQuery.status, 400);
    assert.equal((await overlongQuery.json()).code, "INVALID_QUERY");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("administrator allowlist fails closed unless exactly two distinct deployment emails are configured", async () => {
  const fixture = await accessFixture("groom@example.test");
  const env = { GUESTBOOK_DB: database(), ...fixture.env, WEDDING_ADMIN_EMAILS: "groom@example.test,bride@example.test,extra@example.test" };
  const response = await worker.fetch(request("/api/guestbook/admin/entries", {
    method: "GET",
    headers: { "cf-access-jwt-assertion": fixture.assertion },
  }), env);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "ADMIN_AUTH_REQUIRED");
});
