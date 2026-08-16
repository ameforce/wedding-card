import assert from "node:assert/strict";
import { test } from "node:test";
import { weddingContent } from "../src/content.js";
import { createCalendarFile, eventSummaryText, saveCalendar, shareInvitation } from "../src/invitation-actions.js";

test("calendar export preserves the confirmed Asia/Seoul start and does not infer an end time", () => {
  const calendar = createCalendarFile(weddingContent, new Date("2026-08-16T00:00:00.000Z"));

  assert.match(calendar, /DTSTART;TZID=Asia\/Seoul:20261227T150000/);
  assert.doesNotMatch(calendar, /DTEND/);
  assert.match(calendar, /SUMMARY:김종인 · 유지혜 결혼식/);
  assert.match(calendar, /LOCATION:더 바실리움\\, 경기 성남시 분당구 양현로 322/);
  assert.match(calendar, /DTSTAMP:20260816T000000Z/);
  assert.doesNotMatch(calendar, /KST/);
  assert.ok(calendar.endsWith("\r\n"));
});

test("shareable event summary contains confirmed date, venue and address without a visible timezone label", () => {
  assert.equal(
    eventSummaryText(weddingContent),
    "김종인 · 유지혜 결혼식\n2026년 12월 27일 일요일 오후 3시\n더 바실리움 · 경기 성남시 분당구 양현로 322",
  );
});

test("calendar action prefers a capability-checked native file share", async () => {
  const shared = [];
  let downloads = 0;
  const platform = {
    canShare(payload) {
      assert.equal(payload.files[0].type, "text/calendar;charset=utf-8");
      return true;
    },
    async share(payload) {
      shared.push(payload);
    },
  };

  const result = await saveCalendar(weddingContent, platform, () => { downloads += 1; });

  assert.equal(result, "shared-file");
  assert.equal(shared.length, 1);
  assert.equal(downloads, 0);
  assert.match(await shared[0].files[0].text(), /DTSTART;TZID=Asia\/Seoul:20261227T150000/);
});

test("calendar action treats native-share cancellation as final and does not download", async () => {
  let downloads = 0;
  const platform = {
    canShare: () => true,
    share: async () => { throw new DOMException("cancelled", "AbortError"); },
  };

  const result = await saveCalendar(weddingContent, platform, () => { downloads += 1; });

  assert.equal(result, "cancelled");
  assert.equal(downloads, 0);
});

test("calendar action gracefully downloads when native file sharing is unavailable or fails", async () => {
  for (const platform of [
    {},
    { share: async () => {}, canShare: () => false },
    { share: async () => {}, canShare: () => { throw new Error("blocked"); } },
    { share: async () => { throw new Error("target failed"); }, canShare: () => true },
  ]) {
    let downloads = 0;
    const result = await saveCalendar(weddingContent, platform, () => { downloads += 1; });
    assert.equal(result, "downloaded");
    assert.equal(downloads, 1);
  }
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
