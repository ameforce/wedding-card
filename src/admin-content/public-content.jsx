import { useEffect, useMemo, useState } from "react";
import { weddingContent } from "../content.js";
import { applyContentDocument, normalizeContentDocument } from "./content-document.js";
import { createContentAdapter, isLocalReviewBuild } from "./content-client.js";

export const CONTENT_PREVIEW_MESSAGE_TYPE = "wedding-card:content-preview";
export const CONTENT_PREVIEW_READY_MESSAGE_TYPE = "wedding-card:content-preview-ready";
export const CONTENT_PREVIEW_CHANNEL_NAME = "wedding-card:content-preview-channel-v1";

function shouldPreviewDraft() {
  if (!isLocalReviewBuild() || typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("contentPreview") === "draft";
}

export function usePublicInvitationContent(staticContent = weddingContent) {
  const previewDraft = shouldPreviewDraft();
  const adapter = useMemo(
    () => createContentAdapter({ staticContent, mode: previewDraft ? "local-review" : undefined }),
    [previewDraft, staticContent],
  );
  const [state, setState] = useState(() => ({ content: staticContent, source: "bundled-static" }));

  useEffect(() => {
    let active = true;
    const setContent = (next) => {
      if (active) setState(next);
    };
    const load = async () => {
      try {
        if (previewDraft) {
          const adminState = await adapter.getAdminState();
          setContent({ content: applyContentDocument(adminState.draft, staticContent, { allowLocalPreview: true }), source: "local-review-draft" });
          window.parent.postMessage({ type: CONTENT_PREVIEW_READY_MESSAGE_TYPE }, window.location.origin);
          return;
        }
        setContent(await adapter.getPublicContent());
      } catch {
        setContent({ content: staticContent, source: "bundled-static" });
      }
    };
    void load();

    const unsubscribe = adapter.subscribe?.(() => { void load(); });
    const receivePreview = (event) => {
      if (!previewDraft || event.origin !== window.location.origin) return;
      if (event.data?.type !== CONTENT_PREVIEW_MESSAGE_TYPE) return;
      const document = normalizeContentDocument(event.data.document, staticContent, { allowLocalPreview: true });
      setContent({ content: applyContentDocument(document, staticContent, { allowLocalPreview: true }), source: "local-review-live-preview" });
    };
    if (previewDraft) window.addEventListener("message", receivePreview);
    const previewChannel = previewDraft && typeof BroadcastChannel === "function"
      ? new BroadcastChannel(CONTENT_PREVIEW_CHANNEL_NAME)
      : null;
    if (previewChannel) {
      previewChannel.onmessage = (event) => {
        if (event.data?.type !== CONTENT_PREVIEW_MESSAGE_TYPE) return;
        const document = normalizeContentDocument(event.data.document, staticContent, { allowLocalPreview: true });
        setContent({ content: applyContentDocument(document, staticContent, { allowLocalPreview: true }), source: "local-review-live-preview" });
      };
      previewChannel.postMessage({ type: CONTENT_PREVIEW_READY_MESSAGE_TYPE });
    }

    return () => {
      active = false;
      unsubscribe?.();
      if (previewDraft) window.removeEventListener("message", receivePreview);
      previewChannel?.close();
    };
  }, [adapter, previewDraft, staticContent]);

  return state;
}
