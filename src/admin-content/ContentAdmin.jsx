import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { weddingContent } from "../content.js";
import { cloneContentDocument, createContentDocument, normalizeContentDocument } from "./content-document.js";
import {
  ACCESS_LOGOUT_PATH,
  createContentAdapter,
  isAdminAuthRequiredError,
  isLocalReviewBuild,
} from "./content-client.js";
import {
  CONTENT_PREVIEW_MESSAGE_TYPE,
  CONTENT_PREVIEW_READY_MESSAGE_TYPE,
} from "./public-content.jsx";

function setAtPath(document, path, value) {
  const next = cloneContentDocument(document);
  let target = next;
  for (const key of path.slice(0, -1)) target = target[key];
  target[path.at(-1)] = value;
  return next;
}

function Field({ label, value, onChange, type = "text", hint, required = true }) {
  return (
    <label className="content-admin-field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} required={required} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function CopyField({ label, lines, onChange, hint }) {
  return (
    <label className="content-admin-field is-wide">
      <span>{label}</span>
      <textarea rows={Math.max(3, lines.length)} value={lines.join("\n")} onChange={(event) => onChange(event.target.value.split("\n"))} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function PhotoEditor({ title, slot, photo, onMetaChange, onUpload, busy }) {
  return (
    <article className="content-admin-photo-card">
      <img src={photo.src} alt="" style={{ objectPosition: photo.position }} />
      <div>
        <strong>{title}</strong>
        <label className="content-admin-file">
          <span>{busy ? "이미지 처리 중…" : "사진 교체"}</span>
          <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onUpload(slot, file);
            event.target.value = "";
          }} />
        </label>
        <Field label="대체 텍스트" value={photo.alt} onChange={(value) => onMetaChange("alt", value)} />
        <Field label="초점 위치" value={photo.position} onChange={(value) => onMetaChange("position", value)} hint="예: 50% 58%" />
      </div>
    </article>
  );
}

function formatStorage(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${Math.ceil(bytes / (1024 * 1024))} MB`;
}

function AdminReauthentication() {
  return (
    <section className="admin-auth-required content-admin-auth" role="alert" aria-labelledby="admin-auth-title">
      <p className="eyebrow">SESSION REQUIRED</p>
      <h2 id="admin-auth-title">관리자 인증이 필요합니다</h2>
      <p>인증 방식이 변경되었거나 로그인 세션이 만료되었습니다. 기존 세션을 종료한 뒤 승인된 Google 계정으로 다시 로그인해 주세요.</p>
      <a className="admin-auth-action" href={ACCESS_LOGOUT_PATH}>Google 계정으로 다시 로그인</a>
    </section>
  );
}

export function ContentAdmin() {
  const localReview = isLocalReviewBuild();
  const adapter = useMemo(() => createContentAdapter({ staticContent: weddingContent }), []);
  const previewRef = useRef(null);
  const [editingDocument, setEditingDocument] = useState(() => createContentDocument(weddingContent));
  const documentRef = useRef(editingDocument);
  const [draftRevisionId, setDraftRevisionId] = useState(null);
  const [publishedRevisionId, setPublishedRevisionId] = useState(null);
  const [status, setStatus] = useState({ tone: "neutral", message: "관리 콘텐츠를 불러오는 중입니다." });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(true);
  const [uploadingSlot, setUploadingSlot] = useState("");
  const [mediaUsage, setMediaUsage] = useState(null);
  const [authRequired, setAuthRequired] = useState(false);

  const showAdminError = useCallback((error, fallbackMessage) => {
    if (isAdminAuthRequiredError(error)) {
      setAuthRequired(true);
      setStatus({ tone: "error", message: "승인된 Google 계정으로 다시 로그인해 주세요." });
      return;
    }
    setStatus({ tone: "error", message: error.message || fallbackMessage });
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const [state, usage] = await Promise.all([adapter.getAdminState(), adapter.getMediaUsage()]);
      const next = normalizeContentDocument(state.draft || state.published, weddingContent, { allowLocalPreview: localReview });
      setEditingDocument(next);
      setDraftRevisionId(state.draftRevisionId || null);
      setPublishedRevisionId(state.publishedRevisionId || null);
      setDirty(false);
      setMediaUsage(usage);
      setAuthRequired(false);
      setStatus({
        tone: localReview ? "review" : "success",
        message: localReview
          ? "로컬 검토 모드입니다. 여기서 공개해도 인터넷에는 반영되지 않습니다."
          : "Cloudflare에 저장된 최신 콘텐츠를 불러왔습니다.",
      });
    } catch (error) {
      showAdminError(error, "관리 콘텐츠를 불러오지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }, [adapter, localReview, showAdminError]);

  useEffect(() => { void load(); }, [load]);

  documentRef.current = editingDocument;

  useEffect(() => {
    const send = () => {
      const payload = { type: CONTENT_PREVIEW_MESSAGE_TYPE, document: editingDocument };
      previewRef.current?.contentWindow?.postMessage(payload, window.location.origin);
    };
    send();
    const retry = window.setTimeout(send, 250);
    return () => window.clearTimeout(retry);
  }, [editingDocument]);

  useEffect(() => {
    const sendCurrentDocument = (event) => {
      if (event.origin !== window.location.origin || event.source !== previewRef.current?.contentWindow) return;
      if (event.data?.type !== CONTENT_PREVIEW_READY_MESSAGE_TYPE) return;
      previewRef.current.contentWindow.postMessage({ type: CONTENT_PREVIEW_MESSAGE_TYPE, document: documentRef.current }, window.location.origin);
    };
    window.addEventListener("message", sendCurrentDocument);
    return () => window.removeEventListener("message", sendCurrentDocument);
  }, []);

  const update = (path, value) => {
    setEditingDocument((current) => setAtPath(current, path, value));
    setDirty(true);
    setStatus({ tone: "neutral", message: "아직 저장하지 않은 변경사항이 있습니다." });
  };

  const saveDraft = async () => {
    setBusy(true);
    try {
      const state = await adapter.saveDraft(editingDocument);
      setDraftRevisionId(state.draftRevisionId || null);
      if (state.publishedRevisionId) setPublishedRevisionId(state.publishedRevisionId);
      setEditingDocument(normalizeContentDocument(state.draft || editingDocument, weddingContent, { allowLocalPreview: localReview }));
      setDirty(false);
      setStatus({ tone: "success", message: "임시 저장했습니다. 미리보기를 확인한 뒤 공개해 주세요." });
      return state.draftRevisionId;
    } catch (error) {
      showAdminError(error, "임시 저장하지 못했습니다.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (dirty || !draftRevisionId) {
      setStatus({ tone: "error", message: "먼저 현재 변경사항을 임시 저장해 주세요." });
      return;
    }
    setBusy(true);
    try {
      const published = await adapter.publish(draftRevisionId);
      setPublishedRevisionId(published.revisionId || draftRevisionId);
      setDraftRevisionId(null);
      setStatus({
        tone: "success",
        message: localReview ? "로컬 공개본을 갱신했습니다. 실제 인터넷에는 배포되지 않았습니다." : "새 공개본을 반영했습니다.",
      });
    } catch (error) {
      showAdminError(error, "공개본을 반영하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const uploadPhoto = async (slot, file) => {
    setUploadingSlot(slot);
    try {
      const isHero = slot === "pastel-hero";
      const index = isHero ? -1 : Number(slot.replace("pastel-gallery-", ""));
      const current = isHero ? editingDocument.photos.pastel.hero : editingDocument.photos.pastel.gallery[index];
      const result = await adapter.uploadPhoto({ slot, file, alt: current.alt, position: current.position });
      update(isHero ? ["photos", "pastel", "hero"] : ["photos", "pastel", "gallery", index], result.photo);
      setMediaUsage(result.usage || await adapter.getMediaUsage());
      setStatus({ tone: "success", message: "새 사진을 초안에 넣었습니다. 초점과 설명을 확인해 주세요." });
    } catch (error) {
      showAdminError(error, "사진을 처리하지 못했습니다.");
    } finally {
      setUploadingSlot("");
    }
  };

  const event = editingDocument.content.event;
  const venue = editingDocument.content.venue;
  const transit = editingDocument.content.transit;
  const photos = editingDocument.photos.pastel;
  const previewStateLabel = dirty ? "미저장 변경" : draftRevisionId ? "저장된 초안" : publishedRevisionId ? "공개본" : "저장 전";

  return (
    <main className="content-admin-shell">
      <header className="content-admin-header">
        <div>
          <p className="eyebrow">WEDDING CONTENT STUDIO</p>
          <h1>청첩장 콘텐츠 관리</h1>
          <p>문구와 사진을 초안으로 저장하고, 오른쪽 실제 화면을 확인한 뒤 공개합니다.</p>
        </div>
        <nav aria-label="관리 메뉴">
          <a href="/admin/guestbook">비공개 방명록</a>
          <a href="/" target="_blank" rel="noreferrer">현재 공개 화면</a>
          {!localReview && <a className="admin-logout-link" href={ACCESS_LOGOUT_PATH}>로그아웃</a>}
        </nav>
      </header>

      {authRequired ? <AdminReauthentication /> : <div className="content-admin-layout">
        <section className="content-admin-editor" aria-label="초대장 콘텐츠 편집">
          <p className={`content-admin-status is-${status.tone}`} role="status">{status.message}</p>

          <fieldset disabled={busy}>
            <legend>첫 화면과 기본 정보</legend>
            <div className="content-admin-grid">
              <Field label="신랑 이름" value={editingDocument.content.couple.groom} onChange={(value) => update(["content", "couple", "groom"], value)} />
              <Field label="신부 이름" value={editingDocument.content.couple.bride} onChange={(value) => update(["content", "couple", "bride"], value)} />
              <CopyField label="상단 인사" lines={editingDocument.content.hero.introLines} onChange={(value) => update(["content", "hero", "introLines"], value)} hint="줄바꿈 그대로 표시됩니다." />
            </div>
          </fieldset>

          <fieldset disabled={busy}>
            <legend>예식 정보</legend>
            <div className="content-admin-grid">
              <Field label="예식 날짜" type="date" value={event.isoDate} onChange={(value) => update(["content", "event", "isoDate"], value)} />
              <Field label="시작 시각" type="time" value={event.startTime24h} onChange={(value) => update(["content", "event", "startTime24h"], value)} />
              <Field label="표시 날짜" value={event.dateLabel} onChange={(value) => update(["content", "event", "dateLabel"], value)} />
              <Field label="요일" value={event.day} onChange={(value) => update(["content", "event", "day"], value)} />
              <Field label="표시 시각" value={event.time} onChange={(value) => update(["content", "event", "time"], value)} />
              <Field label="예식장" value={venue.name} onChange={(value) => update(["content", "venue", "name"], value)} />
              <Field label="층" value={venue.floor} onChange={(value) => update(["content", "venue", "floor"], value)} />
              <Field label="주소" value={venue.address} onChange={(value) => update(["content", "venue", "address"], value)} />
            </div>
          </fieldset>

          <fieldset disabled={busy}>
            <legend>초대 문구</legend>
            <div className="content-admin-grid">
              <CopyField label="인사말" lines={editingDocument.content.message} onChange={(value) => update(["content", "message"], value)} />
              <CopyField label="우리의 이야기" lines={editingDocument.content.story} onChange={(value) => update(["content", "story"], value)} />
            </div>
          </fieldset>

          <fieldset disabled={busy}>
            <legend>교통과 주차</legend>
            <div className="content-admin-grid">
              <Field label="지하철" value={transit.subway} onChange={(value) => update(["content", "transit", "subway"], value)} />
              <Field label="셔틀" value={transit.shuttle} onChange={(value) => update(["content", "transit", "shuttle"], value)} />
              <Field label="주차" value={transit.parking} onChange={(value) => update(["content", "transit", "parking"], value)} />
              <Field label="주차 등록 위치" value={transit.parkingRegistrationLocation} onChange={(value) => update(["content", "transit", "parkingRegistrationLocation"], value)} />
              <Field label="주차 등록 안내" value={transit.parkingRegistration} onChange={(value) => update(["content", "transit", "parkingRegistration"], value)} />
            </div>
          </fieldset>

          <fieldset disabled={busy}>
            <legend>사진</legend>
            <div className="content-admin-storage" aria-live="polite">
              <div>
                <strong>사진 저장 공간</strong>
                <span>{mediaUsage?.localReview ? "로컬 검토에서는 Cloudflare 공간을 사용하지 않습니다." : `${formatStorage(mediaUsage?.usedBytes || 0)} / ${formatStorage(mediaUsage?.limitBytes || 0)}`}</span>
              </div>
              <progress max="100" value={mediaUsage?.percent || 0} aria-label="사진 저장 공간 사용률" />
              <small>{mediaUsage?.localReview ? "production에서는 2GB에 도달하면 추가 업로드가 자동으로 차단됩니다." : `사용률 ${mediaUsage?.percent || 0}% · 남은 공간 ${formatStorage(mediaUsage?.remainingBytes || 0)}`}</small>
            </div>
            <div className="content-admin-photo-list">
              <PhotoEditor title="상단 대표 사진" slot="pastel-hero" photo={photos.hero} busy={uploadingSlot === "pastel-hero"} onUpload={uploadPhoto} onMetaChange={(key, value) => update(["photos", "pastel", "hero", key], value)} />
              {photos.gallery.map((photo, index) => (
                <PhotoEditor key={`gallery-${index}`} title={`갤러리 ${index + 1}`} slot={`pastel-gallery-${index}`} photo={photo} busy={uploadingSlot === `pastel-gallery-${index}`} onUpload={uploadPhoto} onMetaChange={(key, value) => update(["photos", "pastel", "gallery", index, key], value)} />
              ))}
            </div>
          </fieldset>

          <div className="content-admin-actions">
            <button type="button" className="is-secondary" onClick={saveDraft} disabled={busy || Boolean(uploadingSlot)}>임시 저장</button>
            <button type="button" onClick={publish} disabled={busy || dirty || !draftRevisionId || Boolean(uploadingSlot)}>이 초안을 공개</button>
          </div>
        </section>

        <aside className="content-admin-preview" aria-label="실제 모바일 미리보기">
          <div>
            <span>390px 실제 화면</span>
            <span>{previewStateLabel}</span>
          </div>
          <iframe ref={previewRef} title="파스텔 청첩장 미리보기" src="/?contentPreview=draft&capture=1" onLoad={() => previewRef.current?.contentWindow?.postMessage({ type: CONTENT_PREVIEW_MESSAGE_TYPE, document: editingDocument }, window.location.origin)} />
        </aside>
      </div>}
    </main>
  );
}
