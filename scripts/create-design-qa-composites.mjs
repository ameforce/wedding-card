import sharp from "sharp";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const qa = new URL("artifacts/qa/", root);
const attachmentDirectory = "C:/Users/enmso/.codex/codex-remote-attachments/019ff501-f8d7-7280-b3f3-9fed0fbb6140/84FA598D-9FE2-4208-99B0-77A056F6295A";

function svgText(text, width, height = 46) {
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#26384d"/>
    <text x="16" y="29" fill="#ffffff" font-family="Arial, sans-serif" font-size="15" font-weight="700">${text}</text>
  </svg>`);
}

async function panel(input, { width, height, title, fit = "cover", position = "top" }) {
  const image = await sharp(input)
    .resize({ width, height: height - 46, fit, position, background: "#f7f5ef" })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 4, background: "#f7f5ef" } })
    .composite([{ input: svgText(title, width), top: 0, left: 0 }, { input: image, top: 46, left: 0 }])
    .png()
    .toBuffer();
}

const referenceOne = `${attachmentDirectory}/1-사진-1.jpg`;
const implementation = fileURLToPath(new URL("pastel-paper-script-390-top.png", qa));

const referencePanels = await Promise.all([
  panel(referenceOne, { width: 560, height: 620, title: "SOURCE · thin connected brush script", fit: "contain", position: "center" }),
  panel(implementation, { width: 390, height: 620, title: "IMPLEMENTATION · Mrs Saint Delafield · -10°" }),
]);
await sharp({ create: { width: 980, height: 640, channels: 4, background: "#dedbd4" } })
  .composite([
    { input: referencePanels[0], left: 10, top: 10 },
    { input: referencePanels[1], left: 580, top: 10 },
  ])
  .png()
  .toFile(fileURLToPath(new URL("pastel-paper-script-reference-comparison.png", qa)));

console.log("Created the current Pastel paper and script reference composite.");
