const API_PREFIX = "/api/guestbook";
const CONTENT_API_PREFIX = "/api/content";
const ADMIN_API_PREFIX = "/api/admin";
const MEDIA_API_PREFIX = "/api/media";
const ADMIN_CONTENT_PAGE = "/admin";
const LEGACY_ADMIN_CONTENT_PAGE = "/admin/content";
const PRODUCTION_HOSTNAME = "wdcard.enmsoftware.com";
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
const MAX_MEDIA_BODY_BYTES = 97 * 1024 * 1024;
const MAX_MEDIA_HEADER_BYTES = 4 * 1024;
const LEGACY_MEDIA_BODY_BYTES = 1024 * 1024;
const MAX_IMAGE_FILE_BYTES = 90 * 1024 * 1024;
const MAX_AUDIO_FILE_BYTES = 25 * 1024 * 1024;
const MAX_AUDIO_BODY_BYTES = 26 * 1024 * 1024;
const MEDIA_STORAGE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const MEDIA_SETS_TABLE = "invitation_media_sets_v2";
const LEGACY_MEDIA_SETS_TABLE = "invitation_media_sets";
const MEDIA_DELETION_JOBS_TABLE = "invitation_media_deletion_jobs_v1";
const MEDIA_UPLOADS_TABLE = "invitation_media_uploads_v1";
const REQUIRED_COPY_LINES = 4;
const MIN_GALLERY_PHOTOS = 1;
const GUESTBOOK_RETENTION = "permanent";
const PUBLIC_BOOTSTRAP_SCHEMA_VERSION = 1;
const PUBLIC_BOOTSTRAP_MARKER = "<!-- WEDDING_PUBLIC_BOOTSTRAP -->";
const PUBLIC_BOOTSTRAP_ID = "wedding-public-bootstrap";
const SEARCH_ROBOTS_DIRECTIVE = "noindex, nofollow, noarchive, nosnippet, noimageindex";
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "script-src 'self' 'sha256-SwY2d+Me7I0cRWZRTmLdSSLdhVnx8+Yeqp1zRYSVZLo='",
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
      "INSERT INTO guestbook_entries (id, name, message, message_search, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, name, message, message.normalize("NFKC"), passwordHash, timestamp, timestamp).run();
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
  await db.prepare("UPDATE guestbook_entries SET message = ?, message_search = ?, updated_at = ? WHERE id = ?")
    .bind(message, message.normalize("NFKC"), updatedAt, entry.id).run();
  return json({ updatedAt });
}

async function deleteEntry(request, env) {
  requireSameOrigin(request);
  const db = requireDatabase(env);
  await enforceGuestbookCallerRateLimit(env, request, { authentication: true });
  const { name, password } = normalizeEntry(await readJson(request), { requireMessage: false });
  await enforceGuestbookCredentialRateLimit(env, name);
  const entry = await requireUniqueCredentialMatch(db, name, password);
  const result = await db.prepare("DELETE FROM guestbook_entries WHERE id = ?").bind(entry.id).run();
  if (Number(result?.meta?.changes ?? result?.changes ?? 0) !== 1) {
    throw { status: 401, code: "ENTRY_AUTH_FAILED", message: "이름 또는 비밀번호를 확인해 주세요." };
  }
  return json({ deleted: true });
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

async function backfillGuestbookMessageSearch(db) {
  for (;;) {
    const result = await db.prepare(
      "SELECT id, message FROM guestbook_entries WHERE message_search IS NULL LIMIT 100",
    ).all();
    const rows = result.results || [];
    if (rows.length === 0) return;
    await runDatabaseBatch(db, rows.map((entry) => db.prepare(
      "UPDATE guestbook_entries SET message_search = ? WHERE id = ? AND message = ? AND message_search IS NULL",
    ).bind(entry.message.normalize("NFKC"), entry.id, entry.message)));
    if (rows.length < 100) return;
  }
}

async function listAdminEntries(request, env) {
  const db = requireDatabase(env);
  await requireAdminEmail(request, env);
  const url = new URL(request.url);
  const rawQuery = (url.searchParams.get("q") || "").trim();
  const normalizedQuery = rawQuery.normalize("NFKC");
  if (normalizedQuery.length > 50) throw { status: 400, code: "INVALID_QUERY", message: "검색어는 50자 이내로 입력해 주세요." };
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
  if (rawQuery) {
    await backfillGuestbookMessageSearch(db);
    const escapeLike = (value) => value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const rawPattern = `%${escapeLike(rawQuery)}%`;
    const normalizedPattern = `%${escapeLike(normalizedQuery)}%`;
    where.push("(name LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\' OR message_search LIKE ? ESCAPE '\\')");
    values.push(normalizedPattern, rawPattern, normalizedPattern);
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

function requireAccountNumber(value, path) {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  if (!/^\d+(?:-\d+)*$/.test(normalized) || normalized.length > 40) {
    throw { status: 400, code: "INVALID_CONTENT", message: `${path} 값을 확인해 주세요.` };
  }
}

function requireMusicSource(value) {
  requireText(value, "content.music.src", 2048);
  if (!/^(?:\/assets\/audio\/[a-z0-9._-]+\.mp3|\/api\/media\/invitation\/[a-f0-9-]{36}\/background-music\/track\.(?:mp3|m4a|wav))$/i.test(value)) {
    throw { status: 400, code: "INVALID_CONTENT", message: "content.music.src 값은 업로드된 음악 경로여야 합니다." };
  }
}

function validPhotoSource(value) {
  return typeof value === "string" && value.length <= 2048
    && /^(?:\/assets\/photos\/[a-z0-9._-]+\.webp|\/api\/media\/invitation\/[a-f0-9-]{36}\/[a-z0-9-]{1,40}\/(?:480|960)\.webp)$/i.test(value);
}

function photoMediaDescriptor(value) {
  if (!validPhotoSource(value)) return null;
  const asset = value.match(/^\/assets\/photos\/(.+?)(?:-(480|960))?\.webp$/i);
  if (asset) return { identity: `asset:${asset[1].toLowerCase()}`, width: asset[2] || null };
  const uploaded = value.match(/^\/api\/media\/invitation\/([a-f0-9-]{36})\/([a-z0-9-]{1,40})\/(480|960)\.webp$/i);
  return uploaded
    ? { identity: `upload:${uploaded[1].toLowerCase()}/${uploaded[2].toLowerCase()}`, width: uploaded[3] }
    : null;
}

function validPhotoSrcSet(value, sourceIdentity) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) return false;
  const candidates = value.split(",").map((candidate) => candidate.trim().match(/^(\S+)\s+(480|960)w$/));
  if (candidates.length !== 2 || candidates.some((candidate) => !candidate)
    || candidates[0][2] !== "480" || candidates[1][2] !== "960") return false;
  const descriptors = candidates.map((candidate) => photoMediaDescriptor(candidate[1]));
  if (descriptors.some((descriptor) => !descriptor)) return false;
  if (descriptors.some((descriptor, index) => descriptor.width !== candidates[index][2])) return false;
  return descriptors.every((descriptor) => descriptor.identity === sourceIdentity);
}

function validPhotoSizes(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 300
    && /^(?!.*(?:javascript:|data:|<|>))[(),:\w\s.%-]+$/i.test(value);
}

function validCropPosition(value) {
  if (typeof value !== "string") return false;
  const match = value.trim().match(/^(\d{1,3})%\s+(\d{1,3})%$/);
  return Boolean(match) && Number(match[1]) <= 100 && Number(match[2]) <= 100;
}

function validateInvitationPhoto(photo, path, seenSources) {
  requirePlainObject(photo, path);
  const sourceDescriptor = photoMediaDescriptor(photo.src);
  if (!sourceDescriptor) {
    throw { status: 400, code: "INVALID_CONTENT", message: `${path}.src 값을 확인해 주세요.` };
  }
  if (sourceDescriptor.width !== "480") {
    throw { status: 400, code: "INVALID_CONTENT", message: `${path}.src 값은 480px 파생본이어야 합니다.` };
  }
  if (seenSources.has(sourceDescriptor.identity)) {
    throw { status: 400, code: "INVALID_CONTENT", message: "같은 사진 파일을 중복해서 사용할 수 없습니다." };
  }
  seenSources.add(sourceDescriptor.identity);
  if (!validPhotoSrcSet(photo.srcSet, sourceDescriptor.identity)) {
    throw { status: 400, code: "INVALID_CONTENT", message: `${path}.srcSet 값을 확인해 주세요.` };
  }
  if (photo.sizes !== undefined && !validPhotoSizes(photo.sizes)) {
    throw { status: 400, code: "INVALID_CONTENT", message: `${path}.sizes 값을 확인해 주세요.` };
  }
  // Retired editor fields: fill safe defaults while keeping valid legacy crops.
  photo.alt = typeof photo.alt === "string" && photo.alt.trim() && photo.alt.trim().length <= 300
    ? photo.alt.trim() : "웨딩 사진";
  photo.position = validCropPosition(photo.position) ? photo.position.trim() : "50% 50%";
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
  const seenPhotoSources = new Set();
  validateInvitationPhoto(photos.pastel.hero, "photos.pastel.hero", seenPhotoSources);
  if (!Array.isArray(photos.pastel.gallery) || photos.pastel.gallery.length < MIN_GALLERY_PHOTOS) {
    throw { status: 400, code: "INVALID_CONTENT", message: `photos.pastel.gallery에는 사진이 최소 ${MIN_GALLERY_PHOTOS}장 필요합니다.` };
  }
  for (const [index, photo] of photos.pastel.gallery.entries()) {
    validateInvitationPhoto(photo, `photos.pastel.gallery[${index}]`, seenPhotoSources);
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
    if (music.autoPlayOnOpen !== undefined && typeof music.autoPlayOnOpen !== "boolean") {
      throw { status: 400, code: "INVALID_CONTENT", message: "content.music.autoPlayOnOpen 값은 참 또는 거짓이어야 합니다." };
    }
    requireText(music.title, "content.music.title", 80);
    requireText(music.artist, "content.music.artist", 80);
    requireHttpsUrl(music.sourceUrl, "content.music.sourceUrl");
    requireText(music.licenseLabel, "content.music.licenseLabel", 80);
    requireHttpsUrl(music.licenseUrl, "content.music.licenseUrl");
    const accounts = requirePlainObject(content.accounts, "content.accounts");
    const accountKeys = Object.keys(accounts);
    if (accountKeys.length > 8) {
      throw { status: 400, code: "INVALID_CONTENT", message: "content.accounts 항목은 최대 8개까지 허용됩니다." };
    }
    for (const side of ["groom", "bride"]) {
      const account = requirePlainObject(accounts[side], `content.accounts.${side}`);
      if (account.side !== undefined && account.side !== side) {
        throw { status: 400, code: "INVALID_CONTENT", message: `content.accounts.${side}.side 값을 확인해 주세요.` };
      }
      requireText(account.bank, `content.accounts.${side}.bank`, 80);
      requireText(account.holder, `content.accounts.${side}.holder`, 50);
      requireAccountNumber(account.number, `content.accounts.${side}.number`);
    }
    for (const key of accountKeys) {
      if (key === "groom" || key === "bride") continue;
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(key)) {
        throw { status: 400, code: "INVALID_CONTENT", message: `content.accounts.${key} 키 형식이 올바르지 않습니다.` };
      }
      const account = requirePlainObject(accounts[key], `content.accounts.${key}`);
      if (account.key !== key) {
        throw { status: 400, code: "INVALID_CONTENT", message: `content.accounts.${key}.key 값이 항목 키와 다릅니다.` };
      }
      if (account.side !== "groom" && account.side !== "bride") {
        throw { status: 400, code: "INVALID_CONTENT", message: `content.accounts.${key}.side 값을 확인해 주세요.` };
      }
      requireText(account.bank, `content.accounts.${key}.bank`, 80);
      requireText(account.holder, `content.accounts.${key}.holder`, 50);
      requireAccountNumber(account.number, `content.accounts.${key}.number`);
    }
  }
  if (write && document.schemaVersion !== 2) {
    throw { status: 400, code: "UNSUPPORTED_CONTENT_SCHEMA", message: "새 초대장 콘텐츠는 schema v2로 저장해야 합니다." };
  }
  for (const [value, path] of [[content.message, "content.message"], [content.story, "content.story"]]) {
    if (!Array.isArray(value) || value.length !== REQUIRED_COPY_LINES) {
      throw { status: 400, code: "INVALID_CONTENT", message: `${path} 값을 확인해 주세요.` };
    }
    for (const line of value) requireText(line, `${path}[]`, 240);
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

function mutationGuard(db, name, predicate, values) {
  return db.prepare(
    `SELECT CASE WHEN ${predicate} THEN 1 ELSE json_extract('mutation-guard-failed', '$') END AS mutation_guard /* ${name} */`,
  ).bind(...values);
}

function isMutationGuardFailure(error) {
  return /malformed json/i.test(String(error?.message || error || ""));
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

async function pendingMediaDeletionForContent(db, contentJson) {
  const mediaIds = [...new Set([...String(contentJson || "").toLowerCase().matchAll(/invitation\/([0-9a-f-]{36})\//g)]
    .map((match) => match[1]))];
  for (let offset = 0; offset < mediaIds.length; offset += 100) {
    const chunk = mediaIds.slice(offset, offset + 100);
    const placeholders = chunk.map(() => "?").join(", ");
    const pending = await db.prepare(
      `SELECT media_id FROM ${MEDIA_DELETION_JOBS_TABLE} WHERE media_id IN (${placeholders}) LIMIT 1`,
    ).bind(...chunk).first();
    if (pending?.media_id) return pending.media_id;
  }
  return null;
}

function mediaDeletionConflict(mediaId) {
  return apiError(409, "MEDIA_DELETE_PENDING", "저장소에서 삭제 대기 중인 미디어입니다. 완료될 때까지 초안이나 공개본에서 사용할 수 없습니다.", { mediaId });
}

async function saveInvitationDraft(request, env) {
  requireSameOrigin(request);
  const db = requireContentDatabase(env);
  const adminEmail = await requireAdminEmail(request, env);
  const payload = await readJson(request, MAX_CONTENT_BODY_BYTES);
  const contentJson = validateInvitationDocument(payload.document, { write: true });
  await migrateLegacyMediaSets(db);
  const pendingMediaId = await pendingMediaDeletionForContent(db, contentJson);
  if (pendingMediaId) return mediaDeletionConflict(pendingMediaId);
  const state = await getInvitationState(db);
  const createdAt = new Date().toISOString();
  if (state?.draft_revision_id) {
    const updated = await db.prepare(
      `UPDATE invitation_revisions SET content_json = ?, created_at = ? WHERE id = ? AND status = 'draft'
       AND NOT EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} job
         WHERE instr(lower(?), lower('invitation/' || job.media_id || '/')) > 0)`,
    ).bind(contentJson, createdAt, state.draft_revision_id, contentJson).run();
    if (updated?.meta?.changes) {
      await db.prepare("UPDATE invitation_state SET updated_at = ? WHERE singleton_id = 1").bind(createdAt).run();
      return json({ revisionId: state.draft_revision_id, savedAt: createdAt });
    }
  }
  const revisionId = crypto.randomUUID();
  const saveResults = await runDatabaseBatch(db, [
    db.prepare(
      `INSERT INTO invitation_revisions (id, content_json, status, created_at, created_by, published_at)
       SELECT ?, ?, 'draft', ?, ?, NULL
       WHERE NOT EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} job
         WHERE instr(lower(?), lower('invitation/' || job.media_id || '/')) > 0)`,
    ).bind(revisionId, contentJson, createdAt, adminEmail, contentJson),
    db.prepare(
      "UPDATE invitation_state SET draft_revision_id = ?, updated_at = ? WHERE singleton_id = 1 AND EXISTS (SELECT 1 FROM invitation_revisions WHERE id = ? AND status = 'draft')",
    ).bind(revisionId, createdAt, revisionId),
  ]);
  if (!saveResults?.[0]?.meta?.changes) {
    const pending = await pendingMediaDeletionForContent(db, contentJson);
    return pending ? mediaDeletionConflict(pending) : apiError(409, "STALE_DRAFT", "초안이 변경되었습니다. 최신 상태를 다시 불러와 주세요.");
  }
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
  await migrateLegacyMediaSets(db);
  const contentJson = JSON.stringify(draft.document);
  const pendingMediaId = await pendingMediaDeletionForContent(db, contentJson);
  if (pendingMediaId) return mediaDeletionConflict(pendingMediaId);
  const publishedAt = new Date().toISOString();
  const statements = [mutationGuard(db, "publish", `
    EXISTS (SELECT 1 FROM invitation_state s JOIN invitation_revisions r ON r.id = s.draft_revision_id
      WHERE s.singleton_id = 1 AND s.draft_revision_id = ? AND s.published_revision_id IS ?
        AND r.status = 'draft' AND r.content_json = ?)
    AND NOT EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} job
      WHERE instr(lower(?), lower('invitation/' || job.media_id || '/')) > 0)
    ${state.published_revision_id ? "AND EXISTS (SELECT 1 FROM invitation_revisions WHERE id = ? AND status = 'published')" : ""}
  `, [revisionId, state.published_revision_id, contentJson, contentJson,
    ...(state.published_revision_id ? [state.published_revision_id] : [])])];
  if (state.published_revision_id) {
    statements.push(db.prepare(
      `UPDATE invitation_revisions SET status = 'archived' WHERE id = ? AND status = 'published'
       AND EXISTS (SELECT 1 FROM invitation_state WHERE singleton_id = 1 AND published_revision_id = ? AND draft_revision_id = ?)
       AND NOT EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} job
         WHERE instr(lower(?), lower('invitation/' || job.media_id || '/')) > 0)`,
    ).bind(state.published_revision_id, state.published_revision_id, revisionId, contentJson));
  }
  statements.push(
    db.prepare(
      `UPDATE invitation_revisions SET status = 'published', published_at = ? WHERE id = ? AND status = 'draft' AND content_json = ?
       AND EXISTS (SELECT 1 FROM invitation_state WHERE singleton_id = 1 AND draft_revision_id = ?)
       AND NOT EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} job
         WHERE instr(lower(?), lower('invitation/' || job.media_id || '/')) > 0)`,
    ).bind(publishedAt, revisionId, contentJson, revisionId, contentJson),
    db.prepare(
      `UPDATE invitation_state SET draft_revision_id = NULL, published_revision_id = ?, updated_at = ?
       WHERE singleton_id = 1 AND draft_revision_id = ? AND published_revision_id IS ?
       AND EXISTS (SELECT 1 FROM invitation_revisions WHERE id = ? AND status = 'published')
       AND NOT EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} job
         WHERE instr(lower(?), lower('invitation/' || job.media_id || '/')) > 0)`,
    ).bind(revisionId, publishedAt, revisionId, state.published_revision_id, revisionId, contentJson),
  );
  let publishResults;
  try {
    publishResults = await runDatabaseBatch(db, statements);
  } catch (error) {
    if (!isMutationGuardFailure(error)) throw error;
    const pending = await pendingMediaDeletionForContent(db, contentJson);
    return pending ? mediaDeletionConflict(pending) : apiError(409, "STALE_DRAFT", "초안이 변경되었습니다. 최신 상태를 다시 불러와 공개해 주세요.");
  }
  const applied = (Array.isArray(publishResults) ? publishResults : publishResults?.results || [])
    .map((result) => result?.meta?.changes ?? 0);
  if (applied.length !== statements.length || !applied.slice(1).every((changes) => changes === 1)) {
    const pending = await pendingMediaDeletionForContent(db, contentJson);
    return pending ? mediaDeletionConflict(pending) : apiError(409, "STALE_DRAFT", "초안이 변경되었습니다. 최신 상태를 다시 불러와 공개해 주세요.");
  }
  return json({ revisionId, publishedAt });
}

async function rollbackInvitation(request, env) {
  requireSameOrigin(request);
  const db = requireContentDatabase(env);
  await requireAdminEmail(request, env);
  const payload = await readJson(request);
  const revisionId = typeof payload.revisionId === "string" ? payload.revisionId : "";
  const expectedPublishedRevisionId = typeof payload.expectedPublishedRevisionId === "string" ? payload.expectedPublishedRevisionId : "";
  const target = await getInvitationRevision(db, revisionId);
  if (!target || !["archived", "published"].includes(target.status) || !target.publishedAt) {
    return apiError(404, "REVISION_NOT_FOUND", "되돌릴 콘텐츠 버전을 찾을 수 없습니다.");
  }
  validateInvitationDocument(target.document, { publish: true });
  await migrateLegacyMediaSets(db);
  const contentJson = JSON.stringify(target.document);
  const pendingMediaId = await pendingMediaDeletionForContent(db, contentJson);
  if (pendingMediaId) return mediaDeletionConflict(pendingMediaId);
  if (!expectedPublishedRevisionId || typeof db.batch !== "function") {
    return apiError(409, "STALE_PUBLISHED_REVISION", "공개본이 변경되었습니다. 최신 상태를 다시 확인해 주세요.");
  }
  const publishedAt = new Date().toISOString();
  const statements = [mutationGuard(db, "rollback", `
    EXISTS (SELECT 1 FROM invitation_state s JOIN invitation_revisions current ON current.id = s.published_revision_id
      JOIN invitation_revisions target ON target.id = ?
      WHERE s.singleton_id = 1 AND s.published_revision_id = ? AND current.status = 'published'
        AND target.status = ? AND target.content_json = ?)
    AND NOT EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} job
      WHERE instr(lower(?), lower('invitation/' || job.media_id || '/')) > 0)
  `, [revisionId, expectedPublishedRevisionId, expectedPublishedRevisionId === revisionId ? "published" : "archived", contentJson, contentJson])];
  if (expectedPublishedRevisionId !== revisionId) {
    statements.push(db.prepare(
      `UPDATE invitation_revisions SET status = 'archived' WHERE id = ? AND status = 'published'
       AND EXISTS (SELECT 1 FROM invitation_state WHERE singleton_id = 1 AND published_revision_id = ?)
       AND NOT EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} job
         WHERE instr(lower(?), lower('invitation/' || job.media_id || '/')) > 0)`,
    ).bind(expectedPublishedRevisionId, expectedPublishedRevisionId, contentJson));
  }
  statements.push(
    db.prepare(
      `UPDATE invitation_revisions SET status = 'published', published_at = ? WHERE id = ?
       AND EXISTS (SELECT 1 FROM invitation_state WHERE singleton_id = 1 AND published_revision_id = ?)
       AND NOT EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} job
         WHERE instr(lower(?), lower('invitation/' || job.media_id || '/')) > 0)`,
    ).bind(publishedAt, revisionId, expectedPublishedRevisionId, contentJson),
    db.prepare(
      `UPDATE invitation_state SET published_revision_id = ?, updated_at = ?
       WHERE singleton_id = 1 AND published_revision_id = ?
       AND EXISTS (SELECT 1 FROM invitation_revisions WHERE id = ? AND status = 'published')
       AND NOT EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} job
         WHERE instr(lower(?), lower('invitation/' || job.media_id || '/')) > 0)`,
    ).bind(revisionId, publishedAt, expectedPublishedRevisionId, revisionId, contentJson),
  );
  let rollbackResults;
  try {
    rollbackResults = await db.batch(statements);
  } catch (error) {
    if (!isMutationGuardFailure(error)) throw error;
    const pending = await pendingMediaDeletionForContent(db, contentJson);
    return pending ? mediaDeletionConflict(pending) : apiError(409, "STALE_PUBLISHED_REVISION", "공개본이 변경되었습니다. 최신 상태를 다시 확인해 주세요.");
  }
  const applied = (Array.isArray(rollbackResults) ? rollbackResults : rollbackResults?.results || [])
    .map((result) => result?.meta?.changes ?? 0);
  if (applied.length !== statements.length || !applied.slice(1).every((changes) => changes === 1)) {
    const pending = await pendingMediaDeletionForContent(db, contentJson);
    if (pending) return mediaDeletionConflict(pending);
    return apiError(409, "STALE_PUBLISHED_REVISION", "공개본이 변경되었습니다. 최신 상태를 다시 확인해 주세요.");
  }
  return json({ revisionId, publishedAt });
}

function requireMediaBucket(env) {
  if (!env.WEDDING_MEDIA || typeof env.WEDDING_MEDIA.put !== "function" || typeof env.WEDDING_MEDIA.get !== "function") {
    throw { status: 503, code: "MEDIA_UNAVAILABLE", message: "미디어 저장소가 아직 연결되지 않았습니다." };
  }
  return env.WEDDING_MEDIA;
}

function createRequestBodyReader(request, maxBytes, tooLargeError) {
  const reader = request.body?.getReader();
  let buffered = new Uint8Array(0);
  let consumed = 0;
  async function nextChunk() {
    if (!reader) return null;
    while (true) {
      const { done, value } = await reader.read();
      if (done || !(value instanceof Uint8Array)) return null;
      if (value.byteLength === 0) continue;
      consumed += value.byteLength;
      if (consumed > maxBytes) throw tooLargeError;
      return value;
    }
  }
  async function readExact(size) {
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      let chunk = buffered;
      buffered = new Uint8Array(0);
      if (chunk.byteLength === 0) chunk = await nextChunk();
      if (chunk === null || chunk.byteLength === 0) break;
      const take = Math.min(size - offset, chunk.byteLength);
      bytes.set(chunk.subarray(0, take), offset);
      if (take < chunk.byteLength) buffered = chunk.subarray(take);
      offset += take;
    }
    if (offset < size) {
      throw { status: 400, code: "INVALID_MEDIA_BODY", message: "업로드 본문이 올바르지 않습니다." };
    }
    return bytes;
  }
  async function readRest(maxSize, tooLarge) {
    const parts = [];
    let size = 0;
    while (true) {
      let chunk = buffered;
      buffered = new Uint8Array(0);
      if (chunk.byteLength === 0) chunk = await nextChunk();
      if (chunk === null || chunk.byteLength === 0) break;
      size += chunk.byteLength;
      if (size > maxSize) throw tooLarge;
      parts.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  }
  async function expectEnd() {
    if (buffered.byteLength > 0 || (await nextChunk()) !== null) {
      throw { status: 400, code: "INVALID_MEDIA_BODY", message: "업로드 본문이 올바르지 않습니다." };
    }
  }
  return { readExact, readRest, expectEnd };
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

async function migrateLegacyMediaSets(db) {
  await runDatabaseBatch(db, [
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${MEDIA_SETS_TABLE} (
         id TEXT PRIMARY KEY,
         slot TEXT NOT NULL CHECK (length(slot) BETWEEN 1 AND 40),
         total_bytes INTEGER NOT NULL CHECK (total_bytes BETWEEN 1 AND 134217728),
         status TEXT NOT NULL CHECK (status IN ('reserved', 'stored')),
         created_at TEXT NOT NULL,
         stored_at TEXT
       )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${MEDIA_DELETION_JOBS_TABLE} (
         media_id TEXT PRIMARY KEY,
         slot TEXT NOT NULL CHECK (length(slot) BETWEEN 1 AND 40),
         claim_token TEXT NOT NULL,
         requested_at TEXT NOT NULL
       )`,
    ),
    db.prepare(`CREATE TABLE IF NOT EXISTS ${MEDIA_UPLOADS_TABLE} (
  media_id TEXT PRIMARY KEY REFERENCES ${MEDIA_SETS_TABLE}(id) ON DELETE CASCADE,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  started_at TEXT
);`),
    db.prepare(
      `INSERT OR IGNORE INTO ${MEDIA_SETS_TABLE} (id, slot, total_bytes, status, created_at, stored_at)
       SELECT id, slot, total_bytes, status, created_at, stored_at FROM ${LEGACY_MEDIA_SETS_TABLE}`,
    ),
    db.prepare(
      `DELETE FROM ${LEGACY_MEDIA_SETS_TABLE} WHERE id IN (SELECT id FROM ${MEDIA_SETS_TABLE})`,
    ),
  ]);
}

async function getMediaUsageFromDatabase(db) {
  await migrateLegacyMediaSets(db);
  const row = await db.prepare(
    `SELECT COALESCE(SUM(total_bytes), 0) AS used_bytes, COUNT(*) AS media_sets FROM ${MEDIA_SETS_TABLE} WHERE status IN ('reserved', 'stored')`,
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
  await migrateLegacyMediaSets(db);
  const createdAt = new Date().toISOString();
  const result = await db.prepare(
    `INSERT INTO ${MEDIA_SETS_TABLE} (id, slot, total_bytes, status, created_at, stored_at)
     SELECT ?, ?, ?, 'reserved', ?, NULL
     WHERE (SELECT COALESCE(SUM(total_bytes), 0) FROM ${MEDIA_SETS_TABLE} WHERE status IN ('reserved', 'stored')) + ? <= ?`,
  ).bind(mediaId, slot, totalBytes, createdAt, totalBytes, MEDIA_STORAGE_LIMIT_BYTES).run().catch((error) => {
    if (String(error?.message || "").includes("CHECK")) {
      throw { status: 413, code: "MEDIA_TOO_LARGE", message: "현재 저장소 구성이 지원하는 크기를 초과했습니다. 더 작은 파일로 다시 시도해 주세요." };
    }
    throw error;
  });
  if (!result?.meta?.changes) {
    throw { status: 507, code: "MEDIA_STORAGE_LIMIT", message: "미디어 저장 공간 2GB 한도에 도달했습니다. 기존 미디어 정리 후 다시 시도해 주세요." };
  }
}

async function releaseMediaStorage(db, mediaId) {
  await migrateLegacyMediaSets(db);
  await db.prepare(`DELETE FROM ${MEDIA_SETS_TABLE} WHERE id = ? AND status = 'reserved'`).bind(mediaId).run();
}

async function commitMediaStorage(db, mediaId) {
  await migrateLegacyMediaSets(db);
  const result = await db.prepare(`UPDATE ${MEDIA_SETS_TABLE} SET status = 'stored', stored_at = ? WHERE id = ? AND status = 'reserved'`)
    .bind(new Date().toISOString(), mediaId).run();
  if (!result?.meta?.changes) {
    throw { status: 409, code: "MEDIA_STORAGE_LOST", message: "미디어 저장 기록이 변경되어 업로드를 완료하지 못했습니다." };
  }
}

const BUNDLED_MUSIC_FALLBACK = {
  src: "/assets/audio/touching-moments-one-pulse.mp3",
  autoPlayOnOpen: false,
  title: "Touching Moments One - Pulse",
  artist: "Kevin MacLeod",
  sourceUrl: "https://incompetech.com/music/royalty-free/index.html?Search=Search&isrc=USUAN1100039",
  licenseLabel: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
};

async function listRevisionsForMediaScan(db) {
  const result = await db.prepare(
    "SELECT id, status, created_at, published_at, content_json FROM invitation_revisions",
  ).all();
  return result.results || [];
}

function revisionsReferencing(revisions, mediaId) {
  const needle = `invitation/${mediaId}/`;
  return revisions.filter((revision) => typeof revision.content_json === "string" && revision.content_json.toLowerCase().includes(needle));
}

function describeRevisionRef(revision) {
  return {
    id: revision.id,
    status: revision.status,
    createdAt: revision.created_at,
    publishedAt: revision.published_at,
  };
}

function mediaReferenceSummary(referencing, state) {
  return {
    draft: referencing.some((revision) => revision.id === state?.draft_revision_id),
    published: referencing.some((revision) => revision.id === state?.published_revision_id),
    archivedRevisions: referencing
      .filter((revision) => revision.id !== state?.draft_revision_id && revision.id !== state?.published_revision_id)
      .map(describeRevisionRef),
  };
}

const STALE_RESERVATION_MS = 60 * 60 * 1000;

function staleReservationCutoff() {
  return new Date(Date.now() - STALE_RESERVATION_MS).toISOString();
}

function isStaleReservation(set) {
  return set.status === "reserved" && Date.parse(set.created_at || "") < Date.now() - STALE_RESERVATION_MS;
}

async function getAdminMediaList(request, env) {
  const db = requireContentDatabase(env);
  await requireAdminEmail(request, env);
  requireMediaBucket(env);
  const state = await getInvitationState(db);
  await migrateLegacyMediaSets(db);
  const sets = (await db.prepare(
    `SELECT id, slot, total_bytes, status, created_at FROM ${MEDIA_SETS_TABLE}
     WHERE status = 'stored' OR (status = 'reserved' AND created_at < ?)
     ORDER BY created_at DESC`,
  ).bind(staleReservationCutoff()).all()).results || [];
  const deletionJobs = (await db.prepare(
    `SELECT media_id, slot, requested_at FROM ${MEDIA_DELETION_JOBS_TABLE}`,
  ).all()).results || [];
  const pendingDeletionIds = new Set(deletionJobs.map((job) => job.media_id));
  const listedIds = new Set(sets.map((row) => row.id));
  for (const job of deletionJobs) {
    if (!listedIds.has(job.media_id)) {
      sets.push({ id: job.media_id, slot: job.slot, total_bytes: 0, status: "deleting", created_at: job.requested_at });
    }
  }
  const revisions = await listRevisionsForMediaScan(db);
  const usage = await getMediaUsageFromDatabase(db);
  const media = sets.map((row) => {
    const kind = row.slot === "background-music" ? "audio" : "photo";
    return {
      mediaId: row.id,
      slot: row.slot,
      kind,
      totalBytes: row.total_bytes,
      status: row.status,
      abandoned: row.status === "reserved",
      deletionPending: pendingDeletionIds.has(row.id),
      createdAt: row.created_at,
      previewUrl: kind === "photo" ? `${MEDIA_API_PREFIX}/invitation/${row.id}/${row.slot}/480.webp` : null,
      references: mediaReferenceSummary(revisionsReferencing(revisions, row.id), state),
    };
  });
  return json({ usage, media });
}

function stripMediaFromDraftDocument(document, mediaId) {
  const needle = `invitation/${mediaId}/`;
  const photos = document?.photos?.pastel;
  let removed = 0;
  if (photos?.hero && JSON.stringify(photos.hero).toLowerCase().includes(needle)) {
    return { blocked: "대표 사진으로 사용 중입니다. 초안에서 다른 사진으로 먼저 교체해 주세요." };
  }
  if (Array.isArray(photos?.gallery)) {
    const kept = photos.gallery.filter((photo) => !JSON.stringify(photo).toLowerCase().includes(needle));
    removed = photos.gallery.length - kept.length;
    if (removed > 0) {
      if (kept.length < 1) {
        return { blocked: "갤러리에는 최소 한 장의 사진이 필요합니다. 초안에서 다른 사진을 먼저 추가해 주세요." };
      }
      photos.gallery = kept;
    }
  }
  if (typeof document?.content?.music?.src === "string" && document.content.music.src.toLowerCase().includes(needle)) {
    document.content.music = { ...BUNDLED_MUSIC_FALLBACK };
    removed += 1;
  }
  if (JSON.stringify(document).toLowerCase().includes(needle)) {
    return { blocked: "이 미디어를 참조하는 초안 항목을 정리하지 못했습니다." };
  }
  return { removed };
}

function mediaObjectKeys(set) {
  if (set.slot === "background-music") {
    return ["mp3", "m4a", "wav"].map((extension) => `invitation/${set.id}/background-music/track.${extension}`);
  }
  const base = `invitation/${set.id}/${set.slot}`;
  return [
    `${base}/original.jpg`,
    `${base}/original.png`,
    `${base}/original.webp`,
    `${base}/480.webp`,
    `${base}/960.webp`,
  ];
}

function mediaDeletionPendingError(mediaId, usage) {
  return apiError(503, "MEDIA_DELETE_PENDING", "R2 파일 정리가 끝나지 않았습니다. 미디어 목록에서 삭제를 다시 시도할 수 있으며, 완료 전까지 저장 공간은 계속 예약됩니다.", {
    mediaId,
    deletionPending: true,
    usage,
  });
}

async function finishAdminMediaDeletion(db, bucket, set, { removedFromDraft = 0, deletedRevisions = [] } = {}) {
  const mediaId = set.id;
  let usage;
  try {
    const reference = await db.prepare(
      "SELECT id FROM invitation_revisions WHERE instr(lower(content_json), lower(?)) > 0 LIMIT 1",
    ).bind(`invitation/${mediaId}/`).first();
    if (reference) {
      usage = await getMediaUsageFromDatabase(db);
      return mediaDeletionPendingError(mediaId, usage);
    }
    await bucket.delete(mediaObjectKeys(set));
    const cleanup = await runDatabaseBatch(db, [
      // Remove the dependent session explicitly: D1 counts cascading changes,
      // while SQLite adapters may report only direct changes. Keep each guard
      // deterministic on both runtimes, within the same database transaction.
      db.prepare(`DELETE FROM ${MEDIA_UPLOADS_TABLE} WHERE media_id = ?
        AND EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} WHERE media_id = ?)
        AND NOT EXISTS (SELECT 1 FROM invitation_revisions r WHERE instr(lower(r.content_json), lower(?)) > 0)`)
        .bind(mediaId, mediaId, `invitation/${mediaId}/`),
      db.prepare(
        `DELETE FROM ${MEDIA_SETS_TABLE} WHERE id = ?
         AND EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} WHERE media_id = ?)
         AND NOT EXISTS (SELECT 1 FROM invitation_revisions r WHERE instr(lower(r.content_json), lower(?)) > 0)`,
      ).bind(mediaId, mediaId, `invitation/${mediaId}/`),
      db.prepare(
        `DELETE FROM ${MEDIA_DELETION_JOBS_TABLE} WHERE media_id = ?
         AND NOT EXISTS (SELECT 1 FROM ${MEDIA_SETS_TABLE} WHERE id = ?)
         AND NOT EXISTS (SELECT 1 FROM invitation_revisions r WHERE instr(lower(r.content_json), lower(?)) > 0)`,
      ).bind(mediaId, mediaId, `invitation/${mediaId}/`),
    ]);
    const changes = (Array.isArray(cleanup) ? cleanup : cleanup?.results || [])
      .map((result) => result?.meta?.changes ?? 0);
    if (changes.length !== 3 || ![0, 1].includes(changes[0]) || ![0, 1].includes(changes[1]) || changes[2] !== 1) {
      usage = await getMediaUsageFromDatabase(db);
      return mediaDeletionPendingError(mediaId, usage);
    }
  } catch {
    try { usage = await getMediaUsageFromDatabase(db); } catch { usage = null; }
    return mediaDeletionPendingError(mediaId, usage);
  }
  return json({
    deleted: mediaId,
    freedBytes: set.total_bytes,
    removedFromDraft,
    deletedRevisions,
    objectsDeleted: true,
    usage: await getMediaUsageFromDatabase(db),
  });
}

async function deleteAdminMedia(request, env) {
  requireSameOrigin(request);
  const db = requireContentDatabase(env);
  await requireAdminEmail(request, env);
  const bucket = requireMediaBucket(env);
  if (typeof bucket.delete !== "function") {
    throw { status: 503, code: "MEDIA_UNAVAILABLE", message: "미디어 저장소가 아직 연결되지 않았습니다." };
  }
  const payload = await readJson(request);
  const mediaId = String(payload?.mediaId || "").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(mediaId)) {
    return apiError(400, "INVALID_MEDIA", "미디어 식별자를 확인해 주세요.");
  }
  await migrateLegacyMediaSets(db);
  const pendingJob = await db.prepare(
    `SELECT media_id, slot, requested_at FROM ${MEDIA_DELETION_JOBS_TABLE} WHERE media_id = ?`,
  ).bind(mediaId).first();
  const storedSet = await db.prepare(
    `SELECT id, slot, total_bytes, status, created_at FROM ${MEDIA_SETS_TABLE} WHERE id = ?`,
  ).bind(mediaId).first();
  if (pendingJob) {
    const retrySet = storedSet || { id: mediaId, slot: pendingJob.slot, total_bytes: 0, status: "deleting", created_at: pendingJob.requested_at };
    return finishAdminMediaDeletion(db, bucket, retrySet);
  }
  const set = storedSet;
  if (!set) return apiError(404, "MEDIA_NOT_FOUND", "미디어를 찾을 수 없습니다.");
  if (set.status !== "stored" && !isStaleReservation(set)) {
    return apiError(409, "MEDIA_IN_USE", "업로드가 진행 중인 미디어입니다. 업로드가 끝난 뒤 다시 시도해 주세요.");
  }
  const state = await getInvitationState(db);
  const revisions = await listRevisionsForMediaScan(db);
  const referencing = revisionsReferencing(revisions, mediaId);
  if (referencing.some((revision) => revision.id === state?.published_revision_id)) {
    return apiError(409, "MEDIA_IN_USE", "현재 공개본이 이 미디어를 사용 중입니다. 먼저 다른 콘텐츠로 교체해 주세요.");
  }
  const archivedRefs = referencing.filter((revision) => revision.id !== state?.draft_revision_id);
  const approvedRevisions = payload?.expectedRevisionIds;
  if (approvedRevisions !== undefined && (!Array.isArray(approvedRevisions) || approvedRevisions.some((id) => typeof id !== "string"))) {
    return apiError(400, "INVALID_MEDIA", "삭제 확인 정보가 올바르지 않습니다.");
  }
  if (archivedRefs.length && (payload?.deleteRevisions !== true
    || (approvedRevisions && archivedRefs.some((revision) => !approvedRevisions.includes(revision.id))))) {
    return apiError(409, "MEDIA_REFERENCED", "과거 리비전이 이 미디어를 참조하고 있습니다. 함께 삭제할지 확인해 주세요.", {
      dependentRevisions: archivedRefs.map(describeRevisionRef),
    });
  }
  const statements = [];
  const expectedChanges = [];
  let removedFromDraft = 0;
  const draftRevision = referencing.find((revision) => revision.id === state?.draft_revision_id);
  if (draftRevision) {
    let draftDocument;
    try {
      draftDocument = JSON.parse(draftRevision.content_json);
    } catch {
      return apiError(409, "DRAFT_CORRUPTED", "초안 문서를 해석하지 못해 미디어를 삭제하지 않았습니다.");
    }
    const strip = stripMediaFromDraftDocument(draftDocument, mediaId);
    if (strip.blocked) return apiError(409, "MEDIA_IN_USE", strip.blocked);
    removedFromDraft = strip.removed;
    statements.push(db.prepare(
      `UPDATE invitation_revisions SET content_json = ? WHERE id = ? AND status = 'draft' AND content_json = ?
       AND EXISTS (SELECT 1 FROM invitation_state s WHERE s.singleton_id = 1 AND s.draft_revision_id = invitation_revisions.id)
       AND EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} WHERE media_id = ?)`,
    ).bind(JSON.stringify(draftDocument), draftRevision.id, draftRevision.content_json, mediaId));
    expectedChanges.push(1);
  }
  for (const revision of archivedRefs) {
    statements.push(db.prepare(
      `DELETE FROM invitation_revisions WHERE id = ? AND NOT EXISTS (
         SELECT 1 FROM invitation_state s WHERE s.singleton_id = 1
           AND (s.draft_revision_id = invitation_revisions.id OR s.published_revision_id = invitation_revisions.id)
       ) AND EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} WHERE media_id = ?)`,
    ).bind(revision.id, mediaId));
    expectedChanges.push(1);
  }
  const claimToken = crypto.randomUUID();
  let claimSql = `INSERT INTO ${MEDIA_DELETION_JOBS_TABLE} (media_id, slot, claim_token, requested_at)
    SELECT ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM ${MEDIA_SETS_TABLE} WHERE id = ?
      AND (status = 'stored' OR (status = 'reserved' AND created_at < ?)))
      AND NOT EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} WHERE media_id = ?)
      AND NOT EXISTS (SELECT 1 FROM invitation_state s JOIN invitation_revisions r ON r.id = s.published_revision_id
        WHERE s.singleton_id = 1 AND instr(lower(r.content_json), lower(?)) > 0)`;
  const claimValues = [mediaId, set.slot, claimToken, new Date().toISOString(), mediaId, staleReservationCutoff(), mediaId, `invitation/${mediaId}/`];
  if (draftRevision) {
    claimSql += ` AND EXISTS (SELECT 1 FROM invitation_state s JOIN invitation_revisions r ON r.id = s.draft_revision_id
      WHERE s.singleton_id = 1 AND r.id = ? AND r.status = 'draft' AND r.content_json = ?)`;
    claimValues.push(draftRevision.id, draftRevision.content_json);
  }
  for (const revision of archivedRefs) {
    claimSql += ` AND EXISTS (SELECT 1 FROM invitation_revisions r WHERE r.id = ?
      AND NOT EXISTS (SELECT 1 FROM invitation_state s WHERE s.singleton_id = 1
        AND (s.draft_revision_id = r.id OR s.published_revision_id = r.id)))`;
    claimValues.push(revision.id);
  }
  const capturedReferenceIds = [...new Set([
    ...(draftRevision ? [draftRevision.id] : []),
    ...archivedRefs.map((revision) => revision.id),
  ])];
  const capturedReferencePredicate = capturedReferenceIds.length
    ? `r.id NOT IN (${capturedReferenceIds.map(() => "?").join(", ")})`
    : "1 = 1";
  claimSql += ` AND NOT EXISTS (SELECT 1 FROM invitation_revisions r
    WHERE instr(lower(r.content_json), lower(?)) > 0 AND ${capturedReferencePredicate})`;
  claimValues.push(`invitation/${mediaId}/`, ...capturedReferenceIds);
  statements.unshift(db.prepare(claimSql).bind(...claimValues));
  expectedChanges.unshift(1);
  statements.splice(1, 0, mutationGuard(db, "delete-claim",
    `EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} WHERE media_id = ? AND claim_token = ?)`,
    [mediaId, claimToken]));
  expectedChanges.splice(1, 0, 0);
  statements.push(mutationGuard(db, "delete-final", `
    EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} WHERE media_id = ? AND claim_token = ?)
    AND NOT EXISTS (SELECT 1 FROM invitation_revisions WHERE instr(lower(content_json), lower(?)) > 0)
  `, [mediaId, claimToken, `invitation/${mediaId}/`]));
  expectedChanges.push(0);
  let results;
  try {
    results = await runDatabaseBatch(db, statements);
  } catch (error) {
    if (!isMutationGuardFailure(error)) throw error;
    return apiError(409, "MEDIA_IN_USE", "삭제 중 다른 변경이 감지되어 미디어를 삭제하지 않았습니다. 다시 시도해 주세요.");
  }
  const applied = (Array.isArray(results) ? results : results?.results || [])
    .map((result) => result?.meta?.changes ?? 0);
  if (applied.length !== expectedChanges.length || !applied.every((changes, index) => changes === expectedChanges[index])) {
    const racedJob = await db.prepare(
      `SELECT media_id FROM ${MEDIA_DELETION_JOBS_TABLE} WHERE media_id = ?`,
    ).bind(mediaId).first();
    if (racedJob) {
      return apiError(409, "MEDIA_DELETE_PENDING", "다른 삭제 요청이 이 미디어를 처리 중입니다. 목록을 새로고침한 뒤 필요하면 재시도해 주세요.", { mediaId, deletionPending: true });
    }
    return apiError(409, "MEDIA_IN_USE", "삭제 중 다른 변경이 감지되어 미디어를 삭제하지 않았습니다. 다시 시도해 주세요.");
  }
  return finishAdminMediaDeletion(db, bucket, set, {
    removedFromDraft,
    deletedRevisions: archivedRefs.map(describeRevisionRef),
  });
}

function mediaUploadLogName(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(value) ? value : undefined;
}

function mediaUploadLogCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : undefined;
}

function isExpectedMediaUploadError(error) {
  const statuses = {
    CROSS_ORIGIN_DENIED: 403,
    ADMIN_AUTH_UNAVAILABLE: 503,
    ADMIN_AUTH_REQUIRED: 401,
    CONTENT_UNAVAILABLE: 503,
    MEDIA_TOO_LARGE: 413,
    MEDIA_UNAVAILABLE: 503,
    UNSUPPORTED_MEDIA_BODY: 415,
    INVALID_MEDIA_BODY: 400,
    INVALID_MEDIA_METADATA: 400,
    INVALID_MEDIA: 400,
    MEDIA_STORAGE_LIMIT: 507,
    MEDIA_STORAGE_LOST: 409,
    UPLOAD_CLIENT_UPDATE_REQUIRED: 409,
  };
  return Number.isInteger(error?.status) && statuses[error.code] === error.status;
}

function logMediaUploadFailure(requestId, phase, error) {
  const entry = { event: "media_upload_failed", requestId, phase };
  const errorName = mediaUploadLogName(error?.name);
  const errorCode = mediaUploadLogCode(error?.code);
  if (errorName) entry.errorName = errorName;
  if (errorCode) entry.errorCode = errorCode;
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) entry.errorStatus = error.status;
  console.error(JSON.stringify(entry));
}

async function uploadInvitationMedia(request, env) {
  const requestId = crypto.randomUUID();
  let phase = "same_origin";
  try {
    requireSameOrigin(request);
    phase = "admin_auth";
    await requireAdminEmail(request, env);
    phase = "database";
    const db = requireContentDatabase(env);
    phase = "request_size";
    const length = Number(request.headers.get("content-length") || 0);
    if (length > MAX_MEDIA_BODY_BYTES) return apiError(413, "MEDIA_TOO_LARGE", "이미지 업로드 크기를 줄여 주세요.");
    if (length > LEGACY_MEDIA_BODY_BYTES) return apiError(409, "UPLOAD_CLIENT_UPDATE_REQUIRED", "사진 업로드 방식이 변경되었습니다. 페이지를 새로고침한 뒤 다시 업로드해 주세요.");
    phase = "media_bucket";
    const bucket = requireMediaBucket(env);
    if (typeof bucket.delete !== "function") return apiError(503, "MEDIA_UNAVAILABLE", "미디어 저장소가 아직 연결되지 않았습니다.");
    const contentType = (request.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
    if (contentType !== "application/octet-stream") {
      return apiError(415, "UNSUPPORTED_MEDIA_BODY", "업로드 형식이 올바르지 않습니다. 페이지를 새로고침해 주세요.");
    }
    phase = "body_header";
    const body = createRequestBodyReader(request, LEGACY_MEDIA_BODY_BYTES,
      { status: 409, code: "UPLOAD_CLIENT_UPDATE_REQUIRED", message: "페이지를 새로고침한 뒤 새로운 사진 업로드를 사용해 주세요." });
    const headerLengthBytes = await body.readExact(2);
    const headerLength = (headerLengthBytes[0] << 8) | headerLengthBytes[1];
    if (headerLength < 2 || headerLength > MAX_MEDIA_HEADER_BYTES) {
      return apiError(400, "INVALID_MEDIA_BODY", "업로드 본문이 올바르지 않습니다.");
    }
    let header;
    try {
      header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await body.readExact(headerLength)));
    } catch (error) {
      if (error && Number.isInteger(error.status)) throw error;
      return apiError(400, "INVALID_MEDIA_BODY", "업로드 본문이 올바르지 않습니다.");
    }
    const slot = String(header?.slot || "").trim().toLowerCase();
    const alt = String(header?.alt || "").trim();
    const position = String(header?.position || "50% 50%").trim();
    const validSlot = /^(?:pastel-hero|pastel-gallery-(?:new|\d+))$/.test(slot);
    if (!validSlot || alt.length > 300 || !validCropPosition(position)) {
      return apiError(400, "INVALID_MEDIA_METADATA", "이미지 슬롯, 설명 또는 초점 위치를 확인해 주세요.");
    }
    const sizes = header?.sizes && typeof header.sizes === "object" ? header.sizes : {};
    const originalSize = Number(sizes.original);
    const smallSize = Number(sizes.small);
    const largeSize = Number(sizes.large);
    const originalType = String(header?.originalType || "");
    const validSizes = Number.isInteger(originalSize) && originalSize > 0 && originalSize <= MAX_IMAGE_FILE_BYTES
      && Number.isInteger(smallSize) && smallSize > 0 && smallSize <= 2 * 1024 * 1024
      && Number.isInteger(largeSize) && largeSize > 0 && largeSize <= 4 * 1024 * 1024
      && originalSize + smallSize + largeSize <= MAX_MEDIA_BODY_BYTES;
    if (!["image/jpeg", "image/png", "image/webp"].includes(originalType) || !validSizes) {
      return apiError(400, "INVALID_MEDIA", "원본과 480·960px WebP 이미지를 확인해 주세요.");
    }
    // Compatibility for already-open old clients is strictly bounded to 1MiB.
    if (originalSize + smallSize + largeSize + headerLength + 2 > LEGACY_MEDIA_BODY_BYTES) {
      return apiError(409, "UPLOAD_CLIENT_UPDATE_REQUIRED", "사진 업로드 방식이 변경되었습니다. 페이지를 새로고침한 뒤 다시 업로드해 주세요.");
    }
    phase = "body_variants";
    const small = await body.readExact(smallSize);
    const large = await body.readExact(largeSize);
    const original = await body.readExact(originalSize);
    const mediaId = crypto.randomUUID();
    const originalExtension = originalType === "image/png" ? "png" : originalType === "image/webp" ? "webp" : "jpg";
    const baseKey = `invitation/${mediaId}/${slot}`;
    const keys = [
      `${baseKey}/original.${originalExtension}`,
      `${baseKey}/480.webp`,
      `${baseKey}/960.webp`,
    ];
    const totalBytes = originalSize + smallSize + largeSize;
    phase = "quota_reserve";
    await reserveMediaStorage(db, { mediaId, slot, totalBytes });
    try {
      phase = "r2_write";
      const writeResults = await Promise.allSettled([
        bucket.put(keys[0], original, { httpMetadata: { contentType: originalType } }),
        bucket.put(keys[1], small, { httpMetadata: { contentType: "image/webp" } }),
        bucket.put(keys[2], large, { httpMetadata: { contentType: "image/webp" } }),
      ]);
      const failedWrite = writeResults.find((result) => result.status === "rejected");
      if (failedWrite) throw failedWrite.reason;
      phase = "body_end";
      await body.expectEnd();
      phase = "quota_commit";
      await commitMediaStorage(db, mediaId);
    } catch (error) {
      const physicalDeletion = Promise.resolve().then(() => bucket.delete(keys));
      const cleanupResults = await Promise.allSettled([
        physicalDeletion,
        physicalDeletion.then(() => releaseMediaStorage(db, mediaId), () => undefined),
      ]);
      let cleanupFailed = false;
      for (const [index, result] of cleanupResults.entries()) {
        if (result.status === "rejected") {
          cleanupFailed = true;
          logMediaUploadFailure(requestId, index === 0 ? "r2_cleanup" : "quota_release", result.reason);
        }
      }
      if (cleanupFailed && isExpectedMediaUploadError(error)) {
        return apiError(500, "INTERNAL_ERROR", "초대장 콘텐츠 요청을 처리하지 못했습니다.", { requestId });
      }
      throw error;
    }
    phase = "media_usage";
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
  } catch (error) {
    if (isExpectedMediaUploadError(error)) throw error;
    logMediaUploadFailure(requestId, phase, error);
    return apiError(500, "INTERNAL_ERROR", "초대장 콘텐츠 요청을 처리하지 못했습니다.", { requestId });
  }
}

function hasMpegFrameHeader(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return false;
  const version = bytes[1] & 0x18;
  const layer = bytes[1] & 0x06;
  const bitrate = bytes[2] & 0xf0;
  const sampleRate = bytes[2] & 0x0c;
  return version !== 0x08 && layer !== 0 && bitrate !== 0 && bitrate !== 0xf0 && sampleRate !== 0x0c;
}

function hasMp3Signature(bytes) {
  const header = bytes.subarray(0, 10);
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
  if (frameOffset + 4 > bytes.length) return false;
  return hasMpegFrameHeader(bytes.subarray(frameOffset, frameOffset + 4));
}

function mediaBoxes(bytes, start, end) {
  const boxes = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  while (offset + 8 <= end && boxes.length < 512) {
    let size = view.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) return null;
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      headerSize = 16;
    } else if (size === 0) size = end - offset;
    if (!Number.isSafeInteger(size) || size < headerSize || size > end - offset) return null;
    boxes.push({ type: String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), start: offset + headerSize, end: offset + size });
    offset += size;
  }
  return offset === end ? boxes : null;
}

function mediaDescriptors(bytes, start, end) {
  const descriptors = [];
  let offset = start;
  while (offset < end) {
    const tag = bytes[offset++];
    let length = 0;
    let complete = false;
    for (let part = 0; part < 4 && offset < end; part += 1) {
      const value = bytes[offset++];
      length = length * 128 + (value & 0x7f);
      if (length > end - offset) return null;
      if ((value & 0x80) === 0) {
        complete = true;
        break;
      }
    }
    if (!complete || length === 0) return null;
    descriptors.push({ tag, start: offset, end: offset + length });
    offset += length;
  }
  return offset === end ? descriptors : null;
}

function isAacAudioSpecificConfig(bytes, start, end) {
  let bitOffset = 0;
  const readBits = (count) => {
    if (count < 1 || bitOffset + count > (end - start) * 8) return null;
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = bytes[start + (bitOffset >> 3)];
      value = (value << 1) | ((byte >> (7 - (bitOffset & 7))) & 1);
      bitOffset += 1;
    }
    return value;
  };
  const readAudioObjectType = () => {
    const objectType = readBits(5);
    if (objectType === null) return null;
    return objectType === 31 ? 32 + (readBits(6) ?? 0) : objectType;
  };
  const readSamplingFrequency = () => {
    const index = readBits(4);
    if (index === null || index >= 13 && index !== 15) return false;
    return index !== 15 || readBits(24) !== null;
  };
  const aacTypes = new Set([1, 2, 3, 4, 5, 6, 17, 19, 20, 21, 22, 23, 29, 39, 42]);
  let objectType = readAudioObjectType();
  if (objectType === null || !readSamplingFrequency()) return false;
  const channelConfig = readBits(4);
  if (channelConfig === null) return false;
  if (objectType === 5 || objectType === 29) {
    if (!readSamplingFrequency()) return false;
    objectType = readAudioObjectType();
    if (objectType === null) return false;
  }
  return aacTypes.has(objectType);
}

function hasAacDescriptor(bytes, start, end) {
  if (end - start < 4) return false;
  const esDescriptors = mediaDescriptors(bytes, start + 4, end);
  if (!esDescriptors) return false;
  for (const esDescriptor of esDescriptors.filter((descriptor) => descriptor.tag === 0x03)) {
    if (esDescriptor.end - esDescriptor.start < 3) continue;
    let cursor = esDescriptor.start + 2;
    const flags = bytes[cursor++];
    if (flags & 0x80) cursor += 2;
    if (flags & 0x40) {
      if (cursor >= esDescriptor.end) continue;
      cursor += 1 + bytes[cursor];
    }
    if (flags & 0x20) cursor += 2;
    if (cursor > esDescriptor.end) continue;
    const configDescriptors = mediaDescriptors(bytes, cursor, esDescriptor.end);
    if (!configDescriptors) continue;
    for (const config of configDescriptors.filter((descriptor) => descriptor.tag === 0x04)) {
      if (config.end - config.start < 13 || bytes[config.start] !== 0x40 || ((bytes[config.start + 1] >> 2) & 0x3f) !== 5) continue;
      const specificDescriptors = mediaDescriptors(bytes, config.start + 13, config.end);
      if (specificDescriptors?.some((descriptor) => descriptor.tag === 0x05
        && isAacAudioSpecificConfig(bytes, descriptor.start, descriptor.end))) return true;
    }
  }
  return false;
}

function hasAacM4aSignature(bytes) {
  const boxes = mediaBoxes(bytes, 0, bytes.length);
  const ftyp = boxes?.[0];
  if (ftyp?.type !== "ftyp" || ftyp.end - ftyp.start < 8 || !["M4A ", "isom", "iso2", "mp41", "mp42"].includes(String.fromCharCode(...bytes.subarray(ftyp.start, ftyp.start + 4)))) return false;
  if (!boxes.some((box) => box.type === "mdat" && box.end > box.start)) return false;
  const moov = boxes.find((box) => box.type === "moov");
  const tracks = moov && mediaBoxes(bytes, moov.start, moov.end)?.filter((box) => box.type === "trak");
  if (!tracks || tracks.length !== 1) return false;
  const mdia = mediaBoxes(bytes, tracks[0].start, tracks[0].end)?.find((box) => box.type === "mdia");
  const media = mdia && mediaBoxes(bytes, mdia.start, mdia.end);
  const handler = media?.find((box) => box.type === "hdlr");
  if (!handler || handler.end - handler.start < 12 || String.fromCharCode(...bytes.subarray(handler.start + 8, handler.start + 12)) !== "soun") return false;
  const minf = media.find((box) => box.type === "minf");
  const stbl = minf && mediaBoxes(bytes, minf.start, minf.end)?.find((box) => box.type === "stbl");
  const stsd = stbl && mediaBoxes(bytes, stbl.start, stbl.end)?.find((box) => box.type === "stsd");
  if (!stsd || stsd.end - stsd.start < 8 || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(stsd.start + 4) !== 1) return false;
  const entries = mediaBoxes(bytes, stsd.start + 8, stsd.end);
  const entry = entries?.[0];
  if (entries?.length !== 1 || entry.type !== "mp4a" || entry.end - entry.start < 28) return false;
  const esds = mediaBoxes(bytes, entry.start + 28, entry.end)?.find((box) => box.type === "esds");
  return Boolean(esds && hasAacDescriptor(bytes, esds.start, esds.end));
}

function hasPcmWavSignature(bytes) {
  if (bytes.length < 44 || String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) + 8 !== bytes.length) return false;
  let formatValid = false;
  let dataValid = false;
  let blockAlign = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (length > bytes.length - start) return false;
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (type === "fmt " && length >= 16) {
      const channels = view.getUint16(start + 2, true);
      const rate = view.getUint32(start + 4, true);
      const bits = view.getUint16(start + 14, true);
      const frameSize = channels * bits / 8;
      const format = view.getUint16(start, true);
      let pcm = format === 1;
      if (format === 0xfffe && length >= 40 && view.getUint16(start + 16, true) >= 22
        && length >= 18 + view.getUint16(start + 16, true)) {
        const validBits = view.getUint16(start + 18, true);
        const pcmSubtype = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
          0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
        pcm = validBits > 0 && validBits <= bits
          && pcmSubtype.every((value, index) => bytes[start + 24 + index] === value);
      }
      blockAlign = frameSize;
      formatValid = pcm && [1, 2].includes(channels) && rate >= 8000 && rate <= 192000
        && [8, 16, 24, 32].includes(bits) && view.getUint16(start + 12, true) === frameSize && view.getUint32(start + 8, true) === rate * frameSize;
    }
    if (type === "data" && length > 0) dataValid = blockAlign > 0 && length % blockAlign === 0;
    offset = start + length + (length & 1);
    if (offset === bytes.length) return formatValid && dataValid;
  }
  return false;
}

async function uploadInvitationAudio(request, env) {
  requireSameOrigin(request);
  await requireAdminEmail(request, env);
  const db = requireContentDatabase(env);
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_AUDIO_BODY_BYTES) return apiError(413, "MEDIA_TOO_LARGE", "음악 파일은 25MB 이하만 업로드할 수 있습니다.");
  const bucket = requireMediaBucket(env);
  const contentType = (request.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
  const format = {
    "audio/mpeg": { extension: "mp3", valid: hasMp3Signature },
    "audio/mp4": { extension: "m4a", valid: hasAacM4aSignature },
    "audio/wav": { extension: "wav", valid: hasPcmWavSignature },
  }[contentType];
  if (!format) return apiError(415, "UNSUPPORTED_MEDIA_BODY", "MP3, M4A(AAC) 또는 WAV(PCM) 파일만 업로드할 수 있습니다.");
  const body = createRequestBodyReader(request, MAX_AUDIO_BODY_BYTES,
    { status: 413, code: "MEDIA_TOO_LARGE", message: "음악 파일은 25MB 이하만 업로드할 수 있습니다." });
  const file = await body.readRest(MAX_AUDIO_FILE_BYTES,
    { status: 400, code: "INVALID_AUDIO", message: "음악 파일은 25MB 이하만 업로드할 수 있습니다." });
  if (file.byteLength === 0) return apiError(400, "INVALID_AUDIO", "음악 파일은 25MB 이하만 업로드할 수 있습니다.");
  if (!format.valid(file)) return apiError(400, "INVALID_AUDIO_SIGNATURE", "파일 내용이 선택한 음악 형식과 맞지 않습니다.");
  const mediaId = crypto.randomUUID();
  const key = `invitation/${mediaId}/background-music/track.${format.extension}`;
  await reserveMediaStorage(db, { mediaId, slot: "background-music", totalBytes: file.byteLength });
  try {
    await bucket.put(key, file, { httpMetadata: { contentType } });
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
      mimeType: contentType,
      sizeBytes: file.byteLength,
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
  const audioExtension = /^invitation\/[a-f0-9-]{36}\/background-music\/track\.(mp3|m4a|wav)$/.exec(key)?.[1];
  if (!isImage && !audioExtension) {
    return apiError(404, "MEDIA_NOT_FOUND", "미디어를 찾을 수 없습니다.");
  }
  if (audioExtension) {
    if (typeof bucket.head !== "function") {
      throw { status: 503, code: "MEDIA_UNAVAILABLE", message: "미디어 스트리밍 저장소가 아직 연결되지 않았습니다." };
    }
    const metadata = await bucket.head(key);
    if (!metadata) return apiError(404, "MEDIA_NOT_FOUND", "미디어를 찾을 수 없습니다.");
    const headers = immutableMediaHeaders(metadata, { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav" }[audioExtension]);
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

// Pure metadata helpers. Object payloads must remain native HTTP streams.
function normalizePhotoUploadMetadata(value, maxOriginalBytes, validCropPosition) {
  const slot = String(value?.slot || "").trim().toLowerCase();
  const alt = String(value?.alt || "").trim();
  const position = String(value?.position || "50% 50%").trim();
  const originalType = String(value?.originalType || "");
  const sizes = { original: value?.sizes?.original, small: value?.sizes?.small, large: value?.sizes?.large };
  if (slot.length > 40 || !/^(?:pastel-hero|pastel-gallery-(?:new|\d+))$/.test(slot) || alt.length > 300 || !validCropPosition(position)
    || !["image/jpeg", "image/png", "image/webp"].includes(originalType)
    || !Object.values(sizes).every((size) => Number.isSafeInteger(size) && size > 0)
    || sizes.original > maxOriginalBytes || sizes.small > 2 * 1024 * 1024 || sizes.large > 4 * 1024 * 1024) {
    throw { status: 400, code: "INVALID_MEDIA_METADATA", message: "사진 형식, 크기 또는 초점 위치를 확인해 주세요." };
  }
  return { slot, alt, position, originalType, sizes };
}

function photoUploadParts(mediaId, metadata) {
  const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[metadata.originalType];
  const base = `invitation/${mediaId}/${metadata.slot}`;
  return [
    { part: "original", key: `${base}/original.${extension}`, contentType: metadata.originalType, size: metadata.sizes.original },
    { part: "small", key: `${base}/480.webp`, contentType: "image/webp", size: metadata.sizes.small },
    { part: "large", key: `${base}/960.webp`, contentType: "image/webp", size: metadata.sizes.large },
  ];
}

function uploadedPhotoPayload(mediaId, metadata) {
  const base = `${MEDIA_API_PREFIX}/invitation/${mediaId}/${metadata.slot}`;
  return { mediaId, photo: {
    src: `${base}/480.webp`, srcSet: `${base}/480.webp 480w, ${base}/960.webp 960w`,
    sizes: "(min-width: 768px) 430px, 100vw", alt: metadata.alt, position: metadata.position,
  } };
}

async function beginPhotoUploads(request, env) {
  requireSameOrigin(request);
  await requireAdminEmail(request, env);
  const db = requireContentDatabase(env);
  requireMediaBucket(env);
  const payload = await readJson(request, MAX_CONTENT_BODY_BYTES);
  if (!Array.isArray(payload?.photos) || !payload.photos.length) {
    return apiError(400, "INVALID_MEDIA_METADATA", "업로드할 사진을 선택해 주세요.");
  }
  const entries = payload.photos.map((value) => {
    const metadata = normalizePhotoUploadMetadata(value, MAX_IMAGE_FILE_BYTES, validCropPosition);
    return { mediaId: crypto.randomUUID(), ...metadata, totalBytes: Object.values(metadata.sizes).reduce((sum, size) => sum + size, 0) };
  });
  const requiredBytes = entries.reduce((sum, item) => sum + item.totalBytes, 0);
  await migrateLegacyMediaSets(db);
  const serialized = JSON.stringify(entries);
  // Reserve the whole selection or none, atomically across administrators.
  const results = await runDatabaseBatch(db, [
    db.prepare(`WITH capacity AS MATERIALIZED (
      SELECT COALESCE(SUM(total_bytes), 0) AS used FROM ${MEDIA_SETS_TABLE} WHERE status IN ('reserved', 'stored')
    ) INSERT INTO ${MEDIA_SETS_TABLE} (id, slot, total_bytes, status, created_at, stored_at)
      SELECT json_extract(value, '$.mediaId'), json_extract(value, '$.slot'), json_extract(value, '$.totalBytes'), 'reserved', ?, NULL
      FROM json_each(?), capacity WHERE capacity.used + ? <= ?`)
      .bind(new Date().toISOString(), serialized, requiredBytes, MEDIA_STORAGE_LIMIT_BYTES),
    db.prepare(`INSERT INTO ${MEDIA_UPLOADS_TABLE} (media_id, metadata_json, started_at)
      SELECT json_extract(value, '$.mediaId'), value, NULL FROM json_each(?)
      WHERE EXISTS (SELECT 1 FROM ${MEDIA_SETS_TABLE} WHERE id = json_extract(value, '$.mediaId'))`).bind(serialized),
  ]);
  const changes = (Array.isArray(results) ? results : results?.results || []).map((result) => result?.meta?.changes || 0);
  if (changes[0] !== entries.length || changes[1] !== entries.length) {
    return apiError(507, "MEDIA_STORAGE_LIMIT", "선택한 사진 전체를 저장할 공간이 부족합니다. 아무 사진도 업로드하지 않았습니다.", {
      requiredBytes, usage: await getMediaUsageFromDatabase(db),
    });
  }
  return json({ uploads: entries.map((entry) => ({ mediaId: entry.mediaId })), usage: await getMediaUsageFromDatabase(db) }, 201);
}

async function photoUploadSession(db, mediaId) {
  const row = await db.prepare(`SELECT u.metadata_json, u.started_at, s.status FROM ${MEDIA_UPLOADS_TABLE} u
    JOIN ${MEDIA_SETS_TABLE} s ON s.id = u.media_id WHERE u.media_id = ?`).bind(mediaId).first();
  if (!row) throw { status: 404, code: "MEDIA_UPLOAD_NOT_FOUND", message: "업로드 예약을 찾을 수 없습니다. 사진을 다시 선택해 주세요." };
  return { ...row, metadata: JSON.parse(row.metadata_json) };
}

async function touchPhotoUpload(db, mediaId) {
  const now = new Date().toISOString();
  const results = await runDatabaseBatch(db, [
    db.prepare(`UPDATE ${MEDIA_SETS_TABLE} SET created_at = ? WHERE id = ? AND status = 'reserved'
      AND NOT EXISTS (SELECT 1 FROM ${MEDIA_DELETION_JOBS_TABLE} WHERE media_id = ?)`)
      .bind(now, mediaId, mediaId),
    db.prepare(`UPDATE ${MEDIA_UPLOADS_TABLE} SET started_at = COALESCE(started_at, ?)
      WHERE media_id = ? AND EXISTS (SELECT 1 FROM ${MEDIA_SETS_TABLE} WHERE id = ? AND status = 'reserved')`)
      .bind(now, mediaId, mediaId),
  ]);
  if (!(Array.isArray(results) ? results : results?.results)?.[0]?.meta?.changes) {
    throw { status: 409, code: "MEDIA_STORAGE_LOST", message: "이미 완료되었거나 삭제 중인 업로드입니다. 목록을 새로고침해 주세요." };
  }
}

async function putPhotoUploadPart(request, env, mediaId, partName) {
  requireSameOrigin(request);
  await requireAdminEmail(request, env);
  const db = requireContentDatabase(env);
  const bucket = requireMediaBucket(env);
  const session = await photoUploadSession(db, mediaId);
  const part = photoUploadParts(mediaId, session.metadata).find((entry) => entry.part === partName);
  if (!part) return apiError(404, "NOT_FOUND", "사진 업로드 경로가 올바르지 않습니다.");
  const contentLength = request.headers.get("content-length");
  if (contentLength === null) return apiError(411, "MEDIA_LENGTH_REQUIRED", "파일 길이를 확인할 수 없습니다. 페이지를 새로고침해 주세요.");
  if (Number(contentLength) !== part.size || !request.body
    || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== part.contentType) {
    return apiError(400, "INVALID_MEDIA_BODY", "예약한 파일의 크기 또는 형식과 일치하지 않습니다.");
  }
  await touchPhotoUpload(db, mediaId);
  // Keep retries immutable. R2 consumes the known-length native HTTP body.
  const object = await bucket.put(part.key, request.body, {
    onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: part.contentType },
  });
  if (!object) {
    const existing = await bucket.head(part.key);
    if (!existing || existing.size !== part.size || existing.httpMetadata?.contentType !== part.contentType) {
      return apiError(409, "MEDIA_PART_CONFLICT", "기존 업로드 파일과 충돌했습니다. 사진을 다시 선택해 주세요.");
    }
  }
  return json({ mediaId, part: partName, stored: true });
}

async function completePhotoUpload(request, env, mediaId) {
  requireSameOrigin(request);
  await requireAdminEmail(request, env);
  const db = requireContentDatabase(env);
  const bucket = requireMediaBucket(env);
  const session = await photoUploadSession(db, mediaId);
  if (session.status !== "stored") {
    await touchPhotoUpload(db, mediaId);
    const parts = photoUploadParts(mediaId, session.metadata);
    const heads = await Promise.all(parts.map((part) => bucket.head(part.key)));
    if (heads.some((head, index) => !head || head.size !== parts[index].size || head.httpMetadata?.contentType !== parts[index].contentType)) {
      return apiError(409, "MEDIA_UPLOAD_INCOMPLETE", "사진 파일 일부가 아직 저장되지 않았습니다. 업로드를 다시 시도해 주세요.");
    }
    await commitMediaStorage(db, mediaId);
  }
  return json({ ...uploadedPhotoPayload(mediaId, session.metadata), usage: await getMediaUsageFromDatabase(db) }, 201);
}

async function cancelUnstartedPhotoUpload(request, env, mediaId) {
  requireSameOrigin(request);
  await requireAdminEmail(request, env);
  const db = requireContentDatabase(env);
  // Do not free space while a failed/ambiguous network request may still write.
  // Started sessions remain accounted for until the existing stale cleanup.
  const result = await db.prepare(`DELETE FROM ${MEDIA_SETS_TABLE} WHERE id = ? AND status = 'reserved'
    AND EXISTS (SELECT 1 FROM ${MEDIA_UPLOADS_TABLE} WHERE media_id = ? AND started_at IS NULL)`)
    .bind(mediaId, mediaId).run();
  return json({ cancelled: Boolean(result?.meta?.changes) });
}

async function handlePhotoUploadSession(request, env, url) {
  const requestId = crypto.randomUUID();
  try {
    if (url.pathname === `${ADMIN_API_PREFIX}/media/uploads` && request.method === "POST") return await beginPhotoUploads(request, env);
    const match = url.pathname.match(/^\/api\/admin\/media\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(original|small|large|complete))?$/);
    if (match) {
      if (request.method === "PUT" && ["original", "small", "large"].includes(match[2])) return await putPhotoUploadPart(request, env, match[1], match[2]);
      if (request.method === "POST" && match[2] === "complete") return await completePhotoUpload(request, env, match[1]);
      if (request.method === "DELETE" && !match[2]) return await cancelUnstartedPhotoUpload(request, env, match[1]);
    }
    return apiError(404, "NOT_FOUND", "사진 업로드 경로가 올바르지 않습니다.");
  } catch (error) {
    if (error && Number.isInteger(error.status)) throw error;
    logMediaUploadFailure(requestId, "native_upload", error);
    return apiError(500, "INTERNAL_ERROR", "사진 업로드를 완료하지 못했습니다. 저장된 미디어를 확인해 주세요.", { requestId });
  }
}

async function handleContent(request, env, url) {
  try {
    if (url.pathname === `${ADMIN_API_PREFIX}/media/uploads` || url.pathname.startsWith(`${ADMIN_API_PREFIX}/media/uploads/`)) {
      return await handlePhotoUploadSession(request, env, url);
    }
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
    if (url.pathname === `${ADMIN_API_PREFIX}/media/list` && request.method === "GET") {
      return await getAdminMediaList(request, env);
    }
    if (url.pathname === `${ADMIN_API_PREFIX}/media/delete` && request.method === "POST") {
      return await deleteAdminMedia(request, env);
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
      if (request.method === "DELETE") return await deleteEntry(request, env);
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
    // Upgrade the document itself before CSP upgrades its module requests.
    // Otherwise HTTP documents fetch HTTPS modules across origins and fail CORS.
    if (url.protocol === "http:" && url.hostname === PRODUCTION_HOSTNAME) {
      url.protocol = "https:";
      url.port = "";
      return withSearchPrivacy(Response.redirect(url.toString(), 308), env);
    }
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
