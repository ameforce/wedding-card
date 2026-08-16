import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bus,
  CalendarBlank,
  CaretRight,
  Car,
  Check,
  Copy,
  MapPin,
  NavigationArrow,
  Phone,
  ShareNetwork,
  Train,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import { DESIGN_ASSETS, getCalendarMonth, SESANG_STICKERS, WEDDING_PHOTOS, weddingContent } from "./content.js";
import { copyText, saveCalendar, shareInvitation } from "./invitation-actions.js";

const VARIANTS = {
  quiet: {
    label: "1 · Quiet Editorial",
    description: "따뜻한 종이색과 절제된 편집 디자인",
  },
  pastel: {
    label: "2 · Pastel Letter",
    description: "파우더 블루와 블러시의 서정적인 편지",
  },
};

function getVariant() {
  const value = new URLSearchParams(window.location.search).get("variant");
  return value === "pastel" ? "pastel" : "quiet";
}

function PhotoButton({ photo, index, openPhoto, registerTrigger, className = "", priority = false, sizes }) {
  const broken = new URLSearchParams(window.location.search).get("brokenAsset") === "1";
  const [failed, setFailed] = useState(false);
  return (
    <button
      className={`photo-button ${className} ${failed ? "is-fallback" : ""}`}
      type="button"
      aria-label={`${index + 1}번째 사진 크게 보기`}
      ref={(node) => registerTrigger(index, node)}
      onClick={() => openPhoto(index)}
    >
      {!failed && (
        <img
          src={broken ? "/assets/design/missing-image.png" : photo.src}
          srcSet={broken ? undefined : photo.srcSet}
          sizes={sizes ?? photo.sizes}
          alt={photo.alt}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={priority ? "high" : "auto"}
          style={{ objectPosition: photo.position }}
          onError={() => setFailed(true)}
        />
      )}
      <span className="sr-only">사진 크게 보기</span>
    </button>
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
  const [visible, setVisible] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);

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
  return (
    <div className="placeholder-badge" role="note">
      DESIGN REVIEW · 일부 예식 정보 미확정
    </div>
  );
}

function CalendarPattern() {
  const { year, month, weekdays } = weddingContent.calendar;
  const calendarDays = getCalendarMonth(weddingContent.calendar);
  const monthLabel = `${year}년 ${month}월`;

  return (
    <section className="calendar-pattern" aria-label={`${monthLabel} 예식 캘린더`}>
      <div className="calendar-heading">
        <p>{monthLabel}</p>
        <span>{weddingContent.calendar.day}일 · {weddingContent.event.time} 예식</span>
      </div>
      <div className="weekday-row">
        {weekdays.map((weekday) => <span key={weekday}>{weekday}</span>)}
      </div>
      <div className="calendar-days">
        {calendarDays.map((calendarDay, index) => {
          if (!calendarDay) return <span className="calendar-day is-empty" aria-hidden="true" key={`empty-${index}`} />;

          const isEvent = calendarDay.isEvent;
          const label = `${month}월 ${calendarDay.date}일 ${weekdays[calendarDay.weekday]}요일${isEvent ? `, ${weddingContent.event.time} 예식` : ""}`;
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
  return (
    <section className="greeting section-pad" aria-labelledby="greeting-title">
      <p className="eyebrow" id="greeting-title">INVITATION</p>
      {weddingContent.message.map((line) => <p key={line}>{line}</p>)}
    </section>
  );
}

function EventDate({ className = "" }) {
  const dateTime = `${weddingContent.event.isoDate}T${weddingContent.event.startTime24h}:00${weddingContent.event.timezone.utcOffset}`;
  return (
    <time className={`event-date ${className}`} dateTime={dateTime}>
      <span className="event-date-primary">{weddingContent.event.dateLabel}</span>
      <span className="event-date-secondary">{weddingContent.event.day} · {weddingContent.event.time}</span>
    </time>
  );
}

function VenueMap() {
  const [failed, setFailed] = useState(false);
  const map = weddingContent.venue.map;
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
      <figcaption><strong>{map.sourceAttribution}</strong> 제공</figcaption>
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
    return <a className={`action-button ${className}`} href={href} target="_blank" rel="noreferrer" onClick={onClick} aria-label={ariaLabel}>{content}</a>;
  }

  return <button className={`action-button ${className}`} type="button" onClick={onClick} aria-label={ariaLabel}>{content}</button>;
}

function Location({ notify, compact = false }) {
  const openMap = (label) => notify(`${label}에서 ${weddingContent.venue.name}을 엽니다.`);
  const copyAddress = async () => {
    try {
      await copyText(weddingContent.venue.address);
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
        <strong>{weddingContent.venue.name}</strong>
        <span>{weddingContent.venue.address}</span>
        <button className="address-copy" type="button" onClick={copyAddress}>
          <Copy aria-hidden="true" weight="light" /> 주소 복사
        </button>
      </div>
      <div className="route-actions" aria-label="길찾기 서비스">
        <ActionButton icon={MapPin} href={weddingContent.venue.mapLinks.naver} onClick={() => openMap("네이버 지도")} ariaLabel="네이버 지도에서 길찾기">네이버</ActionButton>
        <ActionButton icon={NavigationArrow} href={weddingContent.venue.mapLinks.kakao} onClick={() => openMap("카카오맵")}>카카오맵</ActionButton>
        <ActionButton icon={NavigationArrow} href={weddingContent.venue.mapLinks.tmap} onClick={() => openMap("T map")}>T map</ActionButton>
      </div>
      {!compact && (
        <div className="transit-list">
          <div><Train aria-hidden="true" weight="light" /><p><strong>지하철 이용 시</strong><span>{weddingContent.transit.subway}</span></p></div>
          <div><Bus aria-hidden="true" weight="light" /><p><strong>버스 이용 시</strong><span>{weddingContent.transit.bus}</span></p></div>
          <div><Car aria-hidden="true" weight="light" /><p><strong>자가용 이용 시</strong><span>{weddingContent.transit.car}</span></p></div>
        </div>
      )}
    </section>
  );
}

function BottomActions({ notify, pastel = false, showCalendar = true }) {
  const unavailable = (label) => notify(`‘${label}’ 기능은 실제 정보 확정 후 활성화됩니다.`);
  const saveDate = async () => {
    try {
      const result = await saveCalendar(weddingContent);
      if (result === "shared-file") notify("일정 파일을 시스템 공유 메뉴로 전달했습니다.");
      if (result === "downloaded") notify("일정 파일을 저장했습니다. 파일을 열어 캘린더에 추가해 주세요.");
    } catch {
      notify("일정을 준비하지 못했습니다.", "error");
    }
  };
  const share = async () => {
    try {
      const result = await shareInvitation(weddingContent, window.location.href);
      if (result === "shared") notify("청첩장을 공유했습니다.");
      if (result === "copied") notify("공유할 내용과 링크를 복사했습니다.");
    } catch {
      notify("청첩장을 공유하지 못했습니다. 잠시 후 다시 시도해 주세요.", "error");
    }
  };
  return (
    <nav className={`bottom-actions ${pastel ? "is-pastel" : ""}`} aria-label="청첩장 주요 기능">
      <ActionButton icon={Phone} onClick={() => unavailable("연락하기")}>연락하기</ActionButton>
      {showCalendar && <ActionButton icon={CalendarBlank} onClick={saveDate}>일정 저장하기</ActionButton>}
      <ActionButton icon={ShareNetwork} onClick={share}>공유하기</ActionButton>
    </nav>
  );
}

function QuietInvitation({ notify }) {
  const photos = [WEDDING_PHOTOS.quiet.hero, ...WEDDING_PHOTOS.quiet.gallery];
  const gallery = usePhotoGallery();
  return (
    <article className="invitation quiet-invitation" data-variant="quiet">
      <PlaceholderBadge />
      <header className="quiet-hero section-pad">
        <p className="display-title" lang="en">OUR DAY</p>
        <PhotoButton photo={photos[0]} index={0} openPhoto={gallery.openPhoto} registerTrigger={gallery.registerTrigger} className="hero-photo is-arched" priority sizes="198px" />
        <h1>{weddingContent.couple.groom} <i aria-hidden="true">&amp;</i> {weddingContent.couple.bride}</h1>
        <EventDate className="date-line" />
        <p className="venue-line">{weddingContent.venue.name}</p>
      </header>
      <Greeting />
      <CalendarPattern />
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
      <Location notify={notify} compact />
      <BottomActions notify={notify} />
      {gallery.activeIndex !== null && <PhotoLightbox photos={photos} gallery={gallery} tone="quiet" />}
    </article>
  );
}

function CalendarAction({ notify }) {
  const saveDate = async () => {
    try {
      const result = await saveCalendar(weddingContent);
      if (result === "shared-file") notify("일정 파일을 시스템 공유 메뉴로 전달했습니다.");
      if (result === "downloaded") notify("일정 파일을 저장했습니다. 파일을 열어 캘린더에 추가해 주세요.");
    } catch {
      notify("일정을 준비하지 못했습니다.", "error");
    }
  };
  return (
    <section className="save-cards section-pad" aria-label="캘린더 저장">
      <ActionButton icon={CalendarBlank} trailingIcon={CaretRight} className="save-calendar-action" onClick={saveDate}>
        <strong>캘린더에 추가하기</strong><small>기기 환경에 따라 파일로 저장돼요</small>
      </ActionButton>
    </section>
  );
}

function PastelGallery() {
  const gallery = usePhotoGallery();
  const photos = WEDDING_PHOTOS.pastel.gallery;

  return (
    <>
      <section className="pastel-gallery-section section-pad" aria-labelledby="pastel-gallery-title">
        <div className="pastel-section-heading">
          <p className="eyebrow">OUR MOMENTS</p>
          <h2 id="pastel-gallery-title">우리의 순간</h2>
        </div>
        <div className="pastel-gallery">
          {photos.map((photo, index) => (
            <button
              className="pastel-gallery-item"
              type="button"
              aria-label={`${photos.length}장 중 ${index + 1}번째 사진 크게 보기`}
              ref={(node) => gallery.registerTrigger(index, node)}
              onClick={() => gallery.openPhoto(index)}
              key={photo.src}
            >
              <img
                src={photo.src}
                srcSet={photo.srcSet}
                sizes="(min-width: 768px) 169px, calc((100vw - 60px) / 2)"
                alt={photo.alt}
                loading="lazy"
                decoding="async"
                style={{ objectPosition: photo.position }}
              />
              <span aria-hidden="true">크게 보기</span>
            </button>
          ))}
        </div>
      </section>
      {gallery.activeIndex !== null && <PhotoLightbox photos={photos} gallery={gallery} tone="pastel" />}
    </>
  );
}

function PastelInvitation({ notify }) {
  return (
    <article className="invitation pastel-invitation" data-variant="pastel">
      <PlaceholderBadge />
      <header className="pastel-hero section-pad">
        <img className="watercolor-wash" src={DESIGN_ASSETS.pastelWash} alt="" aria-hidden="true" />
        <div className="pastel-hero-copy">
          <p>저희 두 사람<br />새로운 시작을 함께합니다</p>
          <span className="tiny-divider" aria-hidden="true" />
          <h1>{weddingContent.couple.groom} <b aria-hidden="true">·</b> {weddingContent.couple.bride}</h1>
          <span className="name-divider" aria-hidden="true" />
          <EventDate className="date-line" />
          <p className="pastel-venue-line">{weddingContent.venue.name}</p>
        </div>
      </header>
      <Greeting />
      <CalendarAction notify={notify} />
      <PastelGallery />
      <section className="pastel-story section-pad" aria-labelledby="pastel-story-title">
        <div className="pastel-section-heading">
          <p className="eyebrow">OUR STORY</p>
          <h2 id="pastel-story-title">우리의 이야기</h2>
        </div>
        <p>{weddingContent.story.join(" ")}</p>
      </section>
      <Location notify={notify} />
      <BottomActions notify={notify} pastel showCalendar={false} />
      <footer className="pastel-footer">따뜻한 축복으로<br />자리를 빛내 주세요.</footer>
    </article>
  );
}

function VariantSwitcher({ variant, onChange }) {
  return (
    <aside className="variant-switcher" aria-label="디자인 시안 선택">
      <div>
        <strong>Wedding card design review</strong>
        <span>{VARIANTS[variant].description}</span>
      </div>
      <div className="variant-tabs" role="group" aria-label="디자인 버전">
        {Object.entries(VARIANTS).map(([key, item]) => (
          <button
            className={key === variant ? "is-active" : ""}
            aria-pressed={key === variant}
            key={key}
            onClick={() => onChange(key)}
            type="button"
          >{item.label}</button>
        ))}
      </div>
    </aside>
  );
}

export function App() {
  const [variant, setVariant] = useState(getVariant);
  const [toast, setToast] = useState({ message: "", tone: "success" });
  const captureMode = useMemo(() => new URLSearchParams(window.location.search).get("capture") === "1", []);

  useEffect(() => {
    document.documentElement.dataset.variant = variant;
    document.title = `${weddingContent.couple.groom} · ${weddingContent.couple.bride} | ${VARIANTS[variant].label}`;
    const params = new URLSearchParams(window.location.search);
    params.set("variant", variant);
    window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
  }, [variant]);

  const notify = (message, tone = "success") => {
    setToast({ message, tone });
    window.clearTimeout(window.__weddingToastTimer);
    window.__weddingToastTimer = window.setTimeout(() => setToast({ message: "", tone: "success" }), 2800);
  };

  return (
    <main className={`app-shell ${captureMode ? "is-capture" : ""}`}>
      {!captureMode && <VariantSwitcher variant={variant} onChange={setVariant} />}
      <div className="invitation-stage">
        {variant === "pastel" ? <PastelInvitation notify={notify} /> : <QuietInvitation notify={notify} />}
      </div>
      <div className={`toast is-${toast.tone} ${toast.message ? "is-visible" : ""}`} role="status" aria-live="polite">
        {toast.tone === "error" ? <WarningCircle aria-hidden="true" weight="bold" /> : <Check aria-hidden="true" weight="bold" />}
        <span>{toast.message}</span>
      </div>
      {!captureMode && (
        <button className="copy-review-link" type="button" onClick={async () => {
          try {
            await copyText(window.location.href);
            notify("현재 시안 링크를 복사했습니다.");
          } catch {
            notify("현재 시안 링크를 복사하지 못했습니다.", "error");
          }
        }}>
          <Copy aria-hidden="true" /> 현재 시안 링크 복사
        </button>
      )}
    </main>
  );
}
