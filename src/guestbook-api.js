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

export function unlockGuestbookEntry(id, credentials) {
  return requestJson(`/api/guestbook/entries/${encodeURIComponent(id)}/unlock`, {
    method: "POST",
    body: JSON.stringify(credentials),
  });
}

export function updateGuestbookEntry(id, entry) {
  return requestJson(`/api/guestbook/entries/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(entry),
  });
}

export function getAdminGuestbookEntries() {
  return requestJson("/api/guestbook/admin/entries", { method: "GET" });
}
