import {
  applyContentDocument,
  cloneContentDocument,
  createContentDocument,
  normalizeContentDocument,
} from "./content-document.js";

export const LOCAL_REVIEW_STORAGE_KEY = "wedding-card.content-review.v1";
export const LOCAL_REVIEW_EVENT = "wedding-card:content-review-updated";

function isDevelopmentBuild() {
  return import.meta.env?.DEV === true;
}

function fallbackPublicContent(staticContent) {
  return {
    source: "bundled-static",
    revisionId: null,
    publishedAt: null,
    content: staticContent,
  };
}

function initialLocalState(staticContent) {
  const document = createContentDocument(staticContent);
  return {
    schemaVersion: 1,
    draftRevisionId: "local-draft-initial",
    publishedRevisionId: "local-published-initial",
    draft: document,
    published: document,
  };
}

function normalizeLocalState(value, staticContent) {
  if (!value || value.schemaVersion !== 1) return initialLocalState(staticContent);
  const fallback = initialLocalState(staticContent);
  return {
    schemaVersion: 1,
    draftRevisionId: typeof value.draftRevisionId === "string" ? value.draftRevisionId : fallback.draftRevisionId,
    publishedRevisionId: typeof value.publishedRevisionId === "string" ? value.publishedRevisionId : fallback.publishedRevisionId,
    draft: normalizeContentDocument(value.draft, staticContent, { allowLocalPreview: true }),
    published: normalizeContentDocument(value.published, staticContent, { allowLocalPreview: true }),
  };
}

function copyState(state) {
  return {
    draftRevisionId: state.draftRevisionId,
    publishedRevisionId: state.publishedRevisionId,
    draft: cloneContentDocument(state.draft),
    published: cloneContentDocument(state.published),
  };
}

function localRevision(prefix, now) {
  return `${prefix}-${now().replace(/[^\d]/g, "").slice(0, 14)}`;
}

function defaultStorage() {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function defaultEventTarget() {
  return typeof window === "undefined" ? null : window;
}

function createRequestError(response, payload) {
  const error = new Error(payload?.message || "콘텐츠 요청을 처리하지 못했습니다.");
  error.status = response.status;
  return error;
}

async function requestJson(fetchImpl, path, options = {}) {
  const response = await fetchImpl(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw createRequestError(response, payload);
  return payload;
}

async function imageBitmap(file) {
  if (typeof createImageBitmap !== "function") throw new Error("이 브라우저에서는 이미지 최적화를 사용할 수 없습니다.");
  return createImageBitmap(file, { imageOrientation: "from-image" });
}

async function resizeWebp(file, maxWidth) {
  const bitmap = await imageBitmap(file);
  try {
    const width = Math.min(maxWidth, bitmap.width);
    const height = Math.max(1, Math.round(bitmap.height * (width / bitmap.width)));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("이미지를 처리하지 못했습니다.");
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error("WebP 이미지를 만들지 못했습니다.")), "image/webp", 0.86);
    });
    return new File([blob], `${maxWidth}.webp`, { type: "image/webp" });
  } finally {
    bitmap.close();
  }
}

function blobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("로컬 미리보기 이미지를 읽지 못했습니다."));
    reader.readAsDataURL(blob);
  });
}

async function optimizedFiles(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("JPG, PNG 또는 WebP 이미지를 선택해 주세요.");
  }
  if (file.size > 25 * 1024 * 1024) throw new Error("원본 이미지는 25MB 이하만 업로드할 수 있습니다.");
  const [small, large] = await Promise.all([resizeWebp(file, 480), resizeWebp(file, 960)]);
  return { small, large };
}

/**
 * Explicitly development-only adapter. Its localStorage snapshot is a review
 * draft, never a production source of truth.
 */
export function createLocalReviewContentAdapter({
  staticContent,
  storage = defaultStorage(),
  eventTarget = defaultEventTarget(),
  now = () => new Date().toISOString(),
} = {}) {
  let state;
  const listeners = new Set();

  const load = () => {
    if (state) return state;
    try {
      const saved = storage?.getItem(LOCAL_REVIEW_STORAGE_KEY);
      state = normalizeLocalState(saved ? JSON.parse(saved) : null, staticContent);
    } catch {
      state = initialLocalState(staticContent);
    }
    return state;
  };

  const notify = () => {
    listeners.forEach((listener) => listener());
    if (eventTarget?.dispatchEvent && typeof Event === "function") {
      eventTarget.dispatchEvent(new Event(LOCAL_REVIEW_EVENT));
    }
  };

  const persist = () => {
    if (!storage?.setItem) throw new Error("로컬 검토 저장소를 사용할 수 없습니다.");
    storage.setItem(LOCAL_REVIEW_STORAGE_KEY, JSON.stringify(state));
    notify();
  };

  const refreshFromStorage = (event) => {
    if (event?.key && event.key !== LOCAL_REVIEW_STORAGE_KEY) return;
    state = undefined;
    load();
    listeners.forEach((listener) => listener());
  };

  return {
    mode: "local-review",
    async getAdminState() {
      return copyState(load());
    },
    async getPublicContent() {
      const current = load();
      return {
        source: "local-review-published",
        revisionId: current.publishedRevisionId,
        publishedAt: null,
        content: applyContentDocument(current.published, staticContent, { allowLocalPreview: true }),
      };
    },
    async saveDraft(document) {
      const current = load();
      state = {
        ...current,
        draftRevisionId: localRevision("local-draft", now),
        draft: normalizeContentDocument(document, staticContent, { allowLocalPreview: true }),
      };
      persist();
      return copyState(state);
    },
    async publish(revisionId) {
      const current = load();
      if (revisionId !== current.draftRevisionId) {
        throw new Error("다른 초안이 저장되어 있습니다. 새로고침 후 다시 검토해 주세요.");
      }
      state = {
        ...current,
        publishedRevisionId: localRevision("local-published", now),
        published: cloneContentDocument(current.draft),
      };
      persist();
      return copyState(state);
    },
    async uploadPhoto({ file, alt, position }) {
      const { large } = await optimizedFiles(file);
      return {
        src: await blobAsDataUrl(large),
        alt,
        position,
        sizes: "(min-width: 768px) 430px, 100vw",
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      eventTarget?.addEventListener?.("storage", refreshFromStorage);
      eventTarget?.addEventListener?.(LOCAL_REVIEW_EVENT, refreshFromStorage);
      return () => {
        listeners.delete(listener);
        eventTarget?.removeEventListener?.("storage", refreshFromStorage);
        eventTarget?.removeEventListener?.(LOCAL_REVIEW_EVENT, refreshFromStorage);
      };
    },
  };
}

export function createCloudflareContentAdapter({ staticContent, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("콘텐츠 API 클라이언트를 초기화할 수 없습니다.");

  return {
    mode: "cloudflare",
    async getPublicContent() {
      try {
        const payload = await requestJson(fetchImpl, "/api/content");
        return {
          source: "cloudflare-published",
          revisionId: payload.revisionId ?? null,
          publishedAt: payload.publishedAt ?? null,
          content: applyContentDocument(payload.document, staticContent),
        };
      } catch {
        return fallbackPublicContent(staticContent);
      }
    },
    async getAdminState() {
      const payload = await requestJson(fetchImpl, "/api/admin/content");
      return {
        draftRevisionId: payload.draftRevisionId ?? null,
        publishedRevisionId: payload.publishedRevisionId ?? null,
        draft: normalizeContentDocument(payload.draft?.document, staticContent),
        published: normalizeContentDocument(payload.published?.document, staticContent),
        history: Array.isArray(payload.history) ? payload.history : [],
      };
    },
    async saveDraft(document) {
      const normalized = normalizeContentDocument(document, staticContent);
      const payload = await requestJson(fetchImpl, "/api/admin/content", {
        method: "PUT",
        body: JSON.stringify({ document: normalized }),
      });
      return {
        draftRevisionId: payload.draftRevisionId ?? payload.revisionId ?? null,
        publishedRevisionId: payload.publishedRevisionId ?? null,
        draft: normalizeContentDocument(payload.draft ?? normalized, staticContent),
        published: normalizeContentDocument(payload.published, staticContent),
      };
    },
    async publish(revisionId) {
      return requestJson(fetchImpl, "/api/admin/content/publish", {
        method: "POST",
        body: JSON.stringify({ revisionId }),
      });
    },
    async uploadPhoto({ slot, file, alt, position }) {
      const { small, large } = await optimizedFiles(file);
      const form = new FormData();
      form.set("slot", slot);
      form.set("alt", alt);
      form.set("position", position);
      form.set("original", file);
      form.set("small", small);
      form.set("large", large);
      const response = await fetchImpl("/api/admin/media", {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw createRequestError(response, payload);
      return payload.photo;
    },
    subscribe() {
      return () => {};
    },
  };
}

export function createContentAdapter(options = {}) {
  if (options.mode === "local-review" || (options.mode === undefined && isDevelopmentBuild())) {
    return createLocalReviewContentAdapter(options);
  }
  return createCloudflareContentAdapter(options);
}

export function isLocalReviewBuild() {
  return isDevelopmentBuild();
}
