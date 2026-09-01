import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { getCalendarMonth, WEDDING_PHOTOS, weddingContent } from "../src/content.js";

const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const staticHeaders = await readFile(new URL("../public/_headers", import.meta.url), "utf8");
const guestbookApi = await readFile(new URL("../src/guestbook-api.js", import.meta.url), "utf8");
const guestbookAdmin = await readFile(new URL("../src/admin-content/GuestbookAdmin.jsx", import.meta.url), "utf8");
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("Pastel Letter is the fixed public default while Quiet remains an explicit regression route", () => {
  assert.match(app, /return value === "quiet" \? "quiet" : "pastel";/);
  assert.match(app, /if \(variant === "quiet"\) params\.set\("variant", "quiet"\);/);
  assert.match(app, /else params\.delete\("variant"\);/);
  assert.match(app, /title: "모바일 청첩장"/);
  assert.doesNotMatch(app, /function VariantSwitcher/);
  assert.doesNotMatch(app, /디자인 시안 선택|Wedding card design review|현재 시안 링크 복사|2 · Pastel Letter/);
  assert.doesNotMatch(css, /\.variant-switcher|\.variant-tabs|\.copy-review-link/);
});

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
  assert.equal(weddingContent.venue.floor, "8층");
  assert.equal("hall" in weddingContent.venue, false);
  assert.equal(weddingContent.venue.address, "경기 성남시 분당구 양현로 322");
  assert.equal(weddingContent.publishing.canonicalUrl, "https://wdcard.enmsoftware.com/");
  assert.equal(weddingContent.publishing.searchIndexing, false);
  assert.deepEqual(weddingContent.publishing.og, {
    title: "김종인 · 유지혜의 결혼식에 초대합니다",
    description: "2026년 12월 27일 일요일 오후 3시 · 더 바실리움 8층",
    image: "https://wdcard.enmsoftware.com/assets/og/wedding-card-1200x630.jpg",
    imageAlt: "야외 스튜디오에서 함께 미소 짓는 김종인과 유지혜",
    width: 1200,
    height: 630,
    type: "image/jpeg",
  });
  assert.deepEqual(weddingContent.rsvp, { enabled: false });
  assert.equal(weddingContent.isDesignPlaceholder, false);
  assert.deepEqual(weddingContent.unconfirmedContent, []);
  assert.deepEqual(weddingContent.message, [
    "서로를 아끼며 믿음으로",
    "한 걸음 한 걸음 함께 걷겠습니다.",
    "이 자리에 함께해 주시면",
    "더없는 기쁨이 되겠습니다.",
  ]);
  assert.deepEqual(weddingContent.story, [
    "처음 만난 순간부터",
    "서로의 하루가 되어주었고,",
    "같은 곳을 바라보며",
    "함께 계절을 걸어갑니다.",
  ]);
  assert.doesNotMatch(app, /weddingContent\.venue\.hall/);
  assert.match(app, /content\.venue\.name} · \{content\.venue\.floor/);
  assert.match(app, /shareInvitation\(content, content\.publishing\.canonicalUrl\)/);
  assert.doesNotMatch(app, /RSVP|참석 여부/);
});

test("public delivery declares a search indexing opt-out without blocking crawler access", () => {
  assert.match(html, /<meta name="robots" content="noindex,nofollow,noarchive,nosnippet,noimageindex" \/>/);
  assert.match(staticHeaders, /\/\*[\s\S]*X-Robots-Tag:\s*noindex, nofollow, noarchive, nosnippet, noimageindex/);
  assert.equal(existsSync(new URL("../public/robots.txt", import.meta.url)), false);
});

test("approved Open Graph metadata and image contract are production-ready", async () => {
  assert.match(html, /<link rel="canonical" href="https:\/\/wdcard\.enmsoftware\.com\/" \/>/);
  assert.match(html, /<meta property="og:title" content="김종인 · 유지혜의 결혼식에 초대합니다" \/>/);
  assert.match(html, /<meta property="og:description" content="2026년 12월 27일 일요일 오후 3시 · 더 바실리움 8층" \/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/wdcard\.enmsoftware\.com\/assets\/og\/wedding-card-1200x630\.jpg" \/>/);
  assert.match(html, /<meta property="og:image:width" content="1200" \/>/);
  assert.match(html, /<meta property="og:image:height" content="630" \/>/);
  const metadata = await sharp(fileURLToPath(new URL("../public/assets/og/wedding-card-1200x630.jpg", import.meta.url))).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 630);
});

test("production content guard passes after every public content contract is confirmed", () => {
  const result = spawnSync(process.execPath, ["scripts/check-content.mjs"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("confirmed family contacts are modeled once and exposed through accessible call and text actions", () => {
  const sides = Object.values(weddingContent.familyContacts);
  const contacts = sides.flatMap((side) => side.contacts);

  assert.equal(sides.length, 2);
  assert.deepEqual(sides.map((side) => side.childRole), ["장남", "장녀"]);
  assert.deepEqual(sides.map((side) => side.contacts.length), [3, 3]);
  assert.ok(contacts.every((contact) => /^010-\d{4}-\d{4}$/.test(contact.phone)));
  assert.match(app, /function FamilyIntroduction\(\)/);
  assert.match(app, /function ContactSection\(/);
  assert.match(app, /href=\{`tel:\$\{phone\}`\}/);
  assert.match(app, /href=\{`sms:\$\{phone\}`\}/);
  assert.match(app, /aria-label=\{`\$\{contact\.relation\} \$\{contact\.name\}에게 전화하기`\}/);
  assert.match(app, /aria-label=\{`\$\{contact\.relation\} \$\{contact\.name\}에게 문자 보내기`\}/);
  assert.match(app, /<ActionButton icon=\{Phone\} href="#contact">연락하기<\/ActionButton>/);
});

test("confirmed account details are modeled once for initially collapsed Pastel-only copy disclosures", () => {
  const accounts = Object.values(weddingContent.accounts);

  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts.map((account) => account.key), ["groom", "bride"]);
  assert.deepEqual(accounts.map((account) => account.holder), ["김종인", "유지혜"]);
  assert.ok(accounts.every((account) => account.bank.length > 0 && /^\d+$/.test(account.number)));
  assert.match(app, /function AccountGroups/);
  assert.match(app, /<section className="account-groups" aria-labelledby="account-title">/);
  assert.match(app, /<h3 id="account-title">마음 전하실 곳<\/h3>/);
  assert.match(app, /<details className=\{`contact-group account-group is-\$\{account\.key\}`\}/);
  assert.match(app, /copyText\(account\.number\)/);
  assert.match(app, /<ContactSection pastel notify=\{notify\} \/>/);
  assert.match(app, /<ScrollReveal><ContactSection \/><\/ScrollReveal>/);

  const accountGroups = app.match(/function AccountGroups\([\s\S]*?function ContactSection/)?.[0] ?? "";
  assert.doesNotMatch(accountGroups, /<details[^>]*\sopen(?:=|\s)/);
});

test("Pastel hero uses the approved local photo derivatives without reusing a gallery selection", async () => {
  const hero = WEDDING_PHOTOS.pastel.hero;

  assert.equal(hero.src, "/assets/photos/pastel-hero-480.webp");
  assert.equal(hero.srcSet, "/assets/photos/pastel-hero-480.webp 480w, /assets/photos/pastel-hero-960.webp 960w");
  assert.equal(hero.alt, "꽃잎이 흩날리는 야외에서 함께 선 신랑과 신부의 스튜디오 사진");
  assert.equal(hero.position, "50% 58%");
  assert.ok(WEDDING_PHOTOS.pastel.gallery.every((photo) => photo.src !== hero.src));

  for (const [name, width, height] of [["pastel-hero-480.webp", 480, 720], ["pastel-hero-960.webp", 960, 1439]]) {
    const asset = await sharp(fileURLToPath(new URL(`../public/assets/photos/${name}`, import.meta.url))).metadata();
    assert.equal(asset.format, "webp");
    assert.equal(asset.width, width);
    assert.equal(asset.height, height);
    assert.equal(asset.hasAlpha, false);
  }
});

test("priority photos remain hidden until the selected URL has loaded and decoded", async () => {
  const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(app, /await image\.decode\?\.\(\)/);
  assert.match(app, /image\.getAttribute\("src"\) === imageSource/);
  assert.match(app, /is-image-ready.*is-image-pending/);
  assert.match(css, /\.photo-button\.is-image-pending img\s*\{[^}]*opacity:\s*0/);
  assert.match(css, /\.photo-button\.is-image-ready img\s*\{[^}]*opacity:\s*1/);
  assert.match(css, /\.invitation-loading-hero\s*\{[^}]*aspect-ratio:\s*4\s*\/\s*5/);
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
  assert.match(app, /content\.calendar\.day}일 \{content\.event\.day} · \{content\.event\.time} 예식/);
  assert.match(app, /className="weekday-row"/);
  assert.match(app, /className="calendar-days"/);
  assert.match(app, /content\.event\.time} 예식/);
  assert.doesNotMatch(app, /date-dots/);
  assert.match(app, /className="pastel-schedule section-pad"/);
  assert.match(app, /id="pastel-schedule-title">예식 일정/);
  const pastelCalendarHeading = css.match(/\.pastel-schedule \.calendar-heading\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(pastelCalendarHeading, /flex-direction:\s*column/);
  assert.match(pastelCalendarHeading, /align-items:\s*center/);
  assert.match(pastelCalendarHeading, /gap:\s*2px/);
});

test("venue map keeps source metadata without a separate visible provider caption", () => {
  assert.deepEqual(weddingContent.venue.map, {
    localAssetPath: "/assets/map/venue-map.webp",
    alt: "더 바실리움 주변 실제 지도와 위치 핀",
    sourceAttribution: "카카오맵",
  });
  assert.ok(existsSync(new URL("../public/assets/map/venue-map.webp", import.meta.url)));
  assert.ok(!existsSync(new URL("../public/assets/design/abstract-map.webp", import.meta.url)));
  assert.match(app, /<img src=\{map\.localAssetPath\} alt=\{map\.alt\}/);
  assert.doesNotMatch(app, /sourceAttribution\}.*제공|카카오맵 제공/);
  assert.doesNotMatch(css, /\.map-frame figcaption/);
  assert.doesNotMatch(app, /DESIGN MAP|abstract-map|map-pin/);
  assert.match(css, /\.map-frame > img \{[^}]*aspect-ratio:\s*2\s*\/\s*1/);
  const pastelLocation = css.match(/\.pastel-invitation \.location-section\s*\{([^}]+)\}/)?.[1] ?? "";
  const pastelMap = css.match(/\.pastel-invitation \.map-frame\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(pastelLocation, /grid-template-columns:\s*1fr/);
  assert.match(pastelMap, /grid-column:\s*1/);
});

test("Pastel removes the redundant timeline and presents one full-width story", () => {
  assert.doesNotMatch(app, /weddingContent\.timeline|timeline-item|우리의 하루/);
  assert.match(app, /className="pastel-story section-pad"/);
  assert.match(app, /content\.story\.join\(" "\)/);

  const pastelStory = css.match(/\.pastel-story\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.doesNotMatch(pastelStory, /grid-template-columns/);
  assert.match(pastelStory, /text-align:\s*center/);
});

test("Pastel gallery uses portrait media and an accessible lightbox", () => {
  assert.match(app, /const photos = \[runtimePhotos\.pastel\.hero, \.\.\.runtimePhotos\.pastel\.gallery\]/);
  assert.match(app, /className="pastel-hero-photo is-inset-frame"/);
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

test("Pastel hero uses a breathing-room inset photo frame without a heavy treatment", () => {
  const pastelHero = css.match(/\.pastel-hero\s*\{([^}]+)\}/)?.[1] ?? "";
  const pastelHeroMedia = css.match(/\.pastel-hero-media\s*\{([^}]+)\}/)?.[1] ?? "";
  const pastelHeroPhoto = css.match(/\.pastel-hero-photo\s*\{([^}]+)\}/)?.[1] ?? "";
  const pastelHeroCopy = css.match(/\.pastel-hero-copy\s*\{([^}]+)\}/)?.[1] ?? "";
  const pastelHeroMarkup = app.match(/<header className="pastel-hero">([\s\S]*?)<\/header>/)?.[1] ?? "";

  assert.ok(pastelHeroMarkup.indexOf("pastel-hero-intro") < pastelHeroMarkup.indexOf("<PhotoButton"));
  assert.ok(pastelHeroMarkup.indexOf("<PhotoButton") < pastelHeroMarkup.indexOf("pastel-hero-copy"));
  assert.doesNotMatch(pastelHeroMarkup, /tiny-divider|name-divider/);
  assert.match(css, /\.pastel-invitation::before\s*\{[\s\S]*pastel-watercolor-surface\.webp/);
  assert.match(pastelHero, /overflow:\s*visible/);
  assert.match(pastelHero, /background:\s*transparent/);
  assert.match(pastelHeroCopy, /background:\s*transparent/);
  assert.doesNotMatch(pastelHeroCopy, /pastel-watercolor-wash|border|box-shadow/);
  assert.match(pastelHeroMedia, /width:\s*86%/);
  assert.match(pastelHeroMedia, /margin:\s*0\s+auto\s+clamp\(32px,\s*8vw,\s*40px\)/);
  assert.match(pastelHeroMedia, /overflow:\s*visible/);
  assert.match(pastelHeroPhoto, /width:\s*100%/);
  assert.match(pastelHeroPhoto, /border-radius:\s*50%\s+50%\s+18px\s+18px\s*\/\s*20%\s+20%\s+18px\s+18px/);
  assert.doesNotMatch(pastelHeroPhoto, /(?:border|box-shadow)\s*:/);
  assert.match(app, /const PASTEL_HERO_WORDMARK/);
  assert.match(app, /className="pastel-hero-wordmark" aria-label="Our Wedding Day"/);
  assert.match(app, /<span className="pastel-hero-wordmark-line" aria-hidden="true">Our Wedding<\/span>/);
  assert.match(app, /<span className="pastel-hero-wordmark-line is-day" aria-hidden="true">Day<\/span>/);
  assert.match(app, /\{PASTEL_HERO_WORDMARK\}/);
  const wordmark = css.match(/\.pastel-hero-wordmark\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(wordmark, /position:\s*absolute/);
  assert.match(wordmark, /font-family:\s*"Allison", cursive/);
  assert.match(wordmark, /--hero-wordmark-rotation:\s*-8deg/);
  assert.match(wordmark, /text-shadow:\s*0\s+1px\s+1px\s+rgba\(25,\s*38,\s*48,\s*\.16\)/);
  assert.match(css, /\.pastel-hero-wordmark-line\s*\{[^}]*scaleX\(1\.04\)\s+skewX\(-2deg\)/);
  assert.match(css, /\.pastel-hero-wordmark-line\.is-day\s*\{[^}]*margin-left:\s*clamp\(146px,\s*39vw,\s*166px\)/);
  assert.doesNotMatch(app, /overlayLabel|photo-overlay-label|PASTEL_HERO_LABEL/);
  assert.doesNotMatch(css, /Mrs Saint Delafield|hero-label-enter|photo-overlay-label/);
});

test("Pastel uses one continuous watercolor surface and an opt-in licensed audio control", () => {
  assert.ok(existsSync(new URL("../public/assets/design/pastel-paper-fibers.webp", import.meta.url)));
  assert.ok(existsSync(new URL("../public/assets/design/pastel-watercolor-surface.webp", import.meta.url)));
  assert.ok(existsSync(new URL("../public/assets/audio/touching-moments-one-pulse.mp3", import.meta.url)));
  assert.ok(existsSync(new URL("../docs/audio-license.md", import.meta.url)));
  assert.match(css, /@import "@fontsource\/allison\/400\.css"/);
  assert.doesNotMatch(css, /@fontsource\/mrs-saint-delafield/);
  assert.doesNotMatch(css, /@fontsource\/(?:sacramento|allura|parisienne|italianno|alex-brush)/);
  assert.match(css, /\.pastel-invitation\s*\{[^}]*isolation:\s*isolate/);
  assert.match(css, /\.pastel-invitation::before\s*\{[\s\S]*?pastel-watercolor-surface\.webp[\s\S]*?background-size:\s*100% 100%/);
  assert.doesNotMatch(css, /pastel-watercolor-wash\.webp|310% 100%/);
  assert.doesNotMatch(css, /radial-gradient/);
  assert.match(css, /\.pastel-invitation::after\s*\{[^}]*pastel-paper-fibers\.webp[^}]*234px 234px/);
  assert.match(css, /\.pastel-invitation > \*\s*\{[^}]*z-index:\s*1/);
  assert.match(app, /<audio[\s\S]*preload="none"[\s\S]*loop/);
  assert.doesNotMatch(app, /autoPlay|autoplay/);
  assert.equal(weddingContent.music.title, "Touching Moments One - Pulse");
  assert.equal(weddingContent.music.artist, "Kevin MacLeod");
  assert.equal(weddingContent.music.licenseUrl, "https://creativecommons.org/licenses/by/4.0/");
  assert.match(app, /src=\{music\.src\}/);
  assert.match(app, /href=\{music\.sourceUrl\}/);
  assert.match(app, /href=\{music\.licenseUrl\}/);
});

test("private guestbook recovery uses only name and password without exposing a receipt", () => {
  assert.doesNotMatch(app, /GUESTBOOK_RECEIPT_KEY|localStorage|접수 번호|copyText\(receipt\)/);
  assert.match(app, /unlockGuestbookEntry\(\{ name, password \}\)/);
  assert.match(app, /updateGuestbookEntry\(\{ name, password, message \}\)/);
  assert.match(guestbookApi, /"\/api\/guestbook\/entries\/unlock"/);
  assert.doesNotMatch(guestbookApi, /encodeURIComponent\(id\)|entries\/\$\{/);
  assert.match(guestbookApi, /메시지는 전송되지 않았습니다/);
});

test("guestbook labels, privacy break, and password guidance stay private without exposing hashing", () => {
  assert.match(app, /<h2 id="guestbook-title">방명록을 남겨주세요<\/h2>/);
  assert.match(app, /메시지는 공개되지 않으며<br\s*\/>신랑·신부만 확인할 수 있습니다/);
  assert.match(app, /minLength=\{4\} maxLength=\{72\}/);
  assert.match(app, /<small>4자 이상<\/small>/);
  assert.doesNotMatch(app, /단방향 해시|해시로만 보관/);
});

test("couple-only guestbook admin loads once on mount and reports a successful empty state", () => {
  assert.match(guestbookAdmin, /status: "loading",\s*entries: \[\],\s*count: 0/);
  assert.match(guestbookAdmin, /useEffect\(\(\) => \{ void load\(\); \}, \[load\]\)/);
  assert.doesNotMatch(guestbookAdmin, /인증 확인 후 불러오기/);
  assert.match(guestbookAdmin, /state\.status === "loading"/);
  assert.match(guestbookAdmin, /state\.status === "ready" && state\.entries\.length === 0/);
  assert.match(guestbookAdmin, /아직 도착한 방명록 메시지가 없습니다/);
  assert.match(guestbookAdmin, /aria-label="방명록 새로고침"/);
});

test("couple-only guestbook admin preserves auth-required and unavailable transitions", () => {
  assert.match(guestbookAdmin, /const totalCount = Number\.isFinite\(result\.totalCount\) \? result\.totalCount : result\.count/);
  assert.match(guestbookAdmin, /!Array\.isArray\(result\.entries\) \|\| !Number\.isFinite\(totalCount\)/);
  assert.match(guestbookAdmin, /statusFromError\(error\)/);
  assert.match(guestbookAdmin, /state\.status === "auth-required" \? \(/);
  assert.match(guestbookAdmin, /Google 계정으로 다시 로그인/);
  assert.match(guestbookAdmin, /\["error", "unavailable"\]\.includes\(state\.status\)/);
  assert.match(guestbookAdmin, /\["ready", "loading-more", "append-error"\]\.includes\(state\.status\) && state\.entries\.length > 0/);
});

test("public section motion stays active in Chrome while capture mode remains static", () => {
  assert.match(app, /function ScrollReveal/);
  assert.match(app, /new IntersectionObserver/);
  assert.doesNotMatch(app, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.section-reveal\s*\{[^}]*opacity:\s*0[^}]*translateY\(14px\)/);
  assert.match(css, /\.pastel-invitation > \.section-reveal \+ \.section-reveal\s*\{[^}]*margin-top:\s*28px/);
  assert.doesNotMatch(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.is-capture \.pastel-hero-wordmark\s*\{[^}]*animation:\s*none/);
  assert.match(css, /\.is-capture \.section-reveal\s*\{[^}]*opacity:\s*1[^}]*transform:\s*none/);
});

test("confirmed subway, shuttle and parking guidance is represented verbatim", () => {
  assert.deepEqual(weddingContent.transit, {
    subway: "수인분당선 야탑역 4번 출구에서 도보 400m",
    shuttle: "야탑역 4번 출구에서 10~15분 간격으로 운행",
    parking: "B2·B4 주차장 이용 · 2시간 무료",
    parkingRegistrationLocation: "웨딩홀·연회장 앞",
    parkingRegistration: "8층 웨딩홀 로비 주차등록 기기에서 등록",
  });
  assert.match(app, /content\.transit\.shuttle/);
  assert.match(app, /content\.transit\.parkingRegistrationLocation/);
  assert.match(app, /content\.transit\.parkingRegistration/);
});

test("Quiet photos use the same accessible lightbox contract", () => {
  assert.match(app, /const photos = \[runtimePhotos\.quiet\.hero, \.\.\.runtimePhotos\.quiet\.gallery\]/);
  assert.match(app, /<PhotoButton photo=\{photos\[0\]\}/);
  assert.match(app, /<PhotoLightbox photos=\{photos\} gallery=\{gallery\} tone="quiet"/);
  assert.match(css, /\.gallery-lightbox\.is-pastel/);
  assert.doesNotMatch(css, /background:\s*rgba\(18,\s*27,\s*38/);
});
