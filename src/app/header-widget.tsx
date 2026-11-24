// The header limits: the 5-hour and weekly windows of one provider at the
// top right of the page, as rings with the percent inside or as a vertical
// bar beside a larger percent (the `headerShow` setting). A press opens the
// limits card below them. bb has no header slot, so an app overlay moves its
// own element into the visible page header row, before the header's actions,
// as the Downshift plugin does; a page without a header row (home) gets the
// fixed dock that plugins share (AGENTS.md, Host facts, Page header).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LimitWindow } from "../shared/contract";
import { shownPercent, type LimitsShow } from "../shared/limits-show";
import type { HeaderShow } from "../shared/header-show";
import { formatPercent, type Tone } from "../shared/thresholds";
import { providerName, shortWindowLabel, windowLabel } from "./format";
import { headerView, threadIdOfPath } from "./header-model";
import { useHeaderShow, useHiddenProviders, useLimitsShow, useNow, useSnapshot, useStrings, useThreadState } from "./hooks";
import type { Strings } from "./i18n";
import { windowView } from "./model";
import { LimitsCard } from "./sidebar-card";
import { INK_CLASS } from "./ui";
import { cn } from "../../lib/utils";

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
  /** The shown percent (used or left), 0–100. */
  percent: number;
  /** How far the ring and the bar fill: the shown percent, so the figure and the fill agree. */
  fill: number;
  tone: Tone;
  title: string;
}

function gauge(s: Strings, w: LimitWindow, now: number, show: LimitsShow): Gauge {
  const v = windowView(w, now);
  const used = Math.max(0, Math.min(100, w.usedPercent));
  const percent = shownPercent(show, used);
  const value = show === "used" ? formatPercent(percent) : s.percentLeft(formatPercent(percent));
  const state = v.pace === null ? "" : `, ${s.paceStateName[v.pace]}`;
  return {
    key: w.label,
    label: shortWindowLabel(s, w.label, w.model),
    percent,
    fill: percent,
    tone: v.tone,
    title: `${windowLabel(s, w.label, w.model)}: ${value}${state}`,
  };
}

/** A ring filled to the shown percent, with it inside. */
export function GaugeRing({ g }: { g: Gauge }) {
  const round = g.fill > 0 && g.fill < 100;
  return (
    <span className="relative inline-flex size-7 shrink-0 items-center justify-center" data-gauge={g.key} data-tone={g.tone}>
      <svg viewBox="0 0 28 28" fill="none" className="absolute inset-0 size-7" aria-hidden>
        <circle cx="14" cy="14" r="11.5" stroke="currentColor" strokeWidth="3" opacity="0.18" />
        <circle
          className={INK_CLASS[g.tone]}
          cx="14"
          cy="14"
          r="11.5"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap={round ? "round" : "butt"}
          pathLength={100}
          strokeDasharray={`${g.fill} 100`}
          transform="rotate(-90 14 14)"
        />
      </svg>
      <span className="relative text-[10px] leading-none font-semibold tabular-nums">{Math.round(g.percent)}</span>
    </span>
  );
}

/** A vertical bar filled from the bottom to the shown percent, beside it. */
export function GaugeBar({ g }: { g: Gauge }) {
  return (
    <span className="inline-flex items-center gap-1" data-gauge={g.key} data-tone={g.tone}>
      <span className="relative h-5 w-[5px] shrink-0 overflow-hidden rounded-full bg-foreground/15" aria-hidden>
        <span className={cn("absolute inset-x-0 bottom-0 rounded-full bg-current", INK_CLASS[g.tone])} style={{ height: `${g.fill}%` }} />
      </span>
      <span className="text-[15px] leading-none font-semibold tabular-nums">
        {Math.round(g.percent)}
        <span className="text-[10px] font-medium text-muted-foreground">%</span>
      </span>
    </span>
  );
}

export function HeaderGauges({ gauges, style }: { gauges: readonly Gauge[]; style: Exclude<HeaderShow, "off"> }) {
  return (
    <>
      {gauges.map((g) => (
        <span key={g.key} className="inline-flex items-center gap-1" title={g.title}>
          <span className="text-[10px] leading-none font-medium text-muted-foreground">{g.label}</span>
          {style === "rings" ? <GaugeRing g={g} /> : <GaugeBar g={g} />}
        </span>
      ))}
    </>
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

  const gauges = view === null ? [] : [view.session, view.weekly].flatMap((w) => (w === null ? [] : [gauge(s, w, now, show)]));
  const name = view === null ? null : providerName(s, view.provider.providerId);
  const label = view === null ? `${s.indicatorLabel}: ${s.noLimitsData}` : `${name} · ${gauges.map((g) => g.title).join(" · ")}`;

  return (
    <>
      <button
        ref={button}
        type="button"
        className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md px-1.5 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="header-limits"
        data-style={style}
        onClick={() => setOpen(!open)}
      >
        {gauges.length === 0 ? <GaugeRing g={{ key: "none", label: "", percent: 0, fill: 0, tone: "normal", title: label }} /> : null}
        <HeaderGauges gauges={gauges} style={style} />
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
