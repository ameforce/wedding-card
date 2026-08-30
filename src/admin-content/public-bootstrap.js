import { weddingContent } from "../content.js";
import { applyContentDocument } from "./content-document.js";

export const PUBLIC_BOOTSTRAP_ID = "wedding-public-bootstrap";
export const PUBLIC_BOOTSTRAP_SCHEMA_VERSION = 1;
export const PUBLIC_CONTENT_TIMEOUT_MS = 3_000;

function decodeBase64Url(value) {
  const normalized = String(value).replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

export function readyContentState(value) {
  return { status: "ready", ...value };
}

export function bundledFallbackState(staticContent = weddingContent) {
  return readyContentState({
    source: "bundled-fallback",
    revisionId: null,
    publishedAt: null,
    content: staticContent,
  });
}

export function readPublicBootstrap(staticContent = weddingContent, root = globalThis.document) {
  const node = root?.getElementById?.(PUBLIC_BOOTSTRAP_ID);
  if (!node || node.dataset?.schemaVersion !== String(PUBLIC_BOOTSTRAP_SCHEMA_VERSION)) return null;
  try {
    const encoded = node.content?.textContent ?? node.textContent ?? "";
    const payload = JSON.parse(decodeBase64Url(encoded.trim()));
    if (payload?.schemaVersion !== PUBLIC_BOOTSTRAP_SCHEMA_VERSION) return null;
    if (payload.source === "bundled-fallback") return bundledFallbackState(staticContent);
    if (payload.source !== "cloudflare-published" || typeof payload.revisionId !== "string" || !payload.document) {
      return null;
    }
    return readyContentState({
      source: "cloudflare-published",
      revisionId: payload.revisionId,
      publishedAt: payload.publishedAt ?? null,
      content: applyContentDocument(payload.document, staticContent),
    });
  } catch {
    return null;
  }
}

export function initialPublicContentState({
  previewDraft = false,
  localReview = false,
  staticContent = weddingContent,
  root = globalThis.document,
} = {}) {
  if (previewDraft || localReview) {
    return { status: "pending", source: "pending", revisionId: null, publishedAt: null, content: staticContent };
  }
  return readPublicBootstrap(staticContent, root)
    ?? { status: "pending", source: "pending", revisionId: null, publishedAt: null, content: staticContent };
}
