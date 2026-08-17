import sharp from "sharp";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const qa = new URL("artifacts/qa/", root);
const attachmentDirectory = "C:/Users/enmso/.codex/codex-remote-attachments/019ff501-f8d7-7280-b3f3-9fed0fbb6140/1A1AB2CB-03BC-490D-A976-70A65304E6E7";

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
const referenceTwo = `${attachmentDirectory}/2-사진-2.jpg`;
const implementation = fileURLToPath(new URL("pastel-sacramento-final-390-top.png", qa));

const referencePanels = await Promise.all([
  panel(referenceOne, { width: 390, height: 620, title: "REFERENCE 1 · rounded terminals" }),
  panel(referenceTwo, { width: 390, height: 620, title: "REFERENCE 2 · connected light stroke" }),
  panel(implementation, { width: 390, height: 620, title: "SACRAMENTO · final implementation" }),
]);
await sharp({ create: { width: 1210, height: 640, channels: 4, background: "#dedbd4" } })
  .composite(referencePanels.map((input, index) => ({ input, left: 10 + index * 400, top: 10 })))
  .png()
  .toFile(fileURLToPath(new URL("pastel-script-reference-comparison.png", qa)));

console.log("Created the current Pastel script reference composite.");
