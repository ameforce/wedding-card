function escapeIcsValue(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll(/\r?\n/g, "\\n");
}

function compactDate(value) {
  return value.replaceAll("-", "");
}

function compactTime(value) {
  return value.replace(":", "") + "00";
}

function formatUtcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function createCalendarFile(content, now = new Date()) {
  const summary = `${content.couple.groom} · ${content.couple.bride} 결혼식`;
  const description = `${content.event.dateLabel} ${content.event.day} ${content.event.time}`;
  const uidDate = compactDate(content.event.isoDate);

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Wedding Card//Invitation//KO",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uidDate}-${content.couple.groom}-${content.couple.bride}@wedding-card.local`,
    `DTSTAMP:${formatUtcStamp(now)}`,
    `DTSTART;TZID=${content.event.timezone.iana}:${uidDate}T${compactTime(content.event.startTime24h)}`,
    `SUMMARY:${escapeIcsValue(summary)}`,
    `DESCRIPTION:${escapeIcsValue(description)}`,
    `LOCATION:${escapeIcsValue(`${content.venue.name}, ${content.venue.address}`)}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

export function eventSummaryText(content) {
  return [
    `${content.couple.groom} · ${content.couple.bride} 결혼식`,
    `${content.event.dateLabel} ${content.event.day} ${content.event.time}`,
    `${content.venue.name} · ${content.venue.address}`,
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

export function downloadCalendar(content) {
  const calendar = createCalendarFile(content);
  const blob = new Blob([calendar], { type: "text/calendar;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `${content.event.isoDate}-${content.couple.groom}-${content.couple.bride}.ics`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 0);
}

function calendarFilename(content) {
  return `${content.event.isoDate}-${content.couple.groom}-${content.couple.bride}.ics`;
}

function createCalendarShareFile(content) {
  if (typeof File !== "function") return null;
  return new File(
    [createCalendarFile(content)],
    calendarFilename(content),
    { type: "text/calendar;charset=utf-8" },
  );
}

export async function saveCalendar(content, platform = navigator, fallback = downloadCalendar) {
  const file = createCalendarShareFile(content);
  const payload = file
    ? { title: `${content.couple.groom} · ${content.couple.bride} 결혼식 일정`, files: [file] }
    : null;

  // There is no cross-platform browser API that inserts an event into the
  // user's default calendar. When the current browser/OS explicitly reports
  // that it can share an iCalendar file, hand the file to its native chooser.
  if (payload && platform.share && platform.canShare) {
    let canShareCalendar = false;
    try {
      canShareCalendar = platform.canShare(payload);
    } catch {
      canShareCalendar = false;
    }

    if (canShareCalendar) {
      try {
        await platform.share(payload);
        return "shared-file";
      } catch (error) {
        if (error?.name === "AbortError") return "cancelled";
      }
    }
  }

  fallback(content);
  return "downloaded";
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
