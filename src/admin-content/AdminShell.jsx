import { ArrowClockwise, ArrowSquareOut, Briefcase, ChatCircleDots, List, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { ACCESS_LOGOUT_PATH } from "./content-client.js";

const NAV_ITEMS = [
  { href: "/admin", label: "콘텐츠", icon: Briefcase },
  { href: "/admin/guestbook", label: "비공개 방명록", icon: ChatCircleDots },
];

export function AdminShell({ active, children, lastUpdated, localReview = false, onRefresh }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const menuButtonRef = useRef(null);
  const closeButtonRef = useRef(null);
  const sidebarRef = useRef(null);
  const restoreMenuFocusRef = useRef(false);
  const activeLabel = NAV_ITEMS.find((item) => item.href === active)?.label || "관리";
  const sidebarHidden = compact && !menuOpen;

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const updateCompact = () => setCompact(query.matches);
    updateCompact();
    query.addEventListener("change", updateCompact);
    return () => query.removeEventListener("change", updateCompact);
  }, []);

  useEffect(() => {
    if (compact && menuOpen) closeButtonRef.current?.focus();
    if (!menuOpen && restoreMenuFocusRef.current) {
      restoreMenuFocusRef.current = false;
      menuButtonRef.current?.focus();
    }
  }, [compact, menuOpen]);

  useEffect(() => {
    if (!compact || !menuOpen) return undefined;
    const sidebar = sidebarRef.current;
    const focusable = () => [...(sidebar?.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])') || [])];
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        restoreMenuFocusRef.current = true;
        setMenuOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        sidebar?.focus();
        return;
      }
      const first = controls[0];
      const last = controls.at(-1);
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
  }, [compact, menuOpen]);

  const closeMenu = () => {
    restoreMenuFocusRef.current = true;
    setMenuOpen(false);
  };

  return (
    <main className="admin-shell">
      <aside ref={sidebarRef} id="admin-navigation" tabIndex="-1" className={`admin-sidebar ${menuOpen ? "is-open" : ""}`} aria-label="청첩장 관리 메뉴" aria-hidden={sidebarHidden ? "true" : undefined} inert={sidebarHidden ? true : undefined}>
        <div className="admin-sidebar-heading">
          <a href="/admin" className="admin-brand">청첩장 관리</a>
          <button ref={closeButtonRef} type="button" aria-label="관리 메뉴 닫기" onClick={closeMenu}><X aria-hidden="true" /></button>
        </div>
        <nav>
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <a key={href} href={href} className={active === href ? "is-active" : ""} aria-current={active === href ? "page" : undefined}>
              <Icon aria-hidden="true" weight={active === href ? "fill" : "regular"} />
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <div className="admin-sidebar-footer">
          <span>마지막 갱신</span>
          <div>
            <time>{lastUpdated || "방금 전"}</time>
            {onRefresh && <button type="button" onClick={onRefresh} aria-label="관리 화면 새로고침"><ArrowClockwise aria-hidden="true" /></button>}
          </div>
          <a href="/" target="_blank" rel="noreferrer"><ArrowSquareOut aria-hidden="true" />공개 청첩장 열기</a>
          {!localReview && <a href={ACCESS_LOGOUT_PATH}>로그아웃</a>}
        </div>
      </aside>

      <section className="admin-main">
        <header className="admin-mobile-header" inert={compact && menuOpen ? true : undefined} aria-hidden={compact && menuOpen ? "true" : undefined}>
          <button ref={menuButtonRef} type="button" aria-label="관리 메뉴 열기" aria-controls="admin-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><List aria-hidden="true" /></button>
          <strong>{activeLabel}</strong>
          <span aria-hidden="true" />
        </header>
        {menuOpen && <button type="button" className="admin-sidebar-backdrop" aria-label="관리 메뉴 닫기" onClick={closeMenu} />}
        <div className="admin-main-content" inert={compact && menuOpen ? true : undefined} aria-hidden={compact && menuOpen ? "true" : undefined}>{children}</div>
      </section>
    </main>
  );
}
