import { useEffect, useMemo, useRef, useState } from "react";
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
  Phone,
  ShareNetwork,
  Train,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import { getCalendarMonth, SESANG_STICKERS, WEDDING_PHOTOS, weddingContent } from "./content.js";
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

const PASTEL_HERO_LABEL = (
  <>
    <span className="photo-overlay-label-line">Our Wedding</span>
    <span className="photo-overlay-label-line is-day">Day</span>
  </>
);

function getVariant() {
  const value = new URLSearchParams(window.location.search).get("variant");
  return value === "pastel" ? "pastel" : "quiet";
}

function PhotoButton({ photo, index, openPhoto, registerTrigger, className = "", priority = false, sizes, overlayLabel }) {
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
      {overlayLabel && <span className="photo-overlay-label" aria-hidden="true">{overlayLabel}</span>}
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

function ScrollReveal({ children, className = "" }) {
  const nodeRef = useRef(null);
  const [visible, setVisible] = useState(() => (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    || new URLSearchParams(window.location.search).get("capture") === "1"
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
  const { year, month, weekdays } = weddingContent.calendar;
  const calendarDays = getCalendarMonth(weddingContent.calendar);
  const monthLabel = `${year}년 ${month}월`;

  return (
    <section className="calendar-pattern" aria-label={`${monthLabel} 예식 캘린더`}>
      <div className="calendar-heading">
        <p>{monthLabel}</p>
        <span>{weddingContent.calendar.day}일 {weddingContent.event.day} · {weddingContent.event.time} 예식</span>
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

function FamilyIntroduction() {
  return (
    <section className="family-introduction section-pad" aria-label="양가 가족 소개">
      {Object.values(weddingContent.familyContacts).map((side) => (
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
  const copyAccount = async (account) => {
    try {
      await copyText(account.number);
      notify(`${account.label} 계좌번호를 복사했습니다.`);
    } catch {
      notify("계좌번호를 복사하지 못했습니다. 잠시 후 다시 시도해 주세요.", "error");
    }
  };

  return (
    <div className="account-groups" aria-label="계좌 안내">
      {Object.values(weddingContent.accounts).map((account) => (
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
    </div>
  );
}

function ContactSection({ pastel = false, notify }) {
  return (
    <section className="contact-section section-pad" id="contact" aria-labelledby="contact-title">
      <div className="section-heading">
        <p className="eyebrow">CONTACT</p>
        <h2 id="contact-title">연락하기</h2>
      </div>
      <p className="contact-intro">축하의 마음을 전하실 분께 연락해 주세요.</p>
      <div className="contact-groups">
        {Object.values(weddingContent.familyContacts).map((side) => (
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
      <div className="transit-list">
        <div><Train aria-hidden="true" weight="light" /><p><strong>지하철 이용 시</strong><span>{weddingContent.transit.subway}</span></p></div>
        <div><Bus aria-hidden="true" weight="light" /><p><strong>셔틀버스 운행</strong><span>{weddingContent.transit.shuttle}</span></p></div>
        <div>
          <Car aria-hidden="true" weight="light" />
          <p>
            <strong>주차 안내</strong>
            <span>{weddingContent.transit.parking}</span>
            <span className="transit-detail">{weddingContent.transit.parkingRegistrationLocation}</span>
            <span className="transit-detail">{weddingContent.transit.parkingRegistration}</span>
          </p>
        </div>
      </div>
    </section>
  );
}

function BottomActions({ notify, pastel = false }) {
  const saveDate = async () => {
    try {
      const result = await saveCalendar(weddingContent);
      if (result === "shared-file") notify("일정 파일을 시스템 공유 메뉴로 전달했습니다.");
      if (result === "opened-file") notify("캘린더 일정 열기를 요청했습니다.");
    } catch {
      notify("일정을 준비하지 못했습니다.", "error");
    }
  };
  const share = async () => {
    try {
      const result = await shareInvitation(weddingContent, window.location.href);
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
      <ScrollReveal><BottomActions notify={notify} /></ScrollReveal>
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
  const photos = [WEDDING_PHOTOS.pastel.hero, ...WEDDING_PHOTOS.pastel.gallery];
  const gallery = usePhotoGallery();
  return (
    <article className="invitation pastel-invitation" data-variant="pastel">
      <PlaceholderBadge />
      <header className="pastel-hero">
        <div className="pastel-hero-intro">
          <p>저희 두 사람<br />새로운 시작을 함께합니다</p>
        </div>
        <PhotoButton
          photo={photos[0]}
          index={0}
          openPhoto={gallery.openPhoto}
          registerTrigger={gallery.registerTrigger}
          className="pastel-hero-photo is-inset-frame"
          priority
          sizes="(min-width: 768px) 370px, 86vw"
          overlayLabel={PASTEL_HERO_LABEL}
        />
        <div className="pastel-hero-copy">
          <h1>{weddingContent.couple.groom} <b aria-hidden="true">·</b> {weddingContent.couple.bride}</h1>
          <EventDate className="date-line" />
          <p className="pastel-venue-line">{weddingContent.venue.name}</p>
        </div>
      </header>
      <ScrollReveal><Greeting /></ScrollReveal>
      <ScrollReveal><FamilyIntroduction /></ScrollReveal>
      <ScrollReveal><PastelSchedule /></ScrollReveal>
      <ScrollReveal><PastelGallery gallery={gallery} photos={WEDDING_PHOTOS.pastel.gallery} /></ScrollReveal>
      <ScrollReveal>
        <section className="pastel-story section-pad" aria-labelledby="pastel-story-title">
          <div className="pastel-section-heading">
            <p className="eyebrow">OUR STORY</p>
            <h2 id="pastel-story-title">우리의 이야기</h2>
          </div>
          <p>{weddingContent.story.join(" ")}</p>
        </section>
      </ScrollReveal>
      <ScrollReveal><Location notify={notify} /></ScrollReveal>
      <ScrollReveal><ContactSection pastel notify={notify} /></ScrollReveal>
      <ScrollReveal><BottomActions notify={notify} pastel /></ScrollReveal>
      <footer className="pastel-footer">따뜻한 축복으로<br />자리를 빛내 주세요.</footer>
      {gallery.activeIndex !== null && <PhotoLightbox photos={photos} gallery={gallery} tone="pastel" />}
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
