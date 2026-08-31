import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { weddingContent } from "../src/content.js";
import {
  applyContentDocument,
  CONTENT_SCHEMA_VERSION,
  createContentDocument,
  normalizeContentDocument,
  validateMusicContent,
} from "../src/admin-content/content-document.js";
import {
  ACCESS_LOGOUT_PATH,
  createContentAdapter,
  createCloudflareContentAdapter,
  createLocalReviewContentAdapter,
  getEmbeddedContentPreviewConfig,
  isAdminAuthRequiredError,
  LOCAL_REVIEW_STORAGE_KEY,
} from "../src/admin-content/content-client.js";
import {
  initialPublicContentState,
  PUBLIC_CONTENT_TIMEOUT_MS,
  readPublicBootstrap,
} from "../src/admin-content/public-bootstrap.js";

function bootstrapRoot(payload, schemaVersion = "1") {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return {
    getElementById() {
      return { dataset: { schemaVersion }, content: { textContent: encoded } };
    },
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    values,
  };
}

test("admin documents preserve non-editable public and search-privacy contracts", () => {
  const document = createContentDocument(weddingContent);
  document.content.couple.groom = "변경 이름";
  document.content.hero.introLines = ["저희 두 사람", "관리자 미리보기 변경"];
  document.content.publishing.searchIndexing = true;
  document.content.rsvp.enabled = true;
  document.content.accounts = {};
  const normalized = normalizeContentDocument(document, weddingContent);

  assert.equal(normalized.content.couple.groom, "변경 이름");
  assert.deepEqual(normalized.content.hero.introLines, ["저희 두 사람", "관리자 미리보기 변경"]);
  assert.equal(normalized.content.publishing.searchIndexing, false);
  assert.deepEqual(normalized.content.rsvp, { enabled: false });
  assert.deepEqual(normalized.content.accounts, weddingContent.accounts);
  assert.deepEqual(normalized.content.familyContacts, weddingContent.familyContacts);
  assert.equal(normalized.photos.pastel.hero.src.startsWith("/assets/photos/"), true);
});

test("schema v1 documents remain readable with the bundled music fallback and new writes use v2", () => {
  const legacy = createContentDocument(weddingContent);
  legacy.schemaVersion = 1;
  legacy.content.music = {
    ...weddingContent.music,
    title: "schema v1의 검증되지 않은 음악",
    src: "https://attacker.example/track.mp3",
  };
  const normalized = normalizeContentDocument(legacy, weddingContent);

  assert.equal(CONTENT_SCHEMA_VERSION, 2);
  assert.equal(normalized.schemaVersion, 2);
  assert.deepEqual(normalized.content.music, weddingContent.music);
});

test("schema v2 music metadata round-trips and rejects invalid credit URLs", async () => {
  const document = createContentDocument(weddingContent);
  document.content.music = {
    src: "/api/media/invitation/123e4567-e89b-12d3-a456-426614174000/background-music/track.mp3",
    title: "새 배경 음악",
    artist: "새 아티스트",
    sourceUrl: "https://music.example.test/track",
    licenseLabel: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  };
  assert.deepEqual(normalizeContentDocument(document, weddingContent).content.music, document.content.music);
  assert.deepEqual(validateMusicContent(document.content.music), {});

  const adapter = createCloudflareContentAdapter({
    staticContent: weddingContent,
    fetchImpl: async () => Response.json({ revisionId: "unexpected" }),
  });
  document.content.music.sourceUrl = "http://music.example.test/track";
  await assert.rejects(adapter.saveDraft(document), /HTTPS/);
});

test("development review keeps draft and published content as separate explicit states", async () => {
  const storage = memoryStorage();
  const adapter = createLocalReviewContentAdapter({
    staticContent: weddingContent,
    storage,
    eventTarget: new EventTarget(),
    now: () => "2026-08-17T12:34:56.000Z",
  });
  const initial = await adapter.getAdminState();
  initial.draft.content.venue.name = "검토용 예식장";
  const saved = await adapter.saveDraft(initial.draft);
  assert.match(saved.draftRevisionId, /^local-draft-/);
  assert.equal((await adapter.getPublicContent()).content.venue.name, weddingContent.venue.name);

  await adapter.publish(saved.draftRevisionId);
  assert.equal((await adapter.getPublicContent()).content.venue.name, "검토용 예식장");
  assert.equal(storage.values.has(LOCAL_REVIEW_STORAGE_KEY), true);
});

test("public bootstrap selects exactly one published or bundled source before React", () => {
  const document = createContentDocument(weddingContent);
  document.content.venue.name = "D1 공개 예식장";
  const published = readPublicBootstrap(weddingContent, bootstrapRoot({
    schemaVersion: 1,
    source: "cloudflare-published",
    revisionId: "published-42",
    publishedAt: "2026-08-30T00:00:00.000Z",
    document,
  }));
  assert.equal(published.status, "ready");
  assert.equal(published.source, "cloudflare-published");
  assert.equal(published.revisionId, "published-42");
  assert.equal(published.content.venue.name, "D1 공개 예식장");

  const fallback = readPublicBootstrap(weddingContent, bootstrapRoot({
    schemaVersion: 1,
    source: "bundled-fallback",
    revisionId: null,
    publishedAt: null,
    document: null,
  }));
  assert.equal(fallback.status, "ready");
  assert.equal(fallback.source, "bundled-fallback");
  assert.equal(fallback.content, weddingContent);
});

test("missing, invalid, and embedded bootstrap states stay neutral until one source settles", () => {
  assert.equal(initialPublicContentState({ staticContent: weddingContent, root: { getElementById: () => null } }).status, "pending");
  assert.equal(initialPublicContentState({ staticContent: weddingContent, root: bootstrapRoot({}, "2") }).status, "pending");
  assert.equal(initialPublicContentState({ previewDraft: true, staticContent: weddingContent }).source, "pending");
  assert.equal(initialPublicContentState({ localReview: true, staticContent: weddingContent }).source, "pending");
  assert.equal(PUBLIC_CONTENT_TIMEOUT_MS, 3_000);
});

test("production draft persists for administrator reloads and moves the public pointer only on publish", async () => {
  let draft = null;
  let published = {
    id: "published-1",
    document: createContentDocument(weddingContent),
  };
  let draftSequence = 1;
  const fetchImpl = async (path, options = {}) => {
    const method = options.method || "GET";
    if (path === "/api/content" && method === "GET") {
      return Response.json({ revisionId: published.id, document: published.document });
    }
    if (path === "/api/admin/content" && method === "GET") {
      return Response.json({
        draftRevisionId: draft?.id ?? null,
        publishedRevisionId: published.id,
        draft: draft && { id: draft.id, document: draft.document },
        published: { id: published.id, document: published.document },
        history: [],
      });
    }
    if (path === "/api/admin/content" && method === "PUT") {
      draft = {
        id: `draft-${draftSequence += 1}`,
        document: JSON.parse(options.body).document,
      };
      return Response.json({ revisionId: draft.id }, { status: 201 });
    }
    if (path === "/api/admin/content/publish" && method === "POST") {
      const { revisionId } = JSON.parse(options.body);
      assert.equal(revisionId, draft?.id);
      published = { id: revisionId, document: draft.document };
      draft = null;
      return Response.json({ revisionId });
    }
    return Response.json({}, { status: 404 });
  };

  const adapter = createCloudflareContentAdapter({ staticContent: weddingContent, fetchImpl });
  const editing = createContentDocument(weddingContent);
  editing.content.venue.name = "초안 전용 예식장";
  const saved = await adapter.saveDraft(editing);

  const reloadedAdmin = await createCloudflareContentAdapter({ staticContent: weddingContent, fetchImpl }).getAdminState();
  assert.equal(reloadedAdmin.draftRevisionId, saved.draftRevisionId);
  assert.equal(reloadedAdmin.draft.content.venue.name, "초안 전용 예식장");
  assert.equal((await adapter.getPublicContent()).content.venue.name, weddingContent.venue.name);

  await adapter.publish(saved.draftRevisionId);
  assert.equal((await adapter.getPublicContent()).content.venue.name, "초안 전용 예식장");
});

test("draft preview is embedded-only and production keeps its public-content transport separate", () => {
  const productionPreview = getEmbeddedContentPreviewConfig({
    search: "?contentPreview=draft",
    embedded: true,
    localReview: false,
  });
  assert.deepEqual(productionPreview, { previewDraft: true, adapterMode: "cloudflare" });
  assert.equal(createContentAdapter({ staticContent: weddingContent, mode: productionPreview.adapterMode }).mode, "cloudflare");
  assert.deepEqual(
    getEmbeddedContentPreviewConfig({ search: "?contentPreview=draft", embedded: false, localReview: false }),
    { previewDraft: false, adapterMode: undefined },
  );
  assert.deepEqual(
    getEmbeddedContentPreviewConfig({ search: "?contentPreview=draft", embedded: true, localReview: true }),
    { previewDraft: true, adapterMode: "local-review" },
  );
});

test("production adapter uses the reviewed Cloudflare API paths and revision envelopes", async () => {
  const document = createContentDocument(weddingContent);
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push([path, options.method || "GET"]);
    if (path === "/api/content") return Response.json({ revisionId: "published-1", document });
    if (path === "/api/admin/content" && !options.method) {
      return Response.json({
        draftRevisionId: "draft-1",
        publishedRevisionId: "published-1",
        draft: { id: "draft-1", document },
        published: { id: "published-1", document },
        history: [],
      });
    }
    if (path === "/api/admin/content" && options.method === "PUT") return Response.json({ revisionId: "draft-2" });
    if (path === "/api/admin/content/publish") return Response.json({ revisionId: "draft-2" });
    if (path === "/api/admin/media/usage") return Response.json({
      usedBytes: 0,
      limitBytes: 2 * 1024 * 1024 * 1024,
      remainingBytes: 2 * 1024 * 1024 * 1024,
      percent: 0,
      mediaSets: 0,
    });
    return Response.json({}, { status: 404 });
  };
  const adapter = createCloudflareContentAdapter({ staticContent: weddingContent, fetchImpl });
  assert.equal((await adapter.getPublicContent()).revisionId, "published-1");
  assert.equal((await adapter.getAdminState()).draft.content.couple.groom, weddingContent.couple.groom);
  assert.equal((await adapter.getMediaUsage()).limitBytes, 2 * 1024 * 1024 * 1024);
  assert.equal((await adapter.saveDraft(document)).draftRevisionId, "draft-2");
  await adapter.publish("draft-2");
  assert.deepEqual(calls, [
    ["/api/content", "GET"],
    ["/api/admin/content", "GET"],
    ["/api/admin/media/usage", "GET"],
    ["/api/admin/content", "PUT"],
    ["/api/admin/content/publish", "POST"],
  ]);
});

test("production and local adapters accept only bounded MP3 uploads", async () => {
  const calls = [];
  const file = new File([new Uint8Array([0x49, 0x44, 0x33, 0x04])], "track.mp3", { type: "audio/mpeg" });
  const cloud = createCloudflareContentAdapter({
    staticContent: weddingContent,
    fetchImpl: async (path, options = {}) => {
      calls.push([path, options]);
      return Response.json({
        audio: { src: "/api/media/invitation/123e4567-e89b-12d3-a456-426614174000/background-music/track.mp3", mimeType: "audio/mpeg", sizeBytes: file.size },
        usage: { usedBytes: file.size },
      }, { status: 201 });
    },
  });
  const uploaded = await cloud.uploadAudio({ file });
  assert.equal(uploaded.audio.mimeType, "audio/mpeg");
  assert.equal(calls[0][0], "/api/admin/media/audio");
  assert.equal(calls[0][1].body instanceof FormData, true);
  assert.equal(calls[0][1].headers, undefined);

  const storage = memoryStorage();
  const blobs = new Map();
  const audioStore = {
    async put(id, blob) { blobs.set(id, blob); },
    async get(id) { return blobs.get(id) ?? null; },
  };
  const local = createLocalReviewContentAdapter({ staticContent: weddingContent, storage, eventTarget: new EventTarget(), audioStore });
  const localUpload = await local.uploadAudio({ file });
  assert.match(localUpload.audio.src, /^blob:/);
  const localDraft = createContentDocument(weddingContent);
  localDraft.content.music.src = localUpload.audio.src;
  localDraft.content.music.title = "로컬 검토 음악";
  const localSaved = await local.saveDraft(localDraft);
  const persisted = storage.values.get(LOCAL_REVIEW_STORAGE_KEY);
  assert.match(persisted, /local-review-audio:[a-f0-9-]{36}/i);
  assert.doesNotMatch(persisted, /data:audio/);
  assert.equal((await local.getPublicContent()).content.music.title, weddingContent.music.title);
  await local.publish(localSaved.draftRevisionId);
  assert.equal((await local.getPublicContent()).content.music.title, "로컬 검토 음악");

  const reloaded = createLocalReviewContentAdapter({ staticContent: weddingContent, storage, eventTarget: new EventTarget(), audioStore });
  const reloadedState = await reloaded.getAdminState();
  assert.match(reloadedState.published.content.music.src, /^blob:/);
  assert.equal((await reloaded.getPublicContent()).content.music.title, "로컬 검토 음악");
  await assert.rejects(local.uploadAudio({ file: new File(["not audio"], "track.txt", { type: "text/plain" }) }), /MP3/);
});

test("production admin requests preserve Access authentication failures for re-login UX", async () => {
  const adapter = createCloudflareContentAdapter({
    staticContent: weddingContent,
    fetchImpl: async () => Response.json({
      code: "ADMIN_AUTH_REQUIRED",
      message: "신랑·신부 계정 인증이 필요합니다.",
    }, { status: 401 }),
  });

  await assert.rejects(adapter.getAdminState(), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, "ADMIN_AUTH_REQUIRED");
    assert.equal(isAdminAuthRequiredError(error), true);
    return true;
  });
  assert.equal(ACCESS_LOGOUT_PATH, "/cdn-cgi/access/logout");
});

test("the app exposes the content admin route and runtime content provider", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /pathname === "\/admin\/content"/);
  assert.match(source, /WeddingRuntimeContext\.Provider/);
  assert.match(source, /usePublicInvitationContent\(weddingContent\)/);
});

test("the admin UI labels local review and keeps publish behind an explicit saved draft", async () => {
  const source = await readFile(new URL("../src/admin-content/ContentAdmin.jsx", import.meta.url), "utf8");
  const previewSource = await readFile(new URL("../src/admin-content/public-content.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /로컬 검토 모드/);
  assert.match(source, /임시 저장/);
  assert.match(source, /이 초안을 공개/);
  assert.match(source, /dirty \|\| !draftRevisionId/);
  assert.match(source, /setDraftRevisionId\(state\.draftRevisionId \|\| null\)/);
  assert.match(source, /setPublishedRevisionId\(published\.revisionId \|\| draftRevisionId\)/);
  assert.match(source, /미저장 변경.*저장된 초안.*공개본/s);
  assert.match(source, /CONTENT_PREVIEW_READY_MESSAGE_TYPE/);
  assert.match(previewSource, /event\.source !== window\.parent/);
  assert.match(previewSource, /source:\s*"admin-live-preview"/);
  assert.match(previewSource, /if \(previewDraft\)/);
  assert.doesNotMatch(previewSource, /getAdminState\(\)/);
  assert.match(source, /\/api\/admin\/media|uploadPhoto/);
  assert.match(source, /새 사진 대체 텍스트/);
  assert.match(source, /replacementAlt\.trim\(\)/);
  assert.doesNotMatch(source, /alt:\s*current\.alt/);
  assert.match(source, /배경 음악/);
  assert.match(source, /uploadAudio/);
  assert.match(source, /accept="audio\/mpeg,\.mp3"/);
  assert.match(source, /controls preload="metadata"/);
  assert.doesNotMatch(source, /autoPlay/);
  assert.match(source, /미디어 저장 공간\(사진·음악\)/);
  assert.match(source, /사진과 음악 합계가 2GB에 도달하면 추가 업로드가 자동으로 차단/);
  assert.match(source, /관리자 인증이 필요합니다/);
  assert.match(source, /Google 계정으로 다시 로그인/);
  assert.match(source, /authRequired \? <AdminReauthentication \/>/);
  assert.match(source, /ACCESS_LOGOUT_PATH/);
  assert.match(styles, /@media \(max-width: 1120px\)\s*\{[\s\S]*?\.content-admin-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test("public music controls and credits resolve from runtime content and reset on track replacement", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /const music = content\.music/);
  assert.match(source, /src=\{music\.src\}/);
  assert.match(source, /\[music\.src\]/);
  assert.match(source, /audio\?\.pause\(\)[\s\S]*audio\.currentTime = 0[\s\S]*audio\?\.load\(\)/);
  assert.match(source, /href=\{music\.sourceUrl\}/);
  assert.match(source, /href=\{music\.licenseUrl\}/);
  assert.match(source, /preload="none"[\s\S]*loop/);
  assert.doesNotMatch(source, /src="\/assets\/audio\/touching-moments-one-pulse\.mp3"/);
});

test("both administrator screens expose logout and block stale sessions behind re-authentication", async () => {
  const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(appSource, /guestbook-admin-nav/);
  assert.match(appSource, /status: authRequired \? "auth-required"/);
  assert.match(appSource, /Google 계정으로 다시 로그인/);
  assert.match(appSource, /href=\{ACCESS_LOGOUT_PATH\}>로그아웃/);
});

test("applied admin content keeps full runtime photo objects", () => {
  const document = createContentDocument(weddingContent);
  document.photos.pastel.hero.alt = "관리자 수정 대체 텍스트";
  const applied = applyContentDocument(document, weddingContent);
  assert.equal(applied.photoMetadata.pastel.hero.alt, "관리자 수정 대체 텍스트");
  assert.match(applied.photoMetadata.pastel.hero.srcSet, /480w/);
});
