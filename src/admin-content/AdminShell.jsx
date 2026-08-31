import { ArrowClockwise, ArrowSquareOut, Briefcase, ChatCircleDots, List, X } from "@phosphor-icons/react";
import { useState } from "react";
import { ACCESS_LOGOUT_PATH } from "./content-client.js";

const NAV_ITEMS = [
  { href: "/admin", label: "콘텐츠", icon: Briefcase },
  { href: "/admin/guestbook", label: "비공개 방명록", icon: ChatCircleDots },
];

export function AdminShell({ active, children, lastUpdated, localReview = false, onRefresh }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const activeLabel = NAV_ITEMS.find((item) => item.href === active)?.label || "관리";

  return (
    <main className="admin-shell">
      <aside className={`admin-sidebar ${menuOpen ? "is-open" : ""}`} aria-label="청첩장 관리 메뉴">
        <div className="admin-sidebar-heading">
          <a href="/admin" className="admin-brand">청첩장 관리</a>
          <button type="button" aria-label="관리 메뉴 닫기" onClick={() => setMenuOpen(false)}><X aria-hidden="true" /></button>
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
        <header className="admin-mobile-header">
          <button type="button" aria-label="관리 메뉴 열기" onClick={() => setMenuOpen(true)}><List aria-hidden="true" /></button>
          <strong>{activeLabel}</strong>
          <span aria-hidden="true" />
        </header>
        {menuOpen && <button type="button" className="admin-sidebar-backdrop" aria-label="관리 메뉴 닫기" onClick={() => setMenuOpen(false)} />}
        {children}
      </section>
    </main>
  );
}
