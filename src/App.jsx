import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bus,
  CalendarBlank,
  CaretDown,
  Car,
  ChatText,
  Check,
  Copy,
  MapPin,
  NavigationArrow,
  Pause,
  Play,
  Phone,
  ShareNetwork,
  Train,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import { getCalendarMonth, SESANG_STICKERS, WEDDING_PHOTOS, weddingContent } from "./content.js";
import { ContentAdmin } from "./admin-content/ContentAdmin.jsx";
import { GuestbookAdmin } from "./admin-content/GuestbookAdmin.jsx";
import { getInvitationPhotos } from "./admin-content/content-document.js";
import { usePublicInvitationContent } from "./admin-content/public-content.jsx";
import { createGuestbookEntry, deleteGuestbookEntry, unlockGuestbookEntry, updateGuestbookEntry } from "./guestbook-api.js";
import { copyText, saveCalendar, shareInvitation } from "./invitation-actions.js";

const VARIANTS = {
  quiet: {
    title: "Quiet Editorial 회귀 검증",
  },
  pastel: {
    title: "모바일 청첩장",
  },
};

const WeddingRuntimeContext = createContext({ content: weddingContent, photos: WEDDING_PHOTOS });
const useWeddingRuntime = () => useContext(WeddingRuntimeContext);

const PASTEL_HERO_WORDMARK = (
  <span className="pastel-hero-wordmark" aria-label="Our Wedding Day">
    <span className="pastel-hero-wordmark-line" aria-hidden="true">Our Wedding</span>
    <span className="pastel-hero-wordmark-line is-day" aria-hidden="true">Day</span>
  </span>
);

function getVariant() {
  const value = new URLSearchParams(window.location.search).get("variant");
  return value === "quiet" ? "quiet" : "pastel";
}

function PhotoButton({ photo, index, openPhoto, registerTrigger, className = "", priority = false, sizes }) {
  const broken = new URLSearchParams(window.location.search).get("brokenAsset") === "1";
  const imageSource = broken ? "/assets/design/missing-image.png" : photo.src;
  const [imageState, setImageState] = useState(() => ({ source: imageSource, failed: false, ready: !priority }));
  const currentImageState = imageState.source === imageSource
    ? imageState
    : { source: imageSource, failed: false, ready: !priority };
  const { failed, ready } = currentImageState;
  const markReady = async (event) => {
    const image = event.currentTarget;
    try {
      await image.decode?.();
    } catch {
      // A successful load remains usable when decode() is unsupported or rejects.
    }
    if (image.getAttribute("src") === imageSource) {
      setImageState({ source: imageSource, failed: false, ready: true });
    }
  };
  return (
    <button
      className={`photo-button ${className} ${failed ? "is-fallback" : ""} ${ready ? "is-image-ready" : "is-image-pending"}`}
      type="button"
      aria-label={`${index + 1}번째 사진 크게 보기`}
      aria-busy={priority && !ready ? "true" : undefined}
      ref={(node) => {
        registerTrigger(index, node);
      }}
      onClick={() => openPhoto(index)}
      onDoubleClick={(event) => event.preventDefault()}
    >
      {!failed && (
        <img
          key={imageSource}
          src={imageSource}
          srcSet={broken ? undefined : photo.srcSet}
          sizes={sizes ?? photo.sizes}
          alt={photo.alt}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={priority ? "high" : "auto"}
          style={{ objectPosition: photo.position }}
          onLoad={markReady}
          onError={() => setImageState({ source: imageSource, failed: true, ready: false })}
        />
      )}
      <span className="sr-only">사진 크게 보기</span>
    </button>
  );
}

function InvitationLoadingShell({ captureMode }) {
  return (
    <main className={`app-shell invitation-loading-shell ${captureMode ? "is-capture" : ""}`} data-content-source="pending" aria-busy="true">
      <div className="invitation-stage">
        <div className="invitation-loading-paper">
          <div className="invitation-loading-hero" />
          <span className="sr-only" role="status">초대장을 불러오는 중입니다.</span>
        </div>
      </div>
    </main>
  );
}

function usePhotoGallery() {
  const [activeIndex, setActiveIndex] = useState(null);
  const triggerRefs = useRef([]);
  const openerIndexRef = useRef(null);
  const openPhoto = (index) => {
    openerIndexRef.current = index;
    setActiveIndex(index);
  };
  const registerTrigger = (index, node) => {
    triggerRefs.current[index] = node;
  };
  return { activeIndex, setActiveIndex, triggerRefs, openerIndexRef, openPhoto, registerTrigger };
}

function PhotoLightbox({ photos, gallery, tone }) {
  const lightboxRef = useRef(null);
  const closeButtonRef = useRef(null);
  const pointerStartXRef = useRef(null);
  const { activeIndex, setActiveIndex, triggerRefs, openerIndexRef } = gallery;
  const activePhoto = photos[activeIndex];

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const galleryTriggers = triggerRefs.current;
    const openerIndex = openerIndexRef.current;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    return () => {
      document.body.style.overflow = previousOverflow;
      galleryTriggers[openerIndex]?.focus();
    };
  }, [openerIndexRef, triggerRefs]);

  useEffect(() => {
    const lightbox = lightboxRef.current;
    if (!lightbox) return undefined;

    const preventNativeZoom = (event) => event.preventDefault();
    lightbox.addEventListener("gesturestart", preventNativeZoom, { passive: false });
    lightbox.addEventListener("gesturechange", preventNativeZoom, { passive: false });

    return () => {
      lightbox.removeEventListener("gesturestart", preventNativeZoom);
      lightbox.removeEventListener("gesturechange", preventNativeZoom);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setActiveIndex(null);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + photos.length) % photos.length);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % photos.length);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = [...lightboxRef.current.querySelectorAll("button")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [photos.length, setActiveIndex]);

  return createPortal(
    <div
      className={`gallery-lightbox is-${tone}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="gallery-lightbox-title"
      ref={lightboxRef}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setActiveIndex(null);
      }}
      onPointerDown={(event) => { pointerStartXRef.current = event.clientX; }}
      onPointerUp={(event) => {
        const startX = pointerStartXRef.current;
        const endX = event.clientX;
        pointerStartXRef.current = null;
        if (startX === null || Math.abs(endX - startX) < 48) return;
        setActiveIndex((index) => (
          endX < startX
            ? (index + 1) % photos.length
            : (index - 1 + photos.length) % photos.length
        ));
      }}
      onPointerCancel={() => { pointerStartXRef.current = null; }}
      onDoubleClick={(event) => event.preventDefault()}
    >
      <h2 className="sr-only" id="gallery-lightbox-title">웨딩 사진 크게 보기</h2>
      <button className="lightbox-close" type="button" aria-label="갤러리 닫기" ref={closeButtonRef} onClick={() => setActiveIndex(null)}>
        <X aria-hidden="true" weight="light" />
      </button>
      <figure className="lightbox-figure">
        <img src={activePhoto.src} srcSet={activePhoto.srcSet} sizes="min(88vw, 760px)" alt={activePhoto.alt} style={{ objectPosition: activePhoto.position }} />
        <figcaption aria-live="polite">{photos.length}장 중 {activeIndex + 1}번째 사진</figcaption>
      </figure>
      <button className="lightbox-control is-previous" type="button" aria-label="이전 사진" onClick={() => setActiveIndex((index) => (index - 1 + photos.length) % photos.length)}>
        <ArrowLeft aria-hidden="true" weight="light" />
      </button>
      <button className="lightbox-control is-next" type="button" aria-label="다음 사진" onClick={() => setActiveIndex((index) => (index + 1) % photos.length)}>
        <ArrowRight aria-hidden="true" weight="light" />
      </button>
    </div>,
    document.body,
  );
}

function SesangCameo({ asset, side }) {
  const nodeRef = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return undefined;
    const node = nodeRef.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "0px 0px -8%", threshold: 0.24 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div
      className={`sesang-cameo is-${side} ${visible ? "is-visible" : ""}`}
      ref={nodeRef}
      aria-hidden="true"
    >
      <span className="sesang-sticker-motion">
        <img src={asset} alt="" loading="lazy" decoding="async" />
      </span>
    </div>
  );
}

function PlaceholderBadge() {
  const { content } = useWeddingRuntime();
  if (!content.isDesignPlaceholder && content.unconfirmedContent?.length === 0) return null;
  return (
    <div className="placeholder-badge" role="note">
      DESIGN REVIEW · 일부 예식 정보 미확정
    </div>
  );
}

function ScrollReveal({ children, className = "" }) {
  const nodeRef = useRef(null);
  const [visible, setVisible] = useState(() => (
    new URLSearchParams(window.location.search).get("capture") === "1"
    || !("IntersectionObserver" in window)
  ));

  useEffect(() => {
    if (visible) return undefined;

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });

    if (nodeRef.current) observer.observe(nodeRef.current);
    return () => observer.disconnect();
  }, [visible]);

  return (
    <div ref={nodeRef} className={`section-reveal ${visible ? "is-visible" : ""} ${className}`.trim()}>
      {children}
    </div>
  );
}

function CalendarPattern() {
  const { content } = useWeddingRuntime();
  const { year, month, weekdays } = content.calendar;
  const calendarDays = getCalendarMonth(content.calendar);
  const monthLabel = `${year}년 ${month}월`;

  return (
    <section className="calendar-pattern" aria-label={`${monthLabel} 예식 캘린더`}>
      <div className="calendar-heading">
        <p>{monthLabel}</p>
        <span>{content.calendar.day}일 {content.event.day} · {content.event.time} 예식</span>
      </div>
      <div className="weekday-row">
        {weekdays.map((weekday) => <span key={weekday}>{weekday}</span>)}
      </div>
      <div className="calendar-days">
        {calendarDays.map((calendarDay, index) => {
          if (!calendarDay) return <span className="calendar-day is-empty" aria-hidden="true" key={`empty-${index}`} />;

          const isEvent = calendarDay.isEvent;
          const label = `${month}월 ${calendarDay.date}일 ${weekdays[calendarDay.weekday]}요일${isEvent ? `, ${content.event.time} 예식` : ""}`;
          return (
            <time
              className={`calendar-day ${calendarDay.weekday === 0 ? "is-sunday" : ""} ${isEvent ? "is-event" : ""}`}
              dateTime={`${year}-${String(month).padStart(2, "0")}-${String(calendarDay.date).padStart(2, "0")}`}
              aria-label={label}
              key={calendarDay.date}
            >
              {calendarDay.date}
            </time>
          );
        })}
      </div>
    </section>
  );
}

function Greeting() {
  const { content } = useWeddingRuntime();
  return (
    <section className="greeting section-pad" aria-labelledby="greeting-title">
      <p className="eyebrow" id="greeting-title">INVITATION</p>
      {content.message.map((line) => <p key={line}>{line}</p>)}
    </section>
  );
}

function FamilyIntroduction() {
  const { content } = useWeddingRuntime();
  return (
    <section className="family-introduction section-pad" aria-label="양가 가족 소개">
      {Object.values(content.familyContacts).map((side) => (
        <p key={side.label}>
          <span>{side.parents.join(" · ")}</span>의 {side.childRole} <strong>{side.childName}</strong>
        </p>
      ))}
    </section>
  );
}

function PastelSchedule() {
  return (
    <section className="pastel-schedule section-pad" aria-labelledby="pastel-schedule-title">
      <div className="pastel-section-heading">
        <p className="eyebrow">WEDDING DAY</p>
        <h2 id="pastel-schedule-title">예식 일정</h2>
      </div>
      <CalendarPattern />
    </section>
  );
}

function EventDate({ className = "" }) {
  const { content } = useWeddingRuntime();
  const dateTime = `${content.event.isoDate}T${content.event.startTime24h}:00${content.event.timezone.utcOffset}`;
  return (
    <time className={`event-date ${className}`} dateTime={dateTime}>
      <span className="event-date-primary">{content.event.dateLabel}</span>
      <span className="event-date-secondary">{content.event.day} · {content.event.time}</span>
    </time>
  );
}

function VenueMap() {
  const { content } = useWeddingRuntime();
  const [failed, setFailed] = useState(false);
  const map = content.venue.map;
  const canRenderMap = Boolean(map.localAssetPath && map.sourceAttribution && map.alt) && !failed;

  if (!canRenderMap) {
    return (
      <div className="map-frame is-pending" role="note">
        <span>실제 예식장 지도 이미지를 준비하고 있습니다.</span>
      </div>
    );
  }

  return (
    <figure className="map-frame">
      <img src={map.localAssetPath} alt={map.alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </figure>
  );
}

function ActionButton({ icon: Icon, trailingIcon: TrailingIcon, children, href, onClick, className = "", ariaLabel }) {
  const content = (
    <>
      <Icon className="action-icon" aria-hidden="true" weight="light" />
      <span>{children}</span>
      {TrailingIcon && <TrailingIcon className="action-trailing-icon" aria-hidden="true" weight="light" />}
    </>
  );

  if (href) {
    const opensExternalPage = /^https?:/i.test(href);
    return (
      <a
        className={`action-button ${className}`}
        href={href}
        target={opensExternalPage ? "_blank" : undefined}
        rel={opensExternalPage ? "noreferrer" : undefined}
        onClick={onClick}
        aria-label={ariaLabel}
      >
        {content}
      </a>
    );
  }

  return <button className={`action-button ${className}`} type="button" onClick={onClick} aria-label={ariaLabel}>{content}</button>;
}

function digitsOnly(phone) {
  return phone.replace(/\D/g, "");
}

function AccountGroups({ notify }) {
  const { content } = useWeddingRuntime();
  const copyAccount = async (account) => {
    try {
      await copyText(account.number);
      notify(`${account.label} 계좌번호를 복사했습니다.`);
    } catch {
      notify("계좌번호를 복사하지 못했습니다. 잠시 후 다시 시도해 주세요.", "error");
    }
  };

  return (
    <section className="account-groups" aria-labelledby="account-title">
      <div className="account-section-heading">
        <h3 id="account-title">마음 전하실 곳</h3>
      </div>
      {Object.values(content.accounts).map((account) => (
        <details className={`contact-group account-group is-${account.key}`} key={account.key}>
          <summary>
            <span className="group-summary-label">
              <span className="side-emoji" aria-hidden="true">{account.emoji}</span>
              <span>{account.label} 계좌</span>
            </span>
            <CaretDown aria-hidden="true" weight="light" />
          </summary>
          <div className="account-list">
            <div className="account-row">
              <div className="account-details">
                <strong>{account.bank} {account.number}</strong>
                <small>예금주 {account.holder}</small>
              </div>
              <button className="account-copy" type="button" onClick={() => copyAccount(account)} aria-label={`${account.label} 계좌번호 복사`}>
                <Copy aria-hidden="true" weight="light" />
                <span>복사</span>
              </button>
            </div>
          </div>
        </details>
      ))}
    </section>
  );
}

function ContactSection({ pastel = false, notify }) {
  const { content } = useWeddingRuntime();
  return (
    <section className="contact-section section-pad" id="contact" aria-labelledby="contact-title">
      <div className="section-heading">
        <p className="eyebrow">CONTACT</p>
        <h2 id="contact-title">연락하기</h2>
      </div>
      <p className="contact-intro">축하의 마음을 전하실 분께 연락해 주세요.</p>
      <div className="contact-groups">
        {Object.values(content.familyContacts).map((side) => (
          <details className={`contact-group ${pastel ? `is-${side.key}` : ""}`.trim()} key={side.label}>
            <summary>
              <span className="group-summary-label">
                {pastel && <span className="side-emoji" aria-hidden="true">{side.emoji}</span>}
                <span>{side.label} 연락처</span>
              </span>
              <CaretDown aria-hidden="true" weight="light" />
            </summary>
            <div className="contact-list">
              {side.contacts.map((contact) => {
                const phone = digitsOnly(contact.phone);
                return (
                  <div className="contact-row" key={`${side.label}-${contact.relation}`}>
                    <div className="contact-person">
                      <span>{contact.relation}</span>
                      <strong>{contact.name}</strong>
                      <small>{contact.phone}</small>
                    </div>
                    <div className="contact-actions">
                      <a href={`tel:${phone}`} aria-label={`${contact.relation} ${contact.name}에게 전화하기`}>
                        <Phone aria-hidden="true" weight="light" />
                      </a>
                      <a href={`sms:${phone}`} aria-label={`${contact.relation} ${contact.name}에게 문자 보내기`}>
                        <ChatText aria-hidden="true" weight="light" />
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </details>
        ))}
      </div>
      {pastel && <AccountGroups notify={notify} />}
    </section>
  );
}

function Location({ notify, compact = false }) {
  const { content } = useWeddingRuntime();
  const openMap = (label) => notify(`${label}에서 ${content.venue.name}을 엽니다.`);
  const copyAddress = async () => {
    try {
      await copyText(content.venue.address);
      notify("예식장 주소를 복사했습니다.");
    } catch {
      notify("주소를 복사하지 못했습니다. 잠시 후 다시 시도해 주세요.", "error");
    }
  };
  return (
    <section className={`location-section section-pad ${compact ? "is-compact" : ""}`} aria-labelledby="location-title">
      <div className="section-heading">
        <p className="eyebrow">LOCATION</p>
        <h2 id="location-title">오시는 길</h2>
      </div>
      <VenueMap />
      <div className="venue-copy">
        <strong>{content.venue.name} · {content.venue.floor}</strong>
        <span>{content.venue.address}</span>
        <button className="address-copy" type="button" onClick={copyAddress}>
          <Copy aria-hidden="true" weight="light" /> 주소 복사
        </button>
      </div>
      <div className="route-actions" aria-label="길찾기 서비스">
        <ActionButton icon={MapPin} href={content.venue.mapLinks.naver} onClick={() => openMap("네이버 지도")} ariaLabel="네이버 지도에서 길찾기">네이버</ActionButton>
        <ActionButton icon={NavigationArrow} href={content.venue.mapLinks.kakao} onClick={() => openMap("카카오맵")}>카카오맵</ActionButton>
        <ActionButton icon={NavigationArrow} href={content.venue.mapLinks.tmap} onClick={() => openMap("T map")}>T map</ActionButton>
      </div>
      <div className="transit-list">
        <div><Train aria-hidden="true" weight="light" /><p><strong>지하철 이용 시</strong><span>{content.transit.subway}</span></p></div>
        <div><Bus aria-hidden="true" weight="light" /><p><strong>셔틀버스 운행</strong><span>{content.transit.shuttle}</span></p></div>
        <div>
          <Car aria-hidden="true" weight="light" />
          <p>
            <strong>주차 안내</strong>
            <span>{content.transit.parking}</span>
            <span className="transit-detail">{content.transit.parkingRegistrationLocation}</span>
            <span className="transit-detail">{content.transit.parkingRegistration}</span>
          </p>
        </div>
      </div>
    </section>
  );
}

function BottomActions({ notify, pastel = false }) {
  const { content } = useWeddingRuntime();
  const saveDate = async () => {
    try {
      const result = await saveCalendar(content);
      if (result === "shared-file") notify("일정 파일을 시스템 공유 메뉴로 전달했습니다.");
      if (result === "opened-file") notify("캘린더 일정 열기를 요청했습니다.");
    } catch {
      notify("일정을 준비하지 못했습니다.", "error");
    }
  };
  const share = async () => {
    try {
      const result = await shareInvitation(content, content.publishing.canonicalUrl);
      if (result === "shared") notify("청첩장을 공유했습니다.");
      if (result === "copied") {
        notify(window.isSecureContext
          ? "시스템 공유를 사용할 수 없어 공유할 내용과 링크를 복사했습니다."
          : "현재 HTTP 미리보기에서는 시스템 공유를 열 수 없어 링크를 복사했습니다. HTTPS에서 다시 확인해 주세요.");
      }
    } catch {
      notify("청첩장을 공유하지 못했습니다. 잠시 후 다시 시도해 주세요.", "error");
    }
  };
  return (
    <nav className={`bottom-actions ${pastel ? "is-pastel" : ""}`} aria-label="청첩장 주요 기능">
      <ActionButton icon={Phone} href="#contact">연락하기</ActionButton>
      <ActionButton icon={CalendarBlank} onClick={saveDate}>캘린더 추가</ActionButton>
      <ActionButton icon={ShareNetwork} onClick={share}>공유하기</ActionButton>
    </nav>
  );
}

function MusicControl({ notify }) {
  const { content } = useWeddingRuntime();
  const music = content.music;
  return <MusicTrackControl key={music.src} music={music} notify={notify} />;
}

function MusicTrackControl({ music, notify }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      audio?.pause();
      if (audio) audio.currentTime = 0;
      audio?.load();
    };
  }, [music.src]);

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    try {
      await audio.play();
      setPlaying(true);
    } catch {
      notify("음악을 재생하지 못했습니다. 브라우저 설정을 확인해 주세요.", "error");
    }
  };

  return (
    <div className="music-control">
      <button type="button" onClick={togglePlayback} aria-pressed={playing} aria-label={playing ? "배경 음악 멈춤" : "배경 음악 재생"}>
        {playing ? <Pause aria-hidden="true" weight="fill" /> : <Play aria-hidden="true" weight="fill" />}
        <span>{playing ? "음악 멈춤" : "음악 재생"}</span>
      </button>
      <audio
        ref={audioRef}
        src={music.src}
        preload="none"
        loop
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
      />
    </div>
  );
}

function MusicCredit() {
  const { content } = useWeddingRuntime();
  const music = content.music;
  return (
    <p className="music-credit">
      BGM: <a href={music.sourceUrl} target="_blank" rel="noreferrer">{music.title}</a> — {music.artist} · <a href={music.licenseUrl} target="_blank" rel="noreferrer">{music.licenseLabel}</a>
    </p>
  );
}

function GuestbookSection({ notify }) {
  const [mode, setMode] = useState("write");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [busyAction, setBusyAction] = useState(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deleteTriggerRef = useRef(null);
  const deleteDialogRef = useRef(null);
  const deleteCancelRef = useRef(null);
  const busy = busyAction !== null;

  const closeDeleteConfirm = () => {
    if (busy) return;
    setDeleteError("");
    setDeleteConfirmOpen(false);
    requestAnimationFrame(() => deleteTriggerRef.current?.focus());
  };

  useEffect(() => {
    if (!deleteConfirmOpen) return undefined;
    const appRoot = document.getElementById("root");
    const wasInert = appRoot?.hasAttribute("inert") ?? false;
    const previousOverflow = document.body.style.overflow;
    appRoot?.setAttribute("inert", "");
    document.body.style.overflow = "hidden";
    deleteCancelRef.current?.focus();
    const keepFocusInside = (event) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        setDeleteConfirmOpen(false);
        requestAnimationFrame(() => deleteTriggerRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(deleteDialogRef.current?.querySelectorAll("button:not(:disabled)") ?? [])];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keepFocusInside);
    return () => {
      window.removeEventListener("keydown", keepFocusInside);
      if (!wasInert) appRoot?.removeAttribute("inert");
      document.body.style.overflow = previousOverflow;
    };
  }, [busy, deleteConfirmOpen]);

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setPassword("");
    setUnlocked(false);
    setDeleteError("");
    setDeleteConfirmOpen(false);
    if (nextMode === "write") {
      setName("");
      setMessage("");
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusyAction("submit");
    try {
      if (mode === "write") {
        await createGuestbookEntry({ name, password, message });
        setName("");
        setPassword("");
        setMessage("");
        notify("축하 메시지를 안전하게 전했습니다.");
      } else if (!unlocked) {
        const result = await unlockGuestbookEntry({ name, password });
        setName(result.entry.name);
        setMessage(result.entry.message);
        setUnlocked(true);
        notify("내 메시지를 불러왔습니다.");
      } else {
        await updateGuestbookEntry({ name, password, message });
        setPassword("");
        setUnlocked(false);
        notify("축하 메시지를 수정했습니다.");
      }
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setBusyAction(null);
    }
  };

  const remove = async () => {
    setDeleteError("");
    setBusyAction("delete");
    try {
      await deleteGuestbookEntry({ name, password });
      switchMode("write");
      notify("방명록을 삭제했습니다.");
    } catch (error) {
      setDeleteError(error.message);
      notify(error.message, "error");
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <section className="guestbook-section section-pad" aria-labelledby="guestbook-title">
      <div className="section-heading">
        <p className="eyebrow">PRIVATE GUESTBOOK</p>
        <h2 id="guestbook-title">방명록을 남겨주세요</h2>
      </div>
      <p className="guestbook-privacy">메시지는 공개되지 않으며<br />신랑·신부만 확인할 수 있습니다.</p>
      <div className="guestbook-tabs" role="group" aria-label="방명록 기능">
        <button type="button" className={mode === "write" ? "is-active" : ""} aria-pressed={mode === "write"} onClick={() => switchMode("write")}>새 메시지</button>
        <button type="button" className={mode === "edit" ? "is-active" : ""} aria-pressed={mode === "edit"} onClick={() => switchMode("edit")}>내 글 수정</button>
      </div>
      <form className="guestbook-form" onSubmit={submit}>
        <div className="guestbook-identity-fields">
          <label>
            <span>이름</span>
            <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={30} autoComplete="name" readOnly={unlocked} />
          </label>
          <label>
            <span>비밀번호</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={4} maxLength={72} autoComplete={mode === "write" ? "new-password" : "current-password"} />
            <small>4자 이상</small>
          </label>
        </div>
        {(mode === "write" || unlocked) && (
          <label>
            <span>축하 메시지</span>
            <textarea value={message} onChange={(event) => setMessage(event.target.value)} required minLength={1} maxLength={500} rows={5} />
          </label>
        )}
        <div className="guestbook-actions">
          <button className="guestbook-submit" type="submit" disabled={busy}>
            {busyAction === "submit" ? "처리 중…" : mode === "write" ? "비공개로 전하기" : unlocked ? "수정 저장" : "내 글 불러오기"}
          </button>
          {unlocked && (
            <button ref={deleteTriggerRef} className="guestbook-delete" type="button" disabled={busy} onClick={() => { setDeleteError(""); setDeleteConfirmOpen(true); }}>
              {busyAction === "delete" ? "삭제 중…" : "삭제"}
            </button>
          )}
        </div>
      </form>
      {deleteConfirmOpen && createPortal((
        <div className={`guestbook-delete-portal ${deleteTriggerRef.current?.closest(".pastel-invitation") ? "is-pastel" : "is-quiet"}`}>
        <div className="guestbook-delete-backdrop">
          <div ref={deleteDialogRef} className="guestbook-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="guestbook-delete-title" aria-describedby="guestbook-delete-description">
            <h3 id="guestbook-delete-title">이 방명록을 삭제할까요?</h3>
            <p id="guestbook-delete-description">삭제한 글은 복구할 수 없습니다.</p>
            {deleteError && <p className="guestbook-delete-error" role="alert">{deleteError}</p>}
            <div className="guestbook-delete-dialog-actions">
              <button
                ref={deleteCancelRef}
                type="button"
                disabled={busy}
                onClick={closeDeleteConfirm}
              >
                취소
              </button>
              <button className="is-destructive" type="button" disabled={busy} onClick={remove}>
                {busyAction === "delete" ? "삭제 중…" : "삭제하기"}
              </button>
            </div>
          </div>
        </div>
        </div>
      ), document.body)}
    </section>
  );
}

function QuietInvitation({ notify }) {
  const { content, photos: runtimePhotos } = useWeddingRuntime();
  const photos = [runtimePhotos.quiet.hero, ...runtimePhotos.quiet.gallery];
  const gallery = usePhotoGallery();
  return (
    <article className="invitation quiet-invitation" data-variant="quiet">
      <PlaceholderBadge />
      <header className="quiet-hero section-pad">
        <p className="display-title" lang="en">OUR DAY</p>
        <PhotoButton photo={photos[0]} index={0} openPhoto={gallery.openPhoto} registerTrigger={gallery.registerTrigger} className="hero-photo is-arched" priority sizes="198px" />
        <h1>{content.couple.groom} <i aria-hidden="true">&amp;</i> {content.couple.bride}</h1>
        <EventDate className="date-line" />
        <p className="venue-line">{content.venue.name} · {content.venue.floor}</p>
      </header>
      <ScrollReveal><Greeting /></ScrollReveal>
      <ScrollReveal><FamilyIntroduction /></ScrollReveal>
      <ScrollReveal><CalendarPattern /></ScrollReveal>
      <ScrollReveal>
        <section className="quiet-gallery section-pad" aria-label="웨딩 사진 갤러리">
          {photos.slice(1).map((photo, index) => (
            <PhotoButton
              photo={photo}
              index={index + 1}
              openPhoto={gallery.openPhoto}
              registerTrigger={gallery.registerTrigger}
              className={`quiet-photo photo-${["one", "two", "three"][index]}`}
              sizes="185px"
              key={photo.src}
            />
          ))}
          <SesangCameo asset={SESANG_STICKERS.left} side="left" />
        </section>
      </ScrollReveal>
      <ScrollReveal><Location notify={notify} compact /></ScrollReveal>
      <ScrollReveal><ContactSection /></ScrollReveal>
      <ScrollReveal><GuestbookSection notify={notify} /></ScrollReveal>
      <ScrollReveal><BottomActions notify={notify} /></ScrollReveal>
      <MusicCredit />
      {gallery.activeIndex !== null && <PhotoLightbox photos={photos} gallery={gallery} tone="quiet" />}
    </article>
  );
}

function PastelGallery({ gallery, photos }) {
  return (
    <section className="pastel-gallery-section section-pad" aria-labelledby="pastel-gallery-title">
      <div className="pastel-section-heading">
        <p className="eyebrow">OUR MOMENTS</p>
        <h2 id="pastel-gallery-title">우리의 순간</h2>
        <p className="gallery-hint">사진을 눌러 크게 보세요</p>
      </div>
      <div className="pastel-gallery">
        {photos.map((photo, index) => (
          <PhotoButton
            photo={photo}
            index={index + 1}
            openPhoto={gallery.openPhoto}
            registerTrigger={gallery.registerTrigger}
            className="pastel-gallery-item"
            sizes="(min-width: 768px) 169px, calc((100vw - 60px) / 2)"
            key={photo.src}
          />
        ))}
      </div>
    </section>
  );
}

function PastelInvitation({ notify }) {
  const { content, photos: runtimePhotos } = useWeddingRuntime();
  const photos = [runtimePhotos.pastel.hero, ...runtimePhotos.pastel.gallery];
  const gallery = usePhotoGallery();
  return (
    <article className="invitation pastel-invitation" data-variant="pastel">
      <PlaceholderBadge />
      <header className="pastel-hero">
        <div className="pastel-hero-intro">
          <p>{content.hero.introLines.map((line, index) => <span key={line}>{index > 0 && <br />}{line}</span>)}</p>
        </div>
        <div className="pastel-hero-media">
          <PhotoButton
            photo={photos[0]}
            index={0}
            openPhoto={gallery.openPhoto}
            registerTrigger={gallery.registerTrigger}
            className="pastel-hero-photo is-inset-frame"
            priority
            sizes="(min-width: 768px) 370px, 86vw"
          />
          {PASTEL_HERO_WORDMARK}
        </div>
        <div className="pastel-hero-copy">
          <h1>{content.couple.groom} <b aria-hidden="true">·</b> {content.couple.bride}</h1>
          <EventDate className="date-line" />
          <p className="pastel-venue-line">{content.venue.name} · {content.venue.floor}</p>
        </div>
      </header>
      <ScrollReveal><Greeting /></ScrollReveal>
      <ScrollReveal><FamilyIntroduction /></ScrollReveal>
      <ScrollReveal><PastelSchedule /></ScrollReveal>
      <ScrollReveal><PastelGallery gallery={gallery} photos={runtimePhotos.pastel.gallery} /></ScrollReveal>
      <ScrollReveal>
        <section className="pastel-story section-pad" aria-labelledby="pastel-story-title">
          <div className="pastel-section-heading">
            <p className="eyebrow">OUR STORY</p>
            <h2 id="pastel-story-title">우리의 이야기</h2>
          </div>
          <p>{content.story.join(" ")}</p>
        </section>
      </ScrollReveal>
      <ScrollReveal><Location notify={notify} /></ScrollReveal>
      <ScrollReveal><ContactSection pastel notify={notify} /></ScrollReveal>
      <ScrollReveal><GuestbookSection notify={notify} /></ScrollReveal>
      <ScrollReveal><BottomActions notify={notify} pastel /></ScrollReveal>
      <footer className="pastel-footer">따뜻한 축복으로<br />자리를 빛내 주세요.<MusicCredit /></footer>
      {gallery.activeIndex !== null && <PhotoLightbox photos={photos} gallery={gallery} tone="pastel" />}
    </article>
  );
}

function WeddingApp() {
  const [variant] = useState(getVariant);
  const runtime = usePublicInvitationContent(weddingContent);
  const runtimePhotos = useMemo(() => ({
    quiet: getInvitationPhotos(runtime.content, "quiet"),
    pastel: getInvitationPhotos(runtime.content, "pastel"),
  }), [runtime.content]);
  const [toast, setToast] = useState({ message: "", tone: "success" });
  const captureMode = useMemo(() => new URLSearchParams(window.location.search).get("capture") === "1", []);
  useEffect(() => {
    if (runtime.status !== "ready") return;
    document.documentElement.dataset.variant = variant;
    document.title = `${runtime.content.couple.groom} · ${runtime.content.couple.bride} | ${VARIANTS[variant].title}`;
    const params = new URLSearchParams(window.location.search);
    if (variant === "quiet") params.set("variant", "quiet");
    else params.delete("variant");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }, [runtime.content.couple.bride, runtime.content.couple.groom, runtime.status, variant]);

  const notify = (message, tone = "success") => {
    setToast({ message, tone });
    window.clearTimeout(window.__weddingToastTimer);
    window.__weddingToastTimer = window.setTimeout(() => setToast({ message: "", tone: "success" }), 2800);
  };

  if (runtime.status !== "ready") return <InvitationLoadingShell captureMode={captureMode} />;

  return (
    <WeddingRuntimeContext.Provider value={{ content: runtime.content, photos: runtimePhotos }}>
    <main
      className={`app-shell ${captureMode ? "is-capture" : ""}`}
      data-content-source={runtime.source}
      data-content-revision={runtime.revisionId || ""}
    >
      <div className="invitation-stage">
        {variant === "pastel" ? <PastelInvitation notify={notify} /> : <QuietInvitation notify={notify} />}
      </div>
      {!captureMode && <MusicControl notify={notify} />}
      <div className={`toast is-${toast.tone} ${toast.message ? "is-visible" : ""}`} role="status" aria-live="polite">
        {toast.tone === "error" ? <WarningCircle aria-hidden="true" weight="bold" /> : <Check aria-hidden="true" weight="bold" />}
        <span>{toast.message}</span>
      </div>
    </main>
    </WeddingRuntimeContext.Provider>
  );
}

export function App() {
  if (window.location.pathname === "/admin/guestbook") return <GuestbookAdmin />;
  if (["/admin", "/admin/content"].includes(window.location.pathname)) return <ContentAdmin />;
  return <WeddingApp />;
}
