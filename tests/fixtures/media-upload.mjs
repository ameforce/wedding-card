import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import worker from "../../worker/index.js";

export async function sqliteDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of ["0003_invitation_content.sql", "0004_invitation_media_quota.sql"]) {
    sqlite.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  }
  const database = {
    sqlite,
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return sqlite.prepare(sql).get(...values) || null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        runSync() {
          const statement = sqlite.prepare(sql);
          const isRead = statement.columns().length > 0;
          const result = statement.run(...values);
          return { success: true, meta: { changes: isRead || /^CREATE/i.test(sql) ? 0 : Number(result.changes) } };
        },
        async run() { return this.runSync(); },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(statement.runSync()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  return database;
}

export async function accessFixture() {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const kid = crypto.randomUUID();
  const origin = "https://media-test.cloudflareaccess.com";
  const audience = "media-test-audience";
  const encode = (value) => Buffer.from(typeof value === "string" ? value : new Uint8Array(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const token = `${encode(JSON.stringify({ alg: "RS256", kid }))}.${encode(JSON.stringify({ iss: origin, aud: audience, email: "admin@example.test", iat: now - 1, exp: now + 3600 }))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(token));
  return { assertion: `${token}.${encode(signature)}`, jwks: { keys: [{ ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid, alg: "RS256", use: "sig" }] },
    env: { ADMIN_AUTH_MODE: "cloudflare-access-jwt", ACCESS_TEAM_DOMAIN: "media-test.cloudflareaccess.com", ACCESS_AUD: audience, WEDDING_ADMIN_EMAILS: "admin@example.test,other@example.test" } };
}

export function memoryBucket() {
  const objects = new Map();
  const bodies = [];
  return { objects, bodies,
    async put(key, body, options = {}) {
      bodies.push(body);
      if (options.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      const object = { size: bytes.byteLength, httpMetadata: options.httpMetadata, bytes, body: new Blob([bytes]).stream() };
      objects.set(key, object); return object;
    },
    async head(key) { return objects.get(key) || null; },
    async get(key) { return objects.get(key) || null; },
    async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
  };
}

export const metadata = (overrides = {}) => ({ slot: "pastel-gallery-new", alt: "", position: "50% 50%", originalType: "image/jpeg", sizes: { original: 4, small: 3, large: 5 }, ...overrides });

export async function mediaFixture(t) {
  const access = await accessFixture();
  const db = await sqliteDatabase();
  const bucket = memoryBucket();
  const env = { ...access.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(access.jwks);
  t.after(() => { globalThis.fetch = oldFetch; db.sqlite.close(); });
  const request = (path, options = {}) => new Request(`https://example.test${path}`, { ...options,
    headers: { origin: "https://example.test", "cf-access-jwt-assertion": access.assertion, "content-type": "application/json", ...options.headers } });
  const call = (path, options) => worker.fetch(request(path, options), env);
  const begin = async (photos = [metadata()]) => {
    const response = await call("/api/admin/media/uploads", { method: "POST", body: JSON.stringify({ photos }) });
    return { response, payload: await response.json() };
  };
  const put = (id, part, bytes, type) => call(`/api/admin/media/uploads/${id}/${part}`, {
    method: "PUT", body: bytes, headers: { "content-length": String(bytes.byteLength), "content-type": type },
  });
  const complete = (id) => call(`/api/admin/media/uploads/${id}/complete`, { method: "POST", body: "{}" });
  const fill = async (id, sizes = metadata().sizes) => {
    for (const part of ["original", "small", "large"]) {
      const response = await put(id, part, new Uint8Array(sizes[part]), part === "original" ? "image/jpeg" : "image/webp");
      if (!response.ok) throw new Error(await response.text());
    }
  };
  return { access, db, bucket, env, request, call, begin, put, complete, fill };
}
