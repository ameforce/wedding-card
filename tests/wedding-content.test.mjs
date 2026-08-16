import assert from "node:assert/strict";
import { test } from "node:test";
import { weddingContent } from "../src/content.js";

test("user-confirmed wedding facts are represented without filling unknown fields", () => {
  assert.deepEqual(weddingContent.couple, { groom: "김종인", bride: "유지혜" });
  assert.deepEqual(weddingContent.event, {
    isoDate: "2026-12-27",
    date: "2026.12.27",
    dateLabel: "2026년 12월 27일",
    day: "일요일",
    time: "오후 3시",
    startTime24h: "15:00",
    timezone: {
      label: "KST",
      iana: "Asia/Seoul",
      utcOffset: "+09:00",
    },
  });
  assert.equal(weddingContent.venue.name, "더 바실리움");
  assert.equal(weddingContent.venue.address, "경기 성남시 분당구 양현로 322");
  assert.equal(weddingContent.isDesignPlaceholder, true);
});

test("all supplied map links are safe HTTPS destinations", () => {
  assert.deepEqual(weddingContent.venue.mapLinks, {
    naver: "https://naver.me/GOPesFwZ",
    kakao: "https://place.map.kakao.com/518455120",
    tmap: "https://tmap.life/03fe38e6",
  });

  for (const link of Object.values(weddingContent.venue.mapLinks)) {
    assert.equal(new URL(link).protocol, "https:");
  }
});

test("the event dot aligns to Sunday, December 27, 2026", () => {
  const { year, month, day } = weddingContent.calendar;
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const eventWeekday = new Date(`${weddingContent.event.isoDate}T00:00:00Z`).getUTCDay();
  const eventIndex = firstWeekday + day - 1;

  assert.equal(eventWeekday, 0);
  assert.equal(eventIndex, 28);
});
