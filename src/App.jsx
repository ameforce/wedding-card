import { useEffect, useMemo, useRef, useState } from "react";
import {
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
} from "@phosphor-icons/react";
import { DESIGN_ASSETS, SESANG_STICKERS, WEDDING_PHOTOS, weddingContent } from "./content.js";

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

function ImageSlot({ asset, className = "", crop, label = "실제 사진으로 교체될 디자인 자리", priority = false }) {
  const broken = new URLSearchParams(window.location.search).get("brokenAsset") === "1";
  const [failed, setFailed] = useState(false);
  const source = asset ?? { src: DESIGN_ASSETS.quietLight, alt: "", position: crop ?? "center" };
  return (
    <figure className={`image-slot ${asset ? "has-photo" : ""} ${className} ${failed ? "is-fallback" : ""}`}>
      {!failed && (
        <img
          src={broken ? "/assets/design/missing-image.png" : source.src}
          srcSet={broken ? undefined : source.srcSet}
          sizes={source.sizes}
          alt={source.alt}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={priority ? "high" : "auto"}
          style={{ objectPosition: crop ?? source.position }}
          onError={() => setFailed(true)}
        />
      )}
      {!asset && <figcaption className="sr-only">{label}</figcaption>}
      {!asset && <span className="crop-mark" aria-hidden="true" />}
    </figure>
  );
}

function SesangCameo({ asset, side, variant = "peek" }) {
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
      className={`sesang-cameo is-${side} is-${variant} ${visible ? "is-visible" : ""}`}
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
  const { year, month, day, weekdays } = weddingContent.calendar;
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const eventIndex = firstWeekday + day - 1;
  const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;

  return (
    <section className="calendar-pattern" aria-label={`${year}년 ${month}월 ${day}일 ${weddingContent.event.day} 예식 캘린더`}>
      <div className="weekday-row" aria-hidden="true">
        {weekdays.map((weekday) => <span key={weekday}>{weekday}</span>)}
      </div>
      <div className="date-dots" aria-hidden="true">
        {Array.from({ length: cellCount }, (_, index) => (
          <span className={index === eventIndex ? "is-event" : ""} key={index} />
        ))}
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

function ActionButton({ icon: Icon, trailingIcon: TrailingIcon, children, href, onClick, className = "" }) {
  const content = (
    <>
      <Icon className="action-icon" aria-hidden="true" weight="light" />
      <span>{children}</span>
      {TrailingIcon && <TrailingIcon className="action-trailing-icon" aria-hidden="true" weight="light" />}
    </>
  );

  if (href) {
    return <a className={`action-button ${className}`} href={href} target="_blank" rel="noreferrer" onClick={onClick}>{content}</a>;
  }

  return <button className={`action-button ${className}`} type="button" onClick={onClick}>{content}</button>;
}

function Location({ notify, compact = false }) {
  const openMap = (label) => notify(`${label}에서 ${weddingContent.venue.name}을 엽니다.`);
  return (
    <section className={`location-section section-pad ${compact ? "is-compact" : ""}`} aria-labelledby="location-title">
      <div className="section-heading">
        <p className="eyebrow">LOCATION</p>
        <h2 id="location-title">오시는 길</h2>
      </div>
      <div className="map-frame">
        <img src={DESIGN_ASSETS.map} alt="실제 주소가 아닌 디자인용 추상 지도" loading="lazy" decoding="async" />
        <MapPin className="map-pin" aria-hidden="true" weight="fill" />
        <span className="map-label">DESIGN MAP</span>
      </div>
      <div className="venue-copy">
        <strong>{weddingContent.venue.name}</strong>
        <span>{weddingContent.venue.address}</span>
      </div>
      <div className="route-actions" aria-label="길찾기 서비스">
        <ActionButton icon={MapPin} href={weddingContent.venue.mapLinks.naver} onClick={() => openMap("네이버 지도")}>네이버 지도</ActionButton>
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

function BottomActions({ notify, pastel = false }) {
  const unavailable = (label) => notify(`‘${label}’ 기능은 실제 정보 확정 후 활성화됩니다.`);
  return (
    <nav className={`bottom-actions ${pastel ? "is-pastel" : ""}`} aria-label="청첩장 주요 기능">
      <ActionButton icon={Phone} onClick={() => unavailable("연락하기")}>연락하기</ActionButton>
      <ActionButton icon={CalendarBlank} onClick={() => unavailable("일정 저장")}>일정 저장하기</ActionButton>
      <ActionButton icon={ShareNetwork} onClick={() => unavailable("공유")}>공유하기</ActionButton>
    </nav>
  );
}

function QuietInvitation({ notify }) {
  return (
    <article className="invitation quiet-invitation" data-variant="quiet">
      <PlaceholderBadge />
      <header className="quiet-hero section-pad">
        <p className="display-title" lang="en">OUR DAY</p>
        <ImageSlot asset={WEDDING_PHOTOS.quiet.hero} className="hero-photo is-arched" priority />
        <h1>{weddingContent.couple.groom} <i aria-hidden="true">&amp;</i> {weddingContent.couple.bride}</h1>
        <p className="date-line">{weddingContent.event.date} · {weddingContent.event.day} {weddingContent.event.time}</p>
        <p className="venue-line">{weddingContent.venue.name}</p>
      </header>
      <Greeting />
      <SesangCameo asset={SESANG_STICKERS.left} side="left" />
      <CalendarPattern />
      <section className="quiet-gallery section-pad" aria-label="웨딩 사진 갤러리">
        <ImageSlot asset={WEDDING_PHOTOS.quiet.gallery[0]} className="quiet-photo photo-one" />
        <ImageSlot asset={WEDDING_PHOTOS.quiet.gallery[1]} className="quiet-photo photo-two" />
        <ImageSlot asset={WEDDING_PHOTOS.quiet.gallery[2]} className="quiet-photo photo-three" />
      </section>
      <SesangCameo asset={SESANG_STICKERS.right} side="right" />
      <Location notify={notify} compact />
      <SesangCameo asset={SESANG_STICKERS.sleep} side="left" variant="sleep" />
      <BottomActions notify={notify} />
    </article>
  );
}

function SaveCards({ notify }) {
  const pendingCalendarDetails = "타임존과 예식 종료 시각 확정 후 일정 저장을 활성화할 수 있어요.";
  return (
    <section className="save-cards section-pad" aria-label="날짜와 캘린더 저장">
      <ActionButton icon={CalendarBlank} className="save-date-action" onClick={() => notify(pendingCalendarDetails)}>
        <strong>날짜 기억하기</strong><small>소중한 날을 기억해 주세요.</small>
      </ActionButton>
      <ActionButton icon={CalendarBlank} trailingIcon={CaretRight} className="save-calendar-action" onClick={() => notify(pendingCalendarDetails)}>
        <strong>캘린더에 저장하기</strong><small>iCalendar 파일 준비 예정</small>
      </ActionButton>
    </section>
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
          <p className="date-line">{weddingContent.event.date}<br />{weddingContent.event.day} {weddingContent.event.time}<br />{weddingContent.venue.name}</p>
        </div>
      </header>
      <Greeting />
      <SaveCards notify={notify} />
      <SesangCameo asset={SESANG_STICKERS.left} side="left" />
      <section className="pastel-gallery section-pad" aria-label="웨딩 사진 갤러리">
        <ImageSlot asset={WEDDING_PHOTOS.pastel.gallery[0]} className="pastel-photo blue-wide" />
        <ImageSlot asset={WEDDING_PHOTOS.pastel.gallery[1]} className="pastel-photo blush" />
        <ImageSlot asset={WEDDING_PHOTOS.pastel.gallery[2]} className="pastel-photo neutral" />
        <ImageSlot asset={WEDDING_PHOTOS.pastel.gallery[3]} className="pastel-photo pale" />
      </section>
      <SesangCameo asset={SESANG_STICKERS.right} side="right" />
      <section className="story-grid section-pad" aria-label="예식 일정과 두 사람의 이야기">
        <div>
          <h2>우리의 하루</h2>
          {weddingContent.timeline.map((item) => (
            <p className="timeline-item" key={item.label}><span>{item.label}</span><small>{item.time}</small></p>
          ))}
        </div>
        <div>
          <h2>우리의 이야기</h2>
          {weddingContent.story.map((line) => <p key={line}>{line}</p>)}
        </div>
      </section>
      <Location notify={notify} />
      <SesangCameo asset={SESANG_STICKERS.sleep} side="left" variant="sleep" />
      <BottomActions notify={notify} pastel />
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
  const [toast, setToast] = useState("");
  const captureMode = useMemo(() => new URLSearchParams(window.location.search).get("capture") === "1", []);

  useEffect(() => {
    document.documentElement.dataset.variant = variant;
    document.title = `${weddingContent.couple.groom} · ${weddingContent.couple.bride} | ${VARIANTS[variant].label}`;
    const params = new URLSearchParams(window.location.search);
    params.set("variant", variant);
    window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
  }, [variant]);

  const notify = (message) => {
    setToast(message);
    window.clearTimeout(window.__weddingToastTimer);
    window.__weddingToastTimer = window.setTimeout(() => setToast(""), 2800);
  };

  return (
    <main className={`app-shell ${captureMode ? "is-capture" : ""}`}>
      {!captureMode && <VariantSwitcher variant={variant} onChange={setVariant} />}
      <div className="invitation-stage">
        {variant === "pastel" ? <PastelInvitation notify={notify} /> : <QuietInvitation notify={notify} />}
      </div>
      <div className={`toast ${toast ? "is-visible" : ""}`} role="status" aria-live="polite">
        <Check aria-hidden="true" weight="bold" />
        <span>{toast}</span>
      </div>
      {!captureMode && (
        <button className="copy-review-link" type="button" onClick={async () => {
          await navigator.clipboard?.writeText(window.location.href);
          notify("현재 시안 링크를 복사했습니다.");
        }}>
          <Copy aria-hidden="true" /> 현재 시안 링크 복사
        </button>
      )}
    </main>
  );
}
