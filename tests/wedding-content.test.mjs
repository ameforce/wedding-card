import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { getCalendarMonth, weddingContent } from "../src/content.js";

const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

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

test("December 2026 calendar has all real dates and emphasizes Sunday the 27th", () => {
  const calendarDays = getCalendarMonth(weddingContent.calendar);
  const eventIndex = calendarDays.findIndex((calendarDay) => calendarDay?.isEvent);
  const eventDay = calendarDays[eventIndex];

  assert.deepEqual(weddingContent.calendar.weekdays, ["일", "월", "화", "수", "목", "금", "토"]);
  assert.equal(calendarDays.length, 35);
  assert.equal(calendarDays[2].date, 1);
  assert.equal(calendarDays[32].date, 31);
  assert.equal(eventIndex, 28);
  assert.deepEqual(eventDay, { date: 27, weekday: 0, isEvent: true });
  assert.match(app, /className="calendar-heading"/);
  assert.match(app, /className="weekday-row"/);
  assert.match(app, /className="calendar-days"/);
  assert.match(app, /weddingContent\.event\.time} 예식/);
  assert.doesNotMatch(app, /date-dots/);
});

test("venue map can render only the supplied real local asset with its attribution", () => {
  assert.deepEqual(weddingContent.venue.map, {
    localAssetPath: "/assets/map/venue-map.webp",
    alt: "더 바실리움 주변 실제 지도와 위치 핀",
    sourceAttribution: "카카오맵",
  });
  assert.ok(existsSync(new URL("../public/assets/map/venue-map.webp", import.meta.url)));
  assert.ok(!existsSync(new URL("../public/assets/design/abstract-map.webp", import.meta.url)));
  assert.match(app, /<img src=\{map\.localAssetPath\} alt=\{map\.alt\}/);
  assert.match(app, /지도 출처: \{map\.sourceAttribution\}/);
  assert.doesNotMatch(app, /DESIGN MAP|abstract-map|map-pin/);
  assert.match(css, /\.map-frame > img \{[^}]*aspect-ratio:\s*2\s*\/\s*1/);
  const caption = css.match(/\.map-frame figcaption\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.doesNotMatch(caption, /position\s*:\s*absolute/);

  const pastelLocation = css.match(/\.pastel-invitation \.location-section\s*\{([^}]+)\}/)?.[1] ?? "";
  const pastelMap = css.match(/\.pastel-invitation \.map-frame\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(pastelLocation, /grid-template-columns:\s*1fr/);
  assert.match(pastelMap, /grid-column:\s*1/);
});

test("Pastel removes the redundant timeline and presents one full-width story", () => {
  assert.doesNotMatch(app, /weddingContent\.timeline|timeline-item|우리의 하루/);
  assert.match(app, /className="pastel-story section-pad"/);
  assert.match(app, /weddingContent\.story\.join\(" "\)/);

  const pastelStory = css.match(/\.pastel-story\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.doesNotMatch(pastelStory, /grid-template-columns/);
  assert.match(pastelStory, /text-align:\s*center/);
});

test("Pastel gallery uses portrait media and an accessible lightbox", () => {
  assert.match(app, /className="pastel-gallery-item"/);
  assert.match(app, /role="dialog"/);
  assert.match(app, /aria-modal="true"/);
  assert.match(app, /aria-label="갤러리 닫기"/);
  assert.match(app, /aria-label="이전 사진"/);
  assert.match(app, /aria-label="다음 사진"/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /event\.key === "ArrowLeft"/);
  assert.match(app, /event\.key === "ArrowRight"/);
  assert.match(app, /onPointerDown=/);
  assert.match(app, /onPointerUp=/);
  assert.match(app, /onPointerCancel=/);
  assert.match(app, /Math\.abs\(endX - startX\) < 48/);

  const galleryItem = css.match(/\.pastel-gallery-item\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(galleryItem, /aspect-ratio:\s*3\s*\/\s*4/);
});
