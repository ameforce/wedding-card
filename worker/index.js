const API_PREFIX = "/api/guestbook";
const CONTENT_API_PREFIX = "/api/content";
const ADMIN_API_PREFIX = "/api/admin";
const MEDIA_API_PREFIX = "/api/media";
const PASSWORD_ITERATIONS = 600_000;
const MAX_BODY_BYTES = 8_192;
const MAX_CONTENT_BODY_BYTES = 131_072;
const MAX_MEDIA_BODY_BYTES = 30 * 1024 * 1024;
const MEDIA_STORAGE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const GUESTBOOK_RETENTION = "permanent";
const SEARCH_ROBOTS_DIRECTIVE = "noindex, nofollow, noarchive, nosnippet, noimageindex";
const ACCESS_JWKS_TTL_MS = 5 * 60 * 1000;
const accessKeyCache = new Map();

function withSearchPrivacy(response) {
  const headers = new Headers(response.headers);
  headers.set("x-robots-tag", SEARCH_ROBOTS_DIRECTIVE);
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

function apiError(status, code, message) {
  return json({ code, message }, status);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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

async function enforceGuestbookRateLimit(env, action, actor = "all") {
  if (env.REQUIRE_GUESTBOOK_RATE_LIMIT !== "1") return;
  if (!env.GUESTBOOK_RATE_LIMITER || typeof env.GUESTBOOK_RATE_LIMITER.limit !== "function") {
    throw { status: 503, code: "RATE_LIMIT_UNAVAILABLE", message: "방명록 보호 기능이 아직 연결되지 않았습니다." };
  }
  const key = `${action}:${await privacyPreservingRateKey(actor)}`;
  const result = await env.GUESTBOOK_RATE_LIMITER.limit({ key });
  if (!result?.success) {
    throw { status: 429, code: "RATE_LIMITED", message: "요청이 많습니다. 잠시 후 다시 시도해 주세요." };
  }
}

async function verifyPassword(password, encoded) {
  const [algorithm, iterationsText, saltText, hashText] = String(encoded).split("$");
  const iterations = Number(iterationsText);
  if (algorithm !== "pbkdf2-sha256" || iterations !== PASSWORD_ITERATIONS || !saltText || !hashText) return false;
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
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw { status: 413, code: "BODY_TOO_LARGE", message: "요청이 너무 큽니다." };
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw { status: 413, code: "BODY_TOO_LARGE", message: "요청이 너무 큽니다." };
  }
  try {
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
  if (name.length < 1 || name.length > 30) throw { status: 400, code: "INVALID_NAME", message: "이름은 1~30자로 입력해 주세요." };
  if (password.length < 4 || password.length > 72) throw { status: 400, code: "INVALID_PASSWORD", message: "비밀번호는 4~72자로 입력해 주세요." };
  if (requireMessage && (message.length < 1 || message.length > 500)) {
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
    "SELECT id, name, message, password_hash, created_at, updated_at FROM guestbook_entries WHERE name = ? LIMIT 2",
  ).bind(name).all();
  return result.results || [];
}

async function requireUniqueCredentialMatch(db, name, password) {
  const candidates = await findEntriesByName(db, name);
  if (candidates.length !== 1) {
    throw { status: 401, code: "ENTRY_AUTH_FAILED", message: "이름 또는 비밀번호를 확인해 주세요." };
  }
  let passwordMatches = false;
  try {
    passwordMatches = await verifyPassword(password, candidates[0].password_hash);
  } catch {
    passwordMatches = false;
  }
  if (!passwordMatches) {
    throw { status: 401, code: "ENTRY_AUTH_FAILED", message: "이름 또는 비밀번호를 확인해 주세요." };
  }
  return candidates[0];
}

async function createEntry(request, env) {
  requireSameOrigin(request);
  const db = requireDatabase(env);
  const { name, password, message } = normalizeEntry(await readJson(request));
  await enforceGuestbookRateLimit(env, "create", request.headers.get("cf-connecting-ip")?.trim() || "unknown-client");
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
  const { name, password } = normalizeEntry(await readJson(request), { requireMessage: false });
  await enforceGuestbookRateLimit(env, "unlock", name);
  const entry = await requireUniqueCredentialMatch(db, name, password);
  return json({ entry: { name: entry.name, message: entry.message, updatedAt: entry.updated_at } });
}

async function updateEntry(request, env) {
  requireSameOrigin(request);
  const db = requireDatabase(env);
  const { name, password, message } = normalizeEntry(await readJson(request));
  await enforceGuestbookRateLimit(env, "update", name);
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
  const result = await db.prepare(
    "SELECT id, name, message, created_at, updated_at FROM guestbook_entries ORDER BY created_at DESC LIMIT 500",
  ).all();
  return json({
    entries: (result.results || []).map((entry) => ({
      id: entry.id,
      name: entry.name,
      message: entry.message,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
    })),
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

function validateInvitationDocument(document, { publish = false } = {}) {
  requirePlainObject(document, "document");
  if (document.schemaVersion !== 1) {
    throw { status: 400, code: "UNSUPPORTED_CONTENT_SCHEMA", message: "지원하지 않는 초대장 콘텐츠 버전입니다." };
  }
  const content = requirePlainObject(document.content, "content");
  const photos = requirePlainObject(document.photos, "photos");
  requirePlainObject(photos.pastel, "photos.pastel");
  requirePlainObject(photos.pastel.hero, "photos.pastel.hero");
  requireText(photos.pastel.hero.src, "photos.pastel.hero.src", 500);
  requireText(photos.pastel.hero.alt, "photos.pastel.hero.alt", 300);
  const requiredTextPaths = [
    [content.couple?.groom, "content.couple.groom", 50],
    [content.couple?.bride, "content.couple.bride", 50],
    [content.event?.isoDate, "content.event.isoDate", 20],
    [content.event?.time, "content.event.time", 30],
    [content.venue?.name, "content.venue.name", 100],
    [content.venue?.address, "content.venue.address", 300],
  ];
  for (const [value, path, maxLength] of requiredTextPaths) requireText(value, path, maxLength);
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

async function runDatabaseBatch(db, statements) {
  if (typeof db.batch === "function") return db.batch(statements);
  const results = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
}

async function getPublishedInvitation(env) {
  const db = requireContentDatabase(env);
  const state = await getInvitationState(db);
  const revision = await getInvitationRevision(db, state?.published_revision_id);
  if (!revision) return apiError(503, "CONTENT_NOT_PUBLISHED", "공개된 초대장 콘텐츠가 아직 없습니다.");
  return json({ revisionId: revision.id, publishedAt: revision.publishedAt, document: revision.document });
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
  return json({
    draftRevisionId: draft?.id || null,
    publishedRevisionId: published?.id || null,
    draft,
    published,
    history: (historyResult.results || []).map((revision) => ({
      id: revision.id,
      status: revision.status,
      createdAt: revision.created_at,
      publishedAt: revision.published_at,
    })),
  });
}

async function saveInvitationDraft(request, env) {
  requireSameOrigin(request);
  const db = requireContentDatabase(env);
  const adminEmail = await requireAdminEmail(request, env);
  const payload = await readJson(request, MAX_CONTENT_BODY_BYTES);
  const contentJson = validateInvitationDocument(payload.document);
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
    return apiError(409, "STALE_DRAFT", "현재 임시 저장본을 다시 불러온 뒤 공개해 주세요.");
  }
  const draft = await getInvitationRevision(db, revisionId);
  if (!draft || draft.status !== "draft") return apiError(409, "STALE_DRAFT", "공개할 임시 저장본이 없습니다.");
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
  if (!target || !["archived", "published"].includes(target.status)) {
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
    throw { status: 503, code: "MEDIA_UNAVAILABLE", message: "이미지 저장소가 아직 연결되지 않았습니다." };
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
    throw { status: 507, code: "MEDIA_STORAGE_LIMIT", message: "사진 저장 공간 2GB 한도에 도달했습니다. 기존 사진 정리 후 다시 시도해 주세요." };
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

async function getInvitationMedia(env, url) {
  const bucket = requireMediaBucket(env);
  const key = decodeURIComponent(url.pathname.slice(`${MEDIA_API_PREFIX}/`.length));
  if (!/^invitation\/[a-f0-9-]{36}\/[a-z0-9-]{1,40}\/(?:480|960)\.webp$/.test(key)) {
    return apiError(404, "MEDIA_NOT_FOUND", "이미지를 찾을 수 없습니다.");
  }
  const object = await bucket.get(key);
  if (!object) return apiError(404, "MEDIA_NOT_FOUND", "이미지를 찾을 수 없습니다.");
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType || "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      etag: object.httpEtag || object.etag,
    },
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
    if (url.pathname === `${ADMIN_API_PREFIX}/media/usage` && request.method === "GET") {
      return await getAdminMediaUsage(request, env);
    }
    if (url.pathname.startsWith(`${MEDIA_API_PREFIX}/`) && request.method === "GET") {
      return await getInvitationMedia(env, url);
    }
    return apiError(404, "NOT_FOUND", "요청한 초대장 콘텐츠 경로가 없습니다.");
  } catch (error) {
    if (error && Number.isInteger(error.status)) return apiError(error.status, error.code, error.message);
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
      return withSearchPrivacy(await handleGuestbook(request, env, url));
    }
    if (url.pathname === CONTENT_API_PREFIX
      || url.pathname.startsWith(`${ADMIN_API_PREFIX}/`)
      || url.pathname.startsWith(`${MEDIA_API_PREFIX}/`)) {
      return withSearchPrivacy(await handleContent(request, env, url));
    }

    const acceptsHtml = request.headers.get("accept")?.includes("text/html");
    const servesAdminShell = ["/admin/content", "/admin/guestbook"].includes(url.pathname)
      && acceptsHtml
      && ["GET", "HEAD"].includes(request.method);

    if (servesAdminShell) {
      const indexUrl = new URL(request.url);
      indexUrl.pathname = "/";
      indexUrl.search = "";
      return withSearchPrivacy(await env.ASSETS.fetch(new Request(indexUrl, request)));
    }

    const response = await env.ASSETS.fetch(request);

    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) {
      return withSearchPrivacy(response);
    }

    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/";
    indexUrl.search = "";
    return withSearchPrivacy(await env.ASSETS.fetch(new Request(indexUrl, request)));
  },
};

export const __test = { hashPassword, verifyPassword, verifyAccessJwt, validateInvitationDocument };
