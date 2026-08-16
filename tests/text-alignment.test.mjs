import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing CSS rule: ${selector}`);
  return match[1];
}

test("Pastel save-card titles share one horizontal action alignment", () => {
  assert.match(rule(".action-button"), /align-items:\s*center/);
  assert.match(rule(".save-cards .save-date-action"), /flex-direction:\s*row/);
  assert.match(rule(".save-cards .save-date-action span"), /text-align:\s*left/);
  assert.match(rule(".save-cards .save-calendar-action"), /display:\s*grid/);
});

test("Quiet date line uses a single Korean-capable serif family", () => {
  const dateLine = rule(".date-line");
  assert.match(dateLine, /font-family:\s*"Noto Serif KR Variable", serif/);
  assert.doesNotMatch(dateLine, /Cormorant Garamond Variable/);
});

test("Quiet ampersand is optically raised to the names' centerline", () => {
  assert.match(rule(".quiet-hero h1 i"), /vertical-align:\s*\.08em/);
});
