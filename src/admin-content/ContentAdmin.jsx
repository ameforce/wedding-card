import { ArrowClockwise, ArrowDown, ArrowUp, ArrowsOutSimple, CheckCircle, DeviceMobile, MusicNotes, PencilSimple, Plus, Trash, Warning, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { weddingContent } from "../content.js";
import {
  ACCOUNT_SIDE_LABELS,
  ACCOUNT_SIDES,
  MAX_ACCOUNT_ENTRIES,
  MIN_GALLERY_PHOTOS,
  REQUIRED_COPY_LINES,
  buildPublishDiff,
  cloneContentDocument,
  contentDocumentsEqual,
  createContentDocument,
  deriveEventDisplay,
  normalizeContentDocument,
  removeEditableCopyLine,
  updateRequiredCopyLine,
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

function Field({ label, value, onChange, type = "text", hint, error, required = true, wide = false, maxLength, inputMode }) {
  return (
    <label className={`content-admin-field ${wide ? "is-wide" : ""}`}>
      <span>{label}</span>
      <input type={type} inputMode={inputMode} value={value ?? ""} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} required={required} aria-invalid={error ? "true" : undefined} />
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

function FourLineCopyField({ label, lines, onChange, error }) {
  const errorId = useId();
  const displayedLines = Array.from({ length: REQUIRED_COPY_LINES }, (_, index) => typeof lines?.[index] === "string" ? lines[index] : "");
  const overflowLines = Array.isArray(lines) ? lines.slice(REQUIRED_COPY_LINES) : [];
  return (
    <fieldset className="content-admin-copy-lines" aria-invalid={error ? "true" : undefined} aria-describedby={error ? errorId : undefined}>
      <legend>{label}</legend>
      {displayedLines.map((line, index) => (
        <Field key={index} label={`${index + 1}번째 줄`} value={line} maxLength={240} onChange={(value) => onChange(updateRequiredCopyLine(lines, index, value))} error={!line.trim() ? `${index + 1}번째 줄을 입력해 주세요.` : line.length > 240 ? `${index + 1}번째 줄은 240자 이내로 입력해 주세요.` : undefined} />
      ))}
      {overflowLines.length > 0 && (
        <div className="content-admin-copy-overflow" aria-label={`${label} 추가 줄`}>
          {overflowLines.map((line, offset) => {
            const sourceIndex = REQUIRED_COPY_LINES + offset;
            return (
              <div key={sourceIndex}>
                <span><strong>{sourceIndex + 1}번째 줄</strong> {String(line)}</span>
                <button type="button" onClick={() => onChange(removeEditableCopyLine(lines, sourceIndex))}>{sourceIndex + 1}번째 줄 삭제</button>
              </div>
            );
          })}
        </div>
      )}
      {error && <small id={errorId} className="is-error" role="alert">{lines?.length !== REQUIRED_COPY_LINES ? `기존 문구가 ${lines?.length ?? 0}줄입니다. ${overflowLines.length ? "추가 줄을 확인하고 명시적으로 삭제해 주세요." : "비어 있는 줄을 직접 입력해 주세요."}` : error}</small>}
    </fieldset>
  );
}

function UploadProgress({ progress }) {
  const percent = progress.phase === "upload" && progress.total > 0
    ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
    : null;
  const label = progress.count > 1 ? `${progress.index}/${progress.count} · ${progress.fileName}` : progress.fileName;
  const phaseText = progress.phase === "optimize" ? "이미지 처리 중…" : progress.phase === "prepare" ? "파일 준비 중…" : "업로드 중…";
  return (
    <div className="content-admin-upload-progress">
      <span role="status">{label} · {phaseText}</span>
      <progress max="100" value={percent ?? undefined} aria-label="업로드 진행률" />
      <span aria-hidden="true">{percent === null ? "" : `${percent}%`}</span>
    </div>
  );
}

function PhotoEditor({ title, slot, photo, onMetaChange, onUpload, busy, fileError, altError, positionError, actions, progress }) {
  return (
    <article className="content-admin-photo-card">
      <img src={photo.src} alt="" style={{ objectPosition: photo.position }} />
      <div>
        <div className="content-admin-photo-heading">
          <strong>{title}</strong>
          {actions}
        </div>
        <Field label="현재 사진 대체 텍스트" value={photo.alt} onChange={(value) => onMetaChange("alt", value)} error={altError} hint="사진을 교체하면 설명이 비워집니다. 임시 적용 전에 새 사진에 맞는 설명을 입력해 주세요." />
        <label className={`content-admin-file ${busy ? "is-disabled" : ""}`}>
          <span>{busy ? "업로드 중…" : "사진 교체"}</span>
          <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} aria-invalid={fileError ? "true" : undefined} onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) await onUpload(slot, file);
            event.target.value = "";
          }} />
        </label>
        {progress && <UploadProgress progress={progress} />}
        {fileError && <small className="is-error" role="alert">{fileError}</small>}
        <Field label="초점 위치" value={photo.position} onChange={(value) => onMetaChange("position", value)} error={positionError} hint="예: 50% 58%" />
      </div>
    </article>
  );
}

function GalleryPhotoUploader({ onUpload, busy, disabled, progress }) {
  const [position, setPosition] = useState("50% 50%");
  const positionMatch = position.trim().match(/^(\d{1,3})%\s+(\d{1,3})%$/);
  const ready = Boolean(positionMatch)
    && Number(positionMatch?.[1]) <= 100
    && Number(positionMatch?.[2]) <= 100;
  return (
    <section className="content-admin-gallery-add">
      <strong>갤러리 사진 추가</strong>
      <p>실제 승인된 사진을 한 번에 여러 장 업로드할 수 있습니다. 성공한 사진은 목록 끝에 추가되며, 임시 적용 전에 각 사진의 대체 텍스트를 입력해 주세요.</p>
      <div className="content-admin-grid">
        <Field label="초점 위치" value={position} onChange={setPosition} hint="예: 50% 50% · 선택한 사진 모두에 적용되며 나중에 사진별로 바꿀 수 있습니다." />
      </div>
      <label className={`content-admin-file ${ready && !disabled ? "" : "is-disabled"}`}>
        <span>{busy ? "업로드 중…" : "사진 선택 및 추가"}</span>
        <input type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={busy || disabled || !ready} onChange={async (event) => {
          const files = [...(event.target.files || [])];
          if (files.length > 0) await onUpload(files, position.trim());
          event.target.value = "";
        }} />
      </label>
      {progress && <UploadProgress progress={progress} />}
    </section>
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
    accounts: ".account-groups",
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
    canApply: !busy && dirty,
    canReview: !busy,
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

function MediaDeleteDialog({ media, dependentRevisions, error, busy, onCancel, onConfirm }) {
  const dialogRef = useDialogFocus({ busy, onCancel });
  const cascade = dependentRevisions.length > 0;
  return createPortal(
    <div className="admin-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section ref={dialogRef} className="admin-dialog is-compact" role="dialog" aria-modal="true" aria-labelledby="media-delete-title" tabIndex="-1">
        <button type="button" className="admin-dialog-close" onClick={onCancel} disabled={busy} aria-label="미디어 삭제 확인 닫기"><X aria-hidden="true" /></button>
        <h2 id="media-delete-title">{media.deletionPending ? "저장소 삭제를 다시 시도할까요?" : "저장된 미디어를 삭제할까요?"}</h2>
        {media.deletionPending
          ? <p>초안과 과거 리비전에서는 분리했지만 저장소 파일 정리가 끝나지 않았습니다. 다시 시도하면 파일을 정리하고 저장 공간을 회수합니다.</p>
          : <p>선택한 {media.kind === "audio" ? "음악" : "사진"} 파일({formatStorage(media.totalBytes || 0)})을 저장소에서 영구 삭제하고 저장 공간을 회수합니다.</p>}
        {media.references?.draft && <p>현재 초안이 이 미디어를 사용 중입니다. 삭제하면 초안의 해당 항목이 자동으로 제거됩니다.</p>}
        {cascade && (
          <>
            <p>아래 과거 리비전 {dependentRevisions.length}개가 이 미디어를 참조합니다. 삭제하면 해당 리비전도 함께 영구 삭제됩니다.</p>
            <ul className="admin-dialog-sections">
              {dependentRevisions.map((revision) => (
                <li key={revision.id}>{revision.publishedAt ? "이전 공개본" : "이전 초안"} · {formatAdminTimestamp(revision.publishedAt || revision.createdAt)} · {revision.id.slice(0, 8)}</li>
              ))}
            </ul>
          </>
        )}
        <div className="admin-dialog-warning"><Warning aria-hidden="true" weight="fill" /><span>{media.deletionPending ? "삭제가 완료될 때까지 이 미디어의 저장 공간은 계속 예약됩니다." : "삭제된 파일과 리비전은 복구할 수 없습니다."}</span></div>
        {error ? <p className="is-error" role="alert">{error}</p> : null}
        <div className="admin-dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>취소</button>
          <button type="button" className="is-destructive" onClick={onConfirm} disabled={busy}>{busy ? "삭제 중…" : media.deletionPending ? "삭제 재시도" : cascade ? "리비전과 함께 삭제" : "영구 삭제"}</button>
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
  const [appliedDocument, setAppliedDocument] = useState(() => createContentDocument(weddingContent));
  const documentRef = useRef(editingDocument);
  const [draftRevisionId, setDraftRevisionId] = useState(null);
  const [publishedRevisionId, setPublishedRevisionId] = useState(null);
  const [publishedDocument, setPublishedDocument] = useState(() => createContentDocument(weddingContent));
  const [history, setHistory] = useState([]);
  const [lastUpdated, setLastUpdated] = useState("");
  const [status, setStatus] = useState({ tone: "neutral", message: "관리 콘텐츠를 불러오는 중입니다." });
  const [busy, setBusy] = useState(true);
  const [uploadingSlot, setUploadingSlot] = useState("");
  const [uploadProgress, setUploadProgress] = useState(null);
  const [mediaUsage, setMediaUsage] = useState(null);
  const [mediaList, setMediaList] = useState([]);
  const [mediaDeleteTarget, setMediaDeleteTarget] = useState(null);
  const [deletingMediaId, setDeletingMediaId] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [publishReviewOpen, setPublishReviewOpen] = useState(false);
  const [republishTarget, setRepublishTarget] = useState(null);
  const [showValidationSummary, setShowValidationSummary] = useState(false);
  const [previewFocus, setPreviewFocus] = useState(".pastel-hero");
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const dirty = useMemo(
    () => !contentDocumentsEqual(editingDocument, appliedDocument),
    [editingDocument, appliedDocument],
  );

  const showAdminError = useCallback((error, fallbackMessage) => {
    if (isAdminAuthRequiredError(error)) {
      setAuthRequired(true);
      setPublishReviewOpen(false);
      setRepublishTarget(null);
      setMediaDeleteTarget(null);
      setStatus({ tone: "error", message: "승인된 Google 계정으로 다시 로그인해 주세요." });
      return;
    }
    setStatus({ tone: "error", message: error.message || fallbackMessage });
  }, []);

  const load = useCallback(async ({ preserveEditingDocument = false } = {}) => {
    setBusy(true);
    try {
      const [state, usage, mediaListPayload] = await Promise.all([adapter.getAdminState(), adapter.getMediaUsage(), adapter.getMediaList()]);
      setMediaList(Array.isArray(mediaListPayload?.media) ? mediaListPayload.media : []);
      const next = normalizeContentDocument(state.draft || state.published, weddingContent, { allowLocalPreview: localReview });
      if (!preserveEditingDocument) setEditingDocument(next);
      setAppliedDocument(next);
      setDraftRevisionId(state.draftRevisionId || null);
      setPublishedRevisionId(state.publishedRevisionId || null);
      setPublishedDocument(normalizeContentDocument(state.published, weddingContent, { allowLocalPreview: localReview }));
      setHistory(Array.isArray(state.history) ? state.history : []);
      setLastUpdated(formatAdminTimestamp(state.draft?.createdAt || state.published?.publishedAt || new Date().toISOString()));
      setMediaUsage(usage);
      setAuthRequired(false);
      setShowValidationSummary(false);
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
    if (uploadingSlot) {
      setStatus({ tone: "error", message: "업로드가 진행 중입니다. 업로드가 끝난 뒤 새로고침해 주세요." });
      return;
    }
    if (dirty && !window.confirm("미적용 변경사항을 버리고 저장된 초안을 다시 불러올까요?")) return;
    void load();
  }, [dirty, load, uploadingSlot]);

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
      const view = previewDocument.defaultView;
      const scroller = previewDocument.scrollingElement || previewDocument.documentElement;
      const top = target.getBoundingClientRect().top + scroller.scrollTop - (view.innerHeight - target.offsetHeight) / 2;
      scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    };
    const timer = window.setTimeout(focusPreview, 120);
    return () => window.clearTimeout(timer);
  }, [editingDocument, previewFocus]);

  const commitEdit = (next, focusSelector) => {
    documentRef.current = next;
    setEditingDocument(next);
    setStatus(contentDocumentsEqual(next, appliedDocument)
      ? { tone: "success", message: "현재 내용은 마지막 임시 적용본과 같습니다." }
      : { tone: "neutral", message: "아직 적용하지 않은 변경사항이 있습니다." });
    setPreviewFocus(focusSelector);
  };

  const update = (path, value) => {
    const next = setAtPath(documentRef.current, path, value);
    if (path[0] === "content" && path[1] === "event" && ["isoDate", "startTime24h"].includes(path[2])) {
      const derived = deriveEventDisplay(next.content.event.isoDate, next.content.event.startTime24h);
      if (derived) Object.assign(next.content.event, derived);
    }
    commitEdit(next, previewSelectorForPath(path));
  };

  const addAccount = (side) => {
    const current = documentRef.current.content.accounts;
    if (Object.keys(current).length >= MAX_ACCOUNT_ENTRIES) return;
    let index = 1;
    let key = `extra-${index}`;
    while (current[key]) key = `extra-${index += 1}`;
    const next = cloneContentDocument(documentRef.current);
    next.content.accounts[key] = { key, side, bank: "", number: "", holder: "" };
    commitEdit(next, ".account-groups");
  };

  const removeAccount = (key) => {
    const next = cloneContentDocument(documentRef.current);
    delete next.content.accounts[key];
    commitEdit(next, ".account-groups");
  };

  const moveGalleryPhoto = (index, direction) => {
    if (uploadingSlot) return;
    const targetIndex = index + direction;
    const gallery = documentRef.current.photos.pastel.gallery;
    if (targetIndex < 0 || targetIndex >= gallery.length) return;
    const next = cloneContentDocument(documentRef.current);
    [next.photos.pastel.gallery[index], next.photos.pastel.gallery[targetIndex]] = [next.photos.pastel.gallery[targetIndex], next.photos.pastel.gallery[index]];
    commitEdit(next, ".pastel-gallery-section");
  };

  const removeGalleryPhoto = (index) => {
    if (uploadingSlot || documentRef.current.photos.pastel.gallery.length <= MIN_GALLERY_PHOTOS) return;
    const next = cloneContentDocument(documentRef.current);
    next.photos.pastel.gallery.splice(index, 1);
    commitEdit(next, ".pastel-gallery-section");
  };

  const saveDraft = async ({ quiet = false, keepBusy = false } = {}) => {
    const documentErrors = validateEditableContentDocument(editingDocument, { allowLocalPreview: localReview });
    if (Object.keys(documentErrors).length > 0) {
      setShowValidationSummary(true);
      setStatus({ tone: "error", message: Object.values(documentErrors)[0] });
      return null;
    }
    setBusy(true);
    try {
      const state = await adapter.saveDraft(editingDocument);
      setDraftRevisionId(state.draftRevisionId || null);
      if (state.publishedRevisionId) setPublishedRevisionId(state.publishedRevisionId);
      const applied = normalizeContentDocument(state.draft || editingDocument, weddingContent, { allowLocalPreview: localReview });
      setEditingDocument(applied);
      setAppliedDocument(applied);
      setShowValidationSummary(false);
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
    if (uploadingSlot) {
      setRepublishTarget(null);
      setStatus({ tone: "error", message: "업로드가 진행 중입니다. 업로드가 끝난 뒤 다시 공개해 주세요." });
      return;
    }
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

  const refreshMediaList = useCallback(async () => {
    try {
      const payload = await adapter.getMediaList();
      setMediaList(Array.isArray(payload?.media) ? payload.media : []);
      if (payload?.usage) setMediaUsage(payload.usage);
      return payload;
    } catch {
      return null;
    }
  }, [adapter]);

  const requestDeleteMedia = async (item) => {
    if (dirty && JSON.stringify(editingDocument).toLowerCase().includes(`invitation/${item.mediaId}/`)) {
      setStatus({ tone: "error", message: "미적용 변경사항이 이 미디어를 참조하고 있습니다. 임시 적용하거나 새로고침한 뒤 삭제해 주세요." });
      return;
    }
    const fresh = await refreshMediaList();
    const current = fresh?.media?.find((entry) => entry.mediaId === item.mediaId) || item;
    setMediaDeleteTarget({ media: current, dependentRevisions: current.references?.archivedRevisions || [], error: "" });
  };

  const confirmDeleteMedia = async () => {
    const target = mediaDeleteTarget;
    if (!target) return;
    setDeletingMediaId(target.media.mediaId);
    try {
      const result = await adapter.deleteMedia(target.media.mediaId, { deleteRevisions: target.dependentRevisions.length > 0 });
      setMediaDeleteTarget(null);
      const listPayload = await refreshMediaList();
      if (!listPayload?.usage) setMediaUsage(result.usage || await adapter.getMediaUsage());
      await load({ preserveEditingDocument: dirty });
      setStatus({
        tone: "success",
        message: `미디어를 삭제하고 ${formatStorage(result.freedBytes || 0)}의 공간을 회수했습니다.${result.removedFromDraft > 0 ? " 초안의 해당 항목도 제거했습니다." : ""}${Array.isArray(result.deletedRevisions) && result.deletedRevisions.length > 0 ? ` 과거 리비전 ${result.deletedRevisions.length}개를 함께 삭제했습니다.` : ""}${result.objectsDeleted === false ? " 단, 저장소 객체 일부를 정리하지 못했습니다." : ""}`,
      });
    } catch (error) {
      if (error?.code === "MEDIA_REFERENCED" && Array.isArray(error.dependentRevisions)) {
        setMediaDeleteTarget((current) => current && { ...current, dependentRevisions: error.dependentRevisions, error: error.message || "" });
        return;
      }
      if (error?.code === "MEDIA_DELETE_PENDING") {
        const refreshed = await refreshMediaList();
        const pendingMedia = refreshed?.media?.find((item) => item.mediaId === target.media.mediaId);
        setMediaDeleteTarget((current) => current && {
          ...current,
          media: { ...current.media, ...pendingMedia, deletionPending: true },
          dependentRevisions: [],
          error: error.message || "저장소 삭제를 완료하지 못했습니다. 다시 시도해 주세요.",
        });
        return;
      }
      if (isAdminAuthRequiredError(error)) {
        setMediaDeleteTarget(null);
        showAdminError(error, "미디어를 삭제하지 못했습니다.");
        return;
      }
      setMediaDeleteTarget((current) => current && { ...current, error: error?.message || "미디어를 삭제하지 못했습니다." });
    } finally {
      setDeletingMediaId("");
    }
  };

  const uploadPhoto = async (slot, file) => {
    const isHero = slot === "pastel-hero";
    const index = isHero ? -1 : Number(slot.replace("pastel-gallery-", ""));
    const current = isHero ? documentRef.current.photos.pastel.hero : documentRef.current.photos.pastel.gallery[index];
    setUploadingSlot(slot);
    setUploadProgress({ slot, index: 1, count: 1, fileName: file.name, phase: "optimize", loaded: 0, total: 0 });
    try {
      const result = await adapter.uploadPhoto({
        slot,
        file,
        alt: "",
        position: current?.position,
        onProgress: (event) => setUploadProgress((state) => state ? { ...state, ...event } : state),
      });
      update(isHero ? ["photos", "pastel", "hero"] : ["photos", "pastel", "gallery", index], result.photo);
      setMediaUsage(result.usage || await adapter.getMediaUsage());
      await refreshMediaList();
      setStatus({ tone: "success", message: "새 사진을 초안에 넣었습니다. 새 사진에 맞는 대체 텍스트와 초점을 확인해 주세요." });
      return true;
    } catch (error) {
      showAdminError(error, "사진을 처리하지 못했습니다.");
      return false;
    } finally {
      setUploadingSlot("");
      setUploadProgress(null);
    }
  };

  const uploadGalleryPhotos = async (files, position) => {
    setUploadingSlot("pastel-gallery-new");
    let succeeded = 0;
    let skipped = 0;
    let remainingBytes = mediaUsage?.localReview ? null : mediaUsage?.remainingBytes ?? null;
    const failures = [];
    try {
      for (const [index, file] of files.entries()) {
        if (remainingBytes !== null && file.size > remainingBytes) {
          skipped = files.length - index;
          break;
        }
        setUploadProgress({ slot: "pastel-gallery-new", index: index + 1, count: files.length, fileName: file.name, phase: "optimize", loaded: 0, total: 0 });
        try {
          const result = await adapter.uploadPhoto({
            slot: "pastel-gallery-new",
            file,
            alt: "",
            position,
            onProgress: (event) => setUploadProgress((state) => state ? { ...state, ...event } : state),
          });
          const next = cloneContentDocument(documentRef.current);
          next.photos.pastel.gallery.push(result.photo);
          commitEdit(next, ".pastel-gallery-section");
          const usage = result.usage || await adapter.getMediaUsage();
          setMediaUsage(usage);
          remainingBytes = usage?.localReview ? null : usage?.remainingBytes ?? remainingBytes;
          succeeded += 1;
        } catch (error) {
          if (isAdminAuthRequiredError(error)) {
            showAdminError(error, "사진을 처리하지 못했습니다.");
            return;
          }
          failures.push(`${file.name}: ${error?.message || "업로드하지 못했습니다."}`);
          if (error?.status === 507 || error?.code === "MEDIA_STORAGE_LIMIT") {
            skipped = files.length - index - 1;
            break;
          }
        }
      }
    } finally {
      setUploadingSlot("");
      setUploadProgress(null);
    }
    await refreshMediaList();
    const skippedNote = skipped > 0 ? ` 저장 공간이 부족해 나머지 ${skipped}장은 올리지 않았습니다.` : "";
    const failureNote = failures.length > 0 ? ` ${failures.join(" · ")}` : "";
    if (failures.length === 0 && skipped === 0) {
      setStatus({ tone: "success", message: `${succeeded}장의 사진을 초안에 넣었습니다. 각 사진의 대체 텍스트와 초점을 확인해 주세요.` });
    } else if (succeeded > 0) {
      const failureCount = failures.length > 0 ? ` ${failures.length}장은 실패했습니다.` : "";
      setStatus({ tone: "error", message: `${succeeded}장은 추가했습니다.${failureCount}${skippedNote}${failureNote}` });
    } else {
      setStatus({ tone: "error", message: `사진을 업로드하지 못했습니다.${skippedNote}${failureNote}` });
    }
  };

  const uploadAudio = async (file) => {
    const musicErrors = validateMusicContent(editingDocument.content.music, { allowLocalPreview: localReview });
    if (Object.keys(musicErrors).length > 0) {
      setStatus({ tone: "error", message: "곡 정보와 HTTPS 출처·라이선스 주소를 먼저 확인해 주세요." });
      return false;
    }
    setUploadingSlot("background-music");
    setUploadProgress({ slot: "background-music", index: 1, count: 1, fileName: file.name, phase: "prepare", loaded: 0, total: 0 });
    try {
      const result = await adapter.uploadAudio({
        file,
        onProgress: (event) => setUploadProgress((state) => state ? { ...state, ...event } : state),
      });
      update(["content", "music", "src"], result.audio.src);
      setMediaUsage(result.usage || await adapter.getMediaUsage());
      await refreshMediaList();
      setStatus({ tone: "success", message: "새 음악과 곡 정보를 초안에 넣었습니다. 미리듣기 후 임시 적용해 주세요." });
      return true;
    } catch (error) {
      showAdminError(error, "배경 음악을 처리하지 못했습니다.");
      return false;
    } finally {
      setUploadingSlot("");
      setUploadProgress(null);
    }
  };

  const event = editingDocument.content.event;
  const venue = editingDocument.content.venue;
  const transit = editingDocument.content.transit;
  const accounts = editingDocument.content.accounts;
  const music = editingDocument.content.music;
  const photos = editingDocument.photos.pastel;
  const musicErrors = validateMusicContent(music, { allowLocalPreview: localReview });
  const musicReady = Object.keys(musicErrors).length === 0;
  const validationErrors = validateEditableContentDocument(editingDocument, { allowLocalPreview: localReview });
  const unappliedDiff = buildPublishDiff(editingDocument, appliedDocument);
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
            <span><PencilSimple aria-hidden="true" />미적용 변경 {unappliedDiff.changes.length}개</span>
            {showValidationSummary && workflow.errorCount > 0 && <span className="is-error"><Warning aria-hidden="true" />입력 오류 {workflow.errorCount}개</span>}
          </div>
        </div>
        {!authRequired && <div className="content-admin-top-actions">
          <button type="button" onClick={() => void saveDraft()} disabled={!workflow.canApply || Boolean(uploadingSlot)}>임시 적용</button>
          <button type="button" className="is-primary" onClick={() => {
            if (workflow.errorCount > 0) {
              setShowValidationSummary(true);
              setStatus({ tone: "error", message: Object.values(validationErrors)[0] });
              return;
            }
            setPublishReviewOpen(true);
          }} disabled={!workflow.canReview || Boolean(uploadingSlot) || publishDiff.changes.length === 0}>게시</button>
        </div>}
      </header>

      {authRequired ? <AdminReauthentication /> : <div className="content-admin-layout">
        <section className="content-admin-editor" aria-label="초대장 콘텐츠 편집">
          <p className={`content-admin-status is-${status.tone}`} role="status">{status.message}</p>
          {showValidationSummary && workflow.errorCount > 0 && (
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
            <div className="content-admin-copy-groups">
              <FourLineCopyField label="인사말" lines={editingDocument.content.message} error={validationErrors["인사말"]} onChange={(value) => update(["content", "message"], value)} />
              <FourLineCopyField label="우리의 이야기" lines={editingDocument.content.story} error={validationErrors["우리의 이야기"]} onChange={(value) => update(["content", "story"], value)} />
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

          <CollapsibleSection title="계좌 정보" busy={busy} attention={Object.keys(validationErrors).some((key) => key.includes("계좌") || key.includes("은행") || key.includes("예금주") || key.includes("소속"))}>
            <div className="content-admin-account-groups">
              {ACCOUNT_SIDES.map((side) => {
                const account = accounts[side];
                const sideLabel = ACCOUNT_SIDE_LABELS[side];
                const sideExtras = Object.entries(accounts).filter(([key, entry]) =>
                  !ACCOUNT_SIDES.includes(key) && (ACCOUNT_SIDES.includes(entry?.side) ? entry.side : "groom") === side);
                return (
                  <section className="content-admin-account-side" key={side}>
                    <strong className="content-admin-account-side-title">{sideLabel} 계좌</strong>
                    <section className="content-admin-account-group">
                      <div className="content-admin-account-heading">
                        <strong>기본 계좌</strong>
                        <span className="content-admin-account-fixed">고정</span>
                      </div>
                      <div className="content-admin-grid">
                        <Field label="은행" value={account.bank} maxLength={80} error={validationErrors[`${sideLabel} 은행`]} onChange={(value) => update(["content", "accounts", side, "bank"], value)} />
                        <Field label="예금주" value={account.holder} maxLength={50} error={validationErrors[`${sideLabel} 예금주`]} onChange={(value) => update(["content", "accounts", side, "holder"], value)} />
                        <Field label="계좌번호" wide inputMode="numeric" value={account.number} maxLength={60} error={validationErrors[`${sideLabel} 계좌번호`]} onChange={(value) => update(["content", "accounts", side, "number"], value)} hint="숫자와 하이픈(-)만 입력해 주세요. 예: 123-45-67890" />
                      </div>
                    </section>
                    {sideExtras.map(([key, extra], index) => {
                      const label = `${sideLabel} 추가 계좌 ${index + 1}`;
                      return (
                        <section className="content-admin-account-group" key={key}>
                          <div className="content-admin-account-heading">
                            <strong>추가 계좌 {index + 1}</strong>
                            <button type="button" className="content-admin-account-remove" onClick={() => removeAccount(key)} aria-label={`${label} 삭제`}>
                              <Trash aria-hidden="true" weight="light" /> 삭제
                            </button>
                          </div>
                          <div className="content-admin-grid">
                            <label className="content-admin-field">
                              <span>소속</span>
                              <select value={ACCOUNT_SIDES.includes(extra.side) ? extra.side : side} onChange={(event) => update(["content", "accounts", key, "side"], event.target.value)} aria-invalid={validationErrors[`${label} 소속`] ? "true" : undefined}>
                                {ACCOUNT_SIDES.map((option) => <option key={option} value={option}>{ACCOUNT_SIDE_LABELS[option]}</option>)}
                              </select>
                              {validationErrors[`${label} 소속`] && <small className="is-error" role="alert">{validationErrors[`${label} 소속`]}</small>}
                            </label>
                            <Field label="은행" value={extra.bank} maxLength={80} error={validationErrors[`${label} 은행`]} onChange={(value) => update(["content", "accounts", key, "bank"], value)} />
                            <Field label="예금주" value={extra.holder} maxLength={50} error={validationErrors[`${label} 예금주`]} onChange={(value) => update(["content", "accounts", key, "holder"], value)} />
                            <Field label="계좌번호" wide inputMode="numeric" value={extra.number} maxLength={60} error={validationErrors[`${label} 계좌번호`]} onChange={(value) => update(["content", "accounts", key, "number"], value)} hint="숫자와 하이픈(-)만 입력해 주세요. 예: 123-45-67890" />
                          </div>
                        </section>
                      );
                    })}
                    <button type="button" className="content-admin-account-add" onClick={() => addAccount(side)} disabled={Object.keys(accounts).length >= MAX_ACCOUNT_ENTRIES}>
                      <Plus aria-hidden="true" weight="light" /> {sideLabel} 계좌 추가
                    </button>
                  </section>
                );
              })}
            </div>
          </CollapsibleSection>

          <CollapsibleSection title="배경 음악" busy={busy}>
            <div className="content-admin-music-card">
              <div className="content-admin-grid">
                <Field label="곡명" value={music.title} error={musicErrors.title} onChange={(value) => update(["content", "music", "title"], value)} />
                <Field label="아티스트" value={music.artist} error={musicErrors.artist} onChange={(value) => update(["content", "music", "artist"], value)} />
                <Field label="출처 URL" wide type="url" value={music.sourceUrl} error={musicErrors.sourceUrl} onChange={(value) => update(["content", "music", "sourceUrl"], value)} hint="HTTPS 주소만 사용할 수 있습니다." />
                <Field label="라이선스명" value={music.licenseLabel} error={musicErrors.licenseLabel} onChange={(value) => update(["content", "music", "licenseLabel"], value)} />
                <Field label="라이선스 URL" wide type="url" value={music.licenseUrl} error={musicErrors.licenseUrl} onChange={(value) => update(["content", "music", "licenseUrl"], value)} hint="HTTPS 주소만 사용할 수 있습니다." />
              </div>
              <label className="content-admin-music-autoplay">
                <input type="checkbox" checked={music.autoPlayOnOpen === true} aria-describedby="content-admin-music-autoplay-hint" onChange={(event) => update(["content", "music", "autoPlayOnOpen"], event.target.checked)} />
                <span>봉투가 열릴 때 음악 재생 시도</span>
              </label>
              <small id="content-admin-music-autoplay-hint" className="content-admin-music-hint">브라우저에서 자동 재생을 차단할 수 있습니다. 차단되면 방문자가 재생 버튼을 눌러 들을 수 있습니다.</small>
              <div className="content-admin-music-upload">
                <div>
                  <strong>현재 곡 미리듣기</strong>
                  <span>{music.title} · {music.artist}</span>
                </div>
                <audio key={music.src} className="content-admin-music-preview" controls preload="metadata" src={music.src} aria-label={`${music.title} 미리듣기`} />
                <label className={`content-admin-file ${musicReady ? "" : "is-disabled"}`}>
                  <span>{uploadingSlot === "background-music" ? "음악 업로드 중…" : "음악 교체"}</span>
                  <input type="file" accept="audio/mpeg,audio/mp4,audio/wav,.mp3,.m4a,.wav" disabled={Boolean(uploadingSlot) || !musicReady} onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (file) await uploadAudio(file);
                    event.target.value = "";
                  }} />
                </label>
                {uploadProgress?.slot === "background-music" && <UploadProgress progress={uploadProgress} />}
                <small>MP3, M4A(AAC), WAV(PCM), 최대 25MB · 업로드만으로는 공개되지 않습니다.</small>
              </div>
            </div>
          </CollapsibleSection>

          <div className="content-admin-storage" aria-live="polite">
            <div>
              <strong>미디어 저장 공간(사진·음악)</strong>
              <span>{mediaUsage?.localReview ? "로컬 검토에서는 Cloudflare 공간을 사용하지 않습니다." : `${formatStorage(mediaUsage?.usedBytes || 0)} / ${formatStorage(mediaUsage?.limitBytes || 0)}`}</span>
            </div>
            <progress max="100" value={mediaUsage?.percent || 0} aria-label="미디어 저장 공간 사용률" />
            <small>{mediaUsage?.localReview ? "production에서는 사진과 음악 합계가 2GB에 도달하면 추가 업로드가 자동으로 차단됩니다." : `사용률 ${mediaUsage?.percent || 0}% · 남은 공간 ${formatStorage(mediaUsage?.remainingBytes || 0)}`}</small>
          </div>

          {!localReview && (
            <CollapsibleSection title="저장된 미디어" busy={busy}>
              <p className="content-admin-media-note">문서에서 제거한 사진·음악 파일도 저장 공간을 계속 사용합니다. 여기서 삭제하면 파일과 용량이 영구 회수됩니다.</p>
              {mediaList.length === 0 ? (
                <p className="content-admin-media-empty">저장된 미디어가 없습니다.</p>
              ) : (
                <ul className="content-admin-media-list">
                  {mediaList.map((item) => {
                    const refs = item.references || {};
                    const archivedCount = refs.archivedRevisions?.length || 0;
                    const statusLabel = item.deletionPending ? "저장소 삭제 대기 중"
                      : item.abandoned ? "업로드 중단됨"
                      : refs.published ? "현재 공개본 사용 중"
                        : refs.draft ? "현재 초안 사용 중"
                          : archivedCount > 0 ? `과거 리비전 ${archivedCount}개 참조`
                            : "미사용";
                    const mediaLabel = item.kind === "audio" ? "배경 음악" : item.slot === "pastel-hero" ? "대표 사진" : "갤러리 사진";
                    return (
                      <li key={item.mediaId} className="content-admin-media-item">
                        {item.previewUrl
                          ? <img src={item.previewUrl} alt="" className="content-admin-media-thumb" loading="lazy" />
                          : <span className="content-admin-media-thumb is-audio" aria-hidden="true"><MusicNotes aria-hidden="true" /></span>}
                        <div className="content-admin-media-meta">
                          <strong>{mediaLabel}</strong>
                          <span>{formatStorage(item.totalBytes)} · {formatAdminTimestamp(item.createdAt)}</span>
                          <em>{statusLabel}</em>
                        </div>
                        <button
                          type="button"
                          className="is-destructive"
                          disabled={Boolean(refs.published) || Boolean(deletingMediaId) || Boolean(uploadingSlot)}
                          onClick={() => requestDeleteMedia(item)}
                          aria-label={`${mediaLabel} 미디어 삭제 (${item.mediaId.slice(0, 8)})`}
                        >
                          <Trash aria-hidden="true" />삭제
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CollapsibleSection>
          )}

          <CollapsibleSection title="사진" busy={busy} attention={Boolean(uploadingSlot || validationErrors["사진"])}>
            <div className="content-admin-photo-list">
              <PhotoEditor title="상단 대표 사진" slot="pastel-hero" photo={photos.hero} busy={Boolean(uploadingSlot)} fileError={validationErrors["상단 대표 사진 파일"]} altError={validationErrors["상단 대표 사진 대체 텍스트"]} positionError={validationErrors["상단 대표 사진 초점 위치"]} onUpload={uploadPhoto} progress={uploadProgress?.slot === "pastel-hero" ? uploadProgress : null} onMetaChange={(key, value) => update(["photos", "pastel", "hero", key], value)} />
              {photos.gallery.map((photo, index) => (
                <PhotoEditor
                  key={photo.src}
                  title={`갤러리 ${index + 1}`}
                  slot={`pastel-gallery-${index}`}
                  photo={photo}
                  busy={Boolean(uploadingSlot)}
                  fileError={validationErrors[`갤러리 ${index + 1} 파일`]}
                  altError={validationErrors[`갤러리 ${index + 1} 대체 텍스트`]}
                  positionError={validationErrors[`갤러리 ${index + 1} 초점 위치`]}
                  onUpload={uploadPhoto}
                  progress={uploadProgress?.slot === `pastel-gallery-${index}` ? uploadProgress : null}
                  onMetaChange={(key, value) => update(["photos", "pastel", "gallery", index, key], value)}
                  actions={<div className="content-admin-photo-actions" aria-label={`갤러리 ${index + 1} 순서와 삭제`}>
                    <button type="button" onClick={() => moveGalleryPhoto(index, -1)} disabled={Boolean(uploadingSlot) || index === 0} aria-label={`갤러리 ${index + 1} 앞으로 이동`}><ArrowUp aria-hidden="true" /></button>
                    <button type="button" onClick={() => moveGalleryPhoto(index, 1)} disabled={Boolean(uploadingSlot) || index === photos.gallery.length - 1} aria-label={`갤러리 ${index + 1} 뒤로 이동`}><ArrowDown aria-hidden="true" /></button>
                    <button type="button" className="is-destructive" onClick={() => removeGalleryPhoto(index)} disabled={Boolean(uploadingSlot) || photos.gallery.length <= MIN_GALLERY_PHOTOS} aria-label={`갤러리 ${index + 1} 목록에서 제거`}><Trash aria-hidden="true" /></button>
                  </div>}
                />
              ))}
              <GalleryPhotoUploader onUpload={uploadGalleryPhotos} busy={uploadingSlot === "pastel-gallery-new"} disabled={Boolean(uploadingSlot)} progress={uploadProgress?.slot === "pastel-gallery-new" ? uploadProgress : null} />
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
              const label = `리비전 ${revision.id.startsWith("local-") ? revision.id.slice(-8) : revision.id.slice(0, 8)}`;
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
                      <button type="button" disabled={Boolean(uploadingSlot)} onClick={() => setRepublishTarget({ id: revision.id, label })}><ArrowClockwise aria-hidden="true" />이 버전을 다시 공개</button>
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
      {!authRequired && mediaDeleteTarget && (
        <MediaDeleteDialog
          media={mediaDeleteTarget.media}
          dependentRevisions={mediaDeleteTarget.dependentRevisions}
          error={mediaDeleteTarget.error}
          busy={Boolean(deletingMediaId)}
          onCancel={() => setMediaDeleteTarget(null)}
          onConfirm={() => void confirmDeleteMedia()}
        />
      )}
      </div>
    </AdminShell>
  );
}
