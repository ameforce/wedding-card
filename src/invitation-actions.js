// The user confirmed on 2026-09-26 that calendar entries end exactly two hours
// after the published ceremony start. Keep this value in sync with worker/index.js.
export const CALENDAR_EVENT_DURATION_MINUTES = 120;
export const CALENDAR_FILE_PATH = "/calendar.ics";

const ICS_LINE_OCTET_LIMIT = 75;
const GOOGLE_CALENDAR_TEMPLATE_URL = "https://calendar.google.com/calendar/render";
const KAKAOTALK_EXTERNAL_BROWSER_URL = "kakaotalk://web/openExternal?url=";
// Only Safari itself hands a text/calendar response to the Calendar app. Other iOS
// browsers and in-app browsers run on WKWebView, so they receive the Google Calendar
// editor instead. Safari's user agent ends with its Safari token; in-app browsers
// usually append their own, and some browsers insert a token before it.
const SAFARI_USER_AGENT = /Version\/[\d.]+.*Safari\/[\d.]+$/;
const NON_SAFARI_APPLE_BROWSERS = /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|DuckDuckGo|Ddg\/|YaBrowser|Whale\//i;

function escapeIcsValue(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll(/\r?\n/g, "\\n");
}

function utf8Length(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

// RFC 5545 section 3.1: content lines stay within 75 octets and continuation
// lines begin with one space. Folding happens between code points, so a UTF-8
// sequence is never split.
function foldIcsLine(line) {
  const segments = [];
  let current = "";
  let octets = 0;
  for (const character of line) {
    const size = utf8Length(character);
    const limit = segments.length === 0 ? ICS_LINE_OCTET_LIMIT : ICS_LINE_OCTET_LIMIT - 1;
    if (octets + size > limit) {
      segments.push(current);
      current = "";
      octets = 0;
    }
    current += character;
    octets += size;
  }
  segments.push(current);
  return segments.join("\r\n ");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function utcOffsetMinutes(offset) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset || "");
  if (!match) throw new Error("invalid-utc-offset");
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function formatUtcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function formatLocalStamp(utcMilliseconds, offsetMinutes) {
  const local = new Date(utcMilliseconds + offsetMinutes * 60_000);
  return `${local.getUTCFullYear()}${pad(local.getUTCMonth() + 1)}${pad(local.getUTCDate())}`
    + `T${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}00`;
}

function formatIcsOffset(offsetMinutes) {
  const absolute = Math.abs(offsetMinutes);
  return `${offsetMinutes < 0 ? "-" : "+"}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`;
}

export function calendarEventWindow(content) {
  const [year, month, day] = content.event.isoDate.split("-").map(Number);
  const [hour, minute] = content.event.startTime24h.split(":").map(Number);
  const offsetMinutes = utcOffsetMinutes(content.event.timezone.utcOffset);
  const startMilliseconds = Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60_000;
  const endMilliseconds = startMilliseconds + CALENDAR_EVENT_DURATION_MINUTES * 60_000;
  return {
    start: new Date(startMilliseconds),
    end: new Date(endMilliseconds),
    localStart: formatLocalStamp(startMilliseconds, offsetMinutes),
    localEnd: formatLocalStamp(endMilliseconds, offsetMinutes),
    offsetMinutes,
  };
}

function calendarTitle(content) {
  return `${content.couple.groom} · ${content.couple.bride} 결혼식`;
}

function calendarDescription(content) {
  return `${content.event.dateLabel} ${content.event.day} ${content.event.time}`;
}

function calendarLocation(content) {
  const venueLabel = [content.venue.name, content.venue.floor].filter(Boolean).join(" ");
  return `${venueLabel}, ${content.venue.address}`;
}

export function createCalendarFile(content, now = new Date()) {
  const eventWindow = calendarEventWindow(content);
  const offset = formatIcsOffset(eventWindow.offsetMinutes);
  const uidDate = content.event.isoDate.replaceAll("-", "");

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Wedding Card//Invitation//KO",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VTIMEZONE",
    `TZID:${content.event.timezone.iana}`,
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    `TZOFFSETFROM:${offset}`,
    `TZOFFSETTO:${offset}`,
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    `UID:${uidDate}-${content.couple.groom}-${content.couple.bride}@wedding-card.local`,
    `DTSTAMP:${formatUtcStamp(now)}`,
    `DTSTART;TZID=${content.event.timezone.iana}:${eventWindow.localStart}`,
    `DTEND;TZID=${content.event.timezone.iana}:${eventWindow.localEnd}`,
    `SUMMARY:${escapeIcsValue(calendarTitle(content))}`,
    `DESCRIPTION:${escapeIcsValue(calendarDescription(content))}`,
    `LOCATION:${escapeIcsValue(calendarLocation(content))}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].map(foldIcsLine).join("\r\n");
}

export function googleCalendarUrl(content) {
  const eventWindow = calendarEventWindow(content);
  const parameters = [
    ["action", "TEMPLATE"],
    ["text", calendarTitle(content)],
    ["dates", `${formatUtcStamp(eventWindow.start)}/${formatUtcStamp(eventWindow.end)}`],
    ["ctz", content.event.timezone.iana],
    ["details", calendarDescription(content)],
    ["location", calendarLocation(content)],
  ];
  const query = parameters.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `${GOOGLE_CALENDAR_TEMPLATE_URL}?${query}`;
}

function describeCalendarDevice(userAgent, maxTouchPoints) {
  const agent = String(userAgent || "");
  // iPadOS Safari reports a desktop Macintosh user agent; touch support separates it from macOS.
  const apple = /iPhone|iPad|iPod/i.test(agent) || (/Macintosh/i.test(agent) && maxTouchPoints > 1);
  // The external-browser scheme is a mobile KakaoTalk feature; desktop builds get the Google editor.
  const kakaoTalk = /KAKAOTALK/i.test(agent) && (apple || /Android/i.test(agent));
  const appleSafari = apple
    && !kakaoTalk
    && SAFARI_USER_AGENT.test(agent.trim())
    && !NON_SAFARI_APPLE_BROWSERS.test(agent);
  return { apple, kakaoTalk, appleSafari };
}

function absoluteUrl(path, origin) {
  try {
    return new URL(path, origin).href;
  } catch {
    return null;
  }
}

// Every device opens an add-event screen with all fields filled in. The visitor
// still confirms with one save tap because the web cannot write to a calendar
// silently. Returns null when Safari should open the browser-built file instead
// of the Worker file, which serves only the published revision.
export function calendarLaunchHref(content, {
  userAgent = globalThis.navigator?.userAgent ?? "",
  maxTouchPoints = globalThis.navigator?.maxTouchPoints ?? 0,
  origin = globalThis.location?.origin ?? "",
  publishedFile = false,
} = {}) {
  const device = describeCalendarDevice(userAgent, maxTouchPoints);
  const googleUrl = googleCalendarUrl(content);
  if (device.kakaoTalk) {
    // KakaoTalk's in-app browser cannot pass .ics files to Calendar and may block
    // Google sign-in, so the same destination opens in the external browser.
    const calendarFile = device.apple && publishedFile ? absoluteUrl(CALENDAR_FILE_PATH, origin) : null;
    return `${KAKAOTALK_EXTERNAL_BROWSER_URL}${encodeURIComponent(calendarFile ?? googleUrl)}`;
  }
  if (device.appleSafari) return publishedFile ? CALENDAR_FILE_PATH : null;
  return googleUrl;
}

export function eventSummaryText(content) {
  const venueLabel = [content.venue.name, content.venue.floor].filter(Boolean).join(" ");
  return [
    `${content.couple.groom} · ${content.couple.bride} 결혼식`,
    `${content.event.dateLabel} ${content.event.day} ${content.event.time}`,
    `${venueLabel} · ${content.venue.address}`,
  ].join("\n");
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Local-network previews may not expose the secure Clipboard API.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy-failed");
}

export function openCalendarFile(content) {
  const calendar = createCalendarFile(content);
  const blob = new Blob([calendar], { type: "text/calendar;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

export async function shareInvitation(content, url, platform = navigator, fallback = copyText) {
  const payload = {
    title: `${content.couple.groom} · ${content.couple.bride} 결혼식`,
    text: eventSummaryText(content),
    url,
  };

  let canSharePayload = Boolean(platform.share);
  if (canSharePayload && typeof platform.canShare === "function") {
    try {
      canSharePayload = platform.canShare(payload);
    } catch {
      canSharePayload = false;
    }
  }

  if (canSharePayload) {
    try {
      await platform.share(payload);
      return "shared";
    } catch (error) {
      if (error?.name === "AbortError") return "cancelled";
    }
  }

  await fallback(`${payload.text}\n${url}`);
  return "copied";
}
