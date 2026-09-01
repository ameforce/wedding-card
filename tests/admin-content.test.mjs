import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { weddingContent } from "../src/content.js";
import {
  applyContentDocument,
  buildPublishDiff,
  cloneContentDocument,
  CONTENT_SCHEMA_VERSION,
  createContentDocument,
  deriveEventDisplay,
  normalizeContentDocument,
  serializeContentDocument,
  validateEditableContentDocument,
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

test("strict serialization preserves invalid values and reports field paths", () => {
  const invalid = createContentDocument(weddingContent);
  invalid.content.couple.groom = "";
  assert.throws(() => serializeContentDocument(invalid), (error) => {
    assert.equal(error.code, "INVALID_CONTENT");
    assert.equal(typeof error.fieldErrors["신랑 이름"], "string");
    assert.equal(invalid.content.couple.groom, "");
    return true;
  });
});

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
  await adapter.republish(initial.publishedRevisionId);
  const republishedState = await adapter.getAdminState();
  assert.equal(republishedState.draftRevisionId, null);
  assert.equal(republishedState.draft, null);
  assert.equal(republishedState.published.content.venue.name, weddingContent.venue.name);

  const reloaded = createLocalReviewContentAdapter({
    staticContent: weddingContent,
    storage,
    eventTarget: new EventTarget(),
    now: () => "2026-08-17T12:34:56.000Z",
  });
  assert.equal((await reloaded.getAdminState()).draftRevisionId, null);
});

test("local review revision IDs remain unique within the same second", async () => {
  const storage = memoryStorage();
  const adapter = createLocalReviewContentAdapter({
    staticContent: weddingContent,
    storage,
    eventTarget: new EventTarget(),
    now: () => "2026-08-17T12:34:56.000Z",
  });
  const document = createContentDocument(weddingContent);
  const first = await adapter.saveDraft(document);
  const second = await adapter.saveDraft(document);

  assert.notEqual(first.draftRevisionId, second.draftRevisionId);
  assert.match(first.draftRevisionId, /^local-draft-20260817123456-[a-f0-9-]{32,36}$/i);
  const history = (await adapter.getAdminState()).history;
  assert.equal(new Set(history.map((revision) => revision.id)).size, 4);
  assert.equal(history.filter((revision) => revision.status === "draft").length, 1);
  assert.equal(history.find((revision) => revision.id === first.draftRevisionId).status, "archived");
});

test("local review IDs retain a non-secure-context fallback", async () => {
  const source = await readFile(new URL("../src/admin-content/content-client.js", import.meta.url), "utf8");
  assert.match(source, /typeof crypto\.randomUUID === "function"/);
  assert.match(source, /crypto\.getRandomValues\(new Uint32Array\(4\)\)/);
  assert.match(source, /localIdCounter \+= 1/);
});

test("photo alt validation and normalization share the 300 character Worker contract", () => {
  const document = createContentDocument(weddingContent);
  const acceptedAlt = "가".repeat(300);
  document.photos.pastel.hero.alt = acceptedAlt;
  assert.equal(normalizeContentDocument(document, weddingContent).photos.pastel.hero.alt, acceptedAlt);
  assert.equal(validateEditableContentDocument(document)["사진"], undefined);

  document.photos.pastel.hero.alt = "가".repeat(301);
  assert.equal(typeof validateEditableContentDocument(document)["사진"], "string");
  assert.throws(() => serializeContentDocument(document), (error) => error.code === "INVALID_CONTENT" && typeof error.fieldErrors["사진"] === "string");
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
  const publishedAdmin = await adapter.getAdminState();
  assert.equal(publishedAdmin.draftRevisionId, null);
  assert.equal(publishedAdmin.draft, null);
  assert.equal(publishedAdmin.published.content.venue.name, "초안 전용 예식장");
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

test("the app exposes the canonical content admin route and runtime content provider", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const shellSource = await readFile(new URL("../src/admin-content/AdminShell.jsx", import.meta.url), "utf8");
  assert.match(source, /\["\/admin", "\/admin\/content"\]\.includes\(window\.location\.pathname\)/);
  assert.match(source, /pathname === "\/admin\/guestbook"/);
  assert.match(source, /import \{ GuestbookAdmin \}/);
  assert.match(shellSource, /href: "\/admin", label: "콘텐츠"/);
  assert.match(source, /WeddingRuntimeContext\.Provider/);
  assert.match(source, /usePublicInvitationContent\(weddingContent\)/);
});

test("long administrator fields use the full edit row without collapsing short-field hierarchy", async () => {
  const source = await readFile(new URL("../src/admin-content/ContentAdmin.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(source, /function Field\(\{[^}]*wide = false[^}]*\}\)/);
  assert.match(source, /className=\{`content-admin-field \$\{wide \? "is-wide" : ""\}`\}/);
  assert.match(source, /className="content-admin-venue-fields"[\s\S]*?<Field label="예식장"[\s\S]*?<Field label="층"[\s\S]*?<Field label="주소"[^>]*\bwide\b/);
  assert.match(source, /<Field label="곡명"[\s\S]*?<Field label="아티스트"[\s\S]*?<Field label="출처 URL"[^>]*\bwide\b[\s\S]*?<Field label="라이선스명"[\s\S]*?<Field label="라이선스 URL"[^>]*\bwide\b/);
  assert.match(styles, /\.content-admin-venue-fields\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.content-admin-venue-fields\s*\{[^}]*min-width:\s*0;/);
  assert.match(styles, /@media \(max-width: 760px\)\s*\{[\s\S]*?\.content-admin-venue-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

test("the admin UI uses apply, automatic publish review, dirty guard, fixed preview, and responsive shared shell", async () => {
  const source = await readFile(new URL("../src/admin-content/ContentAdmin.jsx", import.meta.url), "utf8");
  const shellSource = await readFile(new URL("../src/admin-content/AdminShell.jsx", import.meta.url), "utf8");
  const previewSource = await readFile(new URL("../src/admin-content/public-content.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /로컬 검토 모드/);
  assert.match(source, /임시 적용/);
  assert.match(source, /previewSelectorForPath/);
  assert.match(source, /전체 미리보기 열기/);
  assert.match(source, /PublishReviewDialog/);
  assert.match(source, /미적용 변경사항은 자동으로 임시 적용한 뒤 게시/);
  assert.match(source, /beforeunload/);
  assert.match(source, /setDraftRevisionId\(state\.draftRevisionId \|\| null\)/);
  assert.match(source, /await adapter\.publish\(revisionId\)/);
  assert.match(source, /await load\(\)/);
  assert.match(source, /미적용 변경.*초안.*공개본/s);
  assert.match(source, /width="390"/);
  assert.match(source, /validateEditableContentDocument/);
  assert.match(source, /buildPublishDiff/);
  assert.match(source, /adapter\.republish/);
  assert.match(shellSource, /function AdminShell/);
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
  assert.match(styles, /@media \(max-width: 1024px\)\s*\{[\s\S]*?\.content-admin-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)/);
  assert.match(styles, /\.content-admin-preview iframe\s*\{[^}]*width:\s*390px !important/);
  assert.match(styles, /\.content-admin-preview-frame\s*\{[^}]*position:\s*relative/);
  assert.match(styles, /\.content-admin-preview iframe\s*\{[^}]*position:\s*absolute[^}]*left:\s*50%[^}]*transform:\s*translateX\(-50%\) scale\(var\(--content-preview-scale\)\)/);
  assert.doesNotMatch(styles, /\.content-admin-preview iframe\s*\{[^}]*transform:\s*scale\(/);
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
  const shellSource = await readFile(new URL("../src/admin-content/AdminShell.jsx", import.meta.url), "utf8");
  const guestbookSource = await readFile(new URL("../src/admin-content/GuestbookAdmin.jsx", import.meta.url), "utf8");
  const contentSource = await readFile(new URL("../src/admin-content/ContentAdmin.jsx", import.meta.url), "utf8");
  assert.match(shellSource, /href=\{ACCESS_LOGOUT_PATH\}>로그아웃/);
  assert.match(guestbookSource, /"auth-required"/);
  assert.match(guestbookSource, /Google 계정으로 다시 로그인/);
  assert.match(contentSource, /관리자 인증이 필요합니다/);
});

test("event labels are strictly derived and publish review reports changed sections", () => {
  assert.deepEqual(deriveEventDisplay("2026-12-27", "15:00"), {
    dateLabel: "2026년 12월 27일",
    day: "일요일",
    time: "오후 3시",
  });
  assert.equal(deriveEventDisplay("2026-02-31", "15:00"), null);
  const published = createContentDocument(weddingContent);
  const editing = createContentDocument(weddingContent);
  editing.content.hero.introLines[1] = "두 사람의 새로운 시작입니다";
  editing.content.event.isoDate = "2026-12-28";
  Object.assign(editing.content.event, deriveEventDisplay(editing.content.event.isoDate, editing.content.event.startTime24h));
  const diff = buildPublishDiff(editing, published);
  assert.deepEqual(diff.sections, ["상단 인사", "예식 정보"]);
  assert.equal(diff.changes.some((change) => change.label === "예식 날짜"), true);
  assert.deepEqual(validateEditableContentDocument(editing), {});
  editing.content.event.day = "일요일";
  assert.match(validateEditableContentDocument(editing)["예식 일시"], /파생/);
});

test("publish review includes every editable parking field and material media details", () => {
  const published = createContentDocument(weddingContent);
  const current = cloneContentDocument(published);
  current.content.transit.parkingRegistrationLocation = "변경된 등록 위치";
  current.content.transit.parkingRegistration = "변경된 등록 안내";
  current.content.music.licenseLabel = "변경된 라이선스";
  current.photos.pastel.gallery[0].position = "40% 60%";

  const diff = buildPublishDiff(current, published);
  assert.deepEqual(
    diff.changes.filter((change) => change.section === "교통과 주차").map((change) => change.label),
    ["주차 등록 위치", "주차 등록 안내"],
  );
  const music = diff.changes.find((change) => change.label === "배경 음악");
  assert.match(music.current, /변경된 라이선스/);
  const gallery = diff.changes.find((change) => change.label === "갤러리");
  assert.match(gallery.current, /40% 60%/);
  assert.doesNotMatch(gallery.current, /\[object Object\]/);
});

test("publish review bounds uploaded media labels instead of rendering data URLs", () => {
  const published = createContentDocument(weddingContent);
  const current = cloneContentDocument(published);
  current.photos.pastel.hero.src = `data:image/webp;base64,${"A".repeat(200_000)}`;
  current.content.music.src = `data:audio/mpeg;base64,${"B".repeat(200_000)}`;

  const diff = buildPublishDiff(current, published);
  const mediaValues = diff.changes.flatMap((change) => [change.current, change.published]).join(" ");
  assert.equal(mediaValues.length < 2_000, true);
  assert.doesNotMatch(mediaValues, /base64/);
  assert.match(mediaValues, /새 파일/);
  assert.match(mediaValues, /기존 파일/);
});

test("name validation matches the Worker's 50 character contract", () => {
  const document = createContentDocument(weddingContent);
  document.content.couple.groom = "가".repeat(50);
  document.content.couple.bride = "나".repeat(50);
  assert.equal(validateEditableContentDocument(document)["신랑 이름"], undefined);
  assert.equal(validateEditableContentDocument(document)["신부 이름"], undefined);
  document.content.couple.groom += "가";
  document.content.couple.bride += "나";
  assert.equal(typeof validateEditableContentDocument(document)["신랑 이름"], "string");
  assert.equal(typeof validateEditableContentDocument(document)["신부 이름"], "string");
});

test("authentication, refresh, dialog focus, and rollback guards protect privileged changes", async () => {
  const source = await readFile(new URL("../src/admin-content/ContentAdmin.jsx", import.meta.url), "utf8");
  const client = await readFile(new URL("../src/admin-content/content-client.js", import.meta.url), "utf8");
  const shell = await readFile(new URL("../src/admin-content/AdminShell.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /setAuthRequired\(true\);\s*setPublishReviewOpen\(false\);\s*setRepublishTarget\(null\)/);
  assert.match(source, /!authRequired && <div className="content-admin-top-actions">/);
  assert.match(source, /dirty && !window\.confirm\("미적용 변경사항을 버리고 저장된 초안을 다시 불러올까요\?"\)/);
  assert.match(source, /load\(\{ preserveEditingDocument: dirty \}\)/);
  assert.match(source, /if \(!preserveEditingDocument\) setEditingDocument\(next\)/);
  assert.match(source, /if \(!preserveEditingDocument\) setDirty\(false\)/);
  assert.match(source, /item\.status === "draft" \? \{ \.\.\.item, status: "archived" \} : item/);
  assert.match(source, /revision\.status === "archived" \? "이전 초안" : "초안"/);
  assert.match(source, /maxLength=\{50\}/);
  assert.match(source, /function useDialogFocus/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.key !== "Tab"/);
  assert.match(source, /opener\?\.focus\(\)/);
  assert.match(source, /revision\.publishedAt && !\[draftRevisionId, publishedRevisionId\]\.includes/);
  assert.match(client, /!target\.publishedAt/);
  assert.match(shell, /inert=\{sidebarHidden \? true : undefined\}/);
  assert.match(shell, /closeButtonRef\.current\?\.focus\(\)/);
  assert.match(shell, /restoreMenuFocusRef\.current = true/);
  assert.match(shell, /menuButtonRef\.current\?\.focus\(\)/);
  assert.match(styles, /\.admin-sidebar \{[^}]*visibility: hidden/);
});

test("applied admin content keeps full runtime photo objects", () => {
  const document = createContentDocument(weddingContent);
  document.photos.pastel.hero.alt = "관리자 수정 대체 텍스트";
  const applied = applyContentDocument(document, weddingContent);
  assert.equal(applied.photoMetadata.pastel.hero.alt, "관리자 수정 대체 텍스트");
  assert.match(applied.photoMetadata.pastel.hero.srcSet, /480w/);
});
