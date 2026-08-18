import { weddingContent } from "../src/content.js";

const unconfirmedContent = Array.isArray(weddingContent.unconfirmedContent)
  ? weddingContent.unconfirmedContent
  : [];
const hasUnconfirmedContent = weddingContent.isDesignPlaceholder === true || unconfirmedContent.length > 0;

if (hasUnconfirmedContent && process.env.ALLOW_DESIGN_PLACEHOLDERS !== "1") {
  console.error("Production build blocked: unverified design-only wedding content remains.");
  if (unconfirmedContent.length === 0) {
    console.error("- 상세 미확정 항목이 모델에 등록되지 않았습니다. (content.unconfirmedContent)");
  }
  for (const item of unconfirmedContent) console.error(`- ${item.label} [${item.key}]`);
  console.error("Use `npm run build:design` only for local design review.");
  process.exit(1);
}

console.log(hasUnconfirmedContent ? "Design-only placeholder build explicitly allowed." : "Verified content guard passed.");
