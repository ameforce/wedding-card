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
  createCloudflareContentAdapter,
  createLocalReviewContentAdapter,
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
    return Response.json({}, { status: 404 });
  };
  const adapter = createCloudflareContentAdapter({ staticContent: weddingContent, fetchImpl });
  assert.equal((await adapter.getPublicContent()).revisionId, "published-1");
  assert.equal((await adapter.getAdminState()).draft.content.couple.groom, weddingContent.couple.groom);
  assert.equal((await adapter.saveDraft(document)).draftRevisionId, "draft-2");
  await adapter.publish("draft-2");
  assert.deepEqual(calls, [
    ["/api/content", "GET"],
    ["/api/admin/content", "GET"],
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
  assert.match(source, /로컬 검토 모드/);
  assert.match(source, /임시 저장/);
  assert.match(source, /이 초안을 공개/);
  assert.match(source, /dirty \|\| !revisionId/);
  assert.match(source, /setRevisionId\(state\.draftRevisionId \|\| null\)/);
  assert.match(source, /CONTENT_PREVIEW_READY_MESSAGE_TYPE/);
  assert.match(source, /\/api\/admin\/media|uploadPhoto/);
});

test("applied admin content keeps full runtime photo objects", () => {
  const document = createContentDocument(weddingContent);
  document.photos.pastel.hero.alt = "관리자 수정 대체 텍스트";
  const applied = applyContentDocument(document, weddingContent);
  assert.equal(applied.photoMetadata.pastel.hero.alt, "관리자 수정 대체 텍스트");
  assert.match(applied.photoMetadata.pastel.hero.srcSet, /480w/);
});
