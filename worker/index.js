const API_PREFIX = "/api/guestbook";
const PASSWORD_ITERATIONS = 600_000;
const MAX_BODY_BYTES = 8_192;
const GUESTBOOK_RETENTION = "permanent";

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

async function readJson(request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw { status: 415, code: "JSON_REQUIRED", message: "JSON 요청만 허용됩니다." };
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) throw { status: 413, code: "BODY_TOO_LARGE", message: "요청이 너무 큽니다." };
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
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
  const entry = await requireUniqueCredentialMatch(db, name, password);
  return json({ entry: { name: entry.name, message: entry.message, updatedAt: entry.updated_at } });
}

async function updateEntry(request, env) {
  requireSameOrigin(request);
  const db = requireDatabase(env);
  const { name, password, message } = normalizeEntry(await readJson(request));
  const entry = await requireUniqueCredentialMatch(db, name, password);
  const updatedAt = new Date().toISOString();
  await db.prepare("UPDATE guestbook_entries SET message = ?, updated_at = ? WHERE id = ?").bind(message, updatedAt, entry.id).run();
  return json({ updatedAt });
}

function getTrustedAdminEmail(request, env) {
  if (env.GUESTBOOK_AUTH_MODE !== "trusted-email-header") return null;
  const emailHeader = env.GUESTBOOK_AUTH_EMAIL_HEADER;
  const assertionHeader = env.GUESTBOOK_AUTH_ASSERTION_HEADER;
  if (!emailHeader || !assertionHeader) return null;
  const email = request.headers.get(emailHeader)?.trim().toLowerCase();
  const assertion = request.headers.get(assertionHeader);
  if (!email || !assertion) return null;
  const allowed = String(env.GUESTBOOK_ADMIN_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length !== 2 || new Set(allowed).size !== 2) return null;
  return allowed.includes(email) ? email : null;
}

async function listAdminEntries(request, env) {
  const db = requireDatabase(env);
  const adminEmail = getTrustedAdminEmail(request, env);
  if (!adminEmail) {
    const configured = env.GUESTBOOK_AUTH_MODE === "trusted-email-header";
    return apiError(configured ? 401 : 503, configured ? "ADMIN_AUTH_REQUIRED" : "ADMIN_AUTH_UNAVAILABLE", configured
      ? "신랑·신부 계정 인증이 필요합니다."
      : "관리자 인증 공급자가 아직 연결되지 않았습니다.");
  }
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
    if (url.pathname.startsWith(API_PREFIX)) return handleGuestbook(request, env, url);

    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");

    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) {
      return response;
    }

    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return env.ASSETS.fetch(new Request(indexUrl, request));
  },
};

export const __test = { hashPassword, verifyPassword };
