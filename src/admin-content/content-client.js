import { assertMediaCapacity } from "./media-batch.js";
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
export const MAX_IMAGE_FILE_BYTES = 90 * 1024 * 1024;
export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";
const LOCAL_AUDIO_REFERENCE_PREFIX = "local-review-audio:";
const LOCAL_AUDIO_DATABASE_NAME = "wedding-card.content-review-media.v1";
const LOCAL_AUDIO_STORE_NAME = "audio";
let localIdCounter = 0;

function uuidToken(hex) {
  const characters = hex.padStart(32, "0").slice(-32).split("");
  characters[12] = "4";
  characters[16] = ["8", "9", "a", "b"][Number.parseInt(characters[16], 16) % 4];
  const value = characters.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function randomToken() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return uuidToken(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""));
  }

  localIdCounter += 1;
  const timestamp = Date.now().toString(16).padStart(12, "0");
  const counter = localIdCounter.toString(16).padStart(20, "0");
  return uuidToken(`${timestamp}${counter}`);
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
    draft: state.draftRevisionId ? cloneContentDocument(state.draft) : null,
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

function isAccessLoginUrl(value) {
  return typeof value === "string" && (/^https:\/\/[^/]+\.cloudflareaccess\.com\//i.test(value) || /\/cdn-cgi\/access\/login(?:[/?#]|$)/i.test(value));
}

function createRequestError(response, payload) {
  const fallback = response.status === 401 ? "관리자 로그인이 만료되었습니다. 다시 로그인해 주세요."
    : response.status === 413 ? "요청 크기 제한을 초과했습니다."
      : response.status === 429 ? "요청이 많습니다. 잠시 후 다시 시도해 주세요."
        : response.status >= 500 ? `서버가 업로드 요청을 완료하지 못했습니다(HTTP ${response.status}).`
          : `콘텐츠 요청에 실패했습니다(HTTP ${response.status}).`;
  const error = new Error(payload?.message || fallback);
  error.status = response.status;
  const rayId = response.headers?.get?.("cf-ray");
  if (/^[a-z0-9-]{1,80}$/i.test(rayId || "")) error.rayId = rayId;
  error.code = typeof payload?.code === "string" ? payload.code : response.status === 401 ? "ADMIN_AUTH_REQUIRED" : null;
  error.fieldErrors = payload?.fieldErrors && typeof payload.fieldErrors === "object" ? payload.fieldErrors : null;
  error.dependentRevisions = Array.isArray(payload?.dependentRevisions) ? payload.dependentRevisions : null;
  error.requestId = typeof payload?.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.requestId)
    ? payload.requestId
    : null;
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
  if (isAccessLoginUrl(response.url)) throw createRequestError({ status: 401 }, {});
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw createRequestError(response, payload);
  return payload;
}

function postBodyXhr(XHR, path, body, contentType, onProgress, method = "POST") {
  return new Promise((resolve, reject) => {
    const xhr = new XHR();
    xhr.open(method, path, true);
    xhr.timeout = 180_000;
    xhr.ontimeout = () => reject(Object.assign(new Error("업로드 응답 시간이 초과되었습니다."), { status: 408 }));
    xhr.setRequestHeader("content-type", contentType);
    if (xhr.upload) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress?.({ phase: "upload", loaded: event.loaded, total: event.total });
        }
      };
    }
    xhr.onload = () => {
      if (isAccessLoginUrl(xhr.responseURL)) { reject(createRequestError({ status: 401 }, {})); return; }
      const payload = (() => { try { return JSON.parse(xhr.responseText || "{}"); } catch { return {}; } })();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload);
        return;
      }
      const error = createRequestError({ status: xhr.status }, payload);
      const rayId = xhr.getResponseHeader?.("cf-ray");
      if (/^[a-z0-9-]{1,80}$/i.test(rayId || "")) error.rayId = rayId;
      reject(error);
    };
    xhr.onerror = () => reject(Object.assign(new Error("네트워크 오류로 업로드하지 못했습니다."), { status: 0 }));
    xhr.onabort = () => reject(new Error("업로드가 중단되었습니다."));
    onProgress?.({ phase: "upload", loaded: 0, total: 0 });
    xhr.send(body);
  });
}

async function postBody({ path, body, contentType, fetchImpl, xhrImpl, onProgress, method = "POST" }) {
  if (typeof xhrImpl === "function") return postBodyXhr(xhrImpl, path, body, contentType, onProgress, method);
  onProgress?.({ phase: "upload", loaded: 0, total: 0 });
  const response = await fetchImpl(path, {
    method,
    credentials: "same-origin",
    headers: { "content-type": contentType },
    body,
  });
  if (isAccessLoginUrl(response.url)) throw createRequestError({ status: 401 }, {});
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw createRequestError(response, payload);
  return payload;
}

async function imageBitmap(file) {
  if (typeof createImageBitmap !== "function") throw new Error("이 브라우저에서는 이미지 최적화를 사용할 수 없습니다.");
  return createImageBitmap(file, { imageOrientation: "from-image" });
}

async function resizeWebp(bitmap, maxWidth) {
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
  if (blob.type !== "image/webp") throw new Error("이 브라우저에서 WebP 사진 변환을 지원하지 않습니다.");
  return new File([blob], `${maxWidth}.webp`, { type: "image/webp" });
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
  const formats = {
    mp3: ["audio/mpeg", "audio/mp3"],
    m4a: ["audio/mp4", "audio/x-m4a", "audio/m4a"],
    wav: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"],
  };
  const extension = file?.name?.split(".").at(-1)?.toLowerCase();
  const accepted = formats[extension];
  if (!accepted || (file.type && file.type !== "application/octet-stream" && !accepted.includes(file.type.toLowerCase()))) {
    throw new Error("MP3, M4A(AAC) 또는 WAV(PCM) 파일만 업로드할 수 있습니다.");
  }
  if (file.size < 1 || file.size > MAX_AUDIO_FILE_BYTES) throw new Error("음악 파일은 25MB 이하만 업로드할 수 있습니다.");
  return accepted[0];
}

async function optimizedFiles(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("JPG, PNG 또는 WebP 이미지를 선택해 주세요.");
  }
  if (file.size < 1 || file.size > MAX_IMAGE_FILE_BYTES) throw new Error("원본 이미지는 90MB 이하만 업로드할 수 있습니다.");
  const bitmap = await imageBitmap(file);
  try {
    const small = await resizeWebp(bitmap, 480);
    const large = await resizeWebp(bitmap, 960);
    return { small, large };
  } finally {
    bitmap.close();
  }
}

/**
 * Explicitly development-only adapter. Its localStorage snapshot is a review
 * draft, never a production source of truth.
 */
async function preparePhotoFile(file) {
  const { small, large } = await optimizedFiles(file);
  if (small.size > 2 * 1024 * 1024 || large.size > 4 * 1024 * 1024) throw new Error("생성된 미리보기 이미지가 너무 큽니다.");
  return { file, small, large, totalBytes: file.size + small.size + large.size };
}

async function retryIdempotentUpload(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 2 || ![0, 408, 429, 500, 502, 503, 504].includes(error?.status)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (2 ** attempt)));
    }
  }
}

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
    preparePhoto: preparePhotoFile,
    async beginPhotoUploads(prepared) { return prepared.map(() => ({ mediaId: randomToken() })); },
    async cancelPhotoUpload() { return { cancelled: true }; },
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
    async getMediaList() {
      return { usage: emptyMediaUsage(true), media: [] };
    },
    async deleteMedia() {
      throw new Error("로컬 검토에서는 미디어 저장소를 사용하지 않습니다.");
    },
    async saveDraft(document) {
      const current = load();
      const serialized = serializeContentDocument(serializeDocument(document), { allowLocalPreview: true });
      assertValidMusic(serialized, { allowLocalPreview: true });
      const draftId = current.draftRevisionId || localRevision("local-draft", now);
      state = {
        ...current,
        draftRevisionId: draftId,
        draft: normalizeContentDocument(serialized, staticContent, { allowLocalPreview: true }),
      };
      const priorDraft = (current.revisions || []).find((revision) => revision.id === draftId && revision.status === "draft");
      state.revisions = priorDraft
        ? current.revisions.map((revision) => revision.id === draftId
          ? { ...revision, createdAt: now(), document: cloneContentDocument(state.draft) }
          : revision)
        : [
          {
            id: draftId,
            status: "draft",
            createdAt: now(),
            publishedAt: null,
            document: cloneContentDocument(state.draft),
          },
          ...(current.revisions || []),
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
    async republish(revisionId, expectedPublishedRevisionId) {
      const current = load();
      if (current.publishedRevisionId !== expectedPublishedRevisionId) {
        throw Object.assign(new Error("공개본이 변경되었습니다. 최신 상태를 다시 확인해 주세요."), { code: "STALE_PUBLISHED_REVISION" });
      }
      const target = (current.revisions || []).find((revision) => revision.id === revisionId);
      if (!target || !["archived", "published"].includes(target.status) || !target.publishedAt) throw new Error("이전에 공개된 버전만 다시 공개할 수 있습니다.");
      const publishedAt = now();
      state = {
        ...current,
        publishedRevisionId: revisionId,
        published: cloneContentDocument(target.document),
        draft: current.draftRevisionId ? current.draft : cloneContentDocument(target.document),
        revisions: current.revisions.map((revision) => revision.id === revisionId
          ? { ...revision, status: "published", publishedAt }
          : revision.status === "published" ? { ...revision, status: "archived" } : revision),
      };
      persist();
      return { revisionId, publishedAt };
    },
    async uploadPhoto({ file, prepared, alt, position, onProgress }) {
      onProgress?.({ phase: "optimize" });
      const { large } = prepared || await preparePhotoFile(file);
      const photo = {
        src: await blobAsDataUrl(large),
        alt,
        position,
        sizes: "(min-width: 768px) 430px, 100vw",
      };
      onProgress?.({ phase: "upload", loaded: 1, total: 1 });
      return {
        photo,
        usage: emptyMediaUsage(true),
      };
    },
    async uploadAudio({ file, onProgress }) {
      const mimeType = validAudioFile(file);
      onProgress?.({ phase: "prepare" });
      const id = randomToken();
      const reference = `${LOCAL_AUDIO_REFERENCE_PREFIX}${id}`;
      await audioStore.put(id, file);
      const source = URL.createObjectURL(file);
      sourceReferences.set(source, reference);
      referenceSources.set(reference, source);
      onProgress?.({ phase: "upload", loaded: 1, total: 1 });
      return {
        audio: {
          src: source,
          mimeType,
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

export function createCloudflareContentAdapter({ staticContent, fetchImpl, xhrImpl } = {}) {
  const resolvedFetch = fetchImpl ?? globalThis.fetch;
  if (typeof resolvedFetch !== "function") throw new Error("콘텐츠 API 클라이언트를 초기화할 수 없습니다.");
  const resolvedXhr = xhrImpl !== undefined ? xhrImpl : (fetchImpl === undefined ? globalThis.XMLHttpRequest : null);

  return {
    mode: "cloudflare",
    async getPublicContent({ signal } = {}) {
      try {
        const payload = await requestJson(resolvedFetch, "/api/content", { signal });
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
      const payload = await requestJson(resolvedFetch, "/api/admin/content");
      return {
        draftRevisionId: payload.draftRevisionId ?? null,
        publishedRevisionId: payload.publishedRevisionId ?? null,
        draft: payload.draft?.document ? normalizeContentDocument(payload.draft.document, staticContent) : null,
        published: normalizeContentDocument(payload.published?.document, staticContent),
        history: Array.isArray(payload.history) ? payload.history : [],
      };
    },
    async getMediaUsage() {
      return requestJson(resolvedFetch, "/api/admin/media/usage");
    },
    async getMediaList() {
      return requestJson(resolvedFetch, "/api/admin/media/list");
    },
    async deleteMedia(mediaId, { deleteRevisions = false, expectedRevisionIds } = {}) {
      return requestJson(resolvedFetch, "/api/admin/media/delete", {
        method: "POST",
        body: JSON.stringify({ mediaId, deleteRevisions, ...(expectedRevisionIds ? { expectedRevisionIds } : {}) }),
      });
    },
    async saveDraft(document) {
      assertValidMusic(document, { allowLocalPreview: false });
      const serialized = serializeContentDocument(document, { allowLocalPreview: false });
      const payload = await requestJson(resolvedFetch, "/api/admin/content", {
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
      return requestJson(resolvedFetch, "/api/admin/content/publish", {
        method: "POST",
        body: JSON.stringify({ revisionId }),
      });
    },
    async republish(revisionId, expectedPublishedRevisionId) {
      return requestJson(resolvedFetch, "/api/admin/content/rollback", {
        method: "POST",
        body: JSON.stringify({ revisionId, expectedPublishedRevisionId }),
      });
    },
    preparePhoto: preparePhotoFile,
    async beginPhotoUploads(prepared, { slot, alt = "", position = "50% 50%" }) {
      const payload = await requestJson(resolvedFetch, "/api/admin/media/uploads", {
        method: "POST",
        body: JSON.stringify({ photos: prepared.map(({ file, small, large }) => ({ slot, alt, position,
          originalType: file.type, sizes: { original: file.size, small: small.size, large: large.size },
        })) }),
      });
      if (!Array.isArray(payload.uploads) || payload.uploads.length !== prepared.length
        || payload.uploads.some((item) => !/^[0-9a-f-]{36}$/.test(item.mediaId))) {
        throw new Error("서버의 업로드 예약 응답이 올바르지 않습니다. 저장된 미디어를 확인해 주세요.");
      }
      return payload.uploads;
    },
    async cancelPhotoUpload(mediaId) {
      return requestJson(resolvedFetch, `/api/admin/media/uploads/${mediaId}`, { method: "DELETE" });
    },
    async uploadPhoto({ slot, file, prepared, sessionId, alt = "", position = "50% 50%", onProgress }) {
      let item = prepared;
      if (!item) {
        onProgress?.({ phase: "optimize" });
        assertMediaCapacity(await this.getMediaUsage(), file.size);
        item = await preparePhotoFile(file);
      }
      if (!sessionId) {
        assertMediaCapacity(await this.getMediaUsage(), item.totalBytes);
        sessionId = (await this.beginPhotoUploads([item], { slot, alt, position }))[0].mediaId;
      }
      let sentBytes = 0;
      try {
        for (const [part, body] of [["original", item.file], ["small", item.small], ["large", item.large]]) {
          const payload = await retryIdempotentUpload(() => postBody({
            path: `/api/admin/media/uploads/${sessionId}/${part}`, method: "PUT", body,
            contentType: body.type, fetchImpl: resolvedFetch, xhrImpl: resolvedXhr,
            onProgress: (event) => onProgress?.({ ...event, loaded: sentBytes + Math.min(body.size, event.loaded || 0), total: item.totalBytes }),
          }));
          if (payload.stored !== true) throw new Error("사진 저장 응답을 확인하지 못했습니다.");
          sentBytes += body.size;
          onProgress?.({ phase: "upload", loaded: sentBytes, total: item.totalBytes });
        }
        const payload = await retryIdempotentUpload(() => requestJson(resolvedFetch,
          `/api/admin/media/uploads/${sessionId}/complete`, { method: "POST", body: "{}" }));
        if (!payload.photo?.src) throw new Error("사진 업로드 완료 응답을 확인하지 못했습니다.");
        return { photo: payload.photo, usage: payload.usage };
      } catch (error) {
        await this.cancelPhotoUpload(sessionId).catch(() => {});
        throw error;
      }
    },
    async uploadAudio({ file, onProgress }) {
      const mimeType = validAudioFile(file);
      onProgress?.({ phase: "prepare" });
      const payload = await postBody({ path: "/api/admin/media/audio", body: file, contentType: mimeType, fetchImpl: resolvedFetch, xhrImpl: resolvedXhr, onProgress });
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
