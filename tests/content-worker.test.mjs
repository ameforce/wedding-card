import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker, { __test } from "../worker/index.js";
import { WEDDING_PHOTOS, weddingContent } from "../src/content.js";

const workerSource = await readFile(new URL("../worker/index.js", import.meta.url), "utf8");

function request(path, init = {}) {
  return new Request(`https://example.test${path}`, {
    ...init,
    headers: {
      origin: "https://example.test",
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function base64Url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  return Buffer.from(bytes).toString("base64url");
}

async function accessFixture() {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const kid = crypto.randomUUID();
  const teamOrigin = "https://wedding-content-test.cloudflareaccess.com";
  const audience = "wedding-content-audience";
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const claims = base64Url(JSON.stringify({
    iss: teamOrigin,
    aud: audience,
    email: "groom@example.test",
    iat: now - 5,
    exp: now + 300,
  }));
  const input = `${header}.${claims}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(input));
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  return {
    assertion: `${input}.${base64Url(signature)}`,
    jwks: { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] },
    env: {
      ADMIN_AUTH_MODE: "cloudflare-access-jwt",
      ACCESS_TEAM_DOMAIN: "wedding-content-test.cloudflareaccess.com",
      ACCESS_AUD: audience,
      WEDDING_ADMIN_EMAILS: "groom@example.test,bride@example.test",
    },
  };
}

function invitationDatabase() {
  const state = {
    draft_revision_id: null,
    published_revision_id: null,
    updated_at: "1970-01-01T00:00:00.000Z",
  };
  const revisions = new Map();
  const mediaSets = new Map();
  const legacyMediaSets = new Map();
  const mediaDeletionJobs = new Map();
  const queries = [];
  let beforeMediaDeletionClaim = null;
  let beforeBatch = null;
  const referencesPendingMedia = (contentJson) => [...mediaDeletionJobs.keys()]
    .some((mediaId) => String(contentJson || "").toLowerCase().includes(`invitation/${mediaId}/`));
  return {
    state,
    revisions,
    mediaSets,
    legacyMediaSets,
    mediaDeletionJobs,
    queries,
    injectBeforeMediaDeletionClaim(callback) { beforeMediaDeletionClaim = callback; },
    injectBeforeBatch(kind, callback) { beforeBatch = { kind, callback }; },
    async batch(statements) {
      if (beforeBatch && statements.some((statement) => statement.sql?.includes(`/* ${beforeBatch.kind} */`))) {
        const inject = beforeBatch.callback;
        beforeBatch = null;
        inject();
      }
      if (beforeMediaDeletionClaim && statements.some((statement) => statement.sql?.startsWith("INSERT INTO invitation_media_deletion_jobs_v1"))) {
        const inject = beforeMediaDeletionClaim;
        beforeMediaDeletionClaim = null;
        inject();
      }
      const stateBefore = { ...state };
      const copy = (rows) => new Map([...rows].map(([key, value]) => [key, structuredClone(value)]));
      const revisionsBefore = copy(revisions);
      const mediaSetsBefore = copy(mediaSets);
      const jobsBefore = copy(mediaDeletionJobs);
      const results = [];
      try {
        for (const statement of statements) results.push(await statement.run());
        return results;
      } catch (error) {
        Object.assign(state, stateBefore);
        for (const [target, previous] of [[revisions, revisionsBefore], [mediaSets, mediaSetsBefore], [mediaDeletionJobs, jobsBefore]]) {
          target.clear();
          for (const [key, value] of previous) target.set(key, value);
        }
        throw error;
      }
    },
    prepare(sql) {
      queries.push(sql);
      let values = [];
      return {
        sql,
        bind(...nextValues) {
          values = nextValues;
          return this;
        },
        async first() {
          if (sql.includes("FROM invitation_media_deletion_jobs_v1")) {
            return values.map((id) => mediaDeletionJobs.get(id)).find(Boolean) || null;
          }
          if (sql.includes("FROM invitation_revisions") && sql.includes("instr(lower(content_json)")) {
            const needle = String(values[0] || "").toLowerCase();
            const match = [...revisions.values()].find((row) => String(row.content_json || "").toLowerCase().includes(needle));
            return match ? { id: match.id } : null;
          }
          if (sql.includes("JOIN invitation_revisions AS revision")) {
            return state.published_revision_id ? revisions.get(state.published_revision_id) || null : null;
          }
          if (sql.includes("FROM invitation_state")) return { ...state };
          if (sql.includes("FROM invitation_revisions")) return revisions.get(values[0]) || null;
          if (sql.includes("FROM invitation_media_sets")) {
            if (sql.includes("SUM(")) {
              const active = [...mediaSets.values()].filter((entry) => ["reserved", "stored"].includes(entry.status));
              return {
                used_bytes: active.reduce((total, entry) => total + entry.total_bytes, 0),
                media_sets: active.length,
              };
            }
            return mediaSets.get(values[0]) || null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM invitation_media_deletion_jobs_v1")) {
            return { results: [...mediaDeletionJobs.values()] };
          }
          if (sql.includes("FROM invitation_revisions")) {
            const results = [...revisions.values()];
            if (sql.includes("ORDER BY created_at DESC LIMIT 20")) {
              results.sort((left, right) => right.created_at.localeCompare(left.created_at));
              return { results: results.slice(0, 20) };
            }
            return { results };
          }
          if (sql.includes("FROM invitation_media_sets")) {
            let results = [...mediaSets.values()];
            if (sql.includes("WHERE status = 'stored' OR (status = 'reserved' AND created_at < ?)")) {
              results = results.filter((row) => row.status === "stored" || (row.status === "reserved" && row.created_at < values[0]));
            } else if (sql.includes("WHERE status = 'stored'")) {
              results = results.filter((row) => row.status === "stored");
            }
            results.sort((left, right) => right.created_at.localeCompare(left.created_at));
            return { results };
          }
          return { results: [] };
        },
        async run() {
          let changes = 1;
          if (sql.startsWith("SELECT CASE WHEN") && sql.includes("AS mutation_guard")) {
            let allowed = false;
            if (sql.includes("/* publish */")) {
              const [draftId, publishedId, contentJson] = values;
              const draft = revisions.get(draftId);
              allowed = state.draft_revision_id === draftId && state.published_revision_id === publishedId
                && draft?.status === "draft" && draft.content_json === contentJson
                && (!publishedId || revisions.get(publishedId)?.status === "published")
                && !referencesPendingMedia(contentJson);
            } else if (sql.includes("/* rollback */")) {
              const [targetId, publishedId, targetStatus, contentJson] = values;
              const target = revisions.get(targetId);
              allowed = state.published_revision_id === publishedId && revisions.get(publishedId)?.status === "published"
                && target?.status === targetStatus && target.content_json === contentJson
                && !referencesPendingMedia(contentJson);
            } else if (sql.includes("/* delete-claim */")) {
              const [mediaId, claimToken] = values;
              allowed = mediaDeletionJobs.get(mediaId)?.claim_token === claimToken;
            } else if (sql.includes("/* delete-final */")) {
              const [mediaId, claimToken, needle] = values;
              allowed = mediaDeletionJobs.get(mediaId)?.claim_token === claimToken
                && ![...revisions.values()].some((revision) => String(revision.content_json || "").toLowerCase().includes(String(needle).toLowerCase()));
            }
            if (!allowed) throw new Error("malformed JSON");
            changes = 0;
          } else if (sql.startsWith("INSERT INTO invitation_revisions")) {
            const [id, contentJson, createdAt, createdBy] = values;
            const pending = sql.includes("invitation_media_deletion_jobs_v1")
              && referencesPendingMedia(contentJson);
            if (pending) changes = 0;
            else revisions.set(id, {
                id,
                content_json: contentJson,
                status: "draft",
                created_at: createdAt,
                created_by: createdBy,
                published_at: null,
              });
          } else if (sql.startsWith("CREATE TABLE IF NOT EXISTS invitation_media_sets_v2")) {
            changes = 0;
          } else if (sql.startsWith("CREATE TABLE IF NOT EXISTS invitation_media_deletion_jobs_v1")) {
            changes = 0;
          } else if (sql.includes("INSERT OR IGNORE INTO invitation_media_sets_v2")) {
            changes = 0;
            for (const [id, row] of legacyMediaSets) {
              if (!mediaSets.has(id)) {
                mediaSets.set(id, row);
                changes += 1;
              }
            }
          } else if (sql.startsWith("INSERT INTO invitation_media_sets")) {
            const [id, slot, totalBytes, createdAt, , limitBytes] = values;
            if (totalBytes > 134217728) {
              throw new Error("CHECK constraint failed: invitation_media_sets_v2.total_bytes");
            }
            const usedBytes = [...mediaSets.values()]
              .filter((entry) => ["reserved", "stored"].includes(entry.status))
              .reduce((total, entry) => total + entry.total_bytes, 0);
            if (usedBytes + totalBytes <= limitBytes) {
              mediaSets.set(id, { id, slot, total_bytes: totalBytes, status: "reserved", created_at: createdAt, stored_at: null });
            } else {
              changes = 0;
            }
          } else if (sql.startsWith("INSERT INTO invitation_media_deletion_jobs_v1")) {
            const [mediaId, slot, claimToken, requestedAt, setId, cutoff, existingJobId, needle] = values;
            const set = mediaSets.get(setId);
            const published = revisions.get(state.published_revision_id);
            const publishedRef = published?.content_json?.toLowerCase().includes(String(needle).toLowerCase());
            const capturedReferences = [...revisions.keys()].filter((id) => values.includes(id));
            const unexpectedReference = [...revisions.values()].some((revision) =>
              String(revision.content_json || "").toLowerCase().includes(String(needle).toLowerCase())
                && !capturedReferences.includes(revision.id));
            const deletable = set && (set.status === "stored" || (set.status === "reserved" && set.created_at < cutoff));
            if (!deletable || mediaDeletionJobs.has(existingJobId) || publishedRef || unexpectedReference) {
              changes = 0;
            } else {
              mediaDeletionJobs.set(mediaId, { media_id: mediaId, slot, claim_token: claimToken, requested_at: requestedAt });
            }
          } else if (sql.includes("SET status = 'stored'")) {
            const [storedAt, id] = values;
            const row = mediaSets.get(id);
            if (row?.status === "reserved") {
              row.status = "stored";
              row.stored_at = storedAt;
            } else {
              changes = 0;
            }
          } else if (sql.includes("SET content_json = ?")) {
            const hasCreatedAt = sql.includes("created_at = ?");
            const hasContentGuard = sql.includes("AND content_json = ?");
            const [contentJson, idOrCreatedAt, third] = values;
            const id = hasCreatedAt ? third : idOrCreatedAt;
            const row = revisions.get(id);
            const isCurrentDraft = !sql.includes("invitation_state") || state.draft_revision_id === id;
            const contentMatches = !hasContentGuard || row?.content_json === third;
            const guardedContent = sql.includes("AND NOT EXISTS (SELECT 1 FROM invitation_media_deletion_jobs_v1")
              ? values.at(-1)
              : null;
            const referencesPending = guardedContent && referencesPendingMedia(guardedContent);
            const requiresJob = sql.includes("AND EXISTS (SELECT 1 FROM invitation_media_deletion_jobs_v1")
              && !mediaDeletionJobs.has(values.at(-1));
            if (row && row.status === "draft" && isCurrentDraft && contentMatches && !referencesPending && !requiresJob) {
              row.content_json = contentJson;
              if (hasCreatedAt) row.created_at = idOrCreatedAt;
            } else {
              changes = 0;
            }
          } else if (sql.includes("DELETE FROM invitation_revisions")) {
            const [id] = values;
            const isCurrentPointer = sql.includes("invitation_state")
              && (state.draft_revision_id === id || state.published_revision_id === id);
            const requiresJob = sql.includes("invitation_media_deletion_jobs_v1")
              && !mediaDeletionJobs.has(values.at(-1));
            changes = !isCurrentPointer && !requiresJob && revisions.delete(id) ? 1 : 0;
          } else if (sql.includes("DELETE FROM invitation_media_sets")) {
            if (sql.includes("id IN (SELECT id FROM invitation_media_sets_v2)")) {
              changes = 0;
              for (const id of [...legacyMediaSets.keys()]) {
                if (mediaSets.has(id)) {
                  legacyMediaSets.delete(id);
                  changes += 1;
                }
              }
            } else if (sql.includes("EXISTS (SELECT 1 FROM invitation_media_deletion_jobs_v1")) {
              const [id, jobId, needle] = values;
              const referenced = [...revisions.values()]
                .some((revision) => typeof revision.content_json === "string" && revision.content_json.toLowerCase().includes(String(needle).toLowerCase()));
              changes = mediaSets.has(id) && mediaDeletionJobs.has(jobId) && !referenced && mediaSets.delete(id) ? 1 : 0;
            } else if (sql.includes("LIKE '%' || ? || '%'")) {
              const row = mediaSets.get(values[0]);
              const [id, cutoffIso, needle] = values;
              const deletable = row && (row.status === "stored" || (row.status === "reserved" && row.created_at < cutoffIso));
              const referenced = [...revisions.values()]
                .some((revision) => typeof revision.content_json === "string" && revision.content_json.toLowerCase().includes(needle));
              changes = deletable && !referenced && mediaSets.delete(id) ? 1 : 0;
            } else if (sql.includes("status = 'reserved'")) {
              const row = mediaSets.get(values[0]);
              changes = row?.status === "reserved" && mediaSets.delete(values[0]) ? 1 : 0;
            } else {
              changes = mediaSets.delete(values[0]) ? 1 : 0;
            }
          } else if (sql.startsWith("DELETE FROM invitation_media_deletion_jobs_v1")) {
            const [mediaId, setId, needle] = values;
            const referenced = [...revisions.values()]
              .some((revision) => typeof revision.content_json === "string" && revision.content_json.toLowerCase().includes(String(needle).toLowerCase()));
            changes = mediaDeletionJobs.has(mediaId) && !mediaSets.has(setId) && !referenced && mediaDeletionJobs.delete(mediaId) ? 1 : 0;
          } else if (sql.includes("SET draft_revision_id = ?, updated_at = ?")) {
            const [revisionId, updatedAt] = values;
            const canSet = !sql.includes("EXISTS (SELECT 1 FROM invitation_revisions WHERE id = ?")
              || revisions.get(values[2])?.status === "draft";
            if (canSet) [state.draft_revision_id, state.updated_at] = [revisionId, updatedAt];
            else changes = 0;
          } else if (sql.includes("SET draft_revision_id = NULL, published_revision_id = ?")) {
            const [revisionId, updatedAt, expectedDraftId, expectedPublishedId, candidateId, contentJson] = values;
            const candidate = revisions.get(candidateId);
            if (state.draft_revision_id === expectedDraftId && state.published_revision_id === expectedPublishedId
              && candidate?.status === "published" && !referencesPendingMedia(contentJson)) {
              [state.published_revision_id, state.updated_at] = [revisionId, updatedAt];
              state.draft_revision_id = null;
            } else {
              changes = 0;
            }
          } else if (sql.includes("SET updated_at = ?") && !sql.includes("revision_id")) {
            [state.updated_at] = values;
          } else if (sql.includes("SET published_revision_id = ?, updated_at = ?")) {
            const [nextRevisionId, updatedAt, expectedRevisionId, candidateId, contentJson] = values;
            const candidate = revisions.get(candidateId);
            if ((expectedRevisionId === undefined || state.published_revision_id === expectedRevisionId)
              && (!candidateId || candidate?.status === "published") && !referencesPendingMedia(contentJson)) {
              [state.published_revision_id, state.updated_at] = [nextRevisionId, updatedAt];
            } else {
              changes = 0;
            }
          } else if (sql.includes("SET status = 'archived'")) {
            const [id, expectedRevisionId] = values;
            const hasDraftGuard = sql.includes("draft_revision_id = ?");
            const expectedDraftId = hasDraftGuard ? values[2] : undefined;
            const contentJson = values.at(-1);
            const row = revisions.get(id);
            if (row && (expectedRevisionId === undefined || state.published_revision_id === expectedRevisionId)
              && (expectedDraftId === undefined || state.draft_revision_id === expectedDraftId)
              && !referencesPendingMedia(contentJson)) row.status = "archived";
            else changes = 0;
          } else if (sql.includes("SET status = 'published'")) {
            const [publishedAt, id] = values;
            const hasContentGuard = sql.includes("AND content_json = ?");
            const expectedContent = hasContentGuard ? values[2] : null;
            const expectedRevisionId = hasContentGuard ? values[3] : values[2];
            const contentJson = values.at(-1);
            const row = revisions.get(id);
            const pointerMatches = sql.includes("draft_revision_id = ?")
              ? state.draft_revision_id === expectedRevisionId
              : expectedRevisionId === undefined || state.published_revision_id === expectedRevisionId;
            if (row && pointerMatches && (!hasContentGuard || row.content_json === expectedContent)
              && !referencesPendingMedia(contentJson)) {
              row.status = "published";
              row.published_at = publishedAt;
            } else {
              changes = 0;
            }
          }
          return { success: true, meta: { changes } };
        },
      };
    },
  };
}

function confirmedDocument() {
  const document = structuredClone({ schemaVersion: 2, content: weddingContent, photos: WEDDING_PHOTOS });
  document.content.isDesignPlaceholder = false;
  document.content.unconfirmedContent = [];
  return document;
}

function galleryPhoto(index) {
  const mediaId = `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`;
  const slot = `pastel-gallery-${index}`;
  return {
    src: `/api/media/invitation/${mediaId}/${slot}/480.webp`,
    srcSet: `/api/media/invitation/${mediaId}/${slot}/480.webp 480w, /api/media/invitation/${mediaId}/${slot}/960.webp 960w`,
    sizes: "(min-width: 768px) 430px, 100vw",
    alt: `승인 사진 ${index + 1}`,
    position: "50% 50%",
  };
}

test("Worker accepts exactly four copy lines and dynamic galleries of any size from one photo up", () => {
  for (const photoCount of [1, 4, 12, 30]) {
    const document = confirmedDocument();
    document.photos.pastel.gallery = Array.from({ length: photoCount }, (_, index) => galleryPhoto(index));
    assert.doesNotThrow(() => __test.validateInvitationDocument(document, { write: true }));
  }
});

test("Worker rejects legacy copy counts, invalid gallery counts, duplicates, and invalid crops", () => {
  for (const lineCount of [3, 5]) {
    const document = confirmedDocument();
    document.content.story = Array.from({ length: lineCount }, (_, index) => `이야기 ${index + 1}`);
    assert.throws(() => __test.validateInvitationDocument(document, { write: true }), (error) => error.code === "INVALID_CONTENT");
  }
  for (const photoCount of [0]) {
    const document = confirmedDocument();
    document.photos.pastel.gallery = Array.from({ length: photoCount }, (_, index) => galleryPhoto(index));
    assert.throws(() => __test.validateInvitationDocument(document, { write: true }), (error) => error.code === "INVALID_CONTENT");
  }
  const duplicate = confirmedDocument();
  duplicate.photos.pastel.gallery[1].src = duplicate.photos.pastel.gallery[0].src;
  assert.throws(() => __test.validateInvitationDocument(duplicate, { write: true }), (error) => error.code === "INVALID_CONTENT");

  const mismatchedVariants = confirmedDocument();
  mismatchedVariants.photos.pastel.gallery[0].srcSet = mismatchedVariants.photos.pastel.gallery[1].srcSet;
  assert.throws(() => __test.validateInvitationDocument(mismatchedVariants, { write: true }), (error) => error.code === "INVALID_CONTENT");

  const duplicateVariant = confirmedDocument();
  duplicateVariant.photos.pastel.gallery[1] = {
    ...duplicateVariant.photos.pastel.gallery[0],
    src: duplicateVariant.photos.pastel.gallery[0].src.replace("/480.webp", "/960.webp"),
  };
  assert.throws(() => __test.validateInvitationDocument(duplicateVariant, { write: true }), (error) => error.code === "INVALID_CONTENT");

  const missingWidthSuffix = confirmedDocument();
  missingWidthSuffix.photos.pastel.gallery[0] = {
    ...missingWidthSuffix.photos.pastel.gallery[0],
    src: "/assets/photos/sample.webp",
    srcSet: "/assets/photos/sample.webp 480w, /assets/photos/sample.webp 960w",
  };
  assert.throws(() => __test.validateInvitationDocument(missingWidthSuffix, { write: true }), (error) => error.code === "INVALID_CONTENT");

  const missingSrcSet = confirmedDocument();
  delete missingSrcSet.photos.pastel.gallery[0].srcSet;
  assert.throws(() => __test.validateInvitationDocument(missingSrcSet, { write: true }), (error) => error.code === "INVALID_CONTENT");

  const largeDefault = confirmedDocument();
  largeDefault.photos.pastel.gallery[0].src = largeDefault.photos.pastel.gallery[0].src.replace("-480.webp", "-960.webp");
  assert.throws(() => __test.validateInvitationDocument(largeDefault, { write: true }), (error) => error.code === "INVALID_CONTENT");

  const invalidCrop = confirmedDocument();
  invalidCrop.photos.pastel.gallery[0].position = "50% 101%";
  assert.throws(() => __test.validateInvitationDocument(invalidCrop, { write: true }), (error) => error.code === "INVALID_CONTENT");
});

async function storedBytes(value) {
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(value);
}

async function mediaUploadBody({ slot, alt = "", position = "50% 50%", original, small, large }) {
  const header = new TextEncoder().encode(JSON.stringify({
    slot,
    alt,
    position,
    originalType: original.type,
    sizes: { original: original.size, small: small.size, large: large.size },
  }));
  const [originalBytes, smallBytes, largeBytes] = await Promise.all([
    original.arrayBuffer(), small.arrayBuffer(), large.arrayBuffer(),
  ]);
  const body = new Uint8Array(2 + header.byteLength + smallBytes.byteLength + largeBytes.byteLength + originalBytes.byteLength);
  body[0] = header.byteLength >> 8;
  body[1] = header.byteLength & 0xff;
  body.set(header, 2);
  let offset = 2 + header.byteLength;
  body.set(new Uint8Array(smallBytes), offset);
  offset += smallBytes.byteLength;
  body.set(new Uint8Array(largeBytes), offset);
  offset += largeBytes.byteLength;
  body.set(new Uint8Array(originalBytes), offset);
  return body;
}

const MEDIA_UPLOAD_HEADERS = { "content-type": "application/octet-stream" };
const AUDIO_UPLOAD_HEADERS = { "content-type": "audio/mpeg" };

function memoryMediaBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, options) {
      objects.set(key, { value: await storedBytes(value), httpMetadata: options.httpMetadata, etag: `etag-${objects.size}` });
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { size: object.value.byteLength, httpMetadata: object.httpMetadata, etag: object.etag } : null;
    },
    async get(key, options = {}) {
      const object = objects.get(key);
      if (!object) return null;
      const offset = options.range?.offset ?? 0;
      const length = options.range?.length ?? object.value.byteLength;
      return {
        body: object.value.slice(offset, offset + length),
        size: object.value.byteLength,
        httpMetadata: object.httpMetadata,
        etag: object.etag,
      };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
}

test("public content fails closed until an invitation revision is published", async () => {
  const response = await worker.fetch(request("/api/content", { method: "GET" }), {
    GUESTBOOK_DB: invitationDatabase(),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "CONTENT_NOT_PUBLISHED");
});

test("public HTML atomically injects one published revision and preloads its hero", async () => {
  const db = invitationDatabase();
  const document = confirmedDocument();
  const mediaId = "8a4af8cf-cb4c-48bc-b5ed-9ca0ab42695a";
  document.photos.pastel.hero = {
    ...document.photos.pastel.hero,
    src: `/api/media/invitation/${mediaId}/pastel-hero/480.webp`,
    srcSet: `/api/media/invitation/${mediaId}/pastel-hero/480.webp 480w, /api/media/invitation/${mediaId}/pastel-hero/960.webp 960w`,
    alt: "새로 공개한 대표 사진",
  };
  document.content.music.autoPlayOnOpen = true;
  db.state.published_revision_id = "published-42";
  db.revisions.set("published-42", {
    id: "published-42",
    content_json: JSON.stringify(document),
    status: "published",
    created_at: "2026-08-30T00:00:00.000Z",
    created_by: "admin@example.test",
    published_at: "2026-08-30T00:00:00.000Z",
  });
  const response = await worker.fetch(request("/?capture=1", {
    method: "GET",
    headers: { accept: "text/html" },
  }), {
    GUESTBOOK_DB: db,
    ASSETS: { fetch: async () => new Response("<head><!-- WEDDING_PUBLIC_BOOTSTRAP --></head><body>app</body>") },
    CF_VERSION_METADATA: { id: "worker-version-42", tag: "a".repeat(40), timestamp: "2026-08-31T00:00:00.000Z" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-wedding-content-source"), "cloudflare-published");
  assert.equal(response.headers.get("x-wedding-revision"), "published-42");
  assert.equal(response.headers.get("x-wedding-worker-version"), "worker-version-42");
  assert.equal(response.headers.get("x-wedding-worker-tag"), "a".repeat(40));
  const html = await response.text();
  const encoded = html.match(/<template id="wedding-public-bootstrap"[^>]*>([^<]+)<\/template>/)?.[1];
  assert.ok(encoded);
  const bootstrap = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.equal(bootstrap.schemaVersion, 1);
  assert.equal(bootstrap.source, "cloudflare-published");
  assert.equal(bootstrap.revisionId, "published-42");
  assert.equal(bootstrap.document.photos.pastel.hero.alt, "새로 공개한 대표 사진");
  assert.equal(bootstrap.document.content.music.autoPlayOnOpen, true);
  assert.match(html, new RegExp(`href="/api/media/invitation/${mediaId}/pastel-hero/480\\.webp"`));
  assert.match(html, /rel="preload"/);
  assert.equal(db.queries.filter((sql) => sql.includes("JOIN invitation_revisions AS revision")).length, 1);
  assert.equal(db.queries.filter((sql) => sql.includes("SELECT draft_revision_id, published_revision_id")).length, 0);
});

test("public HTML ignores stale asset validators and removes them from the transformed response", async () => {
  const seenRequests = [];
  const response = await worker.fetch(request("/", {
    method: "GET",
    headers: {
      accept: "text/html",
      "if-none-match": "\"stale-bundled-html\"",
      "if-modified-since": "Sat, 29 Aug 2026 00:00:00 GMT",
    },
  }), {
    ASSETS: {
      fetch: async (assetRequest) => {
        seenRequests.push(assetRequest);
        if (assetRequest.headers.has("if-none-match") || assetRequest.headers.has("if-modified-since")) {
          return new Response(null, { status: 304 });
        }
        return new Response("<head><!-- WEDDING_PUBLIC_BOOTSTRAP --></head><body>app</body>", {
          headers: {
            etag: "\"bundled-html\"",
            "last-modified": "Sat, 29 Aug 2026 00:00:00 GMT",
          },
        });
      },
    },
  });

  assert.equal(response.status, 200);
  assert.equal(seenRequests.length, 1);
  assert.equal(seenRequests[0].headers.get("if-none-match"), null);
  assert.equal(seenRequests[0].headers.get("if-modified-since"), null);
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("last-modified"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(await response.text(), /id="wedding-public-bootstrap"/);
});

test("public HTML selects a permanent bundled fallback when D1 is unavailable", async () => {
  const response = await worker.fetch(request("/", {
    method: "GET",
    headers: { accept: "text/html" },
  }), {
    ASSETS: { fetch: async () => new Response("<head><!-- WEDDING_PUBLIC_BOOTSTRAP --></head><body>app</body>") },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-wedding-content-source"), "bundled-fallback");
  assert.equal(response.headers.get("x-wedding-revision"), null);
  const html = await response.text();
  const encoded = html.match(/<template id="wedding-public-bootstrap"[^>]*>([^<]+)<\/template>/)?.[1];
  const bootstrap = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.deepEqual(bootstrap, {
    schemaVersion: 1,
    source: "bundled-fallback",
    revisionId: null,
    publishedAt: null,
    document: null,
  });
});

test("Access-authenticated admins can save a draft and publish an immutable revision", async () => {
  const db = invitationDatabase();
  const fixture = await accessFixture();
  const env = { GUESTBOOK_DB: db, ...fixture.env };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const headers = { "cf-access-jwt-assertion": fixture.assertion };
    const draftResponse = await worker.fetch(request("/api/admin/content", {
      method: "PUT",
      headers,
      body: JSON.stringify({ document: confirmedDocument() }),
    }), env);
    assert.equal(draftResponse.status, 201);
    const { revisionId } = await draftResponse.json();
    assert.equal(db.state.draft_revision_id, revisionId);
    assert.equal(db.revisions.get(revisionId).status, "draft");

    const publishResponse = await worker.fetch(request("/api/admin/content/publish", {
      method: "POST",
      headers,
      body: JSON.stringify({ revisionId }),
    }), env);
    assert.equal(publishResponse.status, 200);
    assert.equal(db.state.published_revision_id, revisionId);
    assert.equal(db.revisions.get(revisionId).status, "published");

    const publicResponse = await worker.fetch(request("/api/content", { method: "GET" }), env);
    assert.equal(publicResponse.status, 200);
    const publicPayload = await publicResponse.json();
    assert.equal(publicPayload.revisionId, revisionId);
    assert.equal(publicPayload.document.content.publishing.searchIndexing, false);
    assert.equal(publicResponse.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, nosnippet, noimageindex");

    const secondDocument = confirmedDocument();
    secondDocument.content.message = ["두 번째", "공개본을", "네 줄로", "저장합니다"];
    const secondDraft = await worker.fetch(request("/api/admin/content", {
      method: "PUT",
      headers,
      body: JSON.stringify({ document: secondDocument }),
    }), env);
    const secondRevisionId = (await secondDraft.json()).revisionId;
    await worker.fetch(request("/api/admin/content/publish", {
      method: "POST",
      headers,
      body: JSON.stringify({ revisionId: secondRevisionId }),
    }), env);
    assert.equal(db.revisions.get(revisionId).status, "archived");
    const rollbackResponse = await worker.fetch(request("/api/admin/content/rollback", {
      method: "POST",
      headers,
      body: JSON.stringify({ revisionId, expectedPublishedRevisionId: secondRevisionId }),
    }), env);
    assert.equal(rollbackResponse.status, 200);
    assert.equal(db.state.published_revision_id, revisionId);
    assert.equal(db.revisions.get(revisionId).status, "published");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rollback rejects archived drafts that were never public", async () => {
  assert.match(workerSource, /!target\.publishedAt/);
  assert.match(workerSource, /rollbackResults = await db\.batch\(statements\)/);
  assert.match(workerSource, /mutationGuard\(db, "rollback"/);
  assert.match(workerSource, /published_revision_id = \?\)/);
  assert.match(workerSource, /applied\.slice\(1\)\.every\(\(changes\) => changes === 1\)/);
});

test("rollback rejects a stale public pointer before replacing another administrator's publication", async () => {
  const db = invitationDatabase();
  const fixture = await accessFixture();
  const env = { GUESTBOOK_DB: db, ...fixture.env };
  const document = JSON.stringify(confirmedDocument());
  for (const [id, status] of [["current-public", "published"], ["older-public", "archived"]]) {
    db.revisions.set(id, {
      id,
      content_json: document,
      status,
      created_at: `2026-08-${id === "current-public" ? "20" : "10"}T00:00:00.000Z`,
      created_by: "groom@example.test",
      published_at: `2026-08-${id === "current-public" ? "20" : "10"}T00:00:00.000Z`,
    });
  }
  db.state.published_revision_id = "current-public";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const response = await worker.fetch(request("/api/admin/content/rollback", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": fixture.assertion },
      body: JSON.stringify({ revisionId: "older-public", expectedPublishedRevisionId: "stale-public" }),
    }), env);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "STALE_PUBLISHED_REVISION");
    assert.equal(db.state.published_revision_id, "current-public");
    assert.equal(db.revisions.get("current-public").status, "published");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin history always includes active pointers beyond the recent revision limit", async () => {
  const db = invitationDatabase();
  const fixture = await accessFixture();
  const document = JSON.stringify(confirmedDocument());
  const publishedId = "published-outside-limit";
  db.revisions.set(publishedId, {
    id: publishedId,
    content_json: document,
    status: "published",
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "groom@example.test",
    published_at: "2026-01-01T00:00:00.000Z",
  });
  db.state.published_revision_id = publishedId;
  for (let index = 1; index <= 21; index += 1) {
    const id = `newer-draft-${String(index).padStart(2, "0")}`;
    db.revisions.set(id, {
      id,
      content_json: document,
      status: index === 21 ? "draft" : "archived",
      created_at: `2026-02-${String(index).padStart(2, "0")}T00:00:00.000Z`,
      created_by: "groom@example.test",
      published_at: null,
    });
    if (index === 21) db.state.draft_revision_id = id;
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const response = await worker.fetch(request("/api/admin/content", {
      method: "GET",
      headers: { "cf-access-jwt-assertion": fixture.assertion },
    }), { GUESTBOOK_DB: db, ...fixture.env });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.history.length, 21);
    assert.equal(payload.history.some((revision) => revision.id === publishedId), true);
    assert.equal(payload.history.some((revision) => revision.id === db.state.draft_revision_id), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("content validation dual-reads schema v1, requires v2 writes, and validates music credits", () => {
  const legacy = confirmedDocument();
  legacy.schemaVersion = 1;
  assert.doesNotThrow(() => __test.validateInvitationDocument(legacy));
  assert.throws(() => __test.validateInvitationDocument(legacy, { write: true }), (error) => {
    assert.equal(error.code, "UNSUPPORTED_CONTENT_SCHEMA");
    return true;
  });

  const current = confirmedDocument();
  current.content.music.sourceUrl = "http://music.example.test/track";
  assert.throws(() => __test.validateInvitationDocument(current), (error) => {
    assert.equal(error.code, "INVALID_CONTENT");
    assert.match(error.message, /HTTPS/);
    return true;
  });
});

test("v2 music source validation accepts uploaded M4A and WAV but rejects external music URLs", () => {
  const document = confirmedDocument();
  for (const extension of ["m4a", "wav"]) {
    document.content.music.src = `/api/media/invitation/123e4567-e89b-12d3-a456-426614174000/background-music/track.${extension}`;
    assert.doesNotThrow(() => __test.validateInvitationDocument(document, { write: true }));
  }
  document.content.music.src = "https://music.example.test/track.wav";
  assert.throws(() => __test.validateInvitationDocument(document, { write: true }), (error) => error.code === "INVALID_CONTENT");
});

test("published opening music preference accepts booleans, preserves old v2 reads, and rejects malformed values", () => {
  const previous = confirmedDocument();
  delete previous.content.music.autoPlayOnOpen;
  assert.doesNotThrow(() => __test.validateInvitationDocument(previous, { write: true }));

  for (const enabled of [false, true]) {
    const document = confirmedDocument();
    document.content.music.autoPlayOnOpen = enabled;
    assert.doesNotThrow(() => __test.validateInvitationDocument(document, { write: true }));
  }

  for (const invalid of ["true", 1, null]) {
    const document = confirmedDocument();
    document.content.music.autoPlayOnOpen = invalid;
    assert.throws(() => __test.validateInvitationDocument(document, { write: true }), (error) => {
      assert.equal(error.code, "INVALID_CONTENT");
      assert.match(error.message, /content\.music\.autoPlayOnOpen/);
      return true;
    });
  }
});

test("schema v2 writes validate editable account fields while v1 reads stay compatible", () => {
  const document = confirmedDocument();
  document.content.accounts.groom.bank = "테스트은행";
  document.content.accounts.groom.number = "000-111-2222";
  document.content.accounts.groom.holder = "테스트 예금주";
  assert.doesNotThrow(() => __test.validateInvitationDocument(document, { write: true }));

  const invalidNumber = confirmedDocument();
  invalidNumber.content.accounts.bride.number = "abc-123";
  assert.throws(() => __test.validateInvitationDocument(invalidNumber, { write: true }), (error) => {
    assert.equal(error.code, "INVALID_CONTENT");
    assert.match(error.message, /content\.accounts\.bride\.number/);
    return true;
  });

  const missing = confirmedDocument();
  delete missing.content.accounts.groom;
  assert.throws(() => __test.validateInvitationDocument(missing, { write: true }), (error) => {
    assert.equal(error.code, "INVALID_CONTENT");
    assert.match(error.message, /content\.accounts\.groom/);
    return true;
  });

  const legacy = confirmedDocument();
  legacy.schemaVersion = 1;
  delete legacy.content.accounts;
  assert.doesNotThrow(() => __test.validateInvitationDocument(legacy));
});

test("schema v2 writes accept extra accounts and reject malformed ones", () => {
  const document = confirmedDocument();
  document.content.accounts["extra-1"] = { key: "extra-1", side: "groom", bank: "추가은행", number: "1-2", holder: "추가 예금주" };
  document.content.accounts["extra-2"] = { key: "extra-2", side: "bride", bank: "추가은행2", number: "3-4", holder: "추가 예금주2" };
  assert.doesNotThrow(() => __test.validateInvitationDocument(document, { write: true }));

  const badKey = confirmedDocument();
  badKey.content.accounts["bad_key"] = { key: "bad_key", side: "groom", bank: "은행", number: "1", holder: "예금주" };
  assert.throws(() => __test.validateInvitationDocument(badKey, { write: true }), (error) => error.code === "INVALID_CONTENT");

  const noSide = confirmedDocument();
  noSide.content.accounts["extra-1"] = { key: "extra-1", bank: "은행", number: "1", holder: "예금주" };
  assert.throws(() => __test.validateInvitationDocument(noSide, { write: true }), (error) => {
    assert.equal(error.code, "INVALID_CONTENT");
    assert.match(error.message, /content\.accounts\.extra-1\.side/);
    return true;
  });

  const badSide = confirmedDocument();
  badSide.content.accounts["extra-1"] = { key: "extra-1", side: "elsewhere", bank: "은행", number: "1", holder: "예금주" };
  assert.throws(() => __test.validateInvitationDocument(badSide, { write: true }), (error) => error.code === "INVALID_CONTENT");

  const flippedCanonical = confirmedDocument();
  flippedCanonical.content.accounts.groom.side = "bride";
  assert.throws(() => __test.validateInvitationDocument(flippedCanonical, { write: true }), (error) => error.code === "INVALID_CONTENT");

  const noBank = confirmedDocument();
  noBank.content.accounts["extra-1"] = { key: "extra-1", side: "groom", bank: "", number: "1", holder: "예금주" };
  assert.throws(() => __test.validateInvitationDocument(noBank, { write: true }), (error) => {
    assert.equal(error.code, "INVALID_CONTENT");
    assert.match(error.message, /content\.accounts\.extra-1\.bank/);
    return true;
  });

  const mismatchedKey = confirmedDocument();
  mismatchedKey.content.accounts["extra-1"] = { key: "other", side: "groom", bank: "은행", number: "1", holder: "예금주" };
  assert.throws(() => __test.validateInvitationDocument(mismatchedKey, { write: true }), (error) => error.code === "INVALID_CONTENT");

  const overflow = confirmedDocument();
  for (let index = 1; index <= 7; index += 1) {
    overflow.content.accounts[`extra-${index}`] = { key: `extra-${index}`, side: "groom", bank: "은행", number: "1", holder: "예금주" };
  }
  assert.throws(() => __test.validateInvitationDocument(overflow, { write: true }), (error) => error.code === "INVALID_CONTENT");
});

test("content publishing rejects unconfirmed or search-indexable documents", async () => {
  const db = invitationDatabase();
  const fixture = await accessFixture();
  const env = { GUESTBOOK_DB: db, ...fixture.env };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const headers = { "cf-access-jwt-assertion": fixture.assertion };
    const unsafe = confirmedDocument();
    unsafe.content.publishing.searchIndexing = true;
    const unsafeResponse = await worker.fetch(request("/api/admin/content", {
      method: "PUT",
      headers,
      body: JSON.stringify({ document: unsafe }),
    }), env);
    assert.equal(unsafeResponse.status, 400);
    assert.equal((await unsafeResponse.json()).code, "SEARCH_PRIVACY_REQUIRED");

    const invalid = confirmedDocument();
    invalid.content.couple.groom = "";
    const invalidResponse = await worker.fetch(request("/api/admin/content", {
      method: "PUT",
      headers,
      body: JSON.stringify({ document: invalid }),
    }), env);
    assert.equal(invalidResponse.status, 400);
    const invalidPayload = await invalidResponse.json();
    assert.equal(invalidPayload.code, "INVALID_CONTENT");
    assert.equal(typeof invalidPayload.fieldErrors["content.couple.groom"], "string");

    const unconfirmed = confirmedDocument();
    unconfirmed.content.unconfirmedContent = [{ key: "publishing.og", label: "OG" }];
    unconfirmed.content.isDesignPlaceholder = true;
    const draftResponse = await worker.fetch(request("/api/admin/content", {
      method: "PUT",
      headers,
      body: JSON.stringify({ document: unconfirmed }),
    }), env);
    const { revisionId } = await draftResponse.json();
    const publishResponse = await worker.fetch(request("/api/admin/content/publish", {
      method: "POST",
      headers,
      body: JSON.stringify({ revisionId }),
    }), env);
    assert.equal(publishResponse.status, 409);
    assert.equal((await publishResponse.json()).code, "UNCONFIRMED_CONTENT");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin content routes fail closed without the Cloudflare Access JWT contract", async () => {
  const response = await worker.fetch(request("/api/admin/content", { method: "GET" }), {
    GUESTBOOK_DB: invitationDatabase(),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "ADMIN_AUTH_UNAVAILABLE");
});

test("Access-authenticated media uploads keep private immutable R2 keys and expose only optimized variants", async () => {
  const fixture = await accessFixture();
  const objects = new Map();
  const bucket = {
    async put(key, value, options) {
      objects.set(key, { value: await storedBytes(value), httpMetadata: options.httpMetadata, etag: `etag-${objects.size}` });
    },
    async get(key) {
      const object = objects.get(key);
      return object ? { body: object.value, httpMetadata: object.httpMetadata, etag: object.etag } : null;
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  const uploadRequest = new Request("https://example.test/api/admin/media", {
    method: "POST",
    headers: {
      origin: "https://example.test",
      "cf-access-jwt-assertion": fixture.assertion,
      ...MEDIA_UPLOAD_HEADERS,
    },
    body: await mediaUploadBody({
      slot: "pastel-hero",
      alt: "신랑과 신부의 상단 사진",
      position: "50% 58%",
      original: new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }),
      small: new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }),
      large: new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }),
    }),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const db = invitationDatabase();
    const response = await worker.fetch(uploadRequest, { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.match(payload.photo.src, /^\/api\/media\/invitation\/[a-f0-9-]{36}\/pastel-hero\/480\.webp$/);
    assert.equal(payload.photo.alt, "신랑과 신부의 상단 사진");
    assert.equal(objects.size, 3);
    assert.equal(payload.usage.usedBytes, 8);
    assert.equal(payload.usage.limitBytes, 2 * 1024 * 1024 * 1024);
    const originalKey = [...objects.keys()].find((key) => key.includes("/original.jpg"));
    assert.equal(typeof originalKey, "string");
    assert.deepEqual(objects.get(originalKey).value, new Uint8Array([1, 2, 3]));

    const mediaResponse = await worker.fetch(request(payload.photo.src, { method: "GET" }), { WEDDING_MEDIA: bucket });
    assert.equal(mediaResponse.status, 200);
    assert.equal(mediaResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(mediaResponse.headers.get("content-type"), "image/webp");
    assert.deepEqual(new Uint8Array(await mediaResponse.arrayBuffer()), new Uint8Array([4, 5]));

    const usageResponse = await worker.fetch(request("/api/admin/media/usage", {
      headers: { "cf-access-jwt-assertion": fixture.assertion },
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(usageResponse.status, 200);
    assert.equal((await usageResponse.json()).mediaSets, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("media uploads accept an empty description but document writes still require it", async () => {
  const fixture = await accessFixture();
  const db = invitationDatabase();
  const objects = new Map();
  const bucket = {
    async put(key, value, options) {
      objects.set(key, { value: await storedBytes(value), httpMetadata: options.httpMetadata });
    },
    async get() { return null; },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const uploadResponse = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...MEDIA_UPLOAD_HEADERS },
      body: await mediaUploadBody({
        slot: "pastel-gallery-new",
        alt: "",
        original: new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }),
        small: new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }),
        large: new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }),
      }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(uploadResponse.status, 201);
    const payload = await uploadResponse.json();
    assert.equal(payload.photo.alt, "");
    assert.equal(objects.size, 3);

    const highIndexResponse = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...MEDIA_UPLOAD_HEADERS },
      body: await mediaUploadBody({
        slot: "pastel-gallery-15",
        alt: "높은 순번 사진",
        original: new File([new Uint8Array([9])], "photo.jpg", { type: "image/jpeg" }),
        small: new File([new Uint8Array([8])], "480.webp", { type: "image/webp" }),
        large: new File([new Uint8Array([7])], "960.webp", { type: "image/webp" }),
      }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(highIndexResponse.status, 201);
    assert.match((await highIndexResponse.json()).photo.src, /\/pastel-gallery-15\/480\.webp$/);
    assert.equal(objects.size, 6);

    const overLimitResponse = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...MEDIA_UPLOAD_HEADERS },
      body: await mediaUploadBody({
        slot: "pastel-gallery-new",
        alt: "x".repeat(301),
        original: new File([new Uint8Array([1])], "photo.jpg", { type: "image/jpeg" }),
        small: new File([new Uint8Array([2])], "480.webp", { type: "image/webp" }),
        large: new File([new Uint8Array([3])], "960.webp", { type: "image/webp" }),
      }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(overLimitResponse.status, 400);
    assert.equal((await overLimitResponse.json()).code, "INVALID_MEDIA_METADATA");

    const document = confirmedDocument();
    document.photos.pastel.gallery[0] = payload.photo;
    assert.throws(() => __test.validateInvitationDocument(document, { write: true }), (error) => error.code === "INVALID_CONTENT");
    const draftResponse = await worker.fetch(request("/api/admin/content", {
      method: "PUT",
      headers: { "cf-access-jwt-assertion": fixture.assertion },
      body: JSON.stringify({ document }),
    }), { ...fixture.env, GUESTBOOK_DB: db });
    assert.equal(draftResponse.status, 400);
    const draftPayload = await draftResponse.json();
    assert.equal(draftPayload.code, "INVALID_CONTENT");
    assert.equal(typeof draftPayload.fieldErrors["photos.pastel.gallery[0].alt"], "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed image variants settle before R2 cleanup and release the quota reservation only after cleanup", async () => {
  const fixture = await accessFixture();
  const db = invitationDatabase();
  const objects = new Map();
  let settledWrites = 0;
  let cleanupObservedSettledWrites = false;
  const bucket = {
    async put(key, value) {
      try {
        if (key.endsWith("/original.jpg")) throw new Error("simulated original write failure");
        await new Promise((resolve) => setTimeout(resolve, 10));
        objects.set(key, await storedBytes(value));
      } finally {
        settledWrites += 1;
      }
    },
    async delete(keys) {
      cleanupObservedSettledWrites = settledWrites === 3;
      for (const key of keys) objects.delete(key);
    },
    async get() { return null; },
  };
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const logLines = [];
  globalThis.fetch = async () => Response.json(fixture.jwks);
  console.error = (line) => logLines.push(line);
  try {
    const response = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...MEDIA_UPLOAD_HEADERS },
      body: await mediaUploadBody({
        slot: "pastel-gallery-new",
        alt: "실패 원자성 검증 사진",
        original: new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }),
        small: new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }),
        large: new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }),
      }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.code, "INTERNAL_ERROR");
    assert.match(payload.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(logLines.length, 1);
    assert.deepEqual(JSON.parse(logLines[0]), {
      event: "media_upload_failed",
      requestId: payload.requestId,
      phase: "r2_write",
      errorName: "Error",
    });
    assert.doesNotMatch(logLines[0], /simulated original write failure|photo\.jpg|pastel-gallery-new|실패 원자성 검증 사진|cf-access-jwt-assertion/i);
    assert.equal(cleanupObservedSettledWrites, true);
    assert.equal(objects.size, 0);
    assert.equal(db.mediaSets.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("media upload failures return a request reference and log D1 reservation phase without photo data", async () => {
  const fixture = await accessFixture();
  const db = invitationDatabase();
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (!sql.startsWith("INSERT INTO invitation_media_sets_v2")) return statement;
    return {
      bind(...values) { statement.bind(...values); return this; },
      async run() { throw Object.assign(new Error("synthetic D1 failure"), { code: "D1_ERROR", status: 503 }); },
    };
  };
  let putCount = 0;
  const bucket = {
    async put() { putCount += 1; },
    async get() { return null; },
    async delete() {},
  };
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const logLines = [];
  globalThis.fetch = async () => Response.json(fixture.jwks);
  console.error = (line) => logLines.push(line);
  try {
    const response = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...MEDIA_UPLOAD_HEADERS },
      body: await mediaUploadBody({
        slot: "pastel-gallery-new",
        alt: "추적용 시험 이미지",
        original: new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }),
        small: new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }),
        large: new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }),
      }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.code, "INTERNAL_ERROR");
    assert.match(payload.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(putCount, 0);
    assert.equal(db.mediaSets.size, 0);
    assert.equal(logLines.length, 1);
    assert.deepEqual(JSON.parse(logLines[0]), {
      event: "media_upload_failed",
      requestId: payload.requestId,
      phase: "quota_reserve",
      errorName: "Error",
      errorCode: "D1_ERROR",
      errorStatus: 503,
    });
    assert.doesNotMatch(logLines[0], /synthetic D1 failure|photo\.jpg|pastel-gallery-new|추적용 시험 이미지|촬영|EXIF/i);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("failed R2 cleanup still releases the media quota reservation", async () => {
  const fixture = await accessFixture();
  const db = invitationDatabase();
  const bucket = {
    async put(key) {
      if (key.endsWith("/480.webp")) throw new Error("simulated variant write failure");
    },
    delete() {
      throw new Error("simulated cleanup failure");
    },
    async get() { return null; },
  };
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const logLines = [];
  globalThis.fetch = async () => Response.json(fixture.jwks);
  console.error = (line) => logLines.push(line);
  try {
    const response = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...MEDIA_UPLOAD_HEADERS },
      body: await mediaUploadBody({
        slot: "pastel-gallery-new",
        alt: "정리 실패 검증 사진",
        original: new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }),
        small: new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }),
        large: new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }),
      }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.code, "INTERNAL_ERROR");
    assert.match(payload.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(db.mediaSets.size, 0);
    const logs = logLines.map((line) => JSON.parse(line));
    assert.deepEqual(logs.map((entry) => entry.phase), ["r2_cleanup", "r2_write"]);
    assert.doesNotMatch(logLines.join("\n"), /simulated variant write failure|simulated cleanup failure|photo\.jpg|pastel-gallery-new|정리 실패 검증 사진|cf-access-jwt-assertion/i);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("photo uploads fail closed before reserving quota when R2 cleanup is unavailable", async () => {
  const fixture = await accessFixture();
  const db = invitationDatabase();
  let putCount = 0;
  const bucket = {
    async put() { putCount += 1; },
    async get() { return null; },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const response = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...MEDIA_UPLOAD_HEADERS },
      body: await mediaUploadBody({
        slot: "pastel-gallery-new",
        alt: "미디어 설정 시험 이미지",
        original: new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }),
        small: new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }),
        large: new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }),
      }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "MEDIA_UNAVAILABLE");
    assert.equal(putCount, 0);
    assert.equal(db.mediaSets.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cleanup failure returns a request reference when an expected media error becomes internal", async () => {
  const fixture = await accessFixture();
  const db = invitationDatabase();
  const bucket = {
    async put(_key, value) { await storedBytes(value); },
    async delete() { throw new Error("simulated cleanup failure"); },
    async get() { return null; },
  };
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const logLines = [];
  globalThis.fetch = async () => Response.json(fixture.jwks);
  console.error = (line) => logLines.push(line);
  try {
    const framed = await mediaUploadBody({
      slot: "pastel-gallery-new",
      alt: "추적용 시험 이미지",
      original: new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }),
      small: new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }),
      large: new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }),
    });
    const withTrailingByte = new Uint8Array(framed.length + 1);
    withTrailingByte.set(framed);
    withTrailingByte[withTrailingByte.length - 1] = 1;
    const response = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...MEDIA_UPLOAD_HEADERS },
      body: withTrailingByte,
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.equal(payload.code, "INTERNAL_ERROR");
    assert.match(payload.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(db.mediaSets.size, 0);
    assert.equal(logLines.length, 1);
    assert.deepEqual(JSON.parse(logLines[0]), {
      event: "media_upload_failed",
      requestId: payload.requestId,
      phase: "r2_cleanup",
      errorName: "Error",
    });
    assert.doesNotMatch(logLines[0], /simulated cleanup failure|photo\.jpg|pastel-gallery-new|추적용 시험 이미지|cf-access-jwt-assertion/i);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("media upload stores the original through a known-length stream accepted by R2", async () => {
  const fixture = await accessFixture();
  const db = invitationDatabase();
  const objects = new Map();
  const bucket = {
    async put(key, value, options) {
      if (value instanceof ReadableStream && typeof value.expectedLength !== "number") {
        throw new TypeError("Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)");
      }
      objects.set(key, { value: await storedBytes(value), httpMetadata: options.httpMetadata, expectedLength: value?.expectedLength });
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async get() { return null; },
  };
  const originalFetch = globalThis.fetch;
  const originalFixedLengthStream = globalThis.FixedLengthStream;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  globalThis.FixedLengthStream = class extends TransformStream {
    constructor(expectedLength) {
      super();
      this.readable.expectedLength = expectedLength;
    }
  };
  try {
    const response = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...MEDIA_UPLOAD_HEADERS },
      body: await mediaUploadBody({
        slot: "pastel-gallery-new",
        alt: "스트림 길이 검증 사진",
        original: new File([new Uint8Array([1, 2, 3, 9])], "photo.jpg", { type: "image/jpeg" }),
        small: new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }),
        large: new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }),
      }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 201);
    const originalKey = [...objects.keys()].find((key) => key.endsWith("/original.jpg"));
    assert.equal(typeof originalKey, "string");
    assert.equal(objects.get(originalKey).expectedLength, 4);
    assert.deepEqual(objects.get(originalKey).value, new Uint8Array([1, 2, 3, 9]));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalFixedLengthStream === undefined) delete globalThis.FixedLengthStream;
    else globalThis.FixedLengthStream = originalFixedLengthStream;
  }
});

test("Access-authenticated MP3 uploads use immutable private keys and stream GET, HEAD, and byte ranges", async () => {
  const fixture = await accessFixture();
  const db = invitationDatabase();
  const bucket = memoryMediaBucket();
  const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64]);
  const file = new File([bytes], "track.mp3", { type: "audio/mpeg" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const response = await worker.fetch(new Request("https://example.test/api/admin/media/audio", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...AUDIO_UPLOAD_HEADERS },
      body: file,
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.match(payload.audio.src, /^\/api\/media\/invitation\/[a-f0-9-]{36}\/background-music\/track\.mp3$/);
    assert.equal(payload.audio.mimeType, "audio/mpeg");
    assert.equal(payload.audio.sizeBytes, bytes.byteLength);
    assert.equal(payload.usage.usedBytes, bytes.byteLength);
    assert.equal(bucket.objects.size, 1);

    const head = await worker.fetch(request(payload.audio.src, { method: "HEAD" }), { WEDDING_MEDIA: bucket });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "audio/mpeg");
    assert.equal(head.headers.get("content-length"), String(bytes.byteLength));
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    assert.equal(head.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const ranged = await worker.fetch(request(payload.audio.src, { method: "GET", headers: { range: "bytes=3-5" } }), { WEDDING_MEDIA: bucket });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), `bytes 3-5/${bytes.byteLength}`);
    assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), bytes.slice(3, 6));

    const invalidRange = await worker.fetch(request(payload.audio.src, { method: "GET", headers: { range: "bytes=99-100" } }), { WEDDING_MEDIA: bucket });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get("content-range"), `bytes */${bytes.byteLength}`);

    const full = await worker.fetch(request(payload.audio.src, { method: "GET" }), { WEDDING_MEDIA: bucket });
    assert.equal(full.status, 200);
    assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);

    const missing = await worker.fetch(request("/api/media/invitation/123e4567-e89b-12d3-a456-426614174000/background-music/track.mp3", { method: "GET" }), { WEDDING_MEDIA: bucket });
    assert.equal(missing.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authenticated AAC M4A and PCM WAV uploads preserve formats through HEAD and range playback", async () => {
  const box = (type, payload) => {
    const result = Buffer.alloc(8 + payload.length);
    result.writeUInt32BE(result.length, 0);
    result.write(type, 4, "ascii");
    Buffer.from(payload).copy(result, 8);
    return result;
  };
  const descriptor = (tag, payload) => Buffer.concat([Buffer.from([tag, payload.length]), payload]);
  const ftyp = box("ftyp", Buffer.from("M4A \u0000\u0000\u0000\u0000isom", "ascii"));
  const handler = box("hdlr", Buffer.concat([Buffer.alloc(8), Buffer.from("soun"), Buffer.alloc(4)]));
  const decoderConfigHeader = Buffer.from([0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const makeM4a = (decoderConfig) => {
    const esds = box("esds", Buffer.concat([Buffer.alloc(4), descriptor(0x03,
      Buffer.concat([Buffer.from([0, 1, 0]), decoderConfig]))]));
    const stsd = box("stsd", Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), box("mp4a", Buffer.concat([Buffer.alloc(28), esds]))]));
    return Buffer.concat([ftyp, box("moov", box("trak", box("mdia", Buffer.concat([handler, box("minf", box("stbl", stsd))])))), box("mdat", Buffer.from([1, 2, 3, 4]))]);
  };
  const aacSpecificInfo = descriptor(0x05, Buffer.from([0x12, 0x10]));
  const aacConfig = descriptor(0x04, Buffer.concat([decoderConfigHeader, aacSpecificInfo]));
  const m4a = makeM4a(aacConfig);
  const noAacConfig = makeM4a(descriptor(0x04, decoderConfigHeader));
  const invalidAacObjectType = makeM4a(descriptor(0x04, Buffer.concat([decoderConfigHeader, descriptor(0x05, Buffer.from([0x00, 0x10]))])));
  const wav = Buffer.alloc(46);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(2, 40);
  const extensibleWav = Buffer.alloc(70);
  extensibleWav.write("RIFF", 0); extensibleWav.writeUInt32LE(extensibleWav.length - 8, 4); extensibleWav.write("WAVEfmt ", 8);
  extensibleWav.writeUInt32LE(40, 16); extensibleWav.writeUInt16LE(0xfffe, 20); extensibleWav.writeUInt16LE(1, 22);
  extensibleWav.writeUInt32LE(8000, 24); extensibleWav.writeUInt32LE(16000, 28);
  extensibleWav.writeUInt16LE(2, 32); extensibleWav.writeUInt16LE(16, 34); extensibleWav.writeUInt16LE(22, 36);
  extensibleWav.writeUInt16LE(16, 38); extensibleWav.writeUInt32LE(1, 40);
  Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]).copy(extensibleWav, 44);
  extensibleWav.write("data", 60); extensibleWav.writeUInt32LE(2, 64);
  const nonPcmExtensibleWav = Buffer.from(extensibleWav);
  nonPcmExtensibleWav[44] = 0x03;
  const fixture = await accessFixture();
  const db = invitationDatabase();
  const bucket = memoryMediaBucket();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    for (const [mimeType, extension, bytes] of [["audio/mp4", "m4a", m4a], ["audio/wav", "wav", wav], ["audio/wav", "wav", extensibleWav]]) {
      const response = await worker.fetch(new Request("https://example.test/api/admin/media/audio", {
        method: "POST", headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, "content-type": mimeType }, body: bytes,
      }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
      assert.equal(response.status, 201);
      const payload = await response.json();
      assert.match(payload.audio.src, new RegExp(`/background-music/track\\.${extension}$`));
      assert.equal(payload.audio.mimeType, mimeType);
      const head = await worker.fetch(request(payload.audio.src, { method: "HEAD" }), { WEDDING_MEDIA: bucket });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("content-type"), mimeType);
      assert.equal(head.headers.get("accept-ranges"), "bytes");
      const range = await worker.fetch(request(payload.audio.src, { method: "GET", headers: { range: "bytes=0-3" } }), { WEDDING_MEDIA: bucket });
      assert.equal(range.status, 206);
      assert.deepEqual(new Uint8Array(await range.arrayBuffer()), new Uint8Array(bytes.subarray(0, 4)));
    }
    const nonAac = Buffer.from(m4a);
    nonAac[nonAac.indexOf(aacConfig) + 2] = 0x69;
    const invalidFiles = [
      ["audio/mp4", Buffer.concat([ftyp, box("mdat", Buffer.from([1, 2, 3, 4]))])],
      ["audio/mp4", Buffer.from(m4a.toString("binary").replace("soun", "vide"), "binary")],
      ["audio/mp4", nonAac],
      ["audio/mp4", noAacConfig],
      ["audio/mp4", invalidAacObjectType],
      ["audio/mp4", wav],
      ["audio/wav", m4a],
      ["audio/wav", Buffer.from([82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69])],
      ["audio/wav", Buffer.from(wav.map((byte, index) => index === 20 ? 6 : byte))],
      ["audio/wav", nonPcmExtensibleWav],
    ];
    for (const [mimeType, bytes] of invalidFiles) {
      const response = await worker.fetch(new Request("https://example.test/api/admin/media/audio", {
        method: "POST", headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, "content-type": mimeType }, body: bytes,
      }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "INVALID_AUDIO_SIGNATURE");
    }
    assert.equal(db.mediaSets.size, 3);
    assert.equal(bucket.objects.size, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test("MP3 administration fails closed on origin, Access, D1, and R2 boundaries", async () => {
  const fixture = await accessFixture();
  const form = () => new File([new Uint8Array([0x49, 0x44, 0x33, 1])], "track.mp3", { type: "audio/mpeg" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const noAccess = await worker.fetch(new Request("https://example.test/api/admin/media/audio", {
      method: "POST",
      headers: { origin: "https://example.test" },
      body: form(),
    }), { GUESTBOOK_DB: invitationDatabase(), WEDDING_MEDIA: memoryMediaBucket() });
    assert.equal(noAccess.status, 503);
    assert.equal((await noAccess.json()).code, "ADMIN_AUTH_UNAVAILABLE");

    const wrongOrigin = await worker.fetch(new Request("https://example.test/api/admin/media/audio", {
      method: "POST",
      headers: { origin: "https://attacker.example", "cf-access-jwt-assertion": fixture.assertion },
      body: form(),
    }), { ...fixture.env, GUESTBOOK_DB: invitationDatabase(), WEDDING_MEDIA: memoryMediaBucket() });
    assert.equal(wrongOrigin.status, 403);

    const noDatabase = await worker.fetch(new Request("https://example.test/api/admin/media/audio", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion },
      body: form(),
    }), { ...fixture.env, WEDDING_MEDIA: memoryMediaBucket() });
    assert.equal(noDatabase.status, 503);
    assert.equal((await noDatabase.json()).code, "CONTENT_UNAVAILABLE");

    const noBucket = await worker.fetch(new Request("https://example.test/api/admin/media/audio", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion },
      body: form(),
    }), { ...fixture.env, GUESTBOOK_DB: invitationDatabase() });
    assert.equal(noBucket.status, 503);
    assert.equal((await noBucket.json()).code, "MEDIA_UNAVAILABLE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MP3 upload rejects spoofed files and shared-quota overflow before R2 writes", async () => {
  const fixture = await accessFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const spoofDb = invitationDatabase();
    const spoofBucket = memoryMediaBucket();
    const spoofResponse = await worker.fetch(new Request("https://example.test/api/admin/media/audio", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...AUDIO_UPLOAD_HEADERS },
      body: new File([new Uint8Array([1, 2, 3, 4])], "spoof.mp3", { type: "audio/mpeg" }),
    }), { ...fixture.env, GUESTBOOK_DB: spoofDb, WEDDING_MEDIA: spoofBucket });
    assert.equal(spoofResponse.status, 400);
    assert.equal((await spoofResponse.json()).code, "INVALID_AUDIO_SIGNATURE");
    assert.equal(spoofBucket.objects.size, 0);

    const id3OnlyResponse = await worker.fetch(new Request("https://example.test/api/admin/media/audio", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...AUDIO_UPLOAD_HEADERS },
      body: new File([new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])], "id3-only.mp3", { type: "audio/mpeg" }),
    }), { ...fixture.env, GUESTBOOK_DB: invitationDatabase(), WEDDING_MEDIA: memoryMediaBucket() });
    assert.equal(id3OnlyResponse.status, 400);
    assert.equal((await id3OnlyResponse.json()).code, "INVALID_AUDIO_SIGNATURE");

    const quotaDb = invitationDatabase();
    quotaDb.mediaSets.set("existing-media", {
      id: "existing-media",
      slot: "pastel-hero",
      total_bytes: 2 * 1024 * 1024 * 1024 - 4,
      status: "stored",
    });
    const quotaBucket = memoryMediaBucket();
    const quotaResponse = await worker.fetch(new Request("https://example.test/api/admin/media/audio", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...AUDIO_UPLOAD_HEADERS },
      body: new File([new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb, 0x90, 0x64])], "track.mp3", { type: "audio/mpeg" }),
    }), { ...fixture.env, GUESTBOOK_DB: quotaDb, WEDDING_MEDIA: quotaBucket });
    assert.equal(quotaResponse.status, 507);
    assert.equal((await quotaResponse.json()).code, "MEDIA_STORAGE_LIMIT");
    assert.equal(quotaBucket.objects.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("oversized MP3 request bodies are rejected before buffering and R2 writes", async () => {
  const fixture = await accessFixture();
  let putCount = 0;
  const bucket = {
    async put() { putCount += 1; },
    async get() { return null; },
    async delete() {},
  };
  const oversized = new File([new Uint8Array([0x49, 0x44, 0x33])], "huge.mp3", { type: "audio/mpeg" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const response = await worker.fetch(new Request("https://example.test/api/admin/media/audio", {
      method: "POST",
      headers: {
        origin: "https://example.test",
        "cf-access-jwt-assertion": fixture.assertion,
        "content-length": String(27 * 1024 * 1024),
        ...AUDIO_UPLOAD_HEADERS,
      },
      body: oversized,
    }), { ...fixture.env, GUESTBOOK_DB: invitationDatabase(), WEDDING_MEDIA: bucket });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, "MEDIA_TOO_LARGE");
    assert.equal(putCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("media uploads stream a framed raw body without multipart buffering", async () => {
  assert.doesNotMatch(workerSource, /\.formData\s*\(/);
  const fixture = await accessFixture();
  const db = invitationDatabase();
  const bucket = memoryMediaBucket();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const multipart = new FormData();
    multipart.set("slot", "pastel-hero");
    const multipartResponse = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion },
      body: multipart,
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(multipartResponse.status, 415);
    assert.equal((await multipartResponse.json()).code, "UNSUPPORTED_MEDIA_BODY");

    const framed = await mediaUploadBody({
      slot: "pastel-hero",
      original: new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }),
      small: new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }),
      large: new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }),
    });
    const truncatedResponse = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...MEDIA_UPLOAD_HEADERS },
      body: framed.subarray(0, framed.byteLength - 1),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(truncatedResponse.status, 400);
    assert.equal((await truncatedResponse.json()).code, "INVALID_MEDIA_BODY");
    assert.equal(bucket.objects.size, 0);
    assert.equal(db.mediaSets.size, 0);

    const badHeader = new Uint8Array([0, 2, 0xff, 0xfe]);
    const badHeaderResponse = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...MEDIA_UPLOAD_HEADERS },
      body: badHeader,
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(badHeaderResponse.status, 400);
    assert.equal((await badHeaderResponse.json()).code, "INVALID_MEDIA_BODY");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("media uploads fail closed before R2 writes when the 2GB project quota would be exceeded", async () => {
  const fixture = await accessFixture();
  const db = invitationDatabase();
  const limitBytes = 2 * 1024 * 1024 * 1024;
  const storedBytes = limitBytes - 4;
  db.mediaSets.set("existing-media", {
    id: "existing-media",
    slot: "pastel-hero",
    total_bytes: storedBytes,
    status: "stored",
    created_at: "2026-08-17T00:00:00.000Z",
    stored_at: "2026-08-17T00:00:01.000Z",
  });
  let putCount = 0;
  const bucket = {
    async put() { putCount += 1; },
    async get() { return null; },
    async delete() {},
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const response = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: { origin: "https://example.test", "cf-access-jwt-assertion": fixture.assertion, ...MEDIA_UPLOAD_HEADERS },
      body: await mediaUploadBody({
        slot: "pastel-hero",
        alt: "용량 제한 검증 사진",
        original: new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }),
        small: new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }),
        large: new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }),
      }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 507);
    assert.equal((await response.json()).code, "MEDIA_STORAGE_LIMIT");
    assert.equal(putCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function mediaRow(id, slot, bytes, createdAt = "2026-08-17T00:00:00.000Z") {
  return { id, slot, total_bytes: bytes, status: "stored", created_at: createdAt, stored_at: createdAt };
}

function revisionRow(id, document, { status = "archived", publishedAt = null, createdAt = "2026-08-10T00:00:00.000Z" } = {}) {
  return {
    id,
    content_json: JSON.stringify(document),
    status,
    created_at: createdAt,
    created_by: "groom@example.test",
    published_at: publishedAt,
  };
}

function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, value) { objects.set(key, await storedBytes(value)); },
    async get(key) {
      if (!objects.has(key)) return null;
      return { body: objects.get(key), size: objects.get(key).byteLength, etag: "test" };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
}

async function withAccessEnv(run) {
  const fixture = await accessFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  const headers = { "cf-access-jwt-assertion": fixture.assertion };
  try {
    await run(fixture, headers);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("draft saves update the existing draft revision instead of accumulating archives", async () => {
  const db = invitationDatabase();
  await withAccessEnv(async (fixture, headers) => {
    const env = { ...fixture.env, GUESTBOOK_DB: db };
    const first = await worker.fetch(request("/api/admin/content", {
      method: "PUT",
      headers,
      body: JSON.stringify({ document: confirmedDocument() }),
    }), env);
    assert.equal(first.status, 201);
    const { revisionId } = await first.json();
    assert.equal(db.state.draft_revision_id, revisionId);
    assert.equal(db.revisions.size, 1);

    const updated = confirmedDocument();
    updated.content.message = ["수정된", "초안", "문장", "입니다"];
    const second = await worker.fetch(request("/api/admin/content", {
      method: "PUT",
      headers,
      body: JSON.stringify({ document: updated }),
    }), env);
    assert.equal(second.status, 200);
    const secondPayload = await second.json();
    assert.equal(secondPayload.revisionId, revisionId);
    assert.equal(db.revisions.size, 1);
    const row = db.revisions.get(revisionId);
    assert.equal(row.status, "draft");
    assert.match(row.content_json, /수정된/);
    const mutableUpdates = db.queries.filter(
      (sql) => sql.includes("SET content_json = ?") && sql.includes("created_at = ?"),
    );
    assert.equal(mutableUpdates.length, 1);
    assert.equal([...db.revisions.values()].filter((revision) => revision.status === "archived" && !revision.published_at).length, 0);
  });
});

test("admin media list requires Access and reports revision references", async () => {
  const db = invitationDatabase();
  const draftDoc = confirmedDocument();
  const publishedDoc = confirmedDocument();
  const archivedDoc = confirmedDocument();
  const draftMediaId = "00000000-0000-0000-0000-000000000001";
  const publishedMediaId = "00000000-0000-0000-0000-000000000002";
  const archivedMediaId = "00000000-0000-0000-0000-000000000003";
  const audioId = "00000000-0000-0000-0000-000000000004";
  draftDoc.photos.pastel.gallery = [galleryPhoto(0)];
  publishedDoc.photos.pastel.gallery = [{
    ...galleryPhoto(1),
    src: `/api/media/invitation/${publishedMediaId}/pastel-gallery-1/480.webp`,
    srcSet: `/api/media/invitation/${publishedMediaId}/pastel-gallery-1/480.webp 480w, /api/media/invitation/${publishedMediaId}/pastel-gallery-1/960.webp 960w`,
  }];
  archivedDoc.photos.pastel.gallery = [{
    ...galleryPhoto(2),
    src: `/api/media/invitation/${archivedMediaId}/pastel-gallery-2/480.webp`,
    srcSet: `/api/media/invitation/${archivedMediaId}/pastel-gallery-2/480.webp 480w, /api/media/invitation/${archivedMediaId}/pastel-gallery-2/960.webp 960w`,
  }];
  db.revisions.set("draft-1", revisionRow("draft-1", draftDoc, { status: "draft" }));
  db.revisions.set("pub-1", revisionRow("pub-1", publishedDoc, { status: "published", publishedAt: "2026-08-15T00:00:00.000Z" }));
  db.revisions.set("arch-1", revisionRow("arch-1", archivedDoc, { status: "archived", publishedAt: "2026-08-01T00:00:00.000Z" }));
  db.state.draft_revision_id = "draft-1";
  db.state.published_revision_id = "pub-1";
  db.mediaSets.set(draftMediaId, mediaRow(draftMediaId, "pastel-gallery-0", 1000));
  db.mediaSets.set(publishedMediaId, mediaRow(publishedMediaId, "pastel-gallery-1", 2000));
  db.mediaSets.set(archivedMediaId, mediaRow(archivedMediaId, "pastel-gallery-2", 3000));
  db.mediaSets.set(audioId, mediaRow(audioId, "background-music", 4000));
  await withAccessEnv(async (fixture, headers) => {
    const env = { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: memoryBucket() };
    const denied = await worker.fetch(request("/api/admin/media/list", { method: "GET" }), env);
    assert.equal(denied.status, 401);

    const response = await worker.fetch(request("/api/admin/media/list", { method: "GET", headers }), env);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.media.length, 4);
    assert.equal(payload.usage.usedBytes, 10000);
    const byId = Object.fromEntries(payload.media.map((item) => [item.mediaId, item]));
    assert.equal(byId[draftMediaId].references.draft, true);
    assert.equal(byId[draftMediaId].references.published, false);
    assert.equal(byId[publishedMediaId].references.published, true);
    assert.deepEqual(byId[archivedMediaId].references.archivedRevisions.map((revision) => revision.id), ["arch-1"]);
    assert.equal(byId[audioId].kind, "audio");
    assert.equal(byId[audioId].previewUrl, null);
    assert.equal(byId[draftMediaId].previewUrl, `/api/media/invitation/${draftMediaId}/pastel-gallery-0/480.webp`);
  });
});

test("media deletion frees quota and removes R2 objects when unreferenced", async () => {
  const db = invitationDatabase();
  const mediaId = "00000000-0000-0000-0000-000000000009";
  db.mediaSets.set(mediaId, mediaRow(mediaId, "pastel-gallery-0", 5000));
  const bucket = memoryBucket();
  bucket.objects.set(`invitation/${mediaId}/pastel-gallery-0/original.jpg`, new Uint8Array([1]));
  bucket.objects.set(`invitation/${mediaId}/pastel-gallery-0/480.webp`, new Uint8Array([2]));
  bucket.objects.set(`invitation/${mediaId}/pastel-gallery-0/960.webp`, new Uint8Array([3]));
  await withAccessEnv(async (fixture, headers) => {
    const response = await worker.fetch(request("/api/admin/media/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaId }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.deleted, mediaId);
    assert.equal(payload.freedBytes, 5000);
    assert.equal(payload.objectsDeleted, true);
    assert.equal(payload.usage.usedBytes, 0);
    assert.equal(db.mediaSets.size, 0);
    assert.equal(bucket.objects.size, 0);
  });
});

test("publish leaves the current public revision intact when the draft changes before the D1 batch", async () => {
  const db = invitationDatabase();
  const draftId = "draft-concurrent-edit";
  const publishedId = "current-public";
  const draft = confirmedDocument();
  const publicDocument = confirmedDocument();
  db.revisions.set(draftId, revisionRow(draftId, draft, { status: "draft" }));
  db.revisions.set(publishedId, revisionRow(publishedId, publicDocument, {
    status: "published", publishedAt: "2026-08-20T00:00:00.000Z",
  }));
  db.state.draft_revision_id = draftId;
  db.state.published_revision_id = publishedId;
  db.injectBeforeBatch("publish", () => {
    const changed = confirmedDocument();
    changed.content.message = ["수정된", "초안", "문장", "입니다"];
    db.revisions.get(draftId).content_json = JSON.stringify(changed);
  });
  await withAccessEnv(async (fixture, headers) => {
    const response = await worker.fetch(request("/api/admin/content/publish", {
      method: "POST", headers, body: JSON.stringify({ revisionId: draftId }),
    }), { ...fixture.env, GUESTBOOK_DB: db });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "STALE_DRAFT");
    assert.equal(db.state.published_revision_id, publishedId);
    assert.equal(db.state.draft_revision_id, draftId);
    assert.equal(db.revisions.get(publishedId).status, "published");
    assert.equal(db.revisions.get(draftId).status, "draft");
    assert.match(db.revisions.get(draftId).content_json, /수정된/);
  });
});

test("rollback preserves a concurrent publication when the public pointer changes before its D1 batch", async () => {
  const db = invitationDatabase();
  const document = confirmedDocument();
  const publishedAt = "2026-08-20T00:00:00.000Z";
  for (const [id, status] of [["current-public", "published"], ["older-public", "archived"], ["new-public", "archived"]]) {
    db.revisions.set(id, revisionRow(id, document, { status, publishedAt }));
  }
  db.state.published_revision_id = "current-public";
  db.injectBeforeBatch("rollback", () => {
    db.revisions.get("current-public").status = "archived";
    db.revisions.get("new-public").status = "published";
    db.state.published_revision_id = "new-public";
  });
  await withAccessEnv(async (fixture, headers) => {
    const response = await worker.fetch(request("/api/admin/content/rollback", {
      method: "POST", headers,
      body: JSON.stringify({ revisionId: "older-public", expectedPublishedRevisionId: "current-public" }),
    }), { ...fixture.env, GUESTBOOK_DB: db });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "STALE_PUBLISHED_REVISION");
    assert.equal(db.state.published_revision_id, "new-public");
    assert.equal(db.revisions.get("new-public").status, "published");
    assert.equal(db.revisions.get("older-public").status, "archived");
  });
});

test("R2 deletion failure retains quota and a retryable media deletion job", async () => {
  const db = invitationDatabase();
  const mediaId = "00000000-0000-0000-0000-000000000019";
  db.mediaSets.set(mediaId, mediaRow(mediaId, "pastel-gallery-0", 5000));
  const bucket = memoryBucket();
  const objectKeys = [
    `invitation/${mediaId}/pastel-gallery-0/original.jpg`,
    `invitation/${mediaId}/pastel-gallery-0/480.webp`,
    `invitation/${mediaId}/pastel-gallery-0/960.webp`,
  ];
  for (const [index, key] of objectKeys.entries()) bucket.objects.set(key, new Uint8Array([index + 1]));
  const deleteObjects = bucket.delete.bind(bucket);
  let deleteAttempts = 0;
  bucket.delete = async (keys) => {
    deleteAttempts += 1;
    if (deleteAttempts === 1) {
      bucket.objects.delete(objectKeys[0]);
      throw new Error("simulated R2 delete failure after partial cleanup");
    }
    return deleteObjects(keys);
  };

  await withAccessEnv(async (fixture, headers) => {
    const env = { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket };
    const requestDelete = () => worker.fetch(request("/api/admin/media/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaId }),
    }), env);
    const failed = await requestDelete();
    assert.equal(failed.status, 503);
    const failedPayload = await failed.json();
    assert.equal(failedPayload.code, "MEDIA_DELETE_PENDING");
    assert.equal(failedPayload.deletionPending, true);
    assert.equal(failedPayload.usage.usedBytes, 5000);
    assert.equal(db.mediaSets.has(mediaId), true);
    assert.equal(db.mediaDeletionJobs.has(mediaId), true);
    assert.equal(bucket.objects.size, 2);

    const listed = await worker.fetch(request("/api/admin/media/list", { method: "GET", headers }), env);
    const listPayload = await listed.json();
    assert.equal(listPayload.media.find((item) => item.mediaId === mediaId).deletionPending, true);
    assert.equal(listPayload.usage.usedBytes, 5000);

    const retried = await requestDelete();
    assert.equal(retried.status, 200);
    const retryPayload = await retried.json();
    assert.equal(retryPayload.deleted, mediaId);
    assert.equal(retryPayload.freedBytes, 5000);
    assert.equal(retryPayload.objectsDeleted, true);
    assert.equal(retryPayload.usage.usedBytes, 0);
    assert.equal(db.mediaSets.has(mediaId), false);
    assert.equal(db.mediaDeletionJobs.has(mediaId), false);
    assert.equal(bucket.objects.size, 0);
    assert.equal(deleteAttempts, 2);
  });
});

test("media deletion refuses an unobserved revision reference before deleting R2 objects", async () => {
  const db = invitationDatabase();
  const mediaId = "00000000-0000-0000-0000-000000000039";
  db.mediaSets.set(mediaId, mediaRow(mediaId, "pastel-gallery-0", 5000));
  const bucket = memoryBucket();
  const objectKey = `invitation/${mediaId}/pastel-gallery-0/480.webp`;
  bucket.objects.set(objectKey, new Uint8Array([7]));
  db.injectBeforeMediaDeletionClaim(() => {
    const document = confirmedDocument();
    document.photos.pastel.gallery = [{
      ...galleryPhoto(0),
      src: objectKey.replace("invitation/", "/api/media/invitation/").replace("/pastel-gallery-0/480.webp", "/pastel-gallery-0/480.webp"),
      srcSet: `${objectKey.replace("invitation/", "/api/media/invitation/")} 480w`,
    }];
    db.state.draft_revision_id = "draft-added-during-delete";
    db.revisions.set(db.state.draft_revision_id, revisionRow(db.state.draft_revision_id, document, { status: "draft" }));
  });

  await withAccessEnv(async (fixture, headers) => {
    const response = await worker.fetch(request("/api/admin/media/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaId }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "MEDIA_IN_USE");
    assert.equal(db.mediaDeletionJobs.has(mediaId), false);
    assert.equal(db.mediaSets.has(mediaId), true);
    assert.equal(bucket.objects.has(objectKey), true);
  });
});

test("draft save and publish reject media while its storage deletion is pending", async () => {
  const db = invitationDatabase();
  const mediaId = "00000000-0000-0000-0000-000000000029";
  const document = confirmedDocument();
  document.content.music.src = `/api/media/invitation/${mediaId}/background-music/track.wav`;
  const draftId = "draft-pending-delete";
  db.state.draft_revision_id = draftId;
  db.revisions.set(draftId, revisionRow(draftId, document, { status: "draft" }));
  db.mediaSets.set(mediaId, mediaRow(mediaId, "background-music", 1000));
  db.mediaDeletionJobs.set(mediaId, { media_id: mediaId, slot: "background-music", requested_at: new Date().toISOString() });

  await withAccessEnv(async (fixture, headers) => {
    const env = { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: memoryBucket() };
    const saved = await worker.fetch(request("/api/admin/content", {
      method: "PUT",
      headers,
      body: JSON.stringify({ document }),
    }), env);
    assert.equal(saved.status, 409);
    assert.equal((await saved.json()).code, "MEDIA_DELETE_PENDING");
    assert.equal(db.revisions.get(draftId).status, "draft");

    const published = await worker.fetch(request("/api/admin/content/publish", {
      method: "POST",
      headers,
      body: JSON.stringify({ revisionId: draftId }),
    }), env);
    assert.equal(published.status, 409);
    assert.equal((await published.json()).code, "MEDIA_DELETE_PENDING");
    assert.equal(db.state.published_revision_id, null);
    assert.equal(db.state.draft_revision_id, draftId);
    assert.equal(db.revisions.get(draftId).status, "draft");
  });
});

test("rollback rejects archived content that references media being deleted", async () => {
  const db = invitationDatabase();
  const mediaId = "00000000-0000-0000-0000-000000000039";
  const currentId = "published-current";
  const archivedId = "archived-locked-media";
  const archivedDocument = confirmedDocument();
  archivedDocument.content.music.src = `/api/media/invitation/${mediaId}/background-music/track.m4a`;
  db.state.published_revision_id = currentId;
  db.revisions.set(currentId, revisionRow(currentId, confirmedDocument(), {
    status: "published",
    publishedAt: "2026-09-01T00:00:00.000Z",
  }));
  db.revisions.set(archivedId, revisionRow(archivedId, archivedDocument, {
    status: "archived",
    publishedAt: "2026-08-01T00:00:00.000Z",
  }));
  db.mediaSets.set(mediaId, mediaRow(mediaId, "background-music", 1000));
  db.mediaDeletionJobs.set(mediaId, { media_id: mediaId, slot: "background-music", requested_at: new Date().toISOString() });

  await withAccessEnv(async (fixture, headers) => {
    const response = await worker.fetch(request("/api/admin/content/rollback", {
      method: "POST",
      headers,
      body: JSON.stringify({ revisionId: archivedId, expectedPublishedRevisionId: currentId }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: memoryBucket() });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "MEDIA_DELETE_PENDING");
    assert.equal(db.state.published_revision_id, currentId);
    assert.equal(db.revisions.get(currentId).status, "published");
    assert.equal(db.revisions.get(archivedId).status, "archived");
  });
});

test("media deletion removes uploaded M4A objects while resetting draft music to the bundled fallback", async () => {
  const db = invitationDatabase();
  const photoId = "00000000-0000-0000-0000-000000000001";
  const keepId = "00000000-0000-0000-0000-000000000002";
  const audioId = "00000000-0000-0000-0000-000000000003";
  const draftDoc = confirmedDocument();
  draftDoc.photos.pastel.gallery = [galleryPhoto(0), {
    ...galleryPhoto(1),
    src: `/api/media/invitation/${keepId}/pastel-gallery-1/480.webp`,
    srcSet: `/api/media/invitation/${keepId}/pastel-gallery-1/480.webp 480w, /api/media/invitation/${keepId}/pastel-gallery-1/960.webp 960w`,
  }];
  draftDoc.content.music = {
    src: `/api/media/invitation/${audioId}/background-music/track.m4a`,
    title: "업로드한 곡",
    artist: "관리자",
    sourceUrl: "https://example.test/source",
    licenseLabel: "CC0",
    licenseUrl: "https://example.test/license",
  };
  db.revisions.set("draft-1", revisionRow("draft-1", draftDoc, { status: "draft" }));
  db.state.draft_revision_id = "draft-1";
  db.mediaSets.set(photoId, mediaRow(photoId, "pastel-gallery-0", 1000));
  db.mediaSets.set(audioId, mediaRow(audioId, "background-music", 2000));
  const bucket = memoryBucket();
  const audioObjectKey = `invitation/${audioId}/background-music/track.m4a`;
  bucket.objects.set(audioObjectKey, new Uint8Array([4]));
  await withAccessEnv(async (fixture, headers) => {
    const env = { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket };
    const photoResponse = await worker.fetch(request("/api/admin/media/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaId: photoId }),
    }), env);
    assert.equal(photoResponse.status, 200);
    let payload = await photoResponse.json();
    assert.equal(payload.removedFromDraft, 1);
    let draft = JSON.parse(db.revisions.get("draft-1").content_json);
    assert.equal(draft.photos.pastel.gallery.length, 1);
    assert.equal(draft.photos.pastel.gallery[0].src.includes(keepId), true);
    assert.equal(draft.content.music.src.includes(audioId), true);

    const audioResponse = await worker.fetch(request("/api/admin/media/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaId: audioId }),
    }), env);
    assert.equal(audioResponse.status, 200);
    payload = await audioResponse.json();
    assert.equal(payload.removedFromDraft, 1);
    draft = JSON.parse(db.revisions.get("draft-1").content_json);
    assert.deepEqual(draft.content.music, weddingContent.music);
    assert.equal(bucket.objects.has(audioObjectKey), false);
  });
});

test("media deletion blocks while the published revision references the file", async () => {
  const db = invitationDatabase();
  const mediaId = "00000000-0000-0000-0000-000000000001";
  const publishedDoc = confirmedDocument();
  publishedDoc.photos.pastel.gallery = [galleryPhoto(0)];
  db.revisions.set("pub-1", revisionRow("pub-1", publishedDoc, { status: "published", publishedAt: "2026-08-15T00:00:00.000Z" }));
  db.state.published_revision_id = "pub-1";
  db.mediaSets.set(mediaId, mediaRow(mediaId, "pastel-gallery-0", 1000));
  const bucket = memoryBucket();
  bucket.objects.set(`invitation/${mediaId}/pastel-gallery-0/480.webp`, new Uint8Array([1]));
  await withAccessEnv(async (fixture, headers) => {
    const response = await worker.fetch(request("/api/admin/media/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaId }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "MEDIA_IN_USE");
    assert.equal(db.mediaSets.size, 1);
    assert.equal(bucket.objects.size, 1);
  });
});

test("media deletion lists dependent revisions and cascades only after confirmation", async () => {
  const db = invitationDatabase();
  const mediaId = "00000000-0000-0000-0000-000000000001";
  const archivedDoc = confirmedDocument();
  archivedDoc.photos.pastel.gallery = [galleryPhoto(0)];
  db.revisions.set("arch-1", revisionRow("arch-1", archivedDoc, { status: "archived", publishedAt: "2026-08-01T00:00:00.000Z" }));
  db.revisions.set("arch-2", revisionRow("arch-2", confirmedDocument(), { status: "archived", publishedAt: "2026-08-02T00:00:00.000Z" }));
  db.mediaSets.set(mediaId, mediaRow(mediaId, "pastel-gallery-0", 1000));
  const bucket = memoryBucket();
  await withAccessEnv(async (fixture, headers) => {
    const env = { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket };
    const blocked = await worker.fetch(request("/api/admin/media/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaId }),
    }), env);
    assert.equal(blocked.status, 409);
    const blockedPayload = await blocked.json();
    assert.equal(blockedPayload.code, "MEDIA_REFERENCED");
    assert.deepEqual(blockedPayload.dependentRevisions.map((revision) => revision.id), ["arch-1"]);
    assert.equal(db.mediaSets.size, 1);
    assert.equal(db.revisions.has("arch-1"), true);

    const confirmed = await worker.fetch(request("/api/admin/media/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaId, deleteRevisions: true }),
    }), env);
    assert.equal(confirmed.status, 200);
    const payload = await confirmed.json();
    assert.deepEqual(payload.deletedRevisions.map((revision) => revision.id), ["arch-1"]);
    assert.equal(db.revisions.has("arch-1"), false);
    assert.equal(db.revisions.has("arch-2"), true);
    assert.equal(db.mediaSets.size, 0);
  });
});

test("media list hides reserved uploads and deletion refuses in-flight sets", async () => {
  const db = invitationDatabase();
  const reservedId = "00000000-0000-0000-0000-00000000000a";
  const storedId = "00000000-0000-0000-0000-00000000000b";
  const staleId = "00000000-0000-0000-0000-00000000000f";
  db.mediaSets.set(reservedId, { ...mediaRow(reservedId, "pastel-gallery-9", 1000, new Date().toISOString()), status: "reserved" });
  db.mediaSets.set(storedId, mediaRow(storedId, "pastel-gallery-10", 2000));
  db.mediaSets.set(staleId, { ...mediaRow(staleId, "pastel-gallery-15", 3000), status: "reserved" });
  await withAccessEnv(async (fixture, headers) => {
    const env = { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: memoryBucket() };
    const list = await worker.fetch(request("/api/admin/media/list", { method: "GET", headers }), env);
    assert.equal(list.status, 200);
    const payload = await list.json();
    assert.deepEqual(payload.media.map((item) => item.mediaId).sort(), [staleId, storedId].sort());
    assert.equal(payload.media.find((item) => item.mediaId === staleId).abandoned, true);
    assert.equal(payload.media.find((item) => item.mediaId === storedId).abandoned, false);
    assert.equal(payload.usage.usedBytes, 6000);

    const refused = await worker.fetch(request("/api/admin/media/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaId: reservedId }),
    }), env);
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).code, "MEDIA_IN_USE");
    assert.equal(db.mediaSets.has(reservedId), true);

    const staleDelete = await worker.fetch(request("/api/admin/media/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaId: staleId }),
    }), env);
    assert.equal(staleDelete.status, 200);
    assert.equal(db.mediaSets.has(staleId), false);
    assert.equal(db.mediaSets.has(reservedId), true);
  });
});

test("media upload fails closed when the reservation row disappears before commit", async () => {
  const fixture = await accessFixture();
  const db = invitationDatabase();
  const objects = new Map();
  const bucket = {
    async put(key, value, options) {
      objects.set(key, { value: await storedBytes(value), httpMetadata: options.httpMetadata });
      const reserved = [...db.mediaSets.values()].find((row) => row.status === "reserved");
      if (reserved) db.mediaSets.delete(reserved.id);
    },
    async get(key) {
      return objects.get(key) || null;
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const response = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: {
        origin: "https://example.test",
        "cf-access-jwt-assertion": fixture.assertion,
        ...MEDIA_UPLOAD_HEADERS,
      },
      body: await mediaUploadBody({
        slot: "pastel-hero",
        alt: "",
        position: "50% 50%",
        original: new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }),
        small: new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }),
        large: new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }),
      }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "MEDIA_STORAGE_LOST");
    assert.equal(objects.size, 0);
    assert.equal(db.mediaSets.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("media reference matching is case-insensitive", async () => {
  const db = invitationDatabase();
  const mediaId = "00000000-0000-0000-0000-00000000000c";
  const archivedDoc = confirmedDocument();
  archivedDoc.photos.pastel.gallery = [{
    ...galleryPhoto(0),
    src: `/api/media/INVITATION/${mediaId.toUpperCase()}/pastel-gallery-0/480.webp`,
    srcSet: `/api/media/INVITATION/${mediaId.toUpperCase()}/pastel-gallery-0/480.webp 480w`,
  }];
  db.revisions.set("arch-1", revisionRow("arch-1", archivedDoc, { status: "archived", publishedAt: "2026-08-01T00:00:00.000Z" }));
  db.mediaSets.set(mediaId, mediaRow(mediaId, "pastel-gallery-0", 1000));
  await withAccessEnv(async (fixture, headers) => {
    const env = { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: memoryBucket() };
    const list = await worker.fetch(request("/api/admin/media/list", { method: "GET", headers }), env);
    const payload = await list.json();
    const item = payload.media.find((entry) => entry.mediaId === mediaId);
    assert.deepEqual(item.references.archivedRevisions.map((revision) => revision.id), ["arch-1"]);

    const blocked = await worker.fetch(request("/api/admin/media/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaId }),
    }), env);
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, "MEDIA_REFERENCED");
  });
});

test("media deletion refuses when the draft document cannot be parsed", async () => {
  const db = invitationDatabase();
  const mediaId = "00000000-0000-0000-0000-00000000000d";
  db.revisions.set("draft-1", {
    id: "draft-1",
    content_json: `{"photos": "invitation/${mediaId}/`,
    status: "draft",
    created_at: "2026-08-10T00:00:00.000Z",
    created_by: "groom@example.test",
    published_at: null,
  });
  db.state.draft_revision_id = "draft-1";
  db.mediaSets.set(mediaId, mediaRow(mediaId, "pastel-gallery-0", 1000));
  const bucket = memoryBucket();
  await withAccessEnv(async (fixture, headers) => {
    const response = await worker.fetch(request("/api/admin/media/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaId }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "DRAFT_CORRUPTED");
    assert.equal(db.mediaSets.size, 1);
    assert.equal(bucket.objects.size, 0);
  });
});

test("media deletion aborts when a revision becomes a live pointer mid-batch", async () => {
  const db = invitationDatabase();
  const mediaId = "00000000-0000-0000-0000-000000000001";
  const archivedDoc = confirmedDocument();
  archivedDoc.photos.pastel.gallery = [galleryPhoto(0)];
  db.revisions.set("arch-1", revisionRow("arch-1", archivedDoc, { status: "archived", publishedAt: "2026-08-01T00:00:00.000Z" }));
  db.mediaSets.set(mediaId, mediaRow(mediaId, "pastel-gallery-0", 1000));
  const bucket = memoryBucket();
  bucket.objects.set(`invitation/${mediaId}/pastel-gallery-0/480.webp`, new Uint8Array([1]));
  const originalBatch = db.batch.bind(db);
  db.batch = async (statements) => {
    db.state.published_revision_id = "arch-1";
    return originalBatch(statements);
  };
  await withAccessEnv(async (fixture, headers) => {
    const response = await worker.fetch(request("/api/admin/media/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaId, deleteRevisions: true }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "MEDIA_IN_USE");
    assert.equal(db.revisions.has("arch-1"), true);
    assert.equal(db.mediaSets.has(mediaId), true);
    assert.equal(bucket.objects.size, 1);
  });
});

test("photo upload cleanup still releases the reservation when R2 delete fails", async () => {
  const fixture = await accessFixture();
  const db = invitationDatabase();
  const objects = new Map();
  const bucket = {
    async put(key, value) {
      objects.set(key, await storedBytes(value));
      throw new Error("simulated R2 write failure");
    },
    async get(key) {
      return objects.get(key) || null;
    },
    async delete() {
      throw new Error("simulated R2 delete failure");
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const response = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: {
        origin: "https://example.test",
        "cf-access-jwt-assertion": fixture.assertion,
        ...MEDIA_UPLOAD_HEADERS,
      },
      body: await mediaUploadBody({
        slot: "pastel-hero",
        alt: "",
        position: "50% 50%",
        original: new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpeg" }),
        small: new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }),
        large: new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }),
      }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 500);
    assert.equal(db.mediaSets.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy media sets migrate to the v2 quota table on the first media operation", async () => {
  const db = invitationDatabase();
  const legacyId = "00000000-0000-0000-0000-0000000000aa";
  db.legacyMediaSets.set(legacyId, mediaRow(legacyId, "pastel-gallery-3", 1000));
  const bucket = memoryBucket();
  await withAccessEnv(async (fixture, headers) => {
    const env = { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket };
    const list = await worker.fetch(request("/api/admin/media/list", { method: "GET", headers }), env);
    assert.equal(list.status, 200);
    const payload = await list.json();
    assert.deepEqual(payload.media.map((item) => item.mediaId), [legacyId]);
    assert.equal(db.mediaSets.has(legacyId), true);
    assert.equal(db.legacyMediaSets.size, 0);

    const deleted = await worker.fetch(request("/api/admin/media/delete", {
      method: "POST",
      headers,
      body: JSON.stringify({ mediaId: legacyId }),
    }), env);
    assert.equal(deleted.status, 200);
    assert.equal(db.mediaSets.has(legacyId), false);
    assert.equal(db.legacyMediaSets.size, 0);
  });
});

test("media reservations accept totals beyond the retired 30MiB per-set bound", async () => {
  const fixture = await accessFixture();
  const db = invitationDatabase();
  const bucket = memoryBucket();
  const largeOriginal = new Uint8Array(40 * 1024 * 1024);
  largeOriginal[0] = 0xff;
  largeOriginal[1] = 0xd8;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(fixture.jwks);
  try {
    const response = await worker.fetch(new Request("https://example.test/api/admin/media", {
      method: "POST",
      headers: {
        origin: "https://example.test",
        "cf-access-jwt-assertion": fixture.assertion,
        ...MEDIA_UPLOAD_HEADERS,
      },
      body: await mediaUploadBody({
        slot: "pastel-gallery-new",
        alt: "대형 사진",
        position: "50% 50%",
        original: new File([largeOriginal], "photo.jpg", { type: "image/jpeg" }),
        small: new File([new Uint8Array([4, 5])], "480.webp", { type: "image/webp" }),
        large: new File([new Uint8Array([6, 7, 8])], "960.webp", { type: "image/webp" }),
      }),
    }), { ...fixture.env, GUESTBOOK_DB: db, WEDDING_MEDIA: bucket });
    assert.equal(response.status, 201);
    const set = [...db.mediaSets.values()][0];
    assert.equal(set.status, "stored");
    assert.equal(set.total_bytes > 40 * 1024 * 1024, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
