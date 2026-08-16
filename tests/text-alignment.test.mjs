import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const actions = await readFile(new URL("../src/invitation-actions.js", import.meta.url), "utf8");

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing CSS rule: ${selector}`);
  return match[1];
}

function fontSize(selector) {
  const match = rule(selector).match(/font-size:\s*([\d.]+)px/);
  assert.ok(match, `Missing font size for ${selector}`);
  return Number(match[1]);
}

test("Pastel keeps its single calendar action in the bottom utility row", () => {
  assert.match(rule(".action-button"), /align-items:\s*center/);
  assert.doesNotMatch(app, /예식 정보 복사|save-date-action/);
  assert.doesNotMatch(app, /CalendarAction|save-cards|showCalendar=\{false\}/);
  assert.match(app, /<BottomActions notify=\{notify\} pastel \/>/);
});

test("Pastel actions use independent soft controls without coupon separators", () => {
  assert.match(rule(".bottom-actions.is-pastel"), /gap:\s*8px/);
  assert.match(rule(".bottom-actions.is-pastel"), /grid-template-columns:\s*repeat\(3, 1fr\)/);
  assert.match(rule(".bottom-actions.is-pastel .action-button + .action-button::before"), /display:\s*none/);
  assert.match(app, /ariaLabel="네이버 지도에서 길찾기">네이버</);
});

test("Quiet date line uses a single Korean-capable serif family", () => {
  const dateLine = rule(".date-line");
  assert.match(dateLine, /font-family:\s*"Noto Serif KR Variable", serif/);
  assert.doesNotMatch(dateLine, /Cormorant Garamond Variable/);
});

test("Quiet ampersand is optically raised to the names' centerline", () => {
  assert.match(rule(".quiet-hero h1 i"), /vertical-align:\s*\.08em/);
});

test("invitation type scale keeps key information readable on a phone", () => {
  const readableContract = [
    [".event-date-primary", 16],
    [".event-date-secondary", 13],
    [".venue-line", 13],
    [".greeting p:not(.eyebrow)", 14],
    [".calendar-day", 13],
    [".venue-copy strong", 15],
    [".venue-copy span", 13],
    [".route-actions .action-button", 13],
    [".bottom-actions .action-button", 13],
    [".transit-list span", 12],
  ];

  for (const [selector, minimum] of readableContract) {
    assert.ok(fontSize(selector) >= minimum, `${selector} must be at least ${minimum}px`);
  }

  const allDeclaredFontSizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((match) => Number(match[1]));
  assert.ok(Math.min(...allDeclaredFontSizes) >= 12, "No visible text may drop below the 12px secondary-text floor");
});

test("visible invitation, copied and shared copy omit KST while calendar semantics remain internal", () => {
  assert.doesNotMatch(app, /KST|timezone\.label/);
  assert.doesNotMatch(actions, /KST|timezone\.label/);
  assert.match(actions, /DTSTART;TZID=\$\{content\.event\.timezone\.iana\}/);
});
