import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The release canary must load the built production client, not cold Vite dev
// transforms that can consume the application's real five-second startup budget.
export async function createPublishedStaticServer(document, { workerTag, workerVersion }) {
  const root = fileURLToPath(new URL("../../dist/client/", import.meta.url));
  const revisionId = "local-published-42";
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, source: "cloudflare-published",
    revisionId, publishedAt: "2026-09-05T00:00:00.000Z", document })).toString("base64url");
  const html = await readFile(resolve(root, "index.html"), "utf8");
  if (!html.includes("<!-- WEDDING_PUBLIC_BOOTSTRAP -->")) throw new Error("Build the production client before running the render canary.");
  const indexHtml = html.replace("<!-- WEDDING_PUBLIC_BOOTSTRAP -->",
    `<template id="wedding-public-bootstrap" data-schema-version="1">${payload}</template>`);
  const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json",
    ".webp": "image/webp", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".woff": "font/woff", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".bin": "application/octet-stream" };
  const serve = async (request, response) => {
    response.setHeader("x-wedding-content-source", "cloudflare-published");
    response.setHeader("x-wedding-revision", revisionId);
    response.setHeader("x-wedding-worker-tag", workerTag);
    response.setHeader("x-wedding-worker-version", workerVersion);
    response.setHeader("content-security-policy", "connect-src 'self'");
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405).end(); return; }
    const heroPrefix = "/api/media/invitation/local-published/pastel-hero/";
    const relative = pathname === "/" ? "index.html"
      : pathname.startsWith(heroPrefix) ? `assets/photos/pastel-hero-${pathname.endsWith("/960.webp") ? "960" : "480"}.webp`
        : pathname.replace(/^\/+/, "");
    const target = resolve(root, relative);
    if (!target.startsWith(resolve(root) + sep)) { response.writeHead(403).end(); return; }
    try {
      const bytes = relative === "index.html" ? Buffer.from(indexHtml) : await readFile(target);
      response.setHeader("content-type", mime[extname(target)] || "application/octet-stream");
      response.setHeader("content-length", bytes.byteLength);
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      response.writeHead(404).end();
    }
  };
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: new URL(`http://127.0.0.1:${server.address().port}/`),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
