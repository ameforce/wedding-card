import { WEDDING_PHOTOS } from "../content.js";

export const CONTENT_SCHEMA_VERSION = 2;
const SUPPORTED_CONTENT_SCHEMA_VERSIONS = new Set([1, CONTENT_SCHEMA_VERSION]);

const MAX_LENGTH = {
  name: 50,
  short: 80,
  copy: 240,
  photoAlt: 300,
  photoUrl: 2048,
  url: 2048,
  accountNumber: 40,
};

export const ACCOUNT_SIDES = Object.freeze(["groom", "bride"]);
export const ACCOUNT_SIDE_LABELS = Object.freeze({ groom: "신랑 측", bride: "신부 측" });
export const MAX_ACCOUNT_ENTRIES = 8;
export const REQUIRED_COPY_LINES = 4;
export const MIN_GALLERY_PHOTOS = 1;
const ACCOUNT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function updateRequiredCopyLine(lines, index, value) {
  const next = Array.isArray(lines) ? [...lines] : [];
  if (!Number.isInteger(index) || index < 0 || index >= REQUIRED_COPY_LINES) return next;
  if (index < next.length) {
    next[index] = value;
  } else if (value !== "") {
    while (next.length < index) next.push("");
    next.push(value);
  }
  return next;
}

export function removeEditableCopyLine(lines, index) {
  if (!Array.isArray(lines) || !Number.isInteger(index) || index < 0 || index >= lines.length) {
    return Array.isArray(lines) ? [...lines] : [];
  }
  return lines.filter((_, lineIndex) => lineIndex !== index);
}

const DAY_LABELS = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
export const EVENT_TIMEZONE = Object.freeze({ iana: "Asia/Seoul", utcOffset: "+09:00" });

const DIFF_FIELDS = [
  { section: "기본 정보", label: "신랑 이름", path: ["content", "couple", "groom"] },
  { section: "기본 정보", label: "신부 이름", path: ["content", "couple", "bride"] },
  { section: "상단 인사", label: "상단 인사", path: ["content", "hero", "introLines"] },
  { section: "예식 정보", label: "예식 날짜", path: ["content", "event", "dateLabel"] },
  { section: "예식 정보", label: "요일", path: ["content", "event", "day"] },
  { section: "예식 정보", label: "시작 시간", path: ["content", "event", "time"] },
  { section: "예식 정보", label: "예식장", path: ["content", "venue", "name"] },
  { section: "예식 정보", label: "층", path: ["content", "venue", "floor"] },
  { section: "예식 정보", label: "주소", path: ["content", "venue", "address"] },
  { section: "초대 문구", label: "인사말", path: ["content", "message"] },
  { section: "초대 문구", label: "우리의 이야기", path: ["content", "story"] },
  { section: "교통과 주차", label: "지하철", path: ["content", "transit", "subway"] },
  { section: "교통과 주차", label: "셔틀", path: ["content", "transit", "shuttle"] },
  { section: "교통과 주차", label: "주차", path: ["content", "transit", "parking"] },
  { section: "교통과 주차", label: "주차 등록 위치", path: ["content", "transit", "parkingRegistrationLocation"] },
  { section: "교통과 주차", label: "주차 등록 안내", path: ["content", "transit", "parkingRegistration"] },
  { section: "배경 음악", label: "배경 음악", path: ["content", "music"] },
  { section: "사진", label: "대표 사진", path: ["photos", "pastel", "hero"] },
  { section: "사진", label: "갤러리", path: ["photos", "pastel", "gallery"] },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentDocumentsEqual(current, applied) {
  return canonicalJson(current) === canonicalJson(applied);
}

function text(value, fallback, maxLength = MAX_LENGTH.copy) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : fallback;
}

function textLines(value, fallback, maxLines, maxLength = MAX_LENGTH.copy) {
  if (!Array.isArray(value) || value.length !== maxLines) return [...fallback];
  return value.map((line, index) => text(line, fallback[index], maxLength));
}

function editableTextLines(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  return value.map((line) => typeof line === "string" ? line.trim() : line);
}

function date(value, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

function time(value, fallback) {
  return /^\d{2}:\d{2}$/.test(value) ? value : fallback;
}

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function validClockTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value || "")) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export function deriveEventDisplay(isoDate, startTime24h) {
  if (!validCalendarDate(isoDate) || !validClockTime(startTime24h)) return null;
  const [year, month, day] = isoDate.split("-").map(Number);
  const [hour, minute] = startTime24h.split(":").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const period = hour < 12 ? "오전" : "오후";
  const displayHour = hour % 12 || 12;
  return {
    dateLabel: `${year}년 ${month}월 ${day}일`,
    day: DAY_LABELS[date.getUTCDay()],
    time: `${period} ${displayHour}시${minute ? ` ${minute}분` : ""}`,
  };
}

function valueAtPath(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

function mediaLabel(value, counterpart, current) {
  if (value === counterpart) return "같은 파일";
  return current ? "새 파일" : "기존 파일";
}

function displayDiffValue(value, counterpart, current) {
  if (Array.isArray(value)) return value.map((item, index) => displayDiffValue(item, counterpart?.[index], current)).join(" / ");
  if (value && typeof value === "object") {
    if (typeof value.title === "string") {
      return [value.title, value.artist, mediaLabel(value.src, counterpart?.src, current), value.sourceUrl, value.licenseLabel, value.licenseUrl]
        .filter(Boolean)
        .join(" · ");
    }
    if (typeof value.alt === "string") {
      return [value.alt, mediaLabel(value.src, counterpart?.src, current), value.position].filter(Boolean).join(" · ");
    }
    if (typeof value.bank === "string" || typeof value.number === "string") {
      return [`${value.bank ?? ""} ${value.number ?? ""}`.trim(), value.holder && `예금주 ${value.holder}`].filter(Boolean).join(" · ");
    }
    return JSON.stringify(value);
  }
  return String(value ?? "");
}

function accountDiffLabel(key, entry) {
  if (ACCOUNT_SIDE_LABELS[key]) return `${ACCOUNT_SIDE_LABELS[key]} 계좌`;
  const side = ACCOUNT_SIDE_LABELS[entry?.side] ?? "";
  return `${side ? `${side} ` : ""}${entry?.label || entry?.holder || key} 계좌`;
}

export function buildPublishDiff(currentDocument, publishedDocument) {
  const changes = DIFF_FIELDS.flatMap((field) => {
    const current = valueAtPath(currentDocument, field.path);
    const published = valueAtPath(publishedDocument, field.path);
    if (JSON.stringify(current) === JSON.stringify(published)) return [];
    return [{
      section: field.section,
      label: field.label,
      current: displayDiffValue(current, published, true),
      published: displayDiffValue(published, current, false),
    }];
  });
  const currentAccounts = currentDocument?.content?.accounts ?? {};
  const publishedAccounts = publishedDocument?.content?.accounts ?? {};
  const accountKeys = [...new Set([...Object.keys(currentAccounts), ...Object.keys(publishedAccounts)])];
  for (const key of accountKeys) {
    const current = currentAccounts[key];
    const published = publishedAccounts[key];
    if (JSON.stringify(current) === JSON.stringify(published)) continue;
    const suffix = !published ? " 추가" : !current ? " 삭제" : "";
    changes.push({
      section: "계좌 정보",
      label: `${accountDiffLabel(key, current ?? published)}${suffix}`,
      current: displayDiffValue(current, published, true),
      published: displayDiffValue(published, current, false),
    });
  }
  return {
    changes,
    sections: [...new Set(changes.map((change) => change.section))],
  };
}

export function validateEditableContentDocument(document, { allowLocalPreview = false } = {}) {
  const errors = {};
  const required = (value, path, maxLength = MAX_LENGTH.copy) => {
    if (typeof value !== "string" || !value.trim() || value.length > maxLength) errors[path] = `${path} 값을 확인해 주세요.`;
  };
  required(document?.content?.couple?.groom, "신랑 이름", MAX_LENGTH.name);
  required(document?.content?.couple?.bride, "신부 이름", MAX_LENGTH.name);
  if (!Array.isArray(document?.content?.hero?.introLines) || document.content.hero.introLines.length !== 2
    || document.content.hero.introLines.some((line) => typeof line !== "string" || !line.trim() || line.length > MAX_LENGTH.short)) {
    errors["상단 인사"] = "상단 인사는 두 줄 모두 입력해 주세요.";
  }
  const event = document?.content?.event;
  const derived = deriveEventDisplay(event?.isoDate, event?.startTime24h);
  if (!derived) errors["예식 일시"] = "유효한 예식 날짜와 시간을 입력해 주세요.";
  else if (event.dateLabel !== derived.dateLabel || event.day !== derived.day || event.time !== derived.time) {
    errors["예식 일시"] = "예식 표시 정보가 날짜와 시간에서 올바르게 파생되지 않았습니다.";
  } else if (event.timezone?.iana !== EVENT_TIMEZONE.iana || event.timezone?.utcOffset !== EVENT_TIMEZONE.utcOffset) {
    errors["예식 일시"] = "예식 시간대가 Asia/Seoul로 설정되지 않았습니다.";
  }
  required(document?.content?.venue?.name, "예식장", MAX_LENGTH.short);
  required(document?.content?.venue?.floor, "층", MAX_LENGTH.short);
  required(document?.content?.venue?.address, "주소");
  for (const [value, label] of [[document?.content?.message, "인사말"], [document?.content?.story, "우리의 이야기"]]) {
    if (!Array.isArray(value) || value.length !== REQUIRED_COPY_LINES || value.some((line) => typeof line !== "string" || !line.trim() || line.length > MAX_LENGTH.copy)) {
      errors[label] = `${label}은 1번째 줄부터 ${REQUIRED_COPY_LINES}번째 줄까지 모두 입력해 주세요.`;
    }
  }
  const allAccounts = document?.content?.accounts && typeof document.content.accounts === "object" && !Array.isArray(document.content.accounts)
    ? document.content.accounts
    : {};
  const accountNumberError = (label) => `${label} 계좌번호는 숫자와 하이픈(-)만 ${MAX_LENGTH.accountNumber}자 이내로 입력해 주세요.`;
  for (const side of ACCOUNT_SIDES) {
    const account = allAccounts[side];
    const sideLabel = ACCOUNT_SIDE_LABELS[side];
    required(account?.bank, `${sideLabel} 은행`, MAX_LENGTH.short);
    required(account?.holder, `${sideLabel} 예금주`, MAX_LENGTH.name);
    if (normalizeAccountNumber(account?.number) === null) errors[`${sideLabel} 계좌번호`] = accountNumberError(sideLabel);
  }
  const extraAccounts = Object.keys(allAccounts).filter((key) => !ACCOUNT_SIDES.includes(key));
  const perSideCount = { groom: 0, bride: 0 };
  extraAccounts.forEach((key) => {
    const account = allAccounts[key];
    const sideValid = ACCOUNT_SIDES.includes(account?.side);
    const side = sideValid ? account.side : "groom";
    perSideCount[side] += 1;
    const label = `${ACCOUNT_SIDE_LABELS[side]} 추가 계좌 ${perSideCount[side]}`;
    if (!sideValid) errors[`${label} 소속`] = `${label}의 소속(신랑 측/신부 측)을 확인해 주세요.`;
    if (!ACCOUNT_KEY_PATTERN.test(key) || account?.key !== key) {
      errors[`${label} 항목`] = `${label} 항목 키가 올바르지 않습니다.`;
    }
    required(account?.bank, `${label} 은행`, MAX_LENGTH.short);
    required(account?.holder, `${label} 예금주`, MAX_LENGTH.name);
    if (normalizeAccountNumber(account?.number) === null) errors[`${label} 계좌번호`] = accountNumberError(label);
  });
  if (Object.keys(allAccounts).length > MAX_ACCOUNT_ENTRIES) {
    errors["계좌 정보"] = `계좌는 최대 ${MAX_ACCOUNT_ENTRIES}개까지 추가할 수 있습니다.`;
  }
  Object.assign(errors, validateMusicContent(document?.content?.music, { allowLocalPreview }));
  const gallery = document?.photos?.pastel?.gallery;
  const galleryValid = Array.isArray(gallery) && gallery.length >= MIN_GALLERY_PHOTOS;
  if (!galleryValid) {
    errors["사진"] = `갤러리 사진은 최소 ${MIN_GALLERY_PHOTOS}장이 필요합니다.`;
  }
  const photos = [document?.photos?.pastel?.hero, ...(Array.isArray(gallery) ? gallery : [])];
  const seenSources = new Set();
  photos.forEach((photo, index) => {
    const label = index === 0 ? "상단 대표 사진" : `갤러리 ${index}`;
    const normalizedSource = photoUrl(photo?.src, allowLocalPreview);
    const sourceDescriptor = photoMediaDescriptor(photo?.src, allowLocalPreview);
    const ephemeralPreviewPhoto = allowLocalPreview && /^(?:data:image\/(?:jpeg|png|webp);base64,|blob:)/i.test(photo?.src || "");
    if (!normalizedSource) errors[`${label} 파일`] = `${label} 파일을 확인해 주세요.`;
    else if (!ephemeralPreviewPhoto && sourceDescriptor.width !== "480") errors[`${label} 파일`] = `${label} 기본 파일은 480px 파생본이어야 합니다.`;
    else if (seenSources.has(sourceDescriptor.identity)) errors[`${label} 파일`] = "같은 사진 파일을 갤러리에 중복해서 사용할 수 없습니다.";
    else seenSources.add(sourceDescriptor.identity);
    if ((!ephemeralPreviewPhoto && photo?.srcSet === undefined)
      || (photo?.srcSet !== undefined && !photoSrcSet(photo.srcSet, allowLocalPreview, sourceDescriptor?.identity))) {
      errors[`${label} 반응형 파일`] = `${label} 480px 및 960px 반응형 파일을 확인해 주세요.`;
    }
    if (photo?.sizes !== undefined && !photoSizes(photo.sizes)) errors[`${label} 표시 크기`] = `${label} 표시 크기를 확인해 주세요.`;
    if (!photo?.alt?.trim() || photo.alt.length > MAX_LENGTH.photoAlt) errors[`${label} 대체 텍스트`] = `${label} 대체 텍스트를 확인해 주세요.`;
    if (!cropPosition(photo?.position, "")) errors[`${label} 초점 위치`] = `${label} 초점 위치를 백분율 두 개로 입력해 주세요. 예: 50% 58%`;
  });
  return errors;
}

export const validateContentDocument = validateEditableContentDocument;

export function serializeContentDocument(document, { allowLocalPreview = false } = {}) {
  const serialized = clone(document);
  const derived = deriveEventDisplay(serialized?.content?.event?.isoDate, serialized?.content?.event?.startTime24h);
  if (derived) {
    Object.assign(serialized.content.event, derived);
    serialized.content.event.timezone = { ...EVENT_TIMEZONE };
  }
  const fieldErrors = validateContentDocument(serialized, { allowLocalPreview });
  if (Object.keys(fieldErrors).length > 0) {
    throw Object.assign(new Error(Object.values(fieldErrors)[0]), { code: "INVALID_CONTENT", fieldErrors });
  }
  return serialized;
}

function cropPosition(value, fallback) {
  if (typeof value !== "string") return fallback;
  const match = value.trim().match(/^(\d{1,3})%\s+(\d{1,3})%$/);
  if (!match || Number(match[1]) > 100 || Number(match[2]) > 100) return fallback;
  return `${Number(match[1])}% ${Number(match[2])}%`;
}

function normalizeAccountNumber(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, "");
  return normalized.length <= MAX_LENGTH.accountNumber && /^\d+(?:-\d+)*$/.test(normalized) ? normalized : null;
}

function normalizeAccount(value, fallback) {
  return {
    ...fallback,
    bank: text(value?.bank, fallback.bank, MAX_LENGTH.short),
    holder: text(value?.holder, fallback.holder, MAX_LENGTH.name),
    number: normalizeAccountNumber(value?.number) ?? fallback.number,
  };
}

function normalizeExtraAccount(key, value) {
  if (!ACCOUNT_KEY_PATTERN.test(key)) return null;
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    key,
    side: ACCOUNT_SIDES.includes(source.side) ? source.side : "groom",
    bank: text(source.bank, "", MAX_LENGTH.short),
    number: normalizeAccountNumber(source.number) ?? "",
    holder: text(source.holder, "", MAX_LENGTH.name),
  };
}

function photoUrl(value, allowLocalPreview) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (allowLocalPreview && value.length <= 2_000_000 && /^data:image\/(?:jpeg|png|webp);base64,/i.test(value)) return value;
  if (value.length > MAX_LENGTH.photoUrl) return null;
  if (/^blob:/i.test(value)) return allowLocalPreview ? value : null;
  return /^(?:\/assets\/photos\/[a-z0-9._-]+\.webp|\/api\/media\/invitation\/[a-f0-9-]{36}\/[a-z0-9-]{1,40}\/(?:480|960)\.webp)$/i.test(value) ? value : null;
}

function photoMediaDescriptor(value, allowLocalPreview = false) {
  if (!photoUrl(value, allowLocalPreview)) return null;
  const asset = value.match(/^\/assets\/photos\/(.+?)(?:-(480|960))?\.webp$/i);
  if (asset) return { identity: `asset:${asset[1].toLowerCase()}`, width: asset[2] || null };
  const uploaded = value.match(/^\/api\/media\/invitation\/([a-f0-9-]{36})\/([a-z0-9-]{1,40})\/(480|960)\.webp$/i);
  if (uploaded) return { identity: `upload:${uploaded[1].toLowerCase()}/${uploaded[2].toLowerCase()}`, width: uploaded[3] };
  return { identity: value, width: null };
}

function photoSrcSet(value, allowLocalPreview = false, sourceIdentity = null) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH.photoUrl) return null;
  const candidates = value.split(",").map((candidate) => candidate.trim().match(/^(\S+)\s+(480|960)w$/));
  if (candidates.length !== 2 || candidates.some((candidate) => !candidate)) return null;
  if (candidates[0][2] !== "480" || candidates[1][2] !== "960") return null;
  const descriptors = candidates.map((candidate) => photoMediaDescriptor(candidate[1], allowLocalPreview));
  if (descriptors.some((descriptor) => !descriptor)) return null;
  if (descriptors.some((descriptor, index) => descriptor.width !== candidates[index][2])) return null;
  const identity = descriptors[0].identity;
  if (descriptors.some((descriptor) => descriptor.identity !== identity) || (sourceIdentity && identity !== sourceIdentity)) return null;
  return value;
}

function photoSizes(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 300) return null;
  return /^(?!.*(?:javascript:|data:|<|>))[(),:\w\s.%-]+$/i.test(value) ? value : null;
}

function httpsUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_LENGTH.url) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function musicSrc(value, allowLocalPreview) {
  if (typeof value !== "string" || value.length < 1) return null;
  if (allowLocalPreview && value.length <= 36_000_000 && /^data:audio\/mpeg;base64,/i.test(value)) return value;
  if (allowLocalPreview && /^blob:/i.test(value)) return value;
  if (allowLocalPreview && /^local-review-audio:[a-f0-9-]{36}$/i.test(value)) return value;
  if (value.length > MAX_LENGTH.url) return null;
  return /^(?:\/assets\/audio\/[a-z0-9._-]+\.mp3|\/api\/media\/invitation\/[a-f0-9-]{36}\/background-music\/track\.mp3)$/i.test(value)
    ? value
    : null;
}

export function validateMusicContent(music, { allowLocalPreview = false } = {}) {
  const errors = {};
  if (!musicSrc(music?.src, allowLocalPreview)) errors.src = "업로드한 MP3 파일을 선택해 주세요.";
  if (typeof music?.title !== "string" || !music.title.trim() || music.title.length > MAX_LENGTH.short) errors.title = "곡명을 80자 이내로 입력해 주세요.";
  if (typeof music?.artist !== "string" || !music.artist.trim() || music.artist.length > MAX_LENGTH.short) errors.artist = "아티스트를 80자 이내로 입력해 주세요.";
  if (!httpsUrl(music?.sourceUrl)) errors.sourceUrl = "출처 URL은 HTTPS 주소여야 합니다.";
  if (typeof music?.licenseLabel !== "string" || !music.licenseLabel.trim() || music.licenseLabel.length > MAX_LENGTH.short) errors.licenseLabel = "라이선스명을 80자 이내로 입력해 주세요.";
  if (!httpsUrl(music?.licenseUrl)) errors.licenseUrl = "라이선스 URL은 HTTPS 주소여야 합니다.";
  return errors;
}

function normalizeMusic(value, fallback, { allowLocalPreview = false } = {}) {
  return {
    src: musicSrc(value?.src, allowLocalPreview) ?? fallback.src,
    title: text(value?.title, fallback.title, MAX_LENGTH.short),
    artist: text(value?.artist, fallback.artist, MAX_LENGTH.short),
    sourceUrl: httpsUrl(value?.sourceUrl) ?? fallback.sourceUrl,
    licenseLabel: text(value?.licenseLabel, fallback.licenseLabel, MAX_LENGTH.short),
    licenseUrl: httpsUrl(value?.licenseUrl) ?? fallback.licenseUrl,
  };
}

function normalizeEditablePhoto(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = { ...value };
  for (const key of ["src", "srcSet", "sizes", "alt", "position"]) {
    if (typeof normalized[key] === "string") normalized[key] = normalized[key].trim();
  }
  return normalized;
}

function basePhotos(content) {
  return content.photoMetadata ? clone(content.photoMetadata) : clone(WEDDING_PHOTOS);
}

/**
 * The Worker contract owns the full public document. The admin UI only edits a
 * narrow, reviewed subset, while every other public field is copied verbatim
 * from the bundled fallback document.
 */
export function createContentDocument(content) {
  const fullContent = clone(content);
  delete fullContent.photoMetadata;
  return {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    content: fullContent,
    photos: basePhotos(content),
  };
}

export function normalizeContentDocument(document, fallbackContent, options = {}) {
  const fallback = createContentDocument(fallbackContent);
  const hasSupportedDocument = SUPPORTED_CONTENT_SCHEMA_VERSIONS.has(document?.schemaVersion);
  const source = hasSupportedDocument ? document : {};
  const sourceContent = source.content ?? {};
  const event = sourceContent.event ?? {};
  const venue = sourceContent.venue ?? {};
  const transit = sourceContent.transit ?? {};
  const accounts = sourceContent.accounts ?? {};
  const sourcePhotos = source.photos ?? {};
  const content = clone(fallback.content);
  const photos = clone(fallback.photos);

  content.couple = {
    ...content.couple,
    groom: text(sourceContent.couple?.groom, content.couple.groom, MAX_LENGTH.short),
    bride: text(sourceContent.couple?.bride, content.couple.bride, MAX_LENGTH.short),
  };
  content.hero = {
    ...content.hero,
    introLines: textLines(sourceContent.hero?.introLines, content.hero.introLines, content.hero.introLines.length, MAX_LENGTH.short),
  };
  content.event = {
    ...content.event,
    isoDate: date(event.isoDate, content.event.isoDate),
    startTime24h: time(event.startTime24h, content.event.startTime24h),
    timezone: { ...EVENT_TIMEZONE },
  };
  const derivedEvent = deriveEventDisplay(content.event.isoDate, content.event.startTime24h);
  if (derivedEvent) Object.assign(content.event, derivedEvent);
  content.venue = {
    ...content.venue,
    name: text(venue.name, content.venue.name, MAX_LENGTH.short),
    floor: text(venue.floor, content.venue.floor, MAX_LENGTH.short),
    address: text(venue.address, content.venue.address, MAX_LENGTH.copy),
  };
  content.message = editableTextLines(sourceContent.message, content.message);
  content.story = editableTextLines(sourceContent.story, content.story);
  content.transit = {
    ...content.transit,
    subway: text(transit.subway, content.transit.subway),
    shuttle: text(transit.shuttle, content.transit.shuttle),
    parking: text(transit.parking, content.transit.parking),
    parkingRegistrationLocation: text(transit.parkingRegistrationLocation, content.transit.parkingRegistrationLocation),
    parkingRegistration: text(transit.parkingRegistration, content.transit.parkingRegistration),
  };
  content.accounts = {
    groom: normalizeAccount(accounts.groom, content.accounts.groom),
    bride: normalizeAccount(accounts.bride, content.accounts.bride),
  };
  for (const key of Object.keys(accounts)) {
    if (ACCOUNT_SIDES.includes(key)) continue;
    const extra = normalizeExtraAccount(key, accounts[key]);
    if (extra) content.accounts[key] = extra;
  }
  content.music = normalizeMusic(source.schemaVersion === CONTENT_SCHEMA_VERSION ? sourceContent.music : undefined, content.music, options);
  const sourceGallery = sourcePhotos.pastel?.gallery;
  photos.pastel = {
    ...photos.pastel,
    hero: hasSupportedDocument ? (normalizeEditablePhoto(sourcePhotos.pastel?.hero) ?? {}) : photos.pastel.hero,
    gallery: hasSupportedDocument
      ? (Array.isArray(sourceGallery) ? sourceGallery.map(normalizeEditablePhoto) : [])
      : photos.pastel.gallery,
  };

  return { schemaVersion: CONTENT_SCHEMA_VERSION, content, photos };
}

export function applyContentDocument(document, staticContent, options = {}) {
  const normalized = normalizeContentDocument(document, staticContent, options);
  return {
    ...normalized.content,
    photoMetadata: normalized.photos,
  };
}

export function getInvitationPhotos(content, variant) {
  return content.photoMetadata?.[variant] ?? WEDDING_PHOTOS[variant];
}

export function cloneContentDocument(document) {
  return clone(document);
}
