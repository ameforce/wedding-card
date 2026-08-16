import sharp from "sharp";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const qa = new URL("artifacts/qa/", root);

function label(text, width) {
  return Buffer.from(`<svg width="${width}" height="48" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#26384d"/>
    <text x="18" y="31" fill="#ffffff" font-family="Arial, sans-serif" font-size="18" font-weight="700">${text}</text>
  </svg>`);
}

async function panel(input, { width, height, fit = "contain", position = "centre", title }) {
  const image = await sharp(input).resize({ width, height: height - 48, fit, position, background: "#f7f5ef" }).png().toBuffer();
  return sharp({ create: { width, height, channels: 4, background: "#f7f5ef" } })
    .composite([{ input: label(title, width), top: 0, left: 0 }, { input: image, top: 48, left: 0 }])
    .png()
    .toBuffer();
}

const scriptReference = "C:/Users/enmso/AppData/Local/Temp/codex-clipboard-afa74bd9-0c52-4bf9-98cd-8e93847e741a.png";
const seamReference = "C:/Users/enmso/AppData/Local/Temp/codex-clipboard-01ed0016-ff59-4c41-833f-5c38d9582124.png";
const heroImplementation = fileURLToPath(new URL("pastel-hero-script-390.png", qa));
const calendarImplementation = fileURLToPath(new URL("pastel-calendar-seam-390.png", qa));

const heroPanels = await Promise.all([
  panel(scriptReference, { width: 560, height: 760, title: "SOURCE SCRIPT REFERENCE" }),
  panel(heroImplementation, { width: 560, height: 760, fit: "cover", position: "top", title: "IMPLEMENTATION · 390 PX" }),
]);
await sharp({ create: { width: 1160, height: 780, channels: 4, background: "#dedbd4" } })
  .composite([{ input: heroPanels[0], left: 10, top: 10 }, { input: heroPanels[1], left: 590, top: 10 }])
  .png()
  .toFile(fileURLToPath(new URL("pastel-script-reference-comparison.png", qa)));

const seamPanels = await Promise.all([
  panel(seamReference, { width: 560, height: 700, title: "USER SEAM EVIDENCE" }),
  panel(calendarImplementation, { width: 560, height: 700, fit: "cover", position: "centre", title: "IMPLEMENTATION · 390 PX" }),
]);
await sharp({ create: { width: 1160, height: 720, channels: 4, background: "#dedbd4" } })
  .composite([{ input: seamPanels[0], left: 10, top: 10 }, { input: seamPanels[1], left: 590, top: 10 }])
  .png()
  .toFile(fileURLToPath(new URL("pastel-calendar-seam-comparison.png", qa)));

console.log("Created focused Pastel design QA composites.");
