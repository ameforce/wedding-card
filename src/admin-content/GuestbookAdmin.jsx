import { ArrowClockwise, LockKey, MagnifyingGlass } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAdminGuestbookEntries } from "../guestbook-api.js";
import { ACCESS_LOGOUT_PATH, isAdminAuthRequiredError } from "./content-client.js";
import { AdminShell } from "./AdminShell.jsx";

const PAGE_LIMIT = 50;

function formatTimestamp(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value)).replaceAll(". ", "-").replace(".", "");
}

function statusFromError(error) {
  if (isAdminAuthRequiredError(error)) return "auth-required";
  if (error?.status === 404 || error?.status === 503) return "unavailable";
  return "error";
}

export function GuestbookAdmin() {
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [range, setRange] = useState("all");
  const [state, setState] = useState({
    status: "loading",
    entries: [],
    count: 0,
    nextCursor: null,
    hasMore: false,
    message: "",
  });
  const [lastUpdated, setLastUpdated] = useState("");
  const requestSequence = useRef(0);

  const load = useCallback(async ({ append = false, cursor = "" } = {}) => {
    const sequence = requestSequence.current + 1;
    requestSequence.current = sequence;
    setState((current) => ({
      ...current,
      status: append ? "loading-more" : "loading",
      entries: append ? current.entries : [],
      message: "",
    }));
    try {
      const result = await getAdminGuestbookEntries({ query: appliedQuery, range, cursor, limit: PAGE_LIMIT });
      const totalCount = Number.isFinite(result.totalCount) ? result.totalCount : result.count;
      if (!Array.isArray(result.entries) || !Number.isFinite(totalCount)) throw Object.assign(new Error("관리자 방명록 응답 형식이 올바르지 않습니다."), { status: 503 });
      if (requestSequence.current !== sequence) return;
      setState((current) => ({
        status: "ready",
        entries: append ? [...current.entries, ...result.entries] : result.entries,
        count: totalCount,
        nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
        hasMore: result.hasMore === true,
        message: "",
      }));
      setLastUpdated(formatTimestamp(result.refreshedAt || new Date().toISOString()));
    } catch (error) {
      if (requestSequence.current !== sequence) return;
      const status = statusFromError(error);
      if (append && status !== "auth-required") {
        setState((current) => ({
          ...current,
          status: "append-error",
          message: "추가 메시지를 불러오지 못했습니다. 현재 목록은 그대로 유지됩니다.",
        }));
      } else {
        setState({
          status,
          entries: [],
          count: 0,
          nextCursor: null,
          hasMore: false,
          message: status === "auth-required"
            ? "인증 방식이 변경되었거나 로그인 세션이 만료되었습니다."
            : status === "unavailable"
              ? "관리자 인증 공급자와 저장소가 연결되지 않아 메시지를 조회할 수 없습니다."
              : "방명록 메시지를 불러오지 못했습니다.",
        });
      }
    }
  }, [appliedQuery, range]);

  useEffect(() => { void load(); }, [load]);

  const search = (event) => {
    event.preventDefault();
    setAppliedQuery(query.trim());
  };

  return (
    <AdminShell active="/admin/guestbook" lastUpdated={lastUpdated} onRefresh={() => void load()}>
      <div className="admin-page guestbook-admin-page">
        <header className="admin-page-heading">
          <div>
            <h1><LockKey aria-hidden="true" weight="fill" />비공개 방명록</h1>
            <p>인증된 신랑·신부 계정에서만 메시지를 조회할 수 있습니다.</p>
          </div>
        </header>

        {state.status === "auth-required" ? (
          <section className="admin-state-panel is-auth" role="alert">
            <h2>관리자 인증이 필요합니다</h2>
            <p>{state.message} 기존 세션을 종료한 뒤 승인된 Google 계정으로 다시 로그인해 주세요.</p>
            <a href={ACCESS_LOGOUT_PATH}>Google 계정으로 다시 로그인</a>
          </section>
        ) : (
          <>
            <div className="guestbook-admin-toolbar">
              <form role="search" onSubmit={search}>
                <MagnifyingGlass aria-hidden="true" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} maxLength="50" placeholder="이름 또는 메시지 검색" aria-label="방명록 이름 또는 메시지 검색" />
                <button type="submit" className="sr-only">검색</button>
              </form>
              <div className="guestbook-range" role="group" aria-label="방명록 조회 기간">
                {[{ value: "all", label: "전체" }, { value: "7d", label: "7일" }, { value: "30d", label: "30일" }].map((item) => (
                  <button key={item.value} type="button" className={range === item.value ? "is-active" : ""} aria-pressed={range === item.value} onClick={() => setRange(item.value)}>{item.label}</button>
                ))}
              </div>
              <strong className="guestbook-result-count">총 {state.count}개 결과</strong>
              <button type="button" className="admin-icon-button" onClick={() => void load()} disabled={state.status === "loading"} aria-label="방명록 새로고침"><ArrowClockwise aria-hidden="true" /></button>
            </div>

            {state.status === "loading" && <div className="admin-state-panel" role="status"><span className="admin-spinner" />방명록을 불러오는 중입니다.</div>}
            {["error", "unavailable"].includes(state.status) && (
              <section className="admin-state-panel is-error" role="alert">
                <p>{state.message}</p>
                <button type="button" onClick={() => void load()}>다시 시도</button>
              </section>
            )}
            {state.status === "ready" && state.entries.length === 0 && (
              <div className="admin-state-panel" role="status">{appliedQuery ? "검색 조건에 맞는 메시지가 없습니다." : "아직 도착한 방명록 메시지가 없습니다."}</div>
            )}
            {state.status === "append-error" && state.entries.length > 0 && (
              <section className="admin-state-panel is-error" role="alert">
                <p>{state.message}</p>
                <button type="button" onClick={() => void load({ append: true, cursor: state.nextCursor || "" })}>추가 불러오기 다시 시도</button>
              </section>
            )}
            {["ready", "loading-more", "append-error"].includes(state.status) && state.entries.length > 0 && (
              <>
                <div className="guestbook-admin-table" role="table" aria-label="비공개 방명록 메시지">
                  <div className="guestbook-admin-row is-header" role="row">
                    <span role="columnheader">작성자</span><span role="columnheader">메시지</span><span role="columnheader">작성 시간</span>
                  </div>
                  {state.entries.map((entry) => (
                    <article className="guestbook-admin-row" role="row" key={entry.id}>
                      <strong role="cell">{entry.name}</strong>
                      <p role="cell">{entry.message}</p>
                      <time role="cell" dateTime={entry.createdAt}>{formatTimestamp(entry.createdAt)}</time>
                    </article>
                  ))}
                </div>
                {state.hasMore && (
                  <button type="button" className="guestbook-load-more" disabled={state.status === "loading-more"} onClick={() => void load({ append: true, cursor: state.nextCursor })}>
                    {state.status === "loading-more" ? "더 불러오는 중…" : "더 불러오기"}
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </AdminShell>
  );
}
