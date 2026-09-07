import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const paperPath = resolve(process.cwd(), "public/assets/design/intro-paper-ivory.webp");

function dataUri(file, mime) {
  return `data:${mime};base64,${readFileSync(file).toString("base64")}`;
}

export function createEarlyPosterMarkup({ bootSource }) {
  const manifestPath = resolve(process.cwd(), "public/assets/design/ribbon-sequence/manifest.json");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const frameIndex = manifest.schemaVersion === 2 ? manifest.poster?.frameIndex : 0;
  if (frameIndex !== 0 || !Array.isArray(manifest.frames) || !manifest.frames[0]) {
    throw new Error("The early poster requires manifest frame 0.");
  }
  const framePath = resolve(process.cwd(), "public/assets/design/ribbon-sequence", manifest.frames[0]);
  const frameBytes = readFileSync(framePath);
  const poster = dataUri(framePath, "image/webp");
  const paper = dataUri(paperPath, "image/webp");
  const posterSha256 = createHash("sha256").update(frameBytes).digest("hex");
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const manifestBase64 = manifestBytes.toString("base64");
  const registration = manifest.registration || { x: manifest.width / 2, y: manifest.height / 2 };
  const registrationXvw = ((manifest.width / 2 - registration.x) / manifest.width) * 100;
  const registrationYvw = ((manifest.height / 2 - registration.y) / manifest.width) * 100;
  const styles = `
<style id="pastel-intro-early-style">
html.early-intro-enabled,html.early-intro-enabled body{overflow:hidden}
html.early-intro-enabled{--pastel-intro-paper-image:url("${paper}")}
#pastel-intro-early-poster{position:fixed;z-index:200;inset:0;display:none;overflow:hidden;isolation:isolate;background:#f7f0e4;touch-action:none;cursor:pointer;--pastel-intro-left-turn:0deg;--pastel-intro-right-turn:0deg}
html.early-intro-enabled #pastel-intro-early-poster{display:block}
#pastel-intro-early-poster[data-handoff="claimed"]{visibility:hidden;pointer-events:none}
#pastel-intro-early-poster .pastel-intro-cover__panel{position:absolute;z-index:1;inset-block:0;width:50.2%;overflow:hidden;background:#f7f0e4;backface-visibility:hidden;transform-style:flat;transition:transform var(--pastel-intro-panel-duration,1400ms) cubic-bezier(.52,.02,.18,1);will-change:transform}
#pastel-intro-early-poster .pastel-intro-cover__paper{position:absolute;inset-block:0;width:100vw;background:#f7f0e4 var(--pastel-intro-paper-image) center/cover no-repeat}
#pastel-intro-early-poster .pastel-intro-cover__panel--left .pastel-intro-cover__paper{left:0}
#pastel-intro-early-poster .pastel-intro-cover__panel--right .pastel-intro-cover__paper{left:calc(-100vw + 100%)}
#pastel-intro-early-poster .pastel-intro-cover__panel--left{left:0;transform:rotateY(var(--pastel-intro-left-turn));transform-origin:left center;background-position:left center}
#pastel-intro-early-poster .pastel-intro-cover__panel--right{right:0;transform:rotateY(var(--pastel-intro-right-turn));transform-origin:right center;background-position:right center}
#pastel-intro-early-poster .pastel-intro-cover__seam{position:absolute;z-index:2;inset-block:0;left:50%;width:1px;background:rgba(163,137,109,.22);transform:translateX(-.5px)}
#pastel-intro-early-poster .pastel-intro-cover__ribbon{position:absolute;z-index:3;top:calc(50% + var(--pastel-intro-registration-y));left:calc(50% + var(--pastel-intro-registration-x));display:block;width:100vw;height:auto;transform:translate(-50%,-50%);pointer-events:none}
</style>
<script src="${bootSource}"></script>`;
  const posterNode = `<div id="pastel-intro-early-poster" data-ribbon-schema="${manifest.schemaVersion}" data-ribbon-frame="${manifest.frames[0]}" data-ribbon-poster-sha256="${posterSha256}" data-ribbon-manifest-sha256="${manifestSha256}" data-ribbon-manifest-base64="${manifestBase64}" data-ribbon-width="${manifest.width}" data-ribbon-height="${manifest.height}" style="--pastel-intro-registration-x:${registrationXvw}vw;--pastel-intro-registration-y:${registrationYvw}vw" aria-hidden="true"><div class="pastel-intro-cover__panel pastel-intro-cover__panel--left"><span class="pastel-intro-cover__paper"></span></div><div class="pastel-intro-cover__panel pastel-intro-cover__panel--right"><span class="pastel-intro-cover__paper"></span></div><div class="pastel-intro-cover__seam"></div><img class="pastel-intro-cover__ribbon" src="${poster}" width="${manifest.width}" height="${manifest.height}" alt="" /></div>`;
  return { styles, posterNode };
}
