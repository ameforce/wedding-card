import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { weddingContent } from "../src/content.js";
import {
  applyContentDocument,
  createContentDocument,
  normalizeContentDocument,
} from "../src/admin-content/content-document.js";
import {
  createContentAdapter,
  createCloudflareContentAdapter,
  createLocalReviewContentAdapter,
  getEmbeddedContentPreviewConfig,
  LOCAL_REVIEW_STORAGE_KEY,
} from "../src/admin-content/content-client.js";

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
  assert.match(previewSource, /receivedLivePreview/);
  assert.doesNotMatch(previewSource, /getAdminState\(\)/);
  assert.match(source, /\/api\/admin\/media|uploadPhoto/);
  assert.match(source, /사진 저장 공간/);
  assert.match(source, /2GB에 도달하면 추가 업로드가 자동으로 차단/);
  assert.match(styles, /@media \(max-width: 1120px\)\s*\{[\s\S]*?\.content-admin-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test("applied admin content keeps full runtime photo objects", () => {
  const document = createContentDocument(weddingContent);
  document.photos.pastel.hero.alt = "관리자 수정 대체 텍스트";
  const applied = applyContentDocument(document, weddingContent);
  assert.equal(applied.photoMetadata.pastel.hero.alt, "관리자 수정 대체 텍스트");
  assert.match(applied.photoMetadata.pastel.hero.srcSet, /480w/);
});
