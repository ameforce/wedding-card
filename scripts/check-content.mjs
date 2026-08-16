import { readFileSync } from "node:fs";

const content = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
const markers = [
  "isDesignPlaceholder: true",
  "실제 주소 입력 예정",
  "시간 미정",
  "정보 입력 예정",
];
const found = markers.filter((marker) => content.includes(marker));

if (found.length > 0 && process.env.ALLOW_DESIGN_PLACEHOLDERS !== "1") {
  console.error("Production build blocked: unverified design-only wedding content remains.");
  for (const marker of found) console.error(`- ${marker}`);
  console.error("Use `npm run build:design` only for local design review.");
  process.exit(1);
}

console.log(found.length > 0 ? "Design-only placeholder build explicitly allowed." : "Verified content guard passed.");
