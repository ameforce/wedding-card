import { ArrowClockwise, ArrowsOutSimple, CheckCircle, DeviceMobile, PencilSimple, Warning, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { weddingContent } from "../content.js";
import {
  buildPublishDiff,
  cloneContentDocument,
  createContentDocument,
  deriveEventDisplay,
  normalizeContentDocument,
  validateEditableContentDocument,
  validateMusicContent,
} from "./content-document.js";
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
import { AdminShell } from "./AdminShell.jsx";

function setAtPath(document, path, value) {
  const next = cloneContentDocument(document);
  let target = next;
  for (const key of path.slice(0, -1)) target = target[key];
  target[path.at(-1)] = value;
  return next;
}

function Field({ label, value, onChange, type = "text", hint, error, required = true, wide = false, maxLength }) {
  return (
    <label className={`content-admin-field ${wide ? "is-wide" : ""}`}>
      <span>{label}</span>
      <input type={type} value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} required={required} aria-invalid={error ? "true" : undefined} />
      {error ? <small className="is-error" role="alert">{error}</small> : hint && <small>{hint}</small>}
    </label>
  );
}

function CopyField({ label, lines, onChange, hint, error }) {
  return (
    <label className="content-admin-field is-wide">
      <span>{label}</span>
      <textarea rows={Math.max(3, lines.length)} value={lines.join("\n")} onChange={(event) => onChange(event.target.value.split("\n"))} aria-invalid={error ? "true" : undefined} />
      {error ? <small className="is-error" role="alert">{error}</small> : hint && <small>{hint}</small>}
    </label>
  );
}

function PhotoEditor({ title, slot, photo, onMetaChange, onUpload, busy, error }) {
  const [replacementAlt, setReplacementAlt] = useState("");
  const replacementReady = replacementAlt.trim().length > 0;
  return (
    <article className="content-admin-photo-card">
      <img src={photo.src} alt="" style={{ objectPosition: photo.position }} />
      <div>
        <strong>{title}</strong>
        <Field label="현재 사진 대체 텍스트" value={photo.alt} onChange={(value) => onMetaChange("alt", value)} />
        <Field
          label="새 사진 대체 텍스트"
          value={replacementAlt}
          onChange={setReplacementAlt}
          hint="사진을 교체할 때마다 새 사진에 맞는 설명을 다시 입력해야 합니다."
        />
        <label className={`content-admin-file ${replacementReady ? "" : "is-disabled"}`}>
          <span>{busy ? "이미지 처리 중…" : "사진 교체"}</span>
          <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || !replacementReady} onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file && await onUpload(slot, file, replacementAlt.trim())) setReplacementAlt("");
            event.target.value = "";
          }} />
        </label>
        <Field label="초점 위치" value={photo.position} onChange={(value) => onMetaChange("position", value)} error={error} hint="예: 50% 58%" />
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

function previewSelectorForPath(path) {
  if (path[0] === "photos") return path.includes("gallery") ? ".pastel-gallery-section" : ".pastel-hero";
  if (path[0] !== "content") return ".pastel-hero";
  return {
    couple: ".pastel-hero",
    hero: ".pastel-hero",
    event: ".pastel-schedule",
    venue: ".location-section",
    transit: ".location-section",
    message: ".greeting",
    story: ".pastel-story",
    music: ".music-control",
  }[path[1]] || ".pastel-hero";
}

function CollapsibleSection({ title, busy, children, attention = false }) {
  const detailsRef = useRef(null);
  useEffect(() => {
    if (attention && detailsRef.current) detailsRef.current.open = true;
  }, [attention]);
  return (
    <details ref={detailsRef} className="content-admin-section">
      <summary>{title}{attention && <span aria-label="확인이 필요한 항목" />}</summary>
      <fieldset disabled={busy}>{children}</fieldset>
    </details>
  );
}

function formatAdminTimestamp(value) {
  if (!value) return "방금 전";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value)).replaceAll(". ", "-").replace(".", "");
}

function useDialogFocus({ busy, onCancel }) {
  const dialogRef = useRef(null);
  const busyRef = useRef(busy);
  const cancelRef = useRef(onCancel);
  useEffect(() => {
    busyRef.current = busy;
    cancelRef.current = onCancel;
  }, [busy, onCancel]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])];
    (focusable()[0] || dialog)?.focus();
    const handleKeyDown = (event) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      opener?.focus();
    };
  }, []);
  return dialogRef;
}

export function deriveAdminWorkflowState({ dirty, draftRevisionId, busy, validationErrors }) {
  const errorCount = Object.keys(validationErrors || {}).length;
  return {
    label: dirty ? "미적용 변경" : draftRevisionId ? "초안" : "공개본",
    canApply: !busy && dirty && errorCount === 0,
    canReview: !busy && errorCount === 0,
    errorCount,
  };
}

function PublishReviewDialog({ diff, currentLabel, publishedLabel, dirty, busy, onCancel, onConfirm }) {
  const dialogRef = useDialogFocus({ busy, onCancel });
  return createPortal(
    <div className="admin-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section ref={dialogRef} className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-review-title" tabIndex="-1">
        <button type="button" className="admin-dialog-close" onClick={onCancel} disabled={busy} aria-label="게시 확인 닫기"><X aria-hidden="true" /></button>
        <h2 id="publish-review-title">게시 확인</h2>
        <p>게시를 진행하면 변경된 내용이 공개됩니다.</p>
        <strong>변경된 섹션 ({diff.sections.length})</strong>
        {diff.sections.length > 0 ? (
          <ul className="admin-dialog-sections">{diff.sections.map((section) => <li key={section}>{section}</li>)}</ul>
        ) : <p className="admin-dialog-empty">현재 공개본과 다른 내용이 없습니다.</p>}
        {diff.changes.length > 0 && (
          <div className="admin-diff-table" role="table" aria-label="게시 변경사항 비교">
            <div className="admin-diff-row is-header" role="row"><span role="columnheader" /><span role="columnheader">{currentLabel}</span><span role="columnheader">{publishedLabel}</span></div>
            {diff.changes.map((change) => (
              <div className="admin-diff-row" role="row" key={`${change.section}-${change.label}`}>
                <strong role="rowheader">{change.label}</strong>
                <span role="cell">{change.current}</span>
                <span role="cell">{change.published}</span>
              </div>
            ))}
          </div>
        )}
        <div className="admin-dialog-warning"><Warning aria-hidden="true" weight="fill" /><span>게시 후에는 이전 공개 버전이 이력으로 보존됩니다.{dirty ? " 미적용 변경사항은 자동으로 임시 적용한 뒤 게시합니다." : ""}</span></div>
        <div className="admin-dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>취소</button>
          <button type="button" className="is-primary" onClick={onConfirm} disabled={busy || diff.changes.length === 0}>{busy ? "게시 중…" : "게시하기"}</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function RepublishDialog({ version, busy, onCancel, onConfirm }) {
  const dialogRef = useDialogFocus({ busy, onCancel });
  return createPortal(
    <div className="admin-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section ref={dialogRef} className="admin-dialog is-compact" role="dialog" aria-modal="true" aria-labelledby="republish-title" tabIndex="-1">
        <button type="button" className="admin-dialog-close" onClick={onCancel} disabled={busy} aria-label="재공개 확인 닫기"><X aria-hidden="true" /></button>
        <h2 id="republish-title">이 버전을 다시 공개할까요?</h2>
        <p>선택한 {version.label}을 새 공개본으로 전환합니다. 현재 공개본은 이력에 안전하게 보존됩니다.</p>
        <div className="admin-dialog-warning"><Warning aria-hidden="true" weight="fill" /><span>과거 버전의 내용이 현재 콘텐츠를 대체합니다.</span></div>
        <div className="admin-dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>취소</button>
          <button type="button" className="is-primary" onClick={onConfirm} disabled={busy}>{busy ? "재공개 중…" : "다시 공개"}</button>
        </div>
      </section>
    </div>, document.body,
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
  const [publishedDocument, setPublishedDocument] = useState(() => createContentDocument(weddingContent));
  const [history, setHistory] = useState([]);
  const [lastUpdated, setLastUpdated] = useState("");
  const [status, setStatus] = useState({ tone: "neutral", message: "관리 콘텐츠를 불러오는 중입니다." });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(true);
  const [uploadingSlot, setUploadingSlot] = useState("");
  const [mediaUsage, setMediaUsage] = useState(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [publishReviewOpen, setPublishReviewOpen] = useState(false);
  const [republishTarget, setRepublishTarget] = useState(null);
  const [previewFocus, setPreviewFocus] = useState(".pastel-hero");
  const [previewExpanded, setPreviewExpanded] = useState(false);

  const showAdminError = useCallback((error, fallbackMessage) => {
    if (isAdminAuthRequiredError(error)) {
      setAuthRequired(true);
      setPublishReviewOpen(false);
      setRepublishTarget(null);
      setStatus({ tone: "error", message: "승인된 Google 계정으로 다시 로그인해 주세요." });
      return;
    }
    setStatus({ tone: "error", message: error.message || fallbackMessage });
  }, []);

  const load = useCallback(async ({ preserveEditingDocument = false } = {}) => {
    setBusy(true);
    try {
      const [state, usage] = await Promise.all([adapter.getAdminState(), adapter.getMediaUsage()]);
      const next = normalizeContentDocument(state.draft || state.published, weddingContent, { allowLocalPreview: localReview });
      if (!preserveEditingDocument) setEditingDocument(next);
      setDraftRevisionId(state.draftRevisionId || null);
      setPublishedRevisionId(state.publishedRevisionId || null);
      setPublishedDocument(normalizeContentDocument(state.published, weddingContent, { allowLocalPreview: localReview }));
      setHistory(Array.isArray(state.history) ? state.history : []);
      setLastUpdated(formatAdminTimestamp(state.draft?.createdAt || state.published?.publishedAt || new Date().toISOString()));
      if (!preserveEditingDocument) setDirty(false);
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

  const refreshAdminState = useCallback(() => {
    if (dirty && !window.confirm("미적용 변경사항을 버리고 저장된 초안을 다시 불러올까요?")) return;
    void load();
  }, [dirty, load]);

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

  useEffect(() => {
    const guard = (event) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  useEffect(() => {
    const focusPreview = () => {
      const previewDocument = previewRef.current?.contentDocument;
      if (!previewDocument) return;
      previewDocument.querySelectorAll(".is-admin-preview-focused").forEach((element) => element.classList.remove("is-admin-preview-focused"));
      const target = previewDocument.querySelector(previewFocus);
      if (!target) return;
      target.classList.add("is-admin-preview-focused");
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    };
    const timer = window.setTimeout(focusPreview, 120);
    return () => window.clearTimeout(timer);
  }, [editingDocument, previewFocus]);

  const update = (path, value) => {
    setEditingDocument((current) => {
      const next = setAtPath(current, path, value);
      if (path[0] === "content" && path[1] === "event" && ["isoDate", "startTime24h"].includes(path[2])) {
        const derived = deriveEventDisplay(next.content.event.isoDate, next.content.event.startTime24h);
        if (derived) Object.assign(next.content.event, derived);
      }
      return next;
    });
    setDirty(true);
    setPreviewFocus(previewSelectorForPath(path));
    setStatus({ tone: "neutral", message: "아직 저장하지 않은 변경사항이 있습니다." });
  };

  const saveDraft = async ({ quiet = false, keepBusy = false } = {}) => {
    const documentErrors = validateEditableContentDocument(editingDocument, { allowLocalPreview: localReview });
    if (Object.keys(documentErrors).length > 0) {
      setStatus({ tone: "error", message: Object.values(documentErrors)[0] });
      return null;
    }
    setBusy(true);
    try {
      const state = await adapter.saveDraft(editingDocument);
      setDraftRevisionId(state.draftRevisionId || null);
      if (state.publishedRevisionId) setPublishedRevisionId(state.publishedRevisionId);
      setEditingDocument(normalizeContentDocument(state.draft || editingDocument, weddingContent, { allowLocalPreview: localReview }));
      setDirty(false);
      if (!quiet) setStatus({ tone: "success", message: "임시 적용했습니다. 미리보기와 변경사항을 확인한 뒤 게시해 주세요." });
      setHistory((current) => [{
        id: state.draftRevisionId,
        status: "draft",
        createdAt: new Date().toISOString(),
        publishedAt: null,
      }, ...current.filter((item) => item.id !== state.draftRevisionId)
        .map((item) => item.status === "draft" ? { ...item, status: "archived" } : item)]);
      setLastUpdated(formatAdminTimestamp(new Date().toISOString()));
      return state.draftRevisionId;
    } catch (error) {
      showAdminError(error, "임시 적용하지 못했습니다.");
      return null;
    } finally {
      if (!keepBusy) setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    try {
      const revisionId = dirty ? await saveDraft({ quiet: true, keepBusy: true }) : draftRevisionId;
      if (!revisionId) return;
      await adapter.publish(revisionId);
      setPublishReviewOpen(false);
      await load();
      setStatus({
        tone: "success",
        message: localReview ? "로컬 공개본을 갱신했습니다. 실제 인터넷에는 배포되지 않았습니다." : "새 공개본을 반영했습니다.",
      });
    } catch (error) {
      if (error?.code === "STALE_DRAFT") {
        await load();
        setStatus({ tone: "error", message: "더 최신 초안이 확인되어 화면을 갱신했습니다. 변경사항을 다시 검토해 주세요." });
        setPublishReviewOpen(false);
        return;
      }
      showAdminError(error, "공개본을 반영하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const republish = async () => {
    if (!republishTarget) return;
    setBusy(true);
    try {
      const result = await adapter.republish(republishTarget.id, publishedRevisionId);
      setRepublishTarget(null);
      setPublishedRevisionId(result.revisionId || republishTarget.id);
      await load({ preserveEditingDocument: dirty });
      setStatus({ tone: "success", message: `${republishTarget.label}을 다시 공개했습니다.` });
    } catch (error) {
      if (error?.code === "STALE_PUBLISHED_REVISION") {
        setRepublishTarget(null);
        await load({ preserveEditingDocument: dirty });
        setStatus({ tone: "error", message: "다른 관리자가 공개본을 변경해 최신 상태를 불러왔습니다. 다시 선택해 주세요." });
        return;
      }
      showAdminError(error, "선택한 버전을 다시 공개하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const uploadPhoto = async (slot, file, replacementAlt) => {
    if (!replacementAlt.trim()) {
      setStatus({ tone: "error", message: "새 사진에 맞는 대체 텍스트를 먼저 입력해 주세요." });
      return false;
    }
    setUploadingSlot(slot);
    try {
      const isHero = slot === "pastel-hero";
      const index = isHero ? -1 : Number(slot.replace("pastel-gallery-", ""));
      const current = isHero ? editingDocument.photos.pastel.hero : editingDocument.photos.pastel.gallery[index];
      const result = await adapter.uploadPhoto({ slot, file, alt: replacementAlt.trim(), position: current.position });
      update(isHero ? ["photos", "pastel", "hero"] : ["photos", "pastel", "gallery", index], result.photo);
      setMediaUsage(result.usage || await adapter.getMediaUsage());
      setStatus({ tone: "success", message: "새 사진을 초안에 넣었습니다. 초점과 설명을 확인해 주세요." });
      return true;
    } catch (error) {
      showAdminError(error, "사진을 처리하지 못했습니다.");
      return false;
    } finally {
      setUploadingSlot("");
    }
  };

  const uploadAudio = async (file) => {
    const musicErrors = validateMusicContent(editingDocument.content.music, { allowLocalPreview: localReview });
    if (Object.keys(musicErrors).length > 0) {
      setStatus({ tone: "error", message: "곡 정보와 HTTPS 출처·라이선스 주소를 먼저 확인해 주세요." });
      return false;
    }
    setUploadingSlot("background-music");
    try {
      const result = await adapter.uploadAudio({ file });
      update(["content", "music", "src"], result.audio.src);
      setMediaUsage(result.usage || await adapter.getMediaUsage());
      setStatus({ tone: "success", message: "새 MP3와 곡 정보를 초안에 넣었습니다. 미리듣기 후 임시 적용해 주세요." });
      return true;
    } catch (error) {
      showAdminError(error, "배경 음악을 처리하지 못했습니다.");
      return false;
    } finally {
      setUploadingSlot("");
    }
  };

  const event = editingDocument.content.event;
  const venue = editingDocument.content.venue;
  const transit = editingDocument.content.transit;
  const music = editingDocument.content.music;
  const photos = editingDocument.photos.pastel;
  const musicErrors = validateMusicContent(music, { allowLocalPreview: localReview });
  const musicReady = Object.keys(musicErrors).length === 0;
  const validationErrors = validateEditableContentDocument(editingDocument, { allowLocalPreview: localReview });
  const publishDiff = buildPublishDiff(editingDocument, publishedDocument);
  const workflow = deriveAdminWorkflowState({ dirty, draftRevisionId, busy, validationErrors });
  const previewStateLabel = dirty ? "미적용 변경" : draftRevisionId ? "초안" : publishedRevisionId ? "공개본" : "저장 전";
  const versionHistory = history.length > 0 ? history : [
    ...(draftRevisionId ? [{ id: draftRevisionId, status: "draft", createdAt: new Date().toISOString(), publishedAt: null }] : []),
    ...(publishedRevisionId ? [{ id: publishedRevisionId, status: "published", createdAt: null, publishedAt: null }] : []),
  ];

  return (
    <AdminShell active="/admin" localReview={localReview} lastUpdated={lastUpdated} onRefresh={refreshAdminState}>
      <div className="admin-page content-admin-page">
      <header className="content-admin-header admin-page-heading">
        <div>
          <h1>콘텐츠 편집</h1>
          <div className="content-admin-badges" aria-label="편집 상태">
            <span className="is-draft"><i />{workflow.label}</span>
            <span><PencilSimple aria-hidden="true" />변경사항 {publishDiff.changes.length}개</span>
            {workflow.errorCount > 0 && <span className="is-error"><Warning aria-hidden="true" />입력 오류 {workflow.errorCount}개</span>}
          </div>
        </div>
        {!authRequired && <div className="content-admin-top-actions">
          <button type="button" onClick={() => void saveDraft()} disabled={!workflow.canApply || Boolean(uploadingSlot)}>임시 적용</button>
          <button type="button" className="is-primary" onClick={() => setPublishReviewOpen(true)} disabled={!workflow.canReview || Boolean(uploadingSlot) || publishDiff.changes.length === 0}>게시</button>
        </div>}
      </header>

      {authRequired ? <AdminReauthentication /> : <div className="content-admin-layout">
        <section className="content-admin-editor" aria-label="초대장 콘텐츠 편집">
          <p className={`content-admin-status is-${status.tone}`} role="status">{status.message}</p>
          {workflow.errorCount > 0 && (
            <section className="content-admin-validation-summary" role="alert" aria-label="입력 오류 요약">
              <strong>입력 오류 {workflow.errorCount}개를 확인해 주세요.</strong>
              <ul>{Object.entries(validationErrors).map(([field, message]) => <li key={field}><b>{field}</b><span>{message}</span></li>)}</ul>
            </section>
          )}

          <fieldset disabled={busy}>
            <legend>기본 정보</legend>
            <div className="content-admin-grid">
              <Field label="신랑 이름" value={editingDocument.content.couple.groom} maxLength={50} error={validationErrors["신랑 이름"]} onChange={(value) => update(["content", "couple", "groom"], value)} />
              <Field label="신부 이름" value={editingDocument.content.couple.bride} maxLength={50} error={validationErrors["신부 이름"]} onChange={(value) => update(["content", "couple", "bride"], value)} />
              <CopyField label="상단 인사" lines={editingDocument.content.hero.introLines} error={validationErrors["상단 인사"]} onChange={(value) => update(["content", "hero", "introLines"], value)} hint="줄바꿈 그대로 표시됩니다." />
            </div>
          </fieldset>

          <fieldset disabled={busy}>
            <legend>예식 정보</legend>
            <div className="content-admin-grid">
              <Field label="예식 날짜" type="date" value={event.isoDate} error={validationErrors["예식 일시"]} onChange={(value) => update(["content", "event", "isoDate"], value)} />
              <Field label="시작 시각" type="time" value={event.startTime24h} error={validationErrors["예식 일시"]} onChange={(value) => update(["content", "event", "startTime24h"], value)} />
              <p className="content-admin-derived is-wide"><CheckCircle aria-hidden="true" />공개 표기: {event.dateLabel} {event.day} · {event.time}</p>
              <div className="content-admin-venue-fields">
                <Field label="예식장" value={venue.name} error={validationErrors["예식장"]} onChange={(value) => update(["content", "venue", "name"], value)} />
                <Field label="층" value={venue.floor} error={validationErrors["층"]} onChange={(value) => update(["content", "venue", "floor"], value)} />
                <Field label="주소" wide value={venue.address} error={validationErrors["주소"]} onChange={(value) => update(["content", "venue", "address"], value)} />
              </div>
            </div>
          </fieldset>

          <CollapsibleSection title="초대 문구" busy={busy} attention={Boolean(validationErrors["인사말"] || validationErrors["우리의 이야기"])}>
            <div className="content-admin-grid">
              <CopyField label="인사말" lines={editingDocument.content.message} error={validationErrors["인사말"]} onChange={(value) => update(["content", "message"], value)} />
              <CopyField label="우리의 이야기" lines={editingDocument.content.story} error={validationErrors["우리의 이야기"]} onChange={(value) => update(["content", "story"], value)} />
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="교통과 주차" busy={busy}>
            <div className="content-admin-grid">
              <Field label="지하철" value={transit.subway} onChange={(value) => update(["content", "transit", "subway"], value)} />
              <Field label="셔틀" value={transit.shuttle} onChange={(value) => update(["content", "transit", "shuttle"], value)} />
              <Field label="주차" value={transit.parking} onChange={(value) => update(["content", "transit", "parking"], value)} />
              <Field label="주차 등록 위치" value={transit.parkingRegistrationLocation} onChange={(value) => update(["content", "transit", "parkingRegistrationLocation"], value)} />
              <Field label="주차 등록 안내" value={transit.parkingRegistration} onChange={(value) => update(["content", "transit", "parkingRegistration"], value)} />
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="배경 음악" busy={busy}>
            <div className="content-admin-storage" aria-live="polite">
              <div>
                <strong>미디어 저장 공간(사진·음악)</strong>
                <span>{mediaUsage?.localReview ? "로컬 검토에서는 Cloudflare 공간을 사용하지 않습니다." : `${formatStorage(mediaUsage?.usedBytes || 0)} / ${formatStorage(mediaUsage?.limitBytes || 0)}`}</span>
              </div>
              <progress max="100" value={mediaUsage?.percent || 0} aria-label="미디어 저장 공간 사용률" />
              <small>{mediaUsage?.localReview ? "production에서는 사진과 음악 합계가 2GB에 도달하면 추가 업로드가 자동으로 차단됩니다." : `사용률 ${mediaUsage?.percent || 0}% · 남은 공간 ${formatStorage(mediaUsage?.remainingBytes || 0)}`}</small>
            </div>
            <div className="content-admin-music-card">
              <div className="content-admin-grid">
                <Field label="곡명" value={music.title} error={musicErrors.title} onChange={(value) => update(["content", "music", "title"], value)} />
                <Field label="아티스트" value={music.artist} error={musicErrors.artist} onChange={(value) => update(["content", "music", "artist"], value)} />
                <Field label="출처 URL" wide type="url" value={music.sourceUrl} error={musicErrors.sourceUrl} onChange={(value) => update(["content", "music", "sourceUrl"], value)} hint="HTTPS 주소만 사용할 수 있습니다." />
                <Field label="라이선스명" value={music.licenseLabel} error={musicErrors.licenseLabel} onChange={(value) => update(["content", "music", "licenseLabel"], value)} />
                <Field label="라이선스 URL" wide type="url" value={music.licenseUrl} error={musicErrors.licenseUrl} onChange={(value) => update(["content", "music", "licenseUrl"], value)} hint="HTTPS 주소만 사용할 수 있습니다." />
              </div>
              <div className="content-admin-music-upload">
                <div>
                  <strong>현재 곡 미리듣기</strong>
                  <span>{music.title} · {music.artist}</span>
                </div>
                <audio key={music.src} className="content-admin-music-preview" controls preload="metadata" src={music.src} aria-label={`${music.title} 미리듣기`} />
                <label className={`content-admin-file ${musicReady ? "" : "is-disabled"}`}>
                  <span>{uploadingSlot === "background-music" ? "MP3 업로드 중…" : "MP3 교체"}</span>
                  <input type="file" accept="audio/mpeg,.mp3" disabled={Boolean(uploadingSlot) || !musicReady} onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (file) await uploadAudio(file);
                    event.target.value = "";
                  }} />
                </label>
                <small>MP3(audio/mpeg), 최대 25MB · 업로드만으로는 공개되지 않습니다.</small>
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="사진" busy={busy} attention={Boolean(uploadingSlot || validationErrors["사진"])}>
            <div className="content-admin-photo-list">
              <PhotoEditor title="상단 대표 사진" slot="pastel-hero" photo={photos.hero} busy={uploadingSlot === "pastel-hero"} error={validationErrors["상단 대표 사진 초점 위치"] || validationErrors["상단 대표 사진 대체 텍스트"] || validationErrors["상단 대표 사진 파일"]} onUpload={uploadPhoto} onMetaChange={(key, value) => update(["photos", "pastel", "hero", key], value)} />
              {photos.gallery.map((photo, index) => (
                <PhotoEditor key={`gallery-${index}`} title={`갤러리 ${index + 1}`} slot={`pastel-gallery-${index}`} photo={photo} busy={uploadingSlot === `pastel-gallery-${index}`} error={validationErrors[`갤러리 ${index + 1} 초점 위치`] || validationErrors[`갤러리 ${index + 1} 대체 텍스트`] || validationErrors[`갤러리 ${index + 1} 파일`]} onUpload={uploadPhoto} onMetaChange={(key, value) => update(["photos", "pastel", "gallery", index, key], value)} />
              ))}
            </div>
          </CollapsibleSection>

          <div className="content-admin-actions">
            <button type="button" className="is-secondary" onClick={() => void saveDraft()} disabled={!workflow.canApply || Boolean(uploadingSlot) || !musicReady}>임시 적용</button>
            <button type="button" onClick={() => setPublishReviewOpen(true)} disabled={!workflow.canReview || Boolean(uploadingSlot) || publishDiff.changes.length === 0}>게시</button>
          </div>
        </section>

        <aside className={`content-admin-preview ${previewExpanded ? "is-expanded" : ""}`} aria-label="공개 청첩장 미리보기">
          <div className="content-admin-preview-heading">
            <strong>공개 청첩장 미리보기</strong>
            <span>{previewStateLabel}</span>
            <button type="button" className="content-admin-preview-expand" onClick={() => setPreviewExpanded((current) => !current)} aria-label={previewExpanded ? "전체 미리보기 닫기" : "전체 미리보기 열기"}>
              {previewExpanded ? <X aria-hidden="true" /> : <ArrowsOutSimple aria-hidden="true" />}
            </button>
          </div>
          <div className="content-admin-preview-frame">
            <iframe ref={previewRef} title="파스텔 청첩장 390px 미리보기" width="390" src="/?contentPreview=draft&capture=1" onLoad={() => previewRef.current?.contentWindow?.postMessage({ type: CONTENT_PREVIEW_MESSAGE_TYPE, document: editingDocument }, window.location.origin)} />
          </div>
          <p><DeviceMobile aria-hidden="true" />모바일 미리보기 (390px 고정)</p>
        </aside>

        <aside className="content-admin-history" aria-label="콘텐츠 버전 기록">
          <h2>버전 기록</h2>
          <ol>
            {versionHistory.map((revision) => {
              const label = `리비전 ${revision.id.slice(0, 8)}`;
              const active = revision.id === draftRevisionId || revision.id === publishedRevisionId;
              const statusLabel = revision.status === "published" ? "공개 중"
                : revision.publishedAt ? "이전 공개"
                  : revision.status === "archived" ? "이전 초안" : "초안";
              return (
                <li key={revision.id} className={active ? "is-active" : ""}>
                  <span className="content-admin-history-marker" />
                  <div>
                    <div><strong>{label}</strong><em className={`is-${revision.status}`}>{statusLabel}</em></div>
                    <time dateTime={revision.publishedAt || revision.createdAt || ""}>{formatAdminTimestamp(revision.publishedAt || revision.createdAt)}</time>
                    <small>{revision.id === draftRevisionId ? "현재 작업" : revision.id === publishedRevisionId ? "현재 공개 버전" : revision.publishedAt ? "이 버전으로 공개됨" : revision.status === "archived" ? "이전 임시 적용" : "임시 적용"}</small>
                    {revision.publishedAt && ![draftRevisionId, publishedRevisionId].includes(revision.id) && (
                      <button type="button" onClick={() => setRepublishTarget({ id: revision.id, label })}><ArrowClockwise aria-hidden="true" />이 버전을 다시 공개</button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </aside>
      </div>}

      {!authRequired && publishReviewOpen && <PublishReviewDialog diff={publishDiff} currentLabel={draftRevisionId && !dirty ? "현재 초안" : "현재 편집"} publishedLabel="현재 공개" dirty={dirty} busy={busy} onCancel={() => setPublishReviewOpen(false)} onConfirm={() => void publish()} />}
      {!authRequired && republishTarget && <RepublishDialog version={republishTarget} busy={busy} onCancel={() => setRepublishTarget(null)} onConfirm={() => void republish()} />}
      </div>
    </AdminShell>
  );
}
