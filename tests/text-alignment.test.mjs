import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const actions = await readFile(new URL("../src/invitation-actions.js", import.meta.url), "utf8");
const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");

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

test("contact disclosure stays readable and touchable on narrow phones", () => {
  assert.match(rule(".contact-row"), /grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(rule(".contact-actions a"), /width:\s*44px/);
  assert.match(rule(".contact-actions a"), /height:\s*44px/);
  assert.match(rule(".contact-person small"), /font-size:\s*13px/);
  assert.match(rule(".contact-section"), /scroll-margin-top:\s*104px/);
  assert.match(app, /<details className=\{`contact-group/);
  assert.match(app, /<summary>/);
});

test("Pastel account disclosures keep compact copy controls alongside readable account details", () => {
  assert.match(rule(".account-row"), /grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(rule(".account-copy"), /min-height:\s*44px/);
  assert.match(rule(".account-details strong"), /font-size:\s*15px/);
  assert.match(app, /function AccountGroups/);
  assert.match(app, /copyText\(account\.number\)/);
  assert.match(app, /aria-label=\{`\$\{account\.label\} 계좌번호 복사`\}/);
  assert.match(app, /<ContactSection pastel notify=\{notify\} \/>/);
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

test("priority family and Pastel schedule lines stay enlarged and unbroken on a phone", () => {
  const familyLine = rule(".family-introduction p");
  assert.ok(fontSize(".family-introduction p") >= 17);
  assert.ok(fontSize(".family-introduction strong") >= 18);
  assert.match(familyLine, /white-space:\s*nowrap/);

  assert.ok(fontSize(".pastel-schedule .calendar-heading p") >= 19);
  assert.match(css, /\.pastel-schedule \.calendar-heading span\s*\{[^}]*font-size:\s*16px/);
  assert.match(rule(".calendar-heading span"), /white-space:\s*nowrap/);
});

test("static invitation content cannot be selected while editable fields retain native selection", () => {
  const invitation = rule(".invitation");
  assert.match(invitation, /-webkit-user-select:\s*none/);
  assert.match(invitation, /user-select:\s*none/);
  assert.match(css, /\.invitation input,\s*\.invitation textarea,\s*\.invitation \[contenteditable\]:not\(\[contenteditable="false"\]\)\s*\{[^}]*-webkit-user-select:\s*text[^}]*user-select:\s*text/);
});

test("guestbook identity inputs stay side by side, top-aligned, and equally tall", () => {
  const identityFields = app.match(/<div className="guestbook-identity-fields">[\s\S]*?<\/div>/)?.[0] ?? "";
  const inputRule = css.match(/\.guestbook-form input,\s*\.guestbook-form textarea\s*\{([^}]+)\}/)?.[1] ?? "";

  assert.match(identityFields, /<span>이름<\/span>/);
  assert.match(identityFields, /<span>비밀번호<\/span>/);
  const identityGrid = rule(".guestbook-identity-fields");
  const identityLabel = rule(".guestbook-identity-fields > label");
  const identityInput = rule(".guestbook-identity-fields input");

  assert.match(identityGrid, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(identityGrid, /align-items:\s*start/);
  assert.match(identityLabel, /align-self:\s*start/);
  assert.match(identityLabel, /align-content:\s*start/);
  assert.match(rule(".guestbook-form label"), /min-width:\s*0/);
  assert.match(inputRule, /min-height:\s*44px/);
  assert.match(inputRule, /font-size:\s*16px/);
  assert.match(identityInput, /height:\s*46px/);
  assert.match(identityInput, /min-height:\s*46px/);
});

test("lightbox blocks local native zoom without removing its accessible controls", () => {
  const lightbox = rule(".gallery-lightbox");

  assert.match(lightbox, /touch-action:\s*none/);
  assert.match(app, /addEventListener\("gesturestart", preventNativeZoom, \{ passive: false \}\)/);
  assert.match(app, /addEventListener\("gesturechange", preventNativeZoom, \{ passive: false \}\)/);
  assert.match(app, /onDoubleClick=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(app, /onPointerDown=/);
  assert.match(app, /onPointerUp=/);
  assert.match(app, /event\.key === "Escape"/);
});

test("the public invitation blocks page-wide native zoom while preserving vertical scroll and form editing", () => {
  const pageTouchContract = rule("html, body, #root, .app-shell");
  const pageZoomGuard = app.match(/function usePageZoomGuard\([\s\S]*?\n}\n\nfunction PhotoButton/)?.[0] ?? "";

  assert.match(pageTouchContract, /touch-action:\s*pan-y/);
  assert.match(pageZoomGuard, /function usePageZoomGuard/);
  assert.match(pageZoomGuard, /document\.addEventListener\("gesturestart", preventNativeZoom, \{ passive: false \}\)/);
  assert.match(pageZoomGuard, /document\.addEventListener\("gesturechange", preventNativeZoom, \{ passive: false \}\)/);
  assert.match(pageZoomGuard, /document\.addEventListener\("touchstart", preventMultiTouchZoom, \{ passive: false \}\)/);
  assert.match(pageZoomGuard, /document\.addEventListener\("touchmove", preventMultiTouchZoom, \{ passive: false \}\)/);
  assert.match(pageZoomGuard, /event\.touches\.length > 1/);
  assert.doesNotMatch(app, /function usePhotoZoomGuard/);
  assert.match(indexHtml, /maximum-scale=1/);
  assert.match(indexHtml, /user-scalable=no/);
  assert.match(css, /\.invitation input,\s*\.invitation textarea,\s*\.invitation \[contenteditable\]:not\(\[contenteditable="false"\]\)\s*\{[^}]*-webkit-user-select:\s*text[^}]*user-select:\s*text/);
});

test("visible invitation, copied and shared copy omit KST while calendar semantics remain internal", () => {
  assert.doesNotMatch(app, /KST|timezone\.label/);
  assert.doesNotMatch(actions, /KST|timezone\.label/);
  assert.match(actions, /DTSTART;TZID=\$\{content\.event\.timezone\.iana\}/);
});
