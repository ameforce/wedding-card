// Local review only. No review UI or reference video is copied into a public build.
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { validateRibbonManifest } from "../../src/intro/ribbon-player.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".ics": "text/calendar; charset=utf-8" };
mime[".bin"] = "application/octet-stream";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseByteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size || (!match[1] && Number(match[2]) === 0)) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}

export async function createVisualReview({ build, reference, referenceStart = 0 }) {
  if (!Number.isFinite(referenceStart) || referenceStart < 0) throw new Error("A nonnegative reference start is required.");
  const root = await realpath(build);
  const files = new Map();
  async function capture(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Review build must not contain symbolic links.");
      const local = path.join(directory, entry.name);
      const route = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await capture(local, route);
      else if (entry.isFile() && mime[path.extname(entry.name)]) files.set(route, await readFile(local));
    }
  }
  await capture(root);
  if (!files.has("/index.html")) throw new Error("A built invitation index.html is required.");
  const manifestPath = "/assets/design/ribbon-sequence/manifest.json";
  const rawManifest = JSON.parse(files.get(manifestPath)?.toString("utf8") || "null");
  if (rawManifest?.schemaVersion !== 2) throw new Error("The comparison requires a schema-version-2 ribbon build.");
  const manifest = validateRibbonManifest(rawManifest, { manifestUrl: `http://localhost${manifestPath}` });
  for (const url of manifest.frames) {
    const route = new URL(url).pathname;
    if (!files.has(route)) throw new Error(`Missing built frame: ${route}`);
  }
  if (sha256(files.get(new URL(manifest.frames[0]).pathname)) !== manifest.poster.sha256) throw new Error("The built poster hash does not match the manifest.");
  if (manifest.framePack) {
    const packed = files.get(new URL(manifest.framePack.url).pathname);
    if (!packed || packed.length !== manifest.framePack.totalBytes || sha256(packed) !== manifest.framePack.sha256) throw new Error("The built frame pack does not match the manifest.");
    const expected = Buffer.concat(manifest.frames.map((url) => files.get(new URL(url).pathname)));
    if (!packed.equals(expected)) throw new Error("The built frame pack differs from the individual frames.");
  }
  const referencePath = await realpath(reference);
  if (path.extname(referencePath).toLowerCase() !== ".mp4") throw new Error("The original MP4 reference is required.");
  files.set("/__review/reference.mp4", await readFile(referencePath));
  files.set("/__review/index.html", await readFile(path.join(here, "visual-review.html")));
  files.set("/__review/app.mjs", await readFile(path.join(here, "visual-review.mjs")));
  files.set("/__review/player.mjs", await readFile(path.join(here, "../../src/intro/ribbon-player.mjs")));
  files.set("/__review/config.json", Buffer.from(JSON.stringify({ referenceStart })));
  const binding = { schemaVersion: 1, build: root, reference: referencePath, referenceStart,
    createdAt: new Date().toISOString(), source: "Immutable in-memory copies of the supplied local build and original reference",
    files: [...files].map(([route, bytes]) => ({ route, bytes: bytes.length, sha256: sha256(bytes) })) };
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet, noimageindex");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return;
    }
    let route;
    try { route = decodeURIComponent(new URL(request.url, "http://localhost").pathname); }
    catch { response.writeHead(400); response.end(); return; }
    if (route === "/") route = "/index.html";
    if (route === "/__review" || route === "/__review/") route = "/__review/index.html";
    const bytes = files.get(route);
    if (!bytes) { response.writeHead(404); response.end(); return; }
    response.setHeader("Content-Type", mime[path.extname(route)] || "application/octet-stream");
    response.setHeader("Accept-Ranges", "bytes");
    let body = bytes;
    if (request.headers.range) {
      const range = parseByteRange(request.headers.range, bytes.length);
      if (!range) { response.writeHead(416, { "Content-Range": `bytes */${bytes.length}` }); response.end(); return; }
      body = bytes.subarray(range.start, range.end + 1);
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${bytes.length}`);
    }
    response.setHeader("Content-Length", body.length);
    response.end(request.method === "HEAD" ? undefined : body);
  });
  return { server, binding };
}

async function main() {
  const { values } = parseArgs({ options: { build: { type: "string" }, reference: { type: "string" }, record: { type: "string" }, port: { type: "string", default: "4182" }, host: { type: "string", default: "127.0.0.1" }, "reference-start": { type: "string", default: "0" } } });
  if (!values.build || !values.reference || !values.record) throw new Error("--build, --reference and --record are required.");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  const { server, binding } = await createVisualReview({ build: values.build, reference: values.reference, referenceStart: Number(values["reference-start"]) });
  // The receipt is outside the served allowlist and is never reader-facing copy.
  await writeFile(values.record, `${JSON.stringify(binding, null, 2)}\n`, { flag: "wx" });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, values.host, resolve); });
  console.log(JSON.stringify({ listening: true, host: values.host, port, reviewPath: "/__review/", frozenFiles: binding.files.length, bindingSha256: sha256(Buffer.from(JSON.stringify(binding))) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
