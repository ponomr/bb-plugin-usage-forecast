// The header limits: the 5-hour and weekly windows of one provider at the
// top right of the page, in a pill: each window's label, the 5-hour reset,
// with `headerShow: bars` a horizontal bar, and the percent in its tone. A
// press opens the limits card below them. bb has no header slot, so an app overlay moves its
// own element into the visible page header row, before the header's actions,
// as the Downshift plugin does; a page without a header row (home) gets the
// fixed dock that plugins share (AGENTS.md, Host facts, Page header).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LimitWindow } from "../shared/contract";
import { shownPercent, type LimitsShow } from "../shared/limits-show";
import type { HeaderShow } from "../shared/header-show";
import type { ResetShow } from "../shared/reset-show";
import { formatPercent } from "../shared/thresholds";
import { formatResetAt, formatResetIn, formatSpan, providerName, shortWindowLabel, windowLabel } from "./format";
import { headerView, threadIdOfPath } from "./header-model";
import { useHeaderShow, useHiddenProviders, useLimitsShow, useNow, useResetShow, useSnapshot, useStrings, useThreadState } from "./hooks";
import type { Strings } from "./i18n";
import { windowView, type WindowView } from "./model";
import { LimitsCard } from "./sidebar-card";
import { Bar, Ink } from "./ui";

const PLUGIN = "usage-forecast";
const HEADER_ROW = "[data-testid=app-page-header-content-row]";
const DOCK = "data-bb-header-addons";
/** The card's width, 22rem. */
const CARD_WIDTH = 352;

/** The visible page header row, else the shared fixed dock (created when missing). */
function headerParent(): HTMLElement {
  const header = Array.from(document.querySelectorAll<HTMLElement>(HEADER_ROW)).find((el) => el.getClientRects().length > 0);
  if (header !== undefined) return header;
  let dock = document.querySelector<HTMLElement>(`[${DOCK}]`);
  if (dock === null) {
    dock = document.createElement("div");
    dock.setAttribute(DOCK, "");
    Object.assign(dock.style, {
      position: "fixed",
      top: "max(8px, env(safe-area-inset-top))",
      right: "max(48px, calc(env(safe-area-inset-right) + 44px))",
      display: "flex",
      alignItems: "center",
      gap: "4px",
      pointerEvents: "auto",
      zIndex: "90",
    });
    document.body.append(dock);
  }
  return dock;
}

function releaseEmptyDock() {
  for (const dock of Array.from(document.querySelectorAll<HTMLElement>(`[${DOCK}]`))) if (dock.childElementCount === 0) dock.remove();
}

/** An element of this plugin's own that follows the header row; also tracks the path's thread. */
function useHeaderHost(enabled: boolean): { host: HTMLElement | null; threadId: string | null } {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [threadId, setThreadId] = useState(() => threadIdOfPath(window.location.pathname));
  useEffect(() => {
    if (!enabled) return;
    const target = document.createElement("div");
    target.dataset.bbPlugin = PLUGIN;
    target.dataset.bbPluginRoot = "";
    target.className = "usage-forecast-header";
    // The phone's header row passes no pointer events through.
    Object.assign(target.style, { position: "relative", pointerEvents: "auto", flex: "0 0 auto", display: "flex", alignItems: "center" });
    target.style.setProperty("-webkit-app-region", "no-drag");
    let frame = 0;
    const attach = () => {
      frame = 0;
      setThreadId(threadIdOfPath(window.location.pathname));
      const parent = headerParent();
      if (target.parentElement === parent) return;
      if (parent.hasAttribute(DOCK)) parent.append(target);
      else parent.insertBefore(target, parent.lastElementChild);
      releaseEmptyDock();
    };
    const observer = new MutationObserver(() => {
      if (frame === 0) frame = requestAnimationFrame(attach);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", attach);
    attach();
    setHost(target);
    return () => {
      observer.disconnect();
      window.removeEventListener("popstate", attach);
      cancelAnimationFrame(frame);
      target.remove();
      releaseEmptyDock();
      setHost(null);
    };
  }, [enabled]);
  return { host, threadId };
}

/** One window: what it shows and says. */
interface Gauge {
  key: string;
  label: string;
  view: WindowView;
  /** The shown percent (used or left), 0–100. */
  percent: number;
  /** The bar's pace tick, used or left as the percent is. */
  marker: number | null;
  /** The reset as a countdown or a local time (`resetShow`); only the 5-hour window carries it. */
  reset: string | null;
  title: string;
}

function gauge(s: Strings, w: LimitWindow, now: number, show: LimitsShow, resetShow: ResetShow, withReset: boolean): Gauge {
  const view = windowView(w, now);
  const percent = shownPercent(show, Math.max(0, Math.min(100, w.usedPercent)));
  const value = show === "used" ? formatPercent(percent) : s.percentLeft(formatPercent(percent));
  const state = view.pace === null ? "" : `, ${s.paceStateName[view.pace]}`;
  const reset = !withReset || w.resetsAt === null ? null : resetText(s, w.resetsAt, now, resetShow);
  return {
    key: w.label,
    label: shortWindowLabel(s, w.label, w.model),
    view,
    percent,
    marker: view.marker === null ? null : shownPercent(show, view.marker),
    reset,
    title: `${windowLabel(s, w.label, w.model)}: ${value}${state}${reset === null ? "" : `, ${formatResetIn(s, w.resetsAt, now, resetShow)}`}`,
  };
}

/** The reset as the band's reset time says it: a countdown, or the local time while it is ahead. */
function resetText(s: Strings, resetsAt: number, now: number, resetShow: ResetShow): string {
  return resetShow === "time" && resetsAt > now ? formatResetAt(s, resetsAt, now) : formatSpan(s, Math.max(0, resetsAt - now));
}

/** One window as the band's collapsed row has it: label, reset, bar (with `bars`), coloured percent. */
export function HeaderGauge({ g, style }: { g: Gauge; style: Exclude<HeaderShow, "off"> }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap sm:gap-1.5" title={g.title} data-gauge={g.key} data-tone={g.view.tone}>
      <span className="font-semibold">{g.label}</span>
      {g.reset === null ? null : <span className="font-normal text-muted-foreground tabular-nums">{g.reset}</span>}
      {style === "bars" ? (
        <Bar percent={g.percent} tone={g.view.tone} marker={g.marker} className="hidden w-10 shrink-0 sm:flex" />
      ) : null}
      <Ink tone={g.view.tone} className="font-semibold tabular-nums">
        {formatPercent(g.percent)}
      </Ink>
    </span>
  );
}

/** The app overlay; renders into the header, or nothing when `headerShow` is off. */
export function HeaderLimits() {
  const style = useHeaderShow();
  const { host, threadId } = useHeaderHost(style !== "off");
  if (style === "off" || host === null) return null;
  return createPortal(<HeaderPill style={style} threadId={threadId} />, host);
}

function HeaderPill({ style, threadId }: { style: Exclude<HeaderShow, "off">; threadId: string | null }) {
  const s = useStrings();
  const now = useNow();
  const show = useLimitsShow();
  const resetShow = useResetShow();
  const hidden = useHiddenProviders();
  const snapshot = useSnapshot().data;
  const thread = useThreadState(threadId).data;
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);

  // The thread's own state only once it is the open thread's.
  const view = headerView(s, snapshot, thread?.threadId === threadId ? thread : undefined, now, hidden);

  useEffect(() => setOpen(false), [threadId]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!button.current?.contains(target) && !card.current?.contains(target)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const gauges =
    view === null ? [] : [view.session, view.weekly].flatMap((w, i) => (w === null ? [] : [gauge(s, w, now, show, resetShow, i === 0)]));
  const name = view === null ? null : providerName(s, view.provider.providerId);
  const label = view === null ? `${s.indicatorLabel}: ${s.noLimitsData}` : `${name} · ${gauges.map((g) => g.title).join(" · ")}`;

  return (
    <>
      <button
        ref={button}
        type="button"
        // Narrower than 40rem (a phone) the header has no room for one line: the two windows
        // stack in a smaller font and the bars drop out.
        className="inline-flex h-8 cursor-pointer items-start justify-center gap-0 rounded-2xl border border-border bg-muted/60 px-2 text-[11px] leading-[13px] text-foreground max-sm:flex-col sm:items-center sm:gap-3 sm:rounded-full sm:px-3 sm:text-[13px] sm:leading-none hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="header-limits"
        data-style={style}
        onClick={() => setOpen(!open)}
      >
        {gauges.length === 0 ? <span className="text-muted-foreground">—</span> : null}
        {gauges.map((g) => (
          <HeaderGauge key={g.key} g={g} style={style} />
        ))}
      </button>
      {open ? <Popover anchor={button.current} cardRef={card} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** The limits card, fixed below the pill and kept inside the viewport. */
function Popover({ anchor, cardRef, onClose }: { anchor: HTMLElement | null; cardRef: React.RefObject<HTMLDivElement | null>; onClose: () => void }) {
  const s = useStrings();
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    const update = () => {
      if (anchor === null) return;
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      // Under the pill's right edge, moved left of it only as far as the card fits: 22rem, at most the viewport less 8px a side.
      const width = Math.min(CARD_WIDTH, vw - 16);
      setPlace({ top: Math.round(r.bottom + 6), right: Math.max(8, Math.min(Math.round(vw - r.right), vw - width - 8)) });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [anchor]);
  if (place === null) return null;
  return createPortal(
    <div
      ref={cardRef}
      data-bb-plugin={PLUGIN}
      data-bb-plugin-root=""
      role="dialog"
      aria-label={s.indicatorLabel}
      data-testid="header-limits-card"
      className="fixed z-[100] w-[min(22rem,calc(100vw-16px))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
      style={{ top: place.top, right: place.right }}
    >
      <LimitsCard onNavigate={onClose} className="max-h-[min(24rem,70dvh)] overflow-y-auto overscroll-contain" />
    </div>,
    document.body,
  );
}
