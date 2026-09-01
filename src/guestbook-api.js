const JSON_HEADERS = { "content-type": "application/json" };

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...JSON_HEADERS,
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const unavailable = response.status === 404 || response.status === 503;
    const error = new Error(payload.message || (unavailable
      ? "방명록 저장소가 아직 연결되지 않았습니다. 메시지는 전송되지 않았습니다."
      : "요청을 처리하지 못했습니다."));
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

export function createGuestbookEntry(entry) {
  return requestJson("/api/guestbook/entries", {
    method: "POST",
    body: JSON.stringify(entry),
  });
}

export function unlockGuestbookEntry(credentials) {
  return requestJson("/api/guestbook/entries/unlock", {
    method: "POST",
    body: JSON.stringify(credentials),
  });
}

export function updateGuestbookEntry(entry) {
  return requestJson("/api/guestbook/entries", {
    method: "PATCH",
    body: JSON.stringify(entry),
  });
}

export function getAdminGuestbookEntries({ query = "", range = "all", cursor = "", limit = 50 } = {}) {
  const search = new URLSearchParams();
  const normalizedQuery = query.normalize("NFKC").trim();
  if (normalizedQuery) search.set("q", normalizedQuery);
  if (["7d", "30d"].includes(range)) search.set("range", range);
  if (cursor) search.set("cursor", cursor);
  search.set("limit", String(limit));
  return requestJson(`/api/guestbook/admin/entries?${search}`, { method: "GET" });
}
