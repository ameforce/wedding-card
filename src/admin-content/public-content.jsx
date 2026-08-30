import { useEffect, useMemo, useState } from "react";
import { weddingContent } from "../content.js";
import { applyContentDocument, normalizeContentDocument } from "./content-document.js";
import { createContentAdapter, getEmbeddedContentPreviewConfig, isLocalReviewBuild } from "./content-client.js";
import {
  bundledFallbackState,
  initialPublicContentState,
  PUBLIC_CONTENT_TIMEOUT_MS,
  readyContentState,
} from "./public-bootstrap.js";

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
  const [state, setState] = useState(() => initialPublicContentState({
    previewDraft,
    localReview,
    staticContent,
  }));

  useEffect(() => {
    let active = true;
    let settled = state.status === "ready";
    let timeout = null;
    const controller = new AbortController();
    const commit = (next) => {
      if (!active || settled) return;
      settled = true;
      if (timeout !== null) window.clearTimeout(timeout);
      setState(readyContentState(next));
    };

    if (previewDraft) {
      const receivePreview = (event) => {
        if (event.origin !== window.location.origin || event.source !== window.parent) return;
        if (event.data?.type !== CONTENT_PREVIEW_MESSAGE_TYPE) return;
        const document = normalizeContentDocument(event.data.document, staticContent, { allowLocalPreview: localReview });
        if (!active) return;
        setState(readyContentState({
          content: applyContentDocument(document, staticContent, { allowLocalPreview: localReview }),
          source: "admin-live-preview",
          revisionId: null,
          publishedAt: null,
        }));
      };
      window.addEventListener("message", receivePreview);
      window.parent.postMessage({ type: CONTENT_PREVIEW_READY_MESSAGE_TYPE }, window.location.origin);
      return () => {
        active = false;
        window.removeEventListener("message", receivePreview);
      };
    }

    const load = async () => {
      const next = await adapter.getPublicContent({ signal: controller.signal });
      commit(next);
    };

    if (localReview) {
      void load();
      const unsubscribe = adapter.subscribe?.(() => {
        settled = false;
        void load();
      });
      return () => {
        active = false;
        controller.abort();
        unsubscribe?.();
      };
    }

    if (state.status === "ready") {
      return () => {
        active = false;
      };
    }

    timeout = window.setTimeout(() => {
      controller.abort();
      commit(bundledFallbackState(staticContent));
    }, PUBLIC_CONTENT_TIMEOUT_MS);
    void load().catch(() => commit(bundledFallbackState(staticContent)));

    return () => {
      active = false;
      controller.abort();
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [adapter, localReview, previewDraft, state.status, staticContent]);

  return state;
}
