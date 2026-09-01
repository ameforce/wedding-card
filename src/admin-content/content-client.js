import {
  applyContentDocument,
  cloneContentDocument,
  createContentDocument,
  normalizeContentDocument,
  serializeContentDocument,
  validateMusicContent,
} from "./content-document.js";

export const LOCAL_REVIEW_STORAGE_KEY = "wedding-card.content-review.v1";
export const LOCAL_REVIEW_EVENT = "wedding-card:content-review-updated";
export const MEDIA_STORAGE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_AUDIO_FILE_BYTES = 25 * 1024 * 1024;
export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";
const LOCAL_AUDIO_REFERENCE_PREFIX = "local-review-audio:";
const LOCAL_AUDIO_DATABASE_NAME = "wedding-card.content-review-media.v1";
const LOCAL_AUDIO_STORE_NAME = "audio";
let localIdCounter = 0;

function randomToken() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const words = crypto.getRandomValues(new Uint32Array(4));
    return Array.from(words, (word) => word.toString(16).padStart(8, "0")).join("");
  }

  localIdCounter += 1;
  return `${Date.now().toString(36)}-${localIdCounter.toString(36)}`;
}

export function isAdminAuthRequiredError(error) {
  return error?.code === "ADMIN_AUTH_REQUIRED" || error?.status === 401;
}

function emptyMediaUsage(localReview = false) {
  return {
    usedBytes: 0,
    limitBytes: MEDIA_STORAGE_LIMIT_BYTES,
    remainingBytes: MEDIA_STORAGE_LIMIT_BYTES,
    percent: 0,
    mediaSets: 0,
    localReview,
  };
}

function isDevelopmentBuild() {
  return import.meta.env?.DEV === true;
}

export function getEmbeddedContentPreviewConfig({ search = "", embedded = false, localReview = false } = {}) {
  const previewDraft = embedded && new URLSearchParams(search).get("contentPreview") === "draft";
  return {
    previewDraft,
    adapterMode: previewDraft ? (localReview ? "local-review" : "cloudflare") : undefined,
  };
}

function fallbackPublicContent(staticContent) {
  return {
    source: "bundled-fallback",
    revisionId: null,
    publishedAt: null,
    content: staticContent,
  };
}

function initialLocalState(staticContent) {
  const document = createContentDocument(staticContent);
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    draftRevisionId: "local-draft-initial",
    publishedRevisionId: "local-published-initial",
    draft: document,
    published: document,
    revisions: [
      { id: "local-draft-initial", status: "draft", createdAt, publishedAt: null, document },
      { id: "local-published-initial", status: "published", createdAt, publishedAt: createdAt, document },
    ],
  };
}

function normalizeLocalState(value, staticContent) {
  if (!value || value.schemaVersion !== 1) return initialLocalState(staticContent);
  const fallback = initialLocalState(staticContent);
  const draftRevisionId = value.draftRevisionId === null || typeof value.draftRevisionId === "string"
    ? value.draftRevisionId
    : fallback.draftRevisionId;
  const publishedRevisionId = typeof value.publishedRevisionId === "string" ? value.publishedRevisionId : fallback.publishedRevisionId;
  const draft = normalizeContentDocument(value.draft, staticContent, { allowLocalPreview: true });
  const published = normalizeContentDocument(value.published, staticContent, { allowLocalPreview: true });
  const createdAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    draftRevisionId,
    publishedRevisionId,
    draft,
    published,
    revisions: Array.isArray(value.revisions) ? value.revisions.slice(0, 20).map((revision) => ({
      id: typeof revision.id === "string" ? revision.id : randomToken(),
      status: ["draft", "published", "archived"].includes(revision.status) ? revision.status : "archived",
      createdAt: typeof revision.createdAt === "string" ? revision.createdAt : null,
      publishedAt: typeof revision.publishedAt === "string" ? revision.publishedAt : null,
      document: normalizeContentDocument(revision.document, staticContent, { allowLocalPreview: true }),
    })) : [
      ...(draftRevisionId ? [{ id: draftRevisionId, status: "draft", createdAt, publishedAt: null, document: draft }] : []),
      { id: publishedRevisionId, status: "published", createdAt, publishedAt: createdAt, document: published },
    ],
  };
}

function copyState(state) {
  return {
    draftRevisionId: state.draftRevisionId,
    publishedRevisionId: state.publishedRevisionId,
    draft: cloneContentDocument(state.draft),
    published: cloneContentDocument(state.published),
    history: (state.revisions || []).map(({ id, status, createdAt, publishedAt }) => ({ id, status, createdAt, publishedAt })),
  };
}

function localRevision(prefix, now) {
  return `${prefix}-${now().replace(/[^\d]/g, "").slice(0, 14)}-${randomToken()}`;
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
  error.code = typeof payload?.code === "string" ? payload.code : null;
  error.fieldErrors = payload?.fieldErrors && typeof payload.fieldErrors === "object" ? payload.fieldErrors : null;
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
  if (typeof FileReader === "undefined") {
    return blob.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
      return `data:${blob.type};base64,${btoa(binary)}`;
    });
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("로컬 미리보기 파일을 읽지 못했습니다."));
    reader.readAsDataURL(blob);
  });
}

function createMemoryAudioStore() {
  const values = new Map();
  return {
    async put(id, blob) { values.set(id, blob); },
    async get(id) { return values.get(id) ?? null; },
  };
}

function createLocalAudioStore(indexedDb = globalThis.indexedDB) {
  if (!indexedDb?.open) return createMemoryAudioStore();
  let databasePromise;
  const database = () => {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDb.open(LOCAL_AUDIO_DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(LOCAL_AUDIO_STORE_NAME)) {
          request.result.createObjectStore(LOCAL_AUDIO_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("로컬 MP3 저장소를 열지 못했습니다."));
    });
    return databasePromise;
  };
  const request = async (mode, operation) => {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(LOCAL_AUDIO_STORE_NAME, mode);
      const result = operation(transaction.objectStore(LOCAL_AUDIO_STORE_NAME));
      result.onsuccess = () => resolve(result.result ?? null);
      result.onerror = () => reject(result.error || new Error("로컬 MP3 저장소 요청이 실패했습니다."));
      transaction.onabort = () => reject(transaction.error || new Error("로컬 MP3 저장을 완료하지 못했습니다."));
    });
  };
  return {
    async put(id, blob) { await request("readwrite", (store) => store.put(blob, id)); },
    async get(id) { return request("readonly", (store) => store.get(id)); },
  };
}

function assertValidMusic(document, options) {
  const errors = validateMusicContent(document?.content?.music, options);
  const firstError = Object.values(errors)[0];
  if (firstError) throw new Error(firstError);
}

function validAudioFile(file) {
  if (!file || file.type !== "audio/mpeg") throw new Error("MP3(audio/mpeg) 파일만 업로드할 수 있습니다.");
  if (file.size < 1 || file.size > MAX_AUDIO_FILE_BYTES) throw new Error("MP3 파일은 25MB 이하만 업로드할 수 있습니다.");
  return file;
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
  audioStore = createLocalAudioStore(),
} = {}) {
  let state;
  const listeners = new Set();
  const sourceReferences = new Map();
  const referenceSources = new Map();

  const hydrateDocument = async (document) => {
    const reference = document?.content?.music?.src;
    if (!reference?.startsWith(LOCAL_AUDIO_REFERENCE_PREFIX)) return cloneContentDocument(document);
    let source = referenceSources.get(reference);
    if (!source) {
      const blob = await audioStore.get(reference.slice(LOCAL_AUDIO_REFERENCE_PREFIX.length));
      if (!blob) throw new Error("저장된 로컬 MP3 파일을 찾을 수 없습니다. 파일을 다시 선택해 주세요.");
      source = URL.createObjectURL(blob);
      referenceSources.set(reference, source);
      sourceReferences.set(source, reference);
    }
    const hydrated = cloneContentDocument(document);
    hydrated.content.music.src = source;
    return hydrated;
  };

  const presentState = async (current) => {
    const copy = copyState(current);
    copy.draft = await hydrateDocument(copy.draft);
    copy.published = await hydrateDocument(copy.published);
    return copy;
  };

  const serializeDocument = (document) => {
    const serialized = cloneContentDocument(document);
    const reference = sourceReferences.get(serialized.content.music.src);
    if (reference) serialized.content.music.src = reference;
    return serialized;
  };

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
      return presentState(load());
    },
    async getPublicContent() {
      const current = load();
      const published = await hydrateDocument(current.published);
      return {
        source: "local-review-published",
        revisionId: current.publishedRevisionId,
        publishedAt: null,
        content: applyContentDocument(published, staticContent, { allowLocalPreview: true }),
      };
    },
    async getMediaUsage() {
      return emptyMediaUsage(true);
    },
    async saveDraft(document) {
      const current = load();
      const serialized = serializeContentDocument(serializeDocument(document), { allowLocalPreview: true });
      assertValidMusic(serialized, { allowLocalPreview: true });
      state = {
        ...current,
        draftRevisionId: localRevision("local-draft", now),
        draft: normalizeContentDocument(serialized, staticContent, { allowLocalPreview: true }),
      };
      state.revisions = [
        {
          id: state.draftRevisionId,
          status: "draft",
          createdAt: now(),
          publishedAt: null,
          document: cloneContentDocument(state.draft),
        },
        ...(current.revisions || []).map((revision) => revision.status === "draft" ? { ...revision, status: "archived" } : revision),
      ].slice(0, 20);
      persist();
      return presentState(state);
    },
    async publish(revisionId) {
      const current = load();
      if (revisionId !== current.draftRevisionId) {
        throw new Error("다른 초안이 저장되어 있습니다. 새로고침 후 다시 검토해 주세요.");
      }
      state = {
        ...current,
        draftRevisionId: null,
        publishedRevisionId: revisionId,
        published: cloneContentDocument(current.draft),
      };
      const publishedAt = now();
      state.revisions = (current.revisions || []).map((revision) => revision.id === revisionId
        ? { ...revision, status: "published", publishedAt }
        : revision.status === "published" ? { ...revision, status: "archived" } : revision);
      persist();
      return presentState(state);
    },
    async republish(revisionId) {
      const current = load();
      const target = (current.revisions || []).find((revision) => revision.id === revisionId);
      if (!target || !["archived", "published"].includes(target.status) || !target.publishedAt) throw new Error("이전에 공개된 버전만 다시 공개할 수 있습니다.");
      const publishedAt = now();
      state = {
        ...current,
        publishedRevisionId: revisionId,
        published: cloneContentDocument(target.document),
        revisions: current.revisions.map((revision) => revision.id === revisionId
          ? { ...revision, status: "published", publishedAt }
          : revision.status === "published" ? { ...revision, status: "archived" } : revision),
      };
      persist();
      return { revisionId, publishedAt };
    },
    async uploadPhoto({ file, alt, position }) {
      const { large } = await optimizedFiles(file);
      return {
        photo: {
          src: await blobAsDataUrl(large),
          alt,
          position,
          sizes: "(min-width: 768px) 430px, 100vw",
        },
        usage: emptyMediaUsage(true),
      };
    },
    async uploadAudio({ file }) {
      validAudioFile(file);
      const id = randomToken();
      const reference = `${LOCAL_AUDIO_REFERENCE_PREFIX}${id}`;
      await audioStore.put(id, file);
      const source = URL.createObjectURL(file);
      sourceReferences.set(source, reference);
      referenceSources.set(reference, source);
      return {
        audio: {
          src: source,
          mimeType: "audio/mpeg",
          sizeBytes: file.size,
        },
        usage: emptyMediaUsage(true),
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
    async getPublicContent({ signal } = {}) {
      try {
        const payload = await requestJson(fetchImpl, "/api/content", { signal });
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
    async getMediaUsage() {
      return requestJson(fetchImpl, "/api/admin/media/usage");
    },
    async saveDraft(document) {
      assertValidMusic(document, { allowLocalPreview: false });
      const serialized = serializeContentDocument(document, { allowLocalPreview: false });
      const payload = await requestJson(fetchImpl, "/api/admin/content", {
        method: "PUT",
        body: JSON.stringify({ document: serialized }),
      });
      return {
        draftRevisionId: payload.draftRevisionId ?? payload.revisionId ?? null,
        publishedRevisionId: payload.publishedRevisionId ?? null,
        draft: normalizeContentDocument(payload.draft ?? serialized, staticContent),
        published: normalizeContentDocument(payload.published, staticContent),
      };
    },
    async publish(revisionId) {
      return requestJson(fetchImpl, "/api/admin/content/publish", {
        method: "POST",
        body: JSON.stringify({ revisionId }),
      });
    },
    async republish(revisionId) {
      return requestJson(fetchImpl, "/api/admin/content/rollback", {
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
      return { photo: payload.photo, usage: payload.usage };
    },
    async uploadAudio({ file }) {
      validAudioFile(file);
      const form = new FormData();
      form.set("file", file);
      const response = await fetchImpl("/api/admin/media/audio", {
        method: "POST",
        credentials: "same-origin",
        body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw createRequestError(response, payload);
      return { audio: payload.audio, usage: payload.usage };
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
