const API_PREFIX = "/api/guestbook";
const CONTENT_API_PREFIX = "/api/content";
const ADMIN_API_PREFIX = "/api/admin";
const MEDIA_API_PREFIX = "/api/media";
const ADMIN_CONTENT_PAGE = "/admin";
const LEGACY_ADMIN_CONTENT_PAGE = "/admin/content";
// workerd rejects PBKDF2 requests above 100,000 iterations. Keep the value in
// the encoded verifier and reject unsupported verifier metadata before asking
// Web Crypto to derive any bits.
const PASSWORD_ITERATIONS = 100_000;
const MAX_PASSWORD_ITERATIONS = 100_000;
const MAX_CONCURRENT_CREDENTIAL_CHECKS = 4;
const AUTH_FAILURE_LIMIT = 5;
const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_LOCK_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 8_192;
const MAX_CONTENT_BODY_BYTES = 131_072;
const MAX_MEDIA_BODY_BYTES = 30 * 1024 * 1024;
const MAX_AUDIO_FILE_BYTES = 25 * 1024 * 1024;
const MEDIA_STORAGE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const GUESTBOOK_RETENTION = "permanent";
const PUBLIC_BOOTSTRAP_SCHEMA_VERSION = 1;
const PUBLIC_BOOTSTRAP_MARKER = "<!-- WEDDING_PUBLIC_BOOTSTRAP -->";
const PUBLIC_BOOTSTRAP_ID = "wedding-public-bootstrap";
const SEARCH_ROBOTS_DIRECTIVE = "noindex, nofollow, noarchive, nosnippet, noimageindex";
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "upgrade-insecure-requests",
].join("; ");
const ACCESS_JWKS_TTL_MS = 5 * 60 * 1000;
const accessKeyCache = new Map();
let activeCredentialChecks = 0;

function withSearchPrivacy(response, env) {
  const headers = new Headers(response.headers);
  headers.set("x-robots-tag", SEARCH_ROBOTS_DIRECTIVE);
  headers.set("content-security-policy", CONTENT_SECURITY_POLICY);
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "SAMEORIGIN");
  if (typeof env?.CF_VERSION_METADATA?.id === "string" && env.CF_VERSION_METADATA.id) {
    headers.set("x-wedding-worker-version", env.CF_VERSION_METADATA.id);
  }
  if (typeof env?.CF_VERSION_METADATA?.tag === "string" && env.CF_VERSION_METADATA.tag) {
    headers.set("x-wedding-worker-tag", env.CF_VERSION_METADATA.tag);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function apiError(status, code, message, details = {}) {
  return json({ code, message, ...details }, status);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function derivePassword(password, salt, iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derivePassword(password, salt);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(derived)}`;
}

async function privacyPreservingRateKey(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rateLimitError() {
  return { status: 429, code: "RATE_LIMITED", message: "요청이 많습니다. 잠시 후 다시 시도해 주세요." };
}

async function requireRateLimit(binding, key) {
  const result = await binding.limit({ key });
  if (!result?.success) throw rateLimitError();
}

async function enforceGuestbookCallerRateLimit(env, request, { authentication = false } = {}) {
  if (env.REQUIRE_GUESTBOOK_RATE_LIMIT !== "1") return;
  if (!env.GUESTBOOK_RATE_LIMITER || typeof env.GUESTBOOK_RATE_LIMITER.limit !== "function") {
    throw { status: 503, code: "RATE_LIMIT_UNAVAILABLE", message: "방명록 보호 기능이 아직 연결되지 않았습니다." };
  }
  const actor = request.headers.get("cf-connecting-ip")?.trim() || "unknown-client";
  await requireRateLimit(env.GUESTBOOK_RATE_LIMITER, `caller:${await privacyPreservingRateKey(actor)}`);
  if (authentication) {
    await requireRateLimit(env.GUESTBOOK_RATE_LIMITER, "authentication:global");
  }
}

async function enforceGuestbookCredentialRateLimit(env, name) {
  if (env.REQUIRE_GUESTBOOK_RATE_LIMIT !== "1") return;
  if (!env.GUESTBOOK_CREDENTIAL_RATE_LIMITER
    || typeof env.GUESTBOOK_CREDENTIAL_RATE_LIMITER.limit !== "function") {
    throw { status: 503, code: "RATE_LIMIT_UNAVAILABLE", message: "방명록 보호 기능이 아직 연결되지 않았습니다." };
  }
  await requireRateLimit(
    env.GUESTBOOK_CREDENTIAL_RATE_LIMITER,
    `credential:${await privacyPreservingRateKey(name)}`,
  );
}

async function withCredentialVerificationSlot(operation) {
  if (activeCredentialChecks >= MAX_CONCURRENT_CREDENTIAL_CHECKS) throw rateLimitError();
  activeCredentialChecks += 1;
  try {
    return await operation();
  } finally {
    activeCredentialChecks -= 1;
  }
}

async function verifyPassword(password, encoded) {
  const [algorithm, iterationsText, saltText, hashText] = String(encoded).split("$");
  const iterations = Number(iterationsText);
  if (algorithm !== "pbkdf2-sha256"
    || !Number.isSafeInteger(iterations)
    || iterations < PASSWORD_ITERATIONS
    || iterations > MAX_PASSWORD_ITERATIONS
    || !saltText
    || !hashText) return false;
  const expected = base64ToBytes(hashText);
  const actual = await derivePassword(password, base64ToBytes(saltText), iterations);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw { status: 415, code: "JSON_REQUIRED", message: "JSON 요청만 허용됩니다." };
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw { status: 413, code: "BODY_TOO_LARGE", message: "요청이 너무 큽니다." };
  }

  const reader = request.body?.getReader();
  const chunks = [];
  let byteLength = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          throw { status: 400, code: "INVALID_JSON", message: "요청 형식이 올바르지 않습니다." };
        }
        byteLength += value.byteLength;
        if (byteLength > maxBytes) {
          await reader.cancel().catch(() => {});
          throw { status: 413, code: "BODY_TOO_LARGE", message: "요청이 너무 큽니다." };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw { status: 400, code: "INVALID_JSON", message: "요청 형식이 올바르지 않습니다." };
  }
}

function requireSameOrigin(request) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin !== requestUrl.origin) {
    throw { status: 403, code: "CROSS_ORIGIN_DENIED", message: "동일 출처 요청만 허용됩니다." };
  }
}

function normalizeEntry(payload, { requireMessage = true } = {}) {
  const name = typeof payload.name === "string" ? payload.name.trim().normalize("NFKC") : "";
  const password = typeof payload.password === "string" ? payload.password : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  // SQLite's length() stops at U+0000, while JavaScript string length does not.
  // Reject it here so a malformed pasted value cannot reach the table CHECK
  // constraint and turn a visitor validation error into a generic 500.
  if (name.length < 1 || name.length > 30 || name.includes("\u0000")) {
    throw { status: 400, code: "INVALID_NAME", message: "이름은 1~30자로 입력해 주세요." };
  }
  if (password.length < 4 || password.length > 72) throw { status: 400, code: "INVALID_PASSWORD", message: "비밀번호는 4~72자로 입력해 주세요." };
  if (requireMessage && (message.length < 1 || message.length > 500 || message.includes("\u0000"))) {
    throw { status: 400, code: "INVALID_MESSAGE", message: "메시지는 1~500자로 입력해 주세요." };
  }
  return { name, password, message };
}

function requireDatabase(env) {
  if (!env.GUESTBOOK_DB || typeof env.GUESTBOOK_DB.prepare !== "function") {
    throw { status: 503, code: "GUESTBOOK_UNAVAILABLE", message: "방명록 저장소가 아직 연결되지 않았습니다." };
  }
  return env.GUESTBOOK_DB;
}

async function findEntriesByName(db, name) {
  const result = await db.prepare(
    "SELECT id, name, message, password_hash, created_at, updated_at, auth_failure_count, auth_window_started_at_ms, auth_locked_until_ms FROM guestbook_entries WHERE name = ? LIMIT 2",
  ).bind(name).all();
  return result.results || [];
}

async function recordCredentialFailure(db, entry, now) {
  const expiredBefore = now - AUTH_FAILURE_WINDOW_MS;
  const result = await db.prepare(
    `UPDATE guestbook_entries SET auth_failure_count = CASE
      WHEN auth_window_started_at_ms = 0 OR auth_window_started_at_ms <= ? THEN 1
      ELSE MIN(auth_failure_count + 1, ?)
    END, auth_window_started_at_ms = CASE
      WHEN auth_window_started_at_ms = 0 OR auth_window_started_at_ms <= ? THEN ?
      ELSE auth_window_started_at_ms
    END, auth_locked_until_ms = CASE
      WHEN auth_window_started_at_ms = 0 OR auth_window_started_at_ms <= ? THEN 0
      WHEN auth_failure_count + 1 >= ? THEN ?
      ELSE auth_locked_until_ms
    END WHERE id = ? RETURNING auth_failure_count, auth_locked_until_ms`,
  ).bind(
    expiredBefore,
    AUTH_FAILURE_LIMIT,
    expiredBefore,
    now,
    expiredBefore,
    AUTH_FAILURE_LIMIT,
    now + AUTH_LOCK_MS,
    entry.id,
  ).first();
  if (!result) throw new Error("guestbook credential failure state was not updated");
  return result;
}

async function resetCredentialFailures(db, entry) {
  if (!Number(entry.auth_failure_count) && !Number(entry.auth_locked_until_ms)) return;
  await db.prepare(
    "UPDATE guestbook_entries SET auth_failure_count = 0, auth_window_started_at_ms = 0, auth_locked_until_ms = 0 WHERE id = ?",
  ).bind(entry.id).run();
}

async function requireUniqueCredentialMatch(db, name, password) {
  const candidates = await findEntriesByName(db, name);
  if (candidates.length !== 1) {
    throw { status: 401, code: "ENTRY_AUTH_FAILED", message: "이름 또는 비밀번호를 확인해 주세요." };
  }
  const entry = candidates[0];
  const now = Date.now();
  if (Number(entry.auth_locked_until_ms) > now) throw rateLimitError();
  let passwordMatches = false;
  try {
    passwordMatches = await withCredentialVerificationSlot(
      () => verifyPassword(password, entry.password_hash),
    );
  } catch (error) {
    if (error?.status === 429) throw error;
    passwordMatches = false;
  }
  if (!passwordMatches) {
    const failure = await recordCredentialFailure(db, entry, now);
    if (Number(failure.auth_locked_until_ms) > now) throw rateLimitError();
    throw { status: 401, code: "ENTRY_AUTH_FAILED", message: "이름 또는 비밀번호를 확인해 주세요." };
  }
  await resetCredentialFailures(db, entry);
  return entry;
}

async function createEntry(request, env) {
  requireSameOrigin(request);
  const db = requireDatabase(env);
  await enforceGuestbookCallerRateLimit(env, request);
  const { name, password, message } = normalizeEntry(await readJson(request));
  const existingEntries = await findEntriesByName(db, name);
  if (existingEntries.length > 0) {
    return apiError(409, "ENTRY_NAME_IN_USE", "같은 이름으로 작성한 글이 이미 있습니다. 소속이나 별칭을 이름에 덧붙여 구분해 주세요.");
  }
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const passwordHash = await hashPassword(password);
  try {
    await db.prepare(
      "INSERT INTO guestbook_entries (id, name, message, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, name, message, passwordHash, timestamp, timestamp).run();
  } catch (error) {
    const racedEntry = await findEntriesByName(db, name);
    if (racedEntry.length > 0) {
      return apiError(409, "ENTRY_NAME_IN_USE", "같은 이름으로 작성한 글이 이미 있습니다. 소속이나 별칭을 이름에 덧붙여 구분해 주세요.");
    }
    throw error;
  }
  return json({ retention: GUESTBOOK_RETENTION }, 201);
}

async function unlockEntry(request, env) {
  requireSameOrigin(request);
  const db = requireDatabase(env);
  await enforceGuestbookCallerRateLimit(env, request, { authentication: true });
  const { name, password } = normalizeEntry(await readJson(request), { requireMessage: false });
  await enforceGuestbookCredentialRateLimit(env, name);
  const entry = await requireUniqueCredentialMatch(db, name, password);
  return json({ entry: { name: entry.name, message: entry.message, updatedAt: entry.updated_at } });
}

async function updateEntry(request, env) {
  requireSameOrigin(request);
  const db = requireDatabase(env);
  await enforceGuestbookCallerRateLimit(env, request, { authentication: true });
  const { name, password, message } = normalizeEntry(await readJson(request));
  await enforceGuestbookCredentialRateLimit(env, name);
  const entry = await requireUniqueCredentialMatch(db, name, password);
  const updatedAt = new Date().toISOString();
  await db.prepare("UPDATE guestbook_entries SET message = ?, updated_at = ? WHERE id = ?").bind(message, updatedAt, entry.id).run();
  return json({ updatedAt });
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return base64ToBytes(padded);
}

function decodeJwtJson(segment) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
}

function configuredAdminEmails(env) {
  const allowed = String(env.WEDDING_ADMIN_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return allowed.length === 2 && new Set(allowed).size === 2 ? allowed : null;
}

function accessTeamOrigin(env) {
  const raw = String(env.ACCESS_TEAM_DOMAIN || "").trim().toLowerCase();
  if (!raw) return null;
  let host;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(host)) return null;
  return `https://${host}`;
}

async function getAccessJwk(teamOrigin, kid) {
  const cacheKey = `${teamOrigin}:${kid}`;
  const cached = accessKeyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.key;
  const response = await fetch(`${teamOrigin}/cdn-cgi/access/certs`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("Access JWKS unavailable");
  const body = await response.json();
  const jwk = Array.isArray(body.keys) ? body.keys.find((candidate) => candidate.kid === kid) : null;
  if (!jwk || jwk.kty !== "RSA") throw new Error("Access signing key unavailable");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  accessKeyCache.set(cacheKey, { key, expiresAt: Date.now() + ACCESS_JWKS_TTL_MS });
  return key;
}

async function verifyAccessJwt(assertion, env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const teamOrigin = accessTeamOrigin(env);
  const audience = String(env.ACCESS_AUD || "").trim();
  const allowed = configuredAdminEmails(env);
  if (!teamOrigin || !audience || !allowed || !assertion) return null;
  const segments = assertion.split(".");
  if (segments.length !== 3) return null;
  try {
    const header = decodeJwtJson(segments[0]);
    const claims = decodeJwtJson(segments[1]);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
    const key = await getAccessJwk(teamOrigin, header.kid);
    const validSignature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      decodeBase64Url(segments[2]),
      new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
    );
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (!validSignature
      || claims.iss !== teamOrigin
      || !audiences.includes(audience)
      || !Number.isFinite(claims.exp)
      || claims.exp <= nowSeconds
      || (Number.isFinite(claims.nbf) && claims.nbf > nowSeconds)
      || !allowed.includes(email)) return null;
    return email;
  } catch {
    return null;
  }
}

async function requireAdminEmail(request, env) {
  if (env.ADMIN_AUTH_MODE !== "cloudflare-access-jwt") {
    throw { status: 503, code: "ADMIN_AUTH_UNAVAILABLE", message: "관리자 인증 공급자가 아직 연결되지 않았습니다." };
  }
  const assertion = request.headers.get("cf-access-jwt-assertion");
  const email = await verifyAccessJwt(assertion, env);
  if (!email) throw { status: 401, code: "ADMIN_AUTH_REQUIRED", message: "신랑·신부 계정 인증이 필요합니다." };
  return email;
}

async function listAdminEntries(request, env) {
  const db = requireDatabase(env);
  await requireAdminEmail(request, env);
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") || "").normalize("NFKC").trim();
  if (query.length > 50) throw { status: 400, code: "INVALID_QUERY", message: "검색어는 50자 이내로 입력해 주세요." };
  const range = url.searchParams.get("range") || "all";
  if (!["all", "7d", "30d"].includes(range)) {
    throw { status: 400, code: "INVALID_RANGE", message: "조회 기간을 확인해 주세요." };
  }
  const limitValue = Number(url.searchParams.get("limit") || 50);
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100) {
    throw { status: 400, code: "INVALID_LIMIT", message: "한 번에 1~100개의 메시지를 조회할 수 있습니다." };
  }
  let cursor = null;
  const cursorValue = url.searchParams.get("cursor");
  if (cursorValue) {
    if (cursorValue.length > 512) throw { status: 400, code: "INVALID_CURSOR", message: "목록 위치가 만료되었습니다. 새로고침해 주세요." };
    try {
      cursor = JSON.parse(new TextDecoder().decode(decodeBase64Url(cursorValue)));
      if (!cursor || typeof cursor.createdAt !== "string" || typeof cursor.id !== "string"
        || Number.isNaN(Date.parse(cursor.createdAt)) || !cursor.id || cursor.id.length > 128) throw new Error("invalid cursor");
    } catch {
      throw { status: 400, code: "INVALID_CURSOR", message: "목록 위치가 만료되었습니다. 새로고침해 주세요." };
    }
  }

  const where = [];
  const values = [];
  if (query) {
    const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    where.push("(name LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\')");
    values.push(`%${escaped}%`, `%${escaped}%`);
  }
  if (range !== "all") {
    const days = range === "7d" ? 7 : 30;
    where.push("created_at >= ?");
    values.push(new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
  }
  const filterSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const countRow = await db.prepare(`SELECT COUNT(*) AS total FROM guestbook_entries${filterSql}`).bind(...values).first();
  const pageWhere = [...where];
  const pageValues = [...values];
  if (cursor) {
    pageWhere.push("(created_at < ? OR (created_at = ? AND id < ?))");
    pageValues.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const pageFilterSql = pageWhere.length ? ` WHERE ${pageWhere.join(" AND ")}` : "";
  pageValues.push(limitValue + 1);
  const result = await db.prepare(
    `SELECT id, name, message, created_at, updated_at FROM guestbook_entries${pageFilterSql} ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(...pageValues).all();
  const rows = result.results || [];
  const hasMore = rows.length > limitValue;
  const visibleRows = rows.slice(0, limitValue);
  const last = visibleRows.at(-1);
  const totalCount = Number(countRow?.total) || 0;
  return json({
    entries: visibleRows.map((entry) => ({
      id: entry.id,
      name: entry.name,
      message: entry.message,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
    })),
    totalCount,
    refreshedAt: new Date().toISOString(),
    count: totalCount,
    hasMore,
    nextCursor: hasMore && last
      ? bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ createdAt: last.created_at, id: last.id })))
      : null,
  });
}

function requireContentDatabase(env) {
  if (!env.GUESTBOOK_DB || typeof env.GUESTBOOK_DB.prepare !== "function") {
    throw { status: 503, code: "CONTENT_UNAVAILABLE", message: "초대장 콘텐츠 저장소가 아직 연결되지 않았습니다." };
  }
  return env.GUESTBOOK_DB;
}

function requirePlainObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw { status: 400, code: "INVALID_CONTENT", message: `${path} 형식이 올바르지 않습니다.` };
  }
  return value;
}

function requireText(value, path, maxLength = 500) {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > maxLength) {
    throw { status: 400, code: "INVALID_CONTENT", message: `${path} 값을 확인해 주세요.` };
  }
}

function requireHttpsUrl(value, path) {
  requireText(value, path, 2048);
  try {
    if (new URL(value).protocol !== "https:") throw new Error("not https");
  } catch {
    throw { status: 400, code: "INVALID_CONTENT", message: `${path} 값은 HTTPS 주소여야 합니다.` };
  }
}

function requireMusicSource(value) {
  requireText(value, "content.music.src", 2048);
  if (!/^(?:\/assets\/audio\/[a-z0-9._-]+\.mp3|\/api\/media\/invitation\/[a-f0-9-]{36}\/background-music\/track\.mp3)$/i.test(value)) {
    throw { status: 400, code: "INVALID_CONTENT", message: "content.music.src 값은 업로드된 MP3 경로여야 합니다." };
  }
}

function derivedEventLabels(isoDate, startTime24h) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || "") || !/^\d{2}:\d{2}$/.test(startTime24h || "")) return null;
  const [year, month, day] = isoDate.split("-").map(Number);
  const [hour, minute] = startTime24h.split(":").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const weekdays = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
  return {
    dateLabel: `${year}년 ${month}월 ${day}일`,
    day: weekdays[date.getUTCDay()],
    time: `${hour < 12 ? "오전" : "오후"} ${hour % 12 || 12}시${minute ? ` ${minute}분` : ""}`,
  };
}

function validateInvitationDocument(document, { publish = false, write = false } = {}) {
  requirePlainObject(document, "document");
  if (![1, 2].includes(document.schemaVersion)) {
    throw { status: 400, code: "UNSUPPORTED_CONTENT_SCHEMA", message: "지원하지 않는 초대장 콘텐츠 버전입니다." };
  }
  const content = requirePlainObject(document.content, "content");
  const photos = requirePlainObject(document.photos, "photos");
  requirePlainObject(photos.pastel, "photos.pastel");
  requirePlainObject(photos.pastel.hero, "photos.pastel.hero");
  requireText(photos.pastel.hero.src, "photos.pastel.hero.src", 500);
  requireText(photos.pastel.hero.alt, "photos.pastel.hero.alt", 300);
  if (!/^\d{1,3}%\s+\d{1,3}%$/.test(photos.pastel.hero.position || "")) {
    throw { status: 400, code: "INVALID_CONTENT", message: "photos.pastel.hero.position 값을 확인해 주세요." };
  }
  if (!Array.isArray(photos.pastel.gallery) || photos.pastel.gallery.length !== 4) {
    throw { status: 400, code: "INVALID_CONTENT", message: "photos.pastel.gallery에는 사진 4개가 필요합니다." };
  }
  for (const [index, photo] of photos.pastel.gallery.entries()) {
    requirePlainObject(photo, `photos.pastel.gallery[${index}]`);
    requireText(photo.src, `photos.pastel.gallery[${index}].src`, 500);
    requireText(photo.alt, `photos.pastel.gallery[${index}].alt`, 300);
    if (!/^\d{1,3}%\s+\d{1,3}%$/.test(photo.position || "")) {
      throw { status: 400, code: "INVALID_CONTENT", message: `photos.pastel.gallery[${index}].position 값을 확인해 주세요.` };
    }
  }
  const requiredTextPaths = [
    [content.couple?.groom, "content.couple.groom", 50],
    [content.couple?.bride, "content.couple.bride", 50],
    [content.event?.isoDate, "content.event.isoDate", 20],
    [content.event?.startTime24h, "content.event.startTime24h", 10],
    [content.event?.dateLabel, "content.event.dateLabel", 30],
    [content.event?.day, "content.event.day", 10],
    [content.event?.time, "content.event.time", 30],
    [content.venue?.name, "content.venue.name", 100],
    [content.venue?.floor, "content.venue.floor", 30],
    [content.venue?.address, "content.venue.address", 300],
  ];
  for (const [value, path, maxLength] of requiredTextPaths) requireText(value, path, maxLength);
  const eventLabels = derivedEventLabels(content.event.isoDate, content.event.startTime24h);
  if (!eventLabels || content.event.dateLabel !== eventLabels.dateLabel || content.event.day !== eventLabels.day || content.event.time !== eventLabels.time
    || content.event.timezone?.iana !== "Asia/Seoul" || content.event.timezone?.utcOffset !== "+09:00") {
    throw { status: 400, code: "INVALID_EVENT", message: "예식 일시의 파생 표기와 Asia/Seoul 시간대를 확인해 주세요." };
  }
  if (!Array.isArray(content.hero?.introLines) || content.hero.introLines.length !== 2) {
    throw { status: 400, code: "INVALID_CONTENT", message: "content.hero.introLines에는 두 줄이 필요합니다." };
  }
  for (const line of content.hero.introLines) requireText(line, "content.hero.introLines[]", 80);
  if (content.rsvp?.enabled !== false || !Array.isArray(content.unconfirmedContent)) {
    throw { status: 400, code: "INVALID_CONTENT", message: "RSVP 비활성화 및 콘텐츠 확인 상태 계약을 변경할 수 없습니다." };
  }
  if (document.schemaVersion === 2) {
    const music = requirePlainObject(content.music, "content.music");
    requireMusicSource(music.src);
    requireText(music.title, "content.music.title", 80);
    requireText(music.artist, "content.music.artist", 80);
    requireHttpsUrl(music.sourceUrl, "content.music.sourceUrl");
    requireText(music.licenseLabel, "content.music.licenseLabel", 80);
    requireHttpsUrl(music.licenseUrl, "content.music.licenseUrl");
  }
  if (write && document.schemaVersion !== 2) {
    throw { status: 400, code: "UNSUPPORTED_CONTENT_SCHEMA", message: "새 초대장 콘텐츠는 schema v2로 저장해야 합니다." };
  }
  for (const [value, path] of [[content.message, "content.message"], [content.story, "content.story"]]) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
      throw { status: 400, code: "INVALID_CONTENT", message: `${path} 값을 확인해 주세요.` };
    }
    for (const line of value) requireText(line, `${path}[]`, 500);
  }
  if (content.publishing?.searchIndexing !== false) {
    throw { status: 400, code: "SEARCH_PRIVACY_REQUIRED", message: "검색 비노출 정책은 해제할 수 없습니다." };
  }
  const serialized = JSON.stringify(document);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CONTENT_BODY_BYTES) {
    throw { status: 413, code: "CONTENT_TOO_LARGE", message: "초대장 콘텐츠가 허용 크기를 초과했습니다." };
  }
  if (publish && (content.isDesignPlaceholder === true || (content.unconfirmedContent?.length || 0) > 0)) {
    throw { status: 409, code: "UNCONFIRMED_CONTENT", message: "미확정 콘텐츠를 모두 확정한 뒤 공개할 수 있습니다." };
  }
  return serialized;
}

async function getInvitationState(db) {
  return db.prepare(
    "SELECT draft_revision_id, published_revision_id, updated_at FROM invitation_state WHERE singleton_id = 1",
  ).first();
}

async function getInvitationRevision(db, id) {
  if (!id) return null;
  const row = await db.prepare(
    "SELECT id, content_json, status, created_at, created_by, published_at FROM invitation_revisions WHERE id = ?",
  ).bind(id).first();
  if (!row) return null;
  try {
    return {
      id: row.id,
      document: JSON.parse(row.content_json),
      status: row.status,
      createdAt: row.created_at,
      publishedAt: row.published_at,
    };
  } catch {
    throw { status: 500, code: "CONTENT_CORRUPTED", message: "저장된 초대장 콘텐츠를 읽지 못했습니다." };
  }
}

function invitationFromPublishedRow(row) {
  if (!row) return null;
  try {
    return {
      revisionId: row.id,
      publishedAt: row.published_at,
      document: JSON.parse(row.content_json),
    };
  } catch {
    throw { status: 500, code: "CONTENT_CORRUPTED", message: "저장된 초대장 콘텐츠를 읽지 못했습니다." };
  }
}

async function getPublishedInvitationPayload(env) {
  const db = requireContentDatabase(env);
  const row = await db.prepare(
    `SELECT revision.id, revision.content_json, revision.published_at
       FROM invitation_state AS state
      JOIN invitation_revisions AS revision ON revision.id = state.published_revision_id
      WHERE state.singleton_id = 1 AND revision.status = 'published'
      LIMIT 1`,
  ).first();
  return invitationFromPublishedRow(row);
}

function publicBootstrapPayload(published) {
  return published
    ? {
      schemaVersion: PUBLIC_BOOTSTRAP_SCHEMA_VERSION,
      source: "cloudflare-published",
      revisionId: published.revisionId,
      publishedAt: published.publishedAt,
      document: published.document,
    }
    : {
      schemaVersion: PUBLIC_BOOTSTRAP_SCHEMA_VERSION,
      source: "bundled-fallback",
      revisionId: null,
      publishedAt: null,
      document: null,
    };
}

function bootstrapHero(published, url) {
  if (url.searchParams.get("variant") === "quiet") {
    return {
      src: "/assets/photos/quiet-hero-480.webp",
      srcSet: "/assets/photos/quiet-hero-480.webp 480w, /assets/photos/quiet-hero-960.webp 960w",
      sizes: "198px",
    };
  }
  const hero = published?.document?.photos?.pastel?.hero;
  if (typeof hero?.src === "string" && hero.src) {
    return {
      src: hero.src,
      srcSet: typeof hero.srcSet === "string" ? hero.srcSet : "",
      sizes: typeof hero.sizes === "string" ? hero.sizes : "(min-width: 768px) 430px, 100vw",
    };
  }
  return {
    src: "/assets/photos/pastel-hero-480.webp",
    srcSet: "/assets/photos/pastel-hero-480.webp 480w, /assets/photos/pastel-hero-960.webp 960w",
    sizes: "(min-width: 768px) 430px, 100vw",
  };
}

async function injectPublicBootstrap(response, published, url) {
  const html = await response.text();
  const markerCount = html.split(PUBLIC_BOOTSTRAP_MARKER).length - 1;
  if (markerCount !== 1) {
    return new Response(null, {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "x-wedding-content-source": "bundled-fallback",
      },
    });
  }

  const bootstrap = publicBootstrapPayload(published);
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(bootstrap)));
  const hero = bootstrapHero(published, url);
  const preloadAttributes = [
    `href="${escapeHtmlAttribute(hero.src)}"`,
    "rel=\"preload\"",
    "as=\"image\"",
    "type=\"image/webp\"",
    "fetchpriority=\"high\"",
  ];
  if (hero.srcSet) preloadAttributes.push(`imagesrcset="${escapeHtmlAttribute(hero.srcSet)}"`);
  if (hero.sizes) preloadAttributes.push(`imagesizes="${escapeHtmlAttribute(hero.sizes)}"`);
  const injection = [
    `<template id="${PUBLIC_BOOTSTRAP_ID}" data-schema-version="${PUBLIC_BOOTSTRAP_SCHEMA_VERSION}">${encoded}</template>`,
    `<link ${preloadAttributes.join(" ")} />`,
  ].join("\n    ");
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("etag");
  headers.delete("last-modified");
  headers.set("cache-control", "no-store");
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("x-wedding-content-source", bootstrap.source);
  if (bootstrap.revisionId) headers.set("x-wedding-revision", bootstrap.revisionId);
  else headers.delete("x-wedding-revision");
  return new Response(html.replace(PUBLIC_BOOTSTRAP_MARKER, injection), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function unconditionalPublicHtmlRequest(request, target = request.url) {
  const headers = new Headers(request.headers);
  headers.delete("if-none-match");
  headers.delete("if-modified-since");
  return new Request(new Request(target, request), { headers });
}

async function runDatabaseBatch(db, statements) {
  if (typeof db.batch === "function") return db.batch(statements);
  const results = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
}

async function getPublishedInvitation(env) {
  const published = await getPublishedInvitationPayload(env);
  if (!published) return apiError(503, "CONTENT_NOT_PUBLISHED", "공개된 초대장 콘텐츠가 아직 없습니다.");
  return json(published);
}

async function getAdminInvitation(request, env) {
  const db = requireContentDatabase(env);
  await requireAdminEmail(request, env);
  const state = await getInvitationState(db);
  const [draft, published] = await Promise.all([
    getInvitationRevision(db, state?.draft_revision_id),
    getInvitationRevision(db, state?.published_revision_id),
  ]);
  const historyResult = await db.prepare(
    "SELECT id, status, created_at, published_at FROM invitation_revisions ORDER BY created_at DESC LIMIT 20",
  ).all();
  const history = (historyResult.results || []).map((revision) => ({
    id: revision.id,
    status: revision.status,
    createdAt: revision.created_at,
    publishedAt: revision.published_at,
  }));
  const historyIds = new Set(history.map((revision) => revision.id));
  for (const current of [draft, published]) {
    if (!current || historyIds.has(current.id)) continue;
    history.push({
      id: current.id,
      status: current.status,
      createdAt: current.createdAt,
      publishedAt: current.publishedAt,
    });
    historyIds.add(current.id);
  }
  history.sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || ""));
  return json({
    draftRevisionId: draft?.id || null,
    publishedRevisionId: published?.id || null,
    draft,
    published,
    history,
  });
}

async function saveInvitationDraft(request, env) {
  requireSameOrigin(request);
  const db = requireContentDatabase(env);
  const adminEmail = await requireAdminEmail(request, env);
  const payload = await readJson(request, MAX_CONTENT_BODY_BYTES);
  const contentJson = validateInvitationDocument(payload.document, { write: true });
  const state = await getInvitationState(db);
  const revisionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const statements = [];
  if (state?.draft_revision_id) {
    statements.push(db.prepare("UPDATE invitation_revisions SET status = 'archived' WHERE id = ? AND status = 'draft'")
      .bind(state.draft_revision_id));
  }
  statements.push(
    db.prepare(
      "INSERT INTO invitation_revisions (id, content_json, status, created_at, created_by, published_at) VALUES (?, ?, 'draft', ?, ?, NULL)",
    ).bind(revisionId, contentJson, createdAt, adminEmail),
    db.prepare(
      "UPDATE invitation_state SET draft_revision_id = ?, updated_at = ? WHERE singleton_id = 1",
    ).bind(revisionId, createdAt),
  );
  await runDatabaseBatch(db, statements);
  return json({ revisionId, savedAt: createdAt }, 201);
}

async function publishInvitationDraft(request, env) {
  requireSameOrigin(request);
  const db = requireContentDatabase(env);
  await requireAdminEmail(request, env);
  const payload = await readJson(request);
  const revisionId = typeof payload.revisionId === "string" ? payload.revisionId : "";
  const state = await getInvitationState(db);
  if (!revisionId || revisionId !== state?.draft_revision_id) {
    return apiError(409, "STALE_DRAFT", "현재 임시 적용본을 다시 불러온 뒤 공개해 주세요.");
  }
  const draft = await getInvitationRevision(db, revisionId);
  if (!draft || draft.status !== "draft") return apiError(409, "STALE_DRAFT", "공개할 임시 적용본이 없습니다.");
  validateInvitationDocument(draft.document, { publish: true });
  const publishedAt = new Date().toISOString();
  const statements = [];
  if (state.published_revision_id) {
    statements.push(db.prepare("UPDATE invitation_revisions SET status = 'archived' WHERE id = ? AND status = 'published'")
      .bind(state.published_revision_id));
  }
  statements.push(
    db.prepare("UPDATE invitation_revisions SET status = 'published', published_at = ? WHERE id = ?")
      .bind(publishedAt, revisionId),
    db.prepare(
      "UPDATE invitation_state SET draft_revision_id = NULL, published_revision_id = ?, updated_at = ? WHERE singleton_id = 1",
    ).bind(revisionId, publishedAt),
  );
  await runDatabaseBatch(db, statements);
  return json({ revisionId, publishedAt });
}

async function rollbackInvitation(request, env) {
  requireSameOrigin(request);
  const db = requireContentDatabase(env);
  await requireAdminEmail(request, env);
  const payload = await readJson(request);
  const revisionId = typeof payload.revisionId === "string" ? payload.revisionId : "";
  const target = await getInvitationRevision(db, revisionId);
  if (!target || !["archived", "published"].includes(target.status) || !target.publishedAt) {
    return apiError(404, "REVISION_NOT_FOUND", "되돌릴 콘텐츠 버전을 찾을 수 없습니다.");
  }
  validateInvitationDocument(target.document, { publish: true });
  const state = await getInvitationState(db);
  const publishedAt = new Date().toISOString();
  const statements = [];
  if (state?.published_revision_id && state.published_revision_id !== revisionId) {
    statements.push(db.prepare("UPDATE invitation_revisions SET status = 'archived' WHERE id = ? AND status = 'published'")
      .bind(state.published_revision_id));
  }
  statements.push(
    db.prepare("UPDATE invitation_revisions SET status = 'published', published_at = ? WHERE id = ?")
      .bind(publishedAt, revisionId),
    db.prepare(
      "UPDATE invitation_state SET published_revision_id = ?, updated_at = ? WHERE singleton_id = 1",
    ).bind(revisionId, publishedAt),
  );
  await runDatabaseBatch(db, statements);
  return json({ revisionId, publishedAt });
}

function requireMediaBucket(env) {
  if (!env.WEDDING_MEDIA || typeof env.WEDDING_MEDIA.put !== "function" || typeof env.WEDDING_MEDIA.get !== "function") {
    throw { status: 503, code: "MEDIA_UNAVAILABLE", message: "미디어 저장소가 아직 연결되지 않았습니다." };
  }
  return env.WEDDING_MEDIA;
}

function validUpload(file, types, maxBytes) {
  return file && typeof file.arrayBuffer === "function" && types.includes(file.type) && file.size > 0 && file.size <= maxBytes;
}

function mediaUsagePayload(usedBytes, mediaSets = 0) {
  const normalizedUsedBytes = Math.max(0, Number(usedBytes) || 0);
  return {
    usedBytes: normalizedUsedBytes,
    limitBytes: MEDIA_STORAGE_LIMIT_BYTES,
    remainingBytes: Math.max(0, MEDIA_STORAGE_LIMIT_BYTES - normalizedUsedBytes),
    percent: Math.min(100, Math.round((normalizedUsedBytes / MEDIA_STORAGE_LIMIT_BYTES) * 10_000) / 100),
    mediaSets: Math.max(0, Number(mediaSets) || 0),
  };
}

async function getMediaUsageFromDatabase(db) {
  const row = await db.prepare(
    "SELECT COALESCE(SUM(total_bytes), 0) AS used_bytes, COUNT(*) AS media_sets FROM invitation_media_sets WHERE status IN ('reserved', 'stored')",
  ).first();
  return mediaUsagePayload(row?.used_bytes, row?.media_sets);
}

async function getAdminMediaUsage(request, env) {
  const db = requireContentDatabase(env);
  await requireAdminEmail(request, env);
  requireMediaBucket(env);
  return json(await getMediaUsageFromDatabase(db));
}

async function reserveMediaStorage(db, { mediaId, slot, totalBytes }) {
  const createdAt = new Date().toISOString();
  const result = await db.prepare(
    `INSERT INTO invitation_media_sets (id, slot, total_bytes, status, created_at, stored_at)
     SELECT ?, ?, ?, 'reserved', ?, NULL
     WHERE (SELECT COALESCE(SUM(total_bytes), 0) FROM invitation_media_sets WHERE status IN ('reserved', 'stored')) + ? <= ?`,
  ).bind(mediaId, slot, totalBytes, createdAt, totalBytes, MEDIA_STORAGE_LIMIT_BYTES).run();
  if (!result?.meta?.changes) {
    throw { status: 507, code: "MEDIA_STORAGE_LIMIT", message: "미디어 저장 공간 2GB 한도에 도달했습니다. 기존 미디어 정리 후 다시 시도해 주세요." };
  }
}

async function releaseMediaStorage(db, mediaId) {
  await db.prepare("DELETE FROM invitation_media_sets WHERE id = ? AND status = 'reserved'").bind(mediaId).run();
}

async function commitMediaStorage(db, mediaId) {
  await db.prepare("UPDATE invitation_media_sets SET status = 'stored', stored_at = ? WHERE id = ? AND status = 'reserved'")
    .bind(new Date().toISOString(), mediaId).run();
}

async function uploadInvitationMedia(request, env) {
  requireSameOrigin(request);
  await requireAdminEmail(request, env);
  const db = requireContentDatabase(env);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_MEDIA_BODY_BYTES) return apiError(413, "MEDIA_TOO_LARGE", "이미지 업로드 크기를 줄여 주세요.");
  const bucket = requireMediaBucket(env);
  const form = await request.formData();
  const original = form.get("original");
  const small = form.get("small");
  const large = form.get("large");
  const slot = String(form.get("slot") || "").trim().toLowerCase();
  const alt = String(form.get("alt") || "").trim();
  const position = String(form.get("position") || "50% 50%").trim();
  if (!/^[a-z0-9-]{1,40}$/.test(slot) || alt.length < 1 || alt.length > 300 || position.length > 32) {
    return apiError(400, "INVALID_MEDIA_METADATA", "이미지 슬롯, 설명 또는 초점 위치를 확인해 주세요.");
  }
  if (!validUpload(original, ["image/jpeg", "image/png", "image/webp"], 25 * 1024 * 1024)
    || !validUpload(small, ["image/webp"], 2 * 1024 * 1024)
    || !validUpload(large, ["image/webp"], 4 * 1024 * 1024)
    || original.size + small.size + large.size > MAX_MEDIA_BODY_BYTES) {
    return apiError(400, "INVALID_MEDIA", "원본과 480·960px WebP 이미지를 확인해 주세요.");
  }
  const mediaId = crypto.randomUUID();
  const originalExtension = original.type === "image/png" ? "png" : original.type === "image/webp" ? "webp" : "jpg";
  const baseKey = `invitation/${mediaId}/${slot}`;
  const keys = [
    `${baseKey}/original.${originalExtension}`,
    `${baseKey}/480.webp`,
    `${baseKey}/960.webp`,
  ];
  const totalBytes = original.size + small.size + large.size;
  await reserveMediaStorage(db, { mediaId, slot, totalBytes });
  try {
    await Promise.all([
      bucket.put(keys[0], await original.arrayBuffer(), { httpMetadata: { contentType: original.type } }),
      bucket.put(keys[1], await small.arrayBuffer(), { httpMetadata: { contentType: "image/webp" } }),
      bucket.put(keys[2], await large.arrayBuffer(), { httpMetadata: { contentType: "image/webp" } }),
    ]);
    await commitMediaStorage(db, mediaId);
  } catch (error) {
    await Promise.allSettled([
      typeof bucket.delete === "function" ? bucket.delete(keys) : Promise.resolve(),
      releaseMediaStorage(db, mediaId),
    ]);
    throw error;
  }
  const src = `${MEDIA_API_PREFIX}/${baseKey}/480.webp`;
  const usage = await getMediaUsageFromDatabase(db);
  return json({
    mediaId,
    usage,
    photo: {
      src,
      srcSet: `${src} 480w, ${MEDIA_API_PREFIX}/${baseKey}/960.webp 960w`,
      sizes: "(min-width: 768px) 430px, 100vw",
      alt,
      position,
    },
  }, 201);
}

function hasMpegFrameHeader(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return false;
  const version = bytes[1] & 0x18;
  const layer = bytes[1] & 0x06;
  const bitrate = bytes[2] & 0xf0;
  const sampleRate = bytes[2] & 0x0c;
  return version !== 0x08 && layer !== 0 && bitrate !== 0 && bitrate !== 0xf0 && sampleRate !== 0x0c;
}

async function hasMp3Signature(file) {
  const header = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  let frameOffset = 0;
  if (header.length >= 10 && header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
    const validId3 = header[3] >= 2
      && header[3] <= 4
      && header[4] !== 0xff
      && header.slice(6, 10).every((value) => value < 0x80);
    if (!validId3) return false;
    const tagSize = (header[6] << 21) | (header[7] << 14) | (header[8] << 7) | header[9];
    const footerSize = header[3] === 4 && (header[5] & 0x10) !== 0 ? 10 : 0;
    frameOffset = 10 + tagSize + footerSize;
  }
  if (frameOffset + 4 > file.size) return false;
  const frame = new Uint8Array(await file.slice(frameOffset, frameOffset + 4).arrayBuffer());
  return hasMpegFrameHeader(frame);
}

async function uploadInvitationAudio(request, env) {
  requireSameOrigin(request);
  await requireAdminEmail(request, env);
  const db = requireContentDatabase(env);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_MEDIA_BODY_BYTES) return apiError(413, "MEDIA_TOO_LARGE", "MP3 파일은 25MB 이하만 업로드할 수 있습니다.");
  const bucket = requireMediaBucket(env);
  const form = await request.formData();
  const file = form.get("file");
  if (!validUpload(file, ["audio/mpeg"], MAX_AUDIO_FILE_BYTES)) {
    return apiError(400, "INVALID_AUDIO", "MP3(audio/mpeg) 파일만 25MB 이하로 업로드할 수 있습니다.");
  }
  if (!await hasMp3Signature(file)) {
    return apiError(400, "INVALID_AUDIO_SIGNATURE", "파일 내용이 올바른 MP3 형식이 아닙니다.");
  }
  const mediaId = crypto.randomUUID();
  const key = `invitation/${mediaId}/background-music/track.mp3`;
  await reserveMediaStorage(db, { mediaId, slot: "background-music", totalBytes: file.size });
  try {
    await bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: "audio/mpeg" } });
    await commitMediaStorage(db, mediaId);
  } catch (error) {
    await Promise.allSettled([
      typeof bucket.delete === "function" ? bucket.delete(key) : Promise.resolve(),
      releaseMediaStorage(db, mediaId),
    ]);
    throw error;
  }
  return json({
    mediaId,
    usage: await getMediaUsageFromDatabase(db),
    audio: {
      src: `${MEDIA_API_PREFIX}/${key}`,
      mimeType: "audio/mpeg",
      sizeBytes: file.size,
    },
  }, 201);
}

function parseByteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size < 1) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) return false;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1 };
}

function immutableMediaHeaders(object, contentType) {
  const headers = new Headers({
    "content-type": contentType,
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  const etag = object?.httpEtag || object?.etag;
  if (etag) headers.set("etag", etag);
  return headers;
}

async function getInvitationMedia(request, env, url) {
  const bucket = requireMediaBucket(env);
  const key = decodeURIComponent(url.pathname.slice(`${MEDIA_API_PREFIX}/`.length));
  const isImage = /^invitation\/[a-f0-9-]{36}\/[a-z0-9-]{1,40}\/(?:480|960)\.webp$/.test(key);
  const isAudio = /^invitation\/[a-f0-9-]{36}\/background-music\/track\.mp3$/.test(key);
  if (!isImage && !isAudio) {
    return apiError(404, "MEDIA_NOT_FOUND", "미디어를 찾을 수 없습니다.");
  }
  if (isAudio) {
    if (typeof bucket.head !== "function") {
      throw { status: 503, code: "MEDIA_UNAVAILABLE", message: "미디어 스트리밍 저장소가 아직 연결되지 않았습니다." };
    }
    const metadata = await bucket.head(key);
    if (!metadata) return apiError(404, "MEDIA_NOT_FOUND", "미디어를 찾을 수 없습니다.");
    const headers = immutableMediaHeaders(metadata, "audio/mpeg");
    headers.set("accept-ranges", "bytes");
    const size = Number(metadata.size) || 0;
    const range = parseByteRange(request.headers.get("range"), size);
    if (range === false) {
      headers.set("content-range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (request.method === "HEAD") {
      headers.set("content-length", String(size));
      return new Response(null, { headers });
    }
    if (range) {
      const object = await bucket.get(key, { range: { offset: range.start, length: range.length } });
      if (!object) return apiError(404, "MEDIA_NOT_FOUND", "미디어를 찾을 수 없습니다.");
      headers.set("content-length", String(range.length));
      headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
      return new Response(object.body, { status: 206, headers });
    }
    const object = await bucket.get(key);
    if (!object) return apiError(404, "MEDIA_NOT_FOUND", "미디어를 찾을 수 없습니다.");
    headers.set("content-length", String(size));
    return new Response(object.body, { headers });
  }
  const object = await bucket.get(key);
  if (!object) return apiError(404, "MEDIA_NOT_FOUND", "미디어를 찾을 수 없습니다.");
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers: immutableMediaHeaders(object, object.httpMetadata?.contentType || "image/webp"),
  });
}

async function handleContent(request, env, url) {
  try {
    if (url.pathname === CONTENT_API_PREFIX && request.method === "GET") return await getPublishedInvitation(env);
    if (url.pathname === `${ADMIN_API_PREFIX}/content`) {
      if (request.method === "GET") return await getAdminInvitation(request, env);
      if (request.method === "PUT") return await saveInvitationDraft(request, env);
    }
    if (url.pathname === `${ADMIN_API_PREFIX}/content/publish` && request.method === "POST") {
      return await publishInvitationDraft(request, env);
    }
    if (url.pathname === `${ADMIN_API_PREFIX}/content/rollback` && request.method === "POST") {
      return await rollbackInvitation(request, env);
    }
    if (url.pathname === `${ADMIN_API_PREFIX}/media` && request.method === "POST") {
      return await uploadInvitationMedia(request, env);
    }
    if (url.pathname === `${ADMIN_API_PREFIX}/media/audio` && request.method === "POST") {
      return await uploadInvitationAudio(request, env);
    }
    if (url.pathname === `${ADMIN_API_PREFIX}/media/usage` && request.method === "GET") {
      return await getAdminMediaUsage(request, env);
    }
    if (url.pathname.startsWith(`${MEDIA_API_PREFIX}/`) && ["GET", "HEAD"].includes(request.method)) {
      return await getInvitationMedia(request, env, url);
    }
    return apiError(404, "NOT_FOUND", "요청한 초대장 콘텐츠 경로가 없습니다.");
  } catch (error) {
    if (error && Number.isInteger(error.status)) {
      const fieldErrors = error.code === "INVALID_CONTENT"
        ? error.fieldErrors || { [String(error.message || "content").split(" ")[0]]: error.message }
        : undefined;
      return apiError(error.status, error.code, error.message, fieldErrors ? { fieldErrors } : {});
    }
    return apiError(500, "INTERNAL_ERROR", "초대장 콘텐츠 요청을 처리하지 못했습니다.");
  }
}

async function handleGuestbook(request, env, url) {
  try {
    if (url.pathname === `${API_PREFIX}/entries`) {
      if (request.method === "POST") return await createEntry(request, env);
      if (request.method === "PATCH") return await updateEntry(request, env);
      return apiError(405, "METHOD_NOT_ALLOWED", "공개 방명록 조회는 제공되지 않습니다.");
    }
    if (url.pathname === `${API_PREFIX}/entries/unlock`) {
      if (request.method === "POST") return await unlockEntry(request, env);
      return apiError(405, "METHOD_NOT_ALLOWED", "허용되지 않은 방명록 요청입니다.");
    }
    if (url.pathname === `${API_PREFIX}/admin/entries` && request.method === "GET") {
      return await listAdminEntries(request, env);
    }
    return apiError(404, "NOT_FOUND", "요청한 방명록 경로가 없습니다.");
  } catch (error) {
    if (error && Number.isInteger(error.status)) return apiError(error.status, error.code, error.message);
    return apiError(500, "INTERNAL_ERROR", "방명록 요청을 처리하지 못했습니다.");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(API_PREFIX)) {
      return withSearchPrivacy(await handleGuestbook(request, env, url), env);
    }
    if (url.pathname === CONTENT_API_PREFIX
      || url.pathname.startsWith(`${ADMIN_API_PREFIX}/`)
      || url.pathname.startsWith(`${MEDIA_API_PREFIX}/`)) {
      return withSearchPrivacy(await handleContent(request, env, url), env);
    }

    const redirectsLegacyAdmin = env.ADMIN_CONTENT_REDIRECT_ENABLED === "true"
      && url.pathname === LEGACY_ADMIN_CONTENT_PAGE
      && ["GET", "HEAD"].includes(request.method);
    if (redirectsLegacyAdmin) {
      const canonicalUrl = new URL(request.url);
      canonicalUrl.pathname = ADMIN_CONTENT_PAGE;
      return withSearchPrivacy(Response.redirect(canonicalUrl.toString(), 308), env);
    }

    const acceptsHtml = request.headers.get("accept")?.includes("text/html");
    const servesAdminShell = [ADMIN_CONTENT_PAGE, LEGACY_ADMIN_CONTENT_PAGE, "/admin/guestbook"].includes(url.pathname)
      && acceptsHtml
      && ["GET", "HEAD"].includes(request.method);

    if (servesAdminShell) {
      const indexUrl = new URL(request.url);
      indexUrl.pathname = "/";
      indexUrl.search = "";
      return withSearchPrivacy(await env.ASSETS.fetch(new Request(indexUrl, request)), env);
    }

    if (!acceptsHtml || !["GET", "HEAD"].includes(request.method)) {
      return withSearchPrivacy(await env.ASSETS.fetch(request), env);
    }

    if (request.method === "HEAD") {
      const response = await env.ASSETS.fetch(request);
      if (response.status !== 404) return withSearchPrivacy(response, env);
      const indexUrl = new URL(request.url);
      indexUrl.pathname = "/";
      indexUrl.search = "";
      return withSearchPrivacy(await env.ASSETS.fetch(new Request(indexUrl, request)), env);
    }

    const publicAssetRequest = unconditionalPublicHtmlRequest(request);
    const [assetResult, publishedResult] = await Promise.allSettled([
      env.ASSETS.fetch(publicAssetRequest),
      getPublishedInvitationPayload(env),
    ]);
    if (assetResult.status === "rejected") throw assetResult.reason;
    let response = assetResult.value;
    if (response.status === 404) {
      const indexUrl = new URL(request.url);
      indexUrl.pathname = "/";
      indexUrl.search = "";
      response = await env.ASSETS.fetch(unconditionalPublicHtmlRequest(request, indexUrl));
    }
    if (response.status !== 200) return withSearchPrivacy(response, env);
    const published = publishedResult.status === "fulfilled" ? publishedResult.value : null;
    return withSearchPrivacy(await injectPublicBootstrap(response, published, url), env);
  },
};

export const __test = {
  PASSWORD_ITERATIONS,
  MAX_PASSWORD_ITERATIONS,
  withCredentialVerificationSlot,
  hashPassword,
  verifyPassword,
  verifyAccessJwt,
  validateInvitationDocument,
  getPublishedInvitationPayload,
  injectPublicBootstrap,
};
