import { WEDDING_PHOTOS } from "../content.js";

export const CONTENT_SCHEMA_VERSION = 1;

const MAX_LENGTH = {
  short: 80,
  copy: 240,
  photoAlt: 180,
  photoUrl: 2048,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function date(value, fallback) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

function time(value, fallback) {
  return /^\d{2}:\d{2}$/.test(value) ? value : fallback;
}

function timezone(value, fallback) {
  return /^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/.test(value) ? value : fallback;
}

function utcOffset(value, fallback) {
  return /^[+-]\d{2}:\d{2}$/.test(value) ? value : fallback;
}

function cropPosition(value, fallback) {
  return /^\d{1,3}%\s+\d{1,3}%$/.test(value) ? value : fallback;
}

function photoUrl(value, allowLocalPreview) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (allowLocalPreview && value.length <= 2_000_000 && /^data:image\/(?:jpeg|png|webp);base64,/i.test(value)) return value;
  if (value.length > MAX_LENGTH.photoUrl) return null;
  if (/^blob:/i.test(value)) return allowLocalPreview ? value : null;
  return /^(?:\/|https:\/\/)/i.test(value) ? value : null;
}

function photoSrcSet(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH.photoUrl) return null;
  return /^(?!.*(?:javascript:|data:|<))/i.test(value) ? value : null;
}

function normalizePhoto(value, fallback, { allowLocalPreview = false } = {}) {
  const normalized = {
    ...fallback,
    alt: text(value?.alt, fallback.alt, MAX_LENGTH.photoAlt),
    position: cropPosition(value?.position, fallback.position),
  };
  const src = photoUrl(value?.src, allowLocalPreview);
  const srcSet = photoSrcSet(value?.srcSet);
  const sizes = typeof value?.sizes === "string" && value.sizes.length <= 300 ? value.sizes : null;

  if (src) normalized.src = src;
  if (src?.startsWith("blob:") || src?.startsWith("data:")) delete normalized.srcSet;
  else if (srcSet) normalized.srcSet = srcSet;
  if (sizes) normalized.sizes = sizes;
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
  const source = document?.schemaVersion === CONTENT_SCHEMA_VERSION ? document : {};
  const sourceContent = source.content ?? {};
  const event = sourceContent.event ?? {};
  const venue = sourceContent.venue ?? {};
  const transit = sourceContent.transit ?? {};
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
    dateLabel: text(event.dateLabel, content.event.dateLabel, MAX_LENGTH.short),
    day: text(event.day, content.event.day, MAX_LENGTH.short),
    time: text(event.time, content.event.time, MAX_LENGTH.short),
    startTime24h: time(event.startTime24h, content.event.startTime24h),
    timezone: {
      ...content.event.timezone,
      iana: timezone(event.timezone?.iana, content.event.timezone.iana),
      utcOffset: utcOffset(event.timezone?.utcOffset, content.event.timezone.utcOffset),
    },
  };
  content.venue = {
    ...content.venue,
    name: text(venue.name, content.venue.name, MAX_LENGTH.short),
    floor: text(venue.floor, content.venue.floor, MAX_LENGTH.short),
    address: text(venue.address, content.venue.address, MAX_LENGTH.copy),
  };
  content.message = textLines(sourceContent.message, content.message, content.message.length);
  content.story = textLines(sourceContent.story, content.story, content.story.length);
  content.transit = {
    ...content.transit,
    subway: text(transit.subway, content.transit.subway),
    shuttle: text(transit.shuttle, content.transit.shuttle),
    parking: text(transit.parking, content.transit.parking),
    parkingRegistrationLocation: text(transit.parkingRegistrationLocation, content.transit.parkingRegistrationLocation),
    parkingRegistration: text(transit.parkingRegistration, content.transit.parkingRegistration),
  };
  photos.pastel = {
    ...photos.pastel,
    hero: normalizePhoto(sourcePhotos.pastel?.hero, photos.pastel.hero, options),
    gallery: photos.pastel.gallery.map((photo, index) => normalizePhoto(sourcePhotos.pastel?.gallery?.[index], photo, options)),
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
