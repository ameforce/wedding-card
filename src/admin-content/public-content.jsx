import { useEffect, useMemo, useState } from "react";
import { weddingContent } from "../content.js";
import { applyContentDocument, normalizeContentDocument } from "./content-document.js";
import { createContentAdapter, getEmbeddedContentPreviewConfig, isLocalReviewBuild } from "./content-client.js";

export const CONTENT_PREVIEW_MESSAGE_TYPE = "wedding-card:content-preview";
export const CONTENT_PREVIEW_READY_MESSAGE_TYPE = "wedding-card:content-preview-ready";

function getContentPreviewConfig() {
  if (typeof window === "undefined") return getEmbeddedContentPreviewConfig();
  return getEmbeddedContentPreviewConfig({
    search: window.location.search,
    embedded: window.parent !== window,
    localReview: isLocalReviewBuild(),
  });
}

export function usePublicInvitationContent(staticContent = weddingContent) {
  const { previewDraft, adapterMode } = getContentPreviewConfig();
  const localReview = isLocalReviewBuild();
  const adapter = useMemo(
    () => createContentAdapter({ staticContent, mode: adapterMode }),
    [adapterMode, staticContent],
  );
  const [state, setState] = useState(() => ({ content: staticContent, source: "bundled-static" }));

  useEffect(() => {
    let active = true;
    let receivedLivePreview = false;
    const setContent = (next) => {
      if (active) setState(next);
    };
    const load = async () => {
      try {
        const next = await adapter.getPublicContent();
        // The embedded admin parent owns drafts. Do not let a public content
        // request race with, or replace, its unsaved live preview document.
        if (!receivedLivePreview) setContent(next);
      } catch {
        if (!receivedLivePreview) setContent({ content: staticContent, source: "bundled-static" });
      }
    };

    const receivePreview = (event) => {
      if (!previewDraft || event.origin !== window.location.origin) return;
      if (event.source !== window.parent) return;
      if (event.data?.type !== CONTENT_PREVIEW_MESSAGE_TYPE) return;
      receivedLivePreview = true;
      const document = normalizeContentDocument(event.data.document, staticContent, { allowLocalPreview: localReview });
      setContent({ content: applyContentDocument(document, staticContent, { allowLocalPreview: localReview }), source: "admin-live-preview" });
    };
    if (previewDraft) window.addEventListener("message", receivePreview);
    if (previewDraft) window.parent.postMessage({ type: CONTENT_PREVIEW_READY_MESSAGE_TYPE }, window.location.origin);
    void load();

    const unsubscribe = adapter.subscribe?.(() => { void load(); });

    return () => {
      active = false;
      unsubscribe?.();
      if (previewDraft) window.removeEventListener("message", receivePreview);
    };
  }, [adapter, localReview, previewDraft, staticContent]);

  return state;
}
