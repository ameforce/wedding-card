import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { weddingContent } from "../src/content.js";
import {
  calendarLaunchHref,
  createCalendarFile,
  eventSummaryText,
  googleCalendarUrl,
  shareInvitation,
} from "../src/invitation-actions.js";

const actionsSource = await readFile(new URL("../src/invitation-actions.js", import.meta.url), "utf8");

const USER_AGENTS = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  ipadDesktopSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.101 Mobile/15E148 Safari/604.1",
  iphoneLine: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1 Line/14.12.0",
  iphoneDuckDuckGo: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 DuckDuckGo/7 Safari/605.1.15",
  iphoneKakaoTalk: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 25.7.0",
  androidKakaoTalk: "Mozilla/5.0 (Linux; Android 15; SM-S928N Build/AP3A.240905.015.A2; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.7339.51 Mobile Safari/537.36;KAKAOTALK 2502570",
  androidChrome: "Mozilla/5.0 (Linux; Android 15; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  windowsKakaoTalk: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 KAKAOTALK",
  windowsChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
};

test("calendar export keeps the confirmed Asia/Seoul start and ends exactly two hours later", () => {
  const calendar = createCalendarFile(weddingContent, new Date("2026-08-16T00:00:00.000Z"));

  assert.match(calendar, /DTSTART;TZID=Asia\/Seoul:20261227T150000/);
  assert.match(calendar, /DTEND;TZID=Asia\/Seoul:20261227T170000/);
  assert.match(calendar, /BEGIN:VTIMEZONE\r\nTZID:Asia\/Seoul\r\n/);
  assert.match(calendar, /TZOFFSETFROM:\+0900\r\nTZOFFSETTO:\+0900/);
  assert.match(calendar, /SUMMARY:김종인 · 유지혜 결혼식/);
  assert.match(calendar, /LOCATION:더 바실리움 8층\\, 경기 성남시 분당구 양현로 322/);
  assert.match(calendar, /DTSTAMP:20260816T000000Z/);
  assert.doesNotMatch(calendar, /KST/);
  assert.ok(calendar.endsWith("\r\n"));

  const longAddress = structuredClone(weddingContent);
  longAddress.venue.address = Array.from({ length: 6 }, () => "경기 성남시 분당구 양현로 322").join(" ");
  const folded = createCalendarFile(longAddress, new Date("2026-08-16T00:00:00.000Z"));
  for (const line of folded.split("\r\n")) {
    assert.ok(new TextEncoder().encode(line).length <= 75, `line exceeds 75 octets: ${line}`);
  }
  assert.ok(folded.replaceAll("\r\n ", "").includes(`LOCATION:더 바실리움 8층\\, ${longAddress.venue.address}\r\n`));
});

test("shareable event summary contains confirmed date, venue and address without a visible timezone label", () => {
  assert.equal(
    eventSummaryText(weddingContent),
    "김종인 · 유지혜 결혼식\n2026년 12월 27일 일요일 오후 3시\n더 바실리움 8층 · 경기 성남시 분당구 양현로 322",
  );
});

test("Google Calendar editor opens with every field filled and the two-hour window", () => {
  const url = new URL(googleCalendarUrl(weddingContent));

  assert.equal(`${url.origin}${url.pathname}`, "https://calendar.google.com/calendar/render");
  assert.equal(url.searchParams.get("action"), "TEMPLATE");
  assert.equal(url.searchParams.get("text"), "김종인 · 유지혜 결혼식");
  assert.equal(url.searchParams.get("dates"), "20261227T060000Z/20261227T080000Z");
  assert.equal(url.searchParams.get("ctz"), "Asia/Seoul");
  assert.equal(url.searchParams.get("details"), "2026년 12월 27일 일요일 오후 3시");
  assert.equal(url.searchParams.get("location"), "더 바실리움 8층, 경기 성남시 분당구 양현로 322");
});

test("calendar action opens each device's prefilled add-event screen", () => {
  const origin = "https://wdcard.enmsoftware.com";
  const google = googleCalendarUrl(weddingContent);
  const launch = (userAgent, options = {}) => calendarLaunchHref(weddingContent, {
    userAgent,
    maxTouchPoints: 0,
    origin,
    publishedFile: true,
    ...options,
  });

  assert.equal(launch(USER_AGENTS.iphoneSafari, { maxTouchPoints: 5 }), "/calendar.ics");
  assert.equal(launch(USER_AGENTS.ipadDesktopSafari, { maxTouchPoints: 5 }), "/calendar.ics");
  assert.equal(launch(USER_AGENTS.iphoneSafari, { maxTouchPoints: 5, publishedFile: false }), null);
  assert.equal(
    launch(USER_AGENTS.iphoneKakaoTalk, { maxTouchPoints: 5 }),
    `kakaotalk://web/openExternal?url=${encodeURIComponent(`${origin}/calendar.ics`)}`,
  );
  assert.equal(
    launch(USER_AGENTS.iphoneKakaoTalk, { maxTouchPoints: 5, publishedFile: false }),
    `kakaotalk://web/openExternal?url=${encodeURIComponent(google)}`,
  );
  assert.equal(launch(USER_AGENTS.androidKakaoTalk), `kakaotalk://web/openExternal?url=${encodeURIComponent(google)}`);
  for (const userAgent of [
    USER_AGENTS.iphoneChrome,
    USER_AGENTS.iphoneLine,
    USER_AGENTS.iphoneDuckDuckGo,
    USER_AGENTS.androidChrome,
    USER_AGENTS.windowsChrome,
    USER_AGENTS.windowsKakaoTalk,
    USER_AGENTS.macSafari,
  ]) {
    assert.equal(launch(userAgent), google, userAgent);
  }
});

test("calendar fallback does not force an attachment download", () => {
  assert.match(actionsSource, /new Blob\(\[calendar\], \{ type: "text\/calendar;charset=utf-8" \}\)/);
  assert.match(actionsSource, /anchor\.click\(\)/);
  assert.doesNotMatch(actionsSource, /anchor\.download/);
});

test("invitation sharing prefers the system share sheet and falls back to copying", async () => {
  const shares = [];
  const copied = [];
  const nativeResult = await shareInvitation(
    weddingContent,
    "https://example.test/invitation",
    { canShare: () => true, share: async (payload) => { shares.push(payload); } },
    async (text) => { copied.push(text); },
  );

  assert.equal(nativeResult, "shared");
  assert.equal(shares.length, 1);
  assert.equal(copied.length, 0);

  for (const platform of [
    {},
    { share: async () => {}, canShare: () => false },
    { share: async () => {}, canShare: () => { throw new Error("permissions policy"); } },
    { share: async () => { throw new Error("share failed"); }, canShare: () => true },
  ]) {
    const fallback = [];
    const result = await shareInvitation(
      weddingContent,
      "https://example.test/invitation",
      platform,
      async (text) => { fallback.push(text); },
    );
    assert.equal(result, "copied");
    assert.equal(fallback.length, 1);
    assert.match(fallback[0], /https:\/\/example\.test\/invitation$/);
  }
});

test("invitation share cancellation does not silently copy", async () => {
  let copied = 0;
  const result = await shareInvitation(
    weddingContent,
    "https://example.test/invitation",
    {
      canShare: () => true,
      share: async () => { throw new DOMException("cancelled", "AbortError"); },
    },
    async () => { copied += 1; },
  );

  assert.equal(result, "cancelled");
  assert.equal(copied, 0);
});
