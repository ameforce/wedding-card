import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.js";
import { WEDDING_PHOTOS, weddingContent } from "../src/content.js";

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

async function accessFixture() {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const kid = crypto.randomUUID();
  const teamOrigin = "https://wedding-content-test.cloudflareaccess.com";
  const audience = "wedding-content-audience";
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const claims = base64Url(JSON.stringify({
    iss: teamOrigin,
    aud: audience,
    email: "groom@example.test",
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
      ACCESS_TEAM_DOMAIN: "wedding-content-test.cloudflareaccess.com",
      ACCESS_AUD: audience,
      WEDDING_ADMIN_EMAILS: "groom@example.test,bride@example.test",
    },
  };
}

function invitationDatabase() {
  const state = {
    draft_revision_id: null,
    published_revision_id: null,
    updated_at: "1970-01-01T00:00:00.000Z",
  };
  const revisions = new Map();
  const mediaSets = new Map();
  return {
    state,
    revisions,
    mediaSets,
    prepare(sql) {
      let values = [];
      return {
        bind(...nextValues) {
          values = nextValues;
          return this;
        },
        async first() {
          if (sql.includes("FROM invitation_state")) return { ...state };
          if (sql.includes("FROM invitation_revisions")) return revisions.get(values[0]) || null;
          if (sql.includes("FROM invitation_media_sets")) {
            const active = [...mediaSets.values()].filter((entry) => ["reserved", "stored"].includes(entry.status));
            return {
              used_bytes: active.reduce((total, entry) => total + entry.total_bytes, 0),
              media_sets: active.length,
            };
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM invitation_revisions")) return { results: [...revisions.values()] };
          return { results: [] };
        },
        async run() {
          let changes = 1;
          if (sql.startsWith("INSERT INTO invitation_revisions")) {
            const [id, contentJson, createdAt, createdBy] = values;
            revisions.set(id, {
              id,
              content_json: contentJson,
              status: "draft",
              created_at: createdAt,
              created_by: createdBy,
              published_at: null,
            });
          } else if (sql.startsWith("INSERT INTO invitation_media_sets")) {
            const [id, slot, totalBytes, createdAt, , limitBytes] = values;
            const usedBytes = [...mediaSets.values()]
              .filter((entry) => ["reserved", "stored"].includes(entry.status))
              .reduce((total, entry) => total + entry.total_bytes, 0);
            if (usedBytes + totalBytes <= limitBytes) {
              mediaSets.set(id, { id, slot, total_bytes: totalBytes, status: "reserved", created_at: createdAt, stored_at: null });
            } else {
              changes = 0;
            }
          } else if (sql.includes("UPDATE invitation_media_sets SET status = 'stored'")) {
            const [storedAt, id] = values;
            const row = mediaSets.get(id);
            if (row?.status === "reserved") {
              row.status = "stored";
              row.stored_at = storedAt;
            } else {
              changes = 0;
            }
          } else if (sql.includes("DELETE FROM invitation_media_sets")) {
            const row = mediaSets.get(values[0]);
            changes = row?.status === "reserved" && mediaSets.delete(values[0]) ? 1 : 0;
          } else if (sql.includes("SET draft_revision_id = ?, updated_at = ?")) {
            [state.draft_revision_id, state.updated_at] = values;
          } else if (sql.includes("SET draft_revision_id = NULL, published_revision_id = ?")) {
            [state.published_revision_id, state.updated_at] = values;
            state.draft_revision_id = null;
          } else if (sql.includes("SET published_revision_id = ?, updated_at = ?")) {
            [state.published_revision_id, state.updated_at] = values;
          } else if (sql.includes("SET status = 'archived'")) {
            const row = revisions.get(values[0]);
            if (row) row.status = "archived";
          } else if (sql.includes("SET status = 'published'")) {
            const [publishedAt, id] = values;
            const row = revisions.get(id);
            row.status = "published";
            row.published_at = publishedAt;
          }
          return { success: true, meta: { changes } };
        },
      };
    },
  };
}

function confirmedDocument() {
  const document = structuredClone({ schemaVersion: 1, content: weddingContent, photos: WEDDING_PHOTOS });
  document.content.isDesignPlaceholder = false;
  document.content.unconfirmedContent = [];
  return document;
}

test("public content fails closed until an invitation revision is published", async () => {
  const response = await worker.fetch(request("/api/content", { method: "GET" }), {
    GUESTBOOK_DB: invitationDatabase(),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "CONTENT_NOT_PUBLISHED");
});

test("Access-authenticated admins can save a draft and publish an immutable revision", async () => {
  const db = invitationDatabase();
  const fixture = await accessFixture();
  const env = { GUESTBOOK_DB: db, ...fixture.env };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const headers = { "cf-access-jwt-assertion": fixture.assertion };
    const draftResponse = await worker.fetch(request("/api/admin/content", {
      method: "PUT",
      headers,
      body: JSON.stringify({ document: confirmedDocument() }),
    }), env);
    assert.equal(draftResponse.status, 201);
    const { revisionId } = await draftResponse.json();
    assert.equal(db.state.draft_revision_id, revisionId);
    assert.equal(db.revisions.get(revisionId).status, "draft");

    const publishResponse = await worker.fetch(request("/api/admin/content/publish", {
      method: "POST",
      headers,
      body: JSON.stringify({ revisionId }),
    }), env);
    assert.equal(publishResponse.status, 200);
    assert.equal(db.state.published_revision_id, revisionId);
    assert.equal(db.revisions.get(revisionId).status, "published");

    const publicResponse = await worker.fetch(request("/api/content", { method: "GET" }), env);
    assert.equal(publicResponse.status, 200);
    const publicPayload = await publicResponse.json();
    assert.equal(publicPayload.revisionId, revisionId);
    assert.equal(publicPayload.document.content.publishing.searchIndexing, false);
    assert.equal(publicResponse.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, nosnippet, noimageindex");

    const secondDocument = confirmedDocument();
    secondDocument.content.message = ["두 번째 공개본"];
    const secondDraft = await worker.fetch(request("/api/admin/content", {
      method: "PUT",
      headers,
      body: JSON.stringify({ document: secondDocument }),
    }), env);
    const secondRevisionId = (await secondDraft.json()).revisionId;
    await worker.fetch(request("/api/admin/content/publish", {
      method: "POST",
      headers,
      body: JSON.stringify({ revisionId: secondRevisionId }),
    }), env);
    assert.equal(db.revisions.get(revisionId).status, "archived");
    const rollbackResponse = await worker.fetch(request("/api/admin/content/rollback", {
      method: "POST",
      headers,
      body: JSON.stringify({ revisionId }),
    }), env);
    assert.equal(rollbackResponse.status, 200);
    assert.equal(db.state.published_revision_id, revisionId);
    assert.equal(db.revisions.get(revisionId).status, "published");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("content publishing rejects unconfirmed or search-indexable documents", async () => {
  const db = invitationDatabase();
  const fixture = await accessFixture();
  const env = { GUESTBOOK_DB: db, ...fixture.env };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const headers = { "cf-access-jwt-assertion": fixture.assertion };
    const unsafe = confirmedDocument();
    unsafe.content.publishing.searchIndexing = true;
    const unsafeResponse = await worker.fetch(request("/api/admin/content", {
      method: "PUT",
      headers,
      body: JSON.stringify({ document: unsafe }),
    }), env);
    assert.equal(unsafeResponse.status, 400);
    assert.equal((await unsafeResponse.json()).code, "SEARCH_PRIVACY_REQUIRED");

    const unconfirmed = confirmedDocument();
    unconfirmed.content.unconfirmedContent = [{ key: "publishing.og", label: "OG" }];
    unconfirmed.content.isDesignPlaceholder = true;
    const draftResponse = await worker.fetch(request("/api/admin/content", {
      method: "PUT",
      headers,
      body: JSON.stringify({ document: unconfirmed }),
    }), env);
    const { revisionId } = await draftResponse.json();
    const publishResponse = await worker.fetch(request("/api/admin/content/publish", {
      method: "POST",
      headers,
      body: JSON.stringify({ revisionId }),
    }), env);
    assert.equal(publishResponse.status, 409);
    assert.equal((await publishResponse.json()).code, "UNCONFIRMED_CONTENT");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin content routes fail closed without the Cloudflare Access JWT contract", async () => {
  const response = await worker.fetch(request("/api/admin/content", { method: "GET" }), {
    GUESTBOOK_DB: invitationDatabase(),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "ADMIN_AUTH_UNAVAILABLE");
});

test("Access-authenticated media uploads keep private immutable R2 keys and expose only optimized variants", async () => {
  const fixture = await accessFixture();
  const objects = new Map();
  const bucket = {
    async put(key, value, options) {
      objects.set(key, { value: new Uint8Array(value), httpMetadata: options.httpMetadata, etag: `etag-${objects.size}` });
    },
    async get(key) {
      const object = objects.get(key);
      return object ? { body: object.value, httpMetadata: object.httpMetadata, etag: object.etag } : null;
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  const form = new FormData();
  form.set("slot", "pastel-hero");
  form.set("alt", "신랑과 신부의 상단 사진");
  form.set("position", "50% 58%");
  form.set("original", new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }));
  form.set("small", new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }));
  form.set("large", new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }));
  const uploadRequest = new Request("https://example.test/api/admin/media", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      "cf-access-jwt-assertion": fixture.assertion,
    },
    body: form,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const db = invitationDatabase();
    const response = await worker.fetch(uploadRequest, { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.match(payload.photo.src, /^\/api\/media\/invitation\/[a-f0-9-]{36}\/pastel-hero\/480\.webp$/);
    assert.equal(payload.photo.alt, "신랑과 신부의 상단 사진");
    assert.equal(objects.size, 3);
    assert.equal(payload.usage.usedBytes, 8);
    assert.equal(payload.usage.limitBytes, 2 * 1024 * 1024 * 1024);
    assert.equal([...objects.keys()].some((key) => key.includes("/original.jpg")), true);

    const mediaResponse = await worker.fetch(request(payload.photo.src, { method: "GET" }), { WEDDING_MEDIA: bucket });
    assert.equal(mediaResponse.status, 200);
    assert.equal(mediaResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(mediaResponse.headers.get("content-type"), "image/webp");
    assert.deepEqual(new Uint8Array(await mediaResponse.arrayBuffer()), new Uint8Array([4, 5]));

    const usageResponse = await worker.fetch(request("/api/admin/media/usage", {
      headers: { "cf-access-jwt-assertion": fixture.assertion },
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(usageResponse.status, 200);
    assert.equal((await usageResponse.json()).mediaSets, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("media uploads fail closed before R2 writes when the 2GB project quota would be exceeded", async () => {
  const fixture = await accessFixture();
  const db = invitationDatabase();
  const limitBytes = 2 * 1024 * 1024 * 1024;
  const storedBytes = limitBytes - 4;
  db.mediaSets.set("existing-media", {
    id: "existing-media",
    slot: "pastel-hero",
    total_bytes: storedBytes,
    status: "stored",
    created_at: "2026-08-17T00:00:00.000Z",
    stored_at: "2026-08-17T00:00:01.000Z",
  });
  let putCount = 0;
  const bucket = {
    async put() { putCount += 1; },
    async get() { return null; },
    async delete() {},
  };
  const form = new FormData();
  form.set("slot", "pastel-hero");
  form.set("alt", "용량 제한 검증 사진");
  form.set("position", "50% 50%");
  form.set("original", new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }));
  form.set("small", new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }));
  form.set("large", new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const response = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion },
      body: form,
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 507);
    assert.equal((await response.json()).code, "MEDIA_STORAGE_LIMIT");
    assert.equal(putCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
