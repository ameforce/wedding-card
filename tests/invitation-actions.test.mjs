import assert from "node:assert/strict";
import { test } from "node:test";
import { weddingContent } from "../src/content.js";
import { createCalendarFile, eventSummaryText } from "../src/invitation-actions.js";

test("calendar export uses the confirmed KST start and does not infer an end time", () => {
  const calendar = createCalendarFile(weddingContent, new Date("2026-08-16T00:00:00.000Z"));

  assert.match(calendar, /DTSTART;TZID=Asia\/Seoul:20261227T150000/);
  assert.doesNotMatch(calendar, /DTEND/);
  assert.match(calendar, /SUMMARY:김종인 · 유지혜 결혼식/);
  assert.match(calendar, /LOCATION:더 바실리움\\, 경기 성남시 분당구 양현로 322/);
  assert.match(calendar, /DTSTAMP:20260816T000000Z/);
  assert.ok(calendar.endsWith("\r\n"));
});

test("shareable event summary contains only confirmed date, timezone, venue and address", () => {
  assert.equal(
    eventSummaryText(weddingContent),
    "김종인 · 유지혜 결혼식\n2026년 12월 27일 일요일 오후 3시 KST\n더 바실리움 · 경기 성남시 분당구 양현로 322",
  );
});
