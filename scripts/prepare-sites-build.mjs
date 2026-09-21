#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const index = path.join(dist, "client", "index.html");
const worker = path.join(root, "worker", "index.js");
const hosting = path.join(root, ".openai", "hosting.json");
const migrations = path.join(root, "migrations");

for (const file of [index, worker, hosting]) {
  if (!existsSync(file)) throw new Error("Missing Sites build input: " + file);
}

const earlyScript = readFileSync(index, "utf8").match(/<script id="pastel-intro-early-boot">([\s\S]*?)<\/script>/u)?.[1];
if (!earlyScript) throw new Error("Missing inline early-cover controller.");
const scriptDirective = `script-src 'self' 'sha256-${createHash("sha256").update(earlyScript).digest("base64")}'`;
if (!readFileSync(worker, "utf8").includes(scriptDirective)) {
  throw new Error("Worker CSP must allow only the exact built early-cover controller hash.");
}
const headersPath = path.join(dist, "client", "_headers");
const headers = readFileSync(headersPath, "utf8");
if (!headers.includes("script-src 'self';")) throw new Error("Unexpected Static Assets script policy.");
writeFileSync(headersPath, headers.replace("script-src 'self';", `${scriptDirective};`));

mkdirSync(path.join(dist, "server"), { recursive: true });
mkdirSync(path.join(dist, ".openai"), { recursive: true });
mkdirSync(path.join(dist, ".openai", "drizzle"), { recursive: true });
copyFileSync(worker, path.join(dist, "server", "index.js"));
copyFileSync(hosting, path.join(dist, ".openai", "hosting.json"));
for (const file of readdirSync(migrations).filter((name) => name.endsWith(".sql"))) {
  copyFileSync(path.join(migrations, file), path.join(dist, ".openai", "drizzle", file));
}

console.log("Prepared Sites build: worker, hosting config, and D1 migrations");
