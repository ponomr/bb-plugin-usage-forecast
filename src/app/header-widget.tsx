// The header limits at the top right of the page, in a pill, by the
// `headerShow` setting: the 5-hour and weekly windows of one provider (each
// window's label, the 5-hour reset, with `bars` a horizontal bar, and the
// percent in its tone), with `forecast` the window that runs out first
// leading with when it runs out, or with `providers` each provider's worst
// window by its bb icon. Narrower than 40rem (a phone) the pill is a dot and
// the worst percent. A press opens the limits card below them. bb has no header slot, so an app overlay moves its
// own element into the visible page header row, before the header's actions,
// as the Downshift plugin does; a page without a header row (home) gets the
// fixed dock that plugins share (AGENTS.md, Host facts, Page header).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { experimental_ProviderIcon as ProviderIcon, experimental_usePluginId, experimental_useProviders } from "@get-bb/plugin-sdk/app";
import type { LimitWindow, ProviderLimits } from "../shared/contract";
import type { HeaderShow } from "../shared/header-show";
import { formatPercent } from "../shared/thresholds";
import { formatResetIn, formatRunOut, formatSpan, providerName, shortWindowLabel, windowLabel } from "./format";
import { headerProviders, headerView, worstWindowOf } from "./header-model";
import { providerStaleAt, staleNote } from "./indicator";
import { useHeaderShow, useHiddenProviders, useNow, usePathThreadId, useSnapshot, useStrings, useThreadState } from "./hooks";
import type { Strings } from "./i18n";
import { windowView, type WindowView } from "./model";
import { LimitsCard } from "./sidebar-card";
import { Bar, Ink } from "./ui";

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

/** An element of this plugin's own that follows the header row. */
function useHeaderHost(enabled: boolean): HTMLElement | null {
  const pluginId = experimental_usePluginId();
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const target = document.createElement("div");
    target.dataset.bbPlugin = pluginId;
    target.dataset.bbPluginRoot = "";
    target.className = "usage-forecast-header";
    // The phone's header row passes no pointer events through.
    Object.assign(target.style, { position: "relative", pointerEvents: "auto", flex: "0 0 auto", display: "flex", alignItems: "center" });
    target.style.setProperty("-webkit-app-region", "no-drag");
    let frame = 0;
    const attach = () => {
      frame = 0;
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
  }, [enabled, pluginId]);
  return host;
}

/** One window: what it shows and says. */
interface Gauge {
  key: string;
  label: string;
  view: WindowView;
  /** The used percent, 0–100. */
  percent: number;
  /** The bar's forecast tick. */
  marker: number | null;
  /** The bar's even-pace tick. */
  even: number | null;
  /** The time left to the reset; only the 5-hour window carries it. */
  reset: string | null;
  /**
   * For `forecast`: when a window on course to run out does ("out 14:20", or
   * "short by 1d 6h" on a later day), or for a used-up one the time to its
   * reset; null for a window that lasts.
   */
  forecast: string | null;
  /** For `forecast`'s order: when the window runs out, -Infinity when it has; null when it lasts. */
  outAt: number | null;
  title: string;
}

function gauge(s: Strings, w: LimitWindow, now: number, withReset: boolean): Gauge {
  const view = windowView(w, now);
  const percent = Math.max(0, Math.min(100, w.usedPercent));
  const state = view.pace === null ? "" : `, ${s.paceStateName[view.pace]}`;
  const span = w.resetsAt === null ? null : formatSpan(s, Math.max(0, w.resetsAt - now));
  const reset = withReset ? span : null;
  let forecast: string | null = null;
  let outAt: number | null = null;
  if (view.status === "hit") {
    forecast = span;
    outAt = -Infinity;
  } else if (view.status === "out" && view.runOutAt !== null && w.resetsAt !== null) {
    const { time, weekday } = formatRunOut(s, view.runOutAt, now);
    forecast = weekday === null ? s.headerOut(time) : s.headerShort(formatSpan(s, Math.max(0, w.resetsAt - view.runOutAt)));
    outAt = view.runOutAt;
  }
  return {
    key: w.label,
    label: shortWindowLabel(s, w.label, w.model),
    view,
    percent,
    marker: view.marker,
    even: view.even,
    reset,
    forecast,
    outAt,
    title: `${windowLabel(s, w.label, w.model)}: ${formatPercent(percent)}${state}${reset === null ? "" : `, ${formatResetIn(s, w.resetsAt, now)}`}`,
  };
}

/**
 * The gauges as `forecast` shows them: unchanged while every window lasts;
 * else the windows that run out first, earliest first, each with its
 * forecast in place of the reset, and the others without a reset.
 */
function forecastGauges(gauges: readonly Gauge[]): Gauge[] {
  if (gauges.every((g) => g.outAt === null)) return [...gauges];
  const out = gauges.filter((g) => g.outAt !== null).sort((a, b) => a.outAt! - b.outAt!);
  const rest = gauges.filter((g) => g.outAt === null).map((g) => ({ ...g, reset: null }));
  return [...out, ...rest];
}

type ShownStyle = Exclude<HeaderShow, "off" | "providers">;

/** One window as the band's collapsed row has it: label, reset, bar (with `bars`), coloured percent, and with `forecast` the run-out. */
function HeaderGauge({ g, style }: { g: Gauge; style: ShownStyle }) {
  const forecast = style === "forecast" ? g.forecast : null;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={g.title} data-gauge={g.key} data-tone={g.view.tone}>
      <span className="font-semibold">{g.label}</span>
      {g.reset === null || forecast !== null ? null : <span className="font-normal text-muted-foreground tabular-nums">{g.reset}</span>}
      {style === "bars" ? <Bar percent={g.percent} tone={g.view.tone} marker={g.marker} even={g.even} className="w-10 shrink-0" /> : null}
      <Ink tone={g.view.tone} className="font-semibold tabular-nums">
        {formatPercent(g.percent)}
      </Ink>
      {forecast === null ? null : (
        <span data-forecast="">
          <Ink tone={g.view.tone} className="font-normal tabular-nums">
            · {forecast}
          </Ink>
        </span>
      )}
    </span>
  );
}

/** One provider for `providers`: bb's icon (or a short label), its worst window's percent and that window's reset. */
interface ProviderGauge {
  providerId: string;
  name: string;
  /** The label when bb has no icon for the provider. */
  short: string;
  view: WindowView;
  percent: number;
  reset: string | null;
  title: string;
}

function providerGauge(s: Strings, p: ProviderLimits, now: number): ProviderGauge | null {
  const w = worstWindowOf(p.windows, now);
  if (w === null) return null;
  const g = gauge(s, w, now, true);
  const name = providerName(s, p.providerId);
  const short = Object.hasOwn(s.providerShort, p.providerId) ? s.providerShort[p.providerId]! : name.slice(0, 2).toUpperCase();
  return { providerId: p.providerId, name, short, view: g.view, percent: g.percent, reset: g.reset, title: `${name} · ${g.title}` };
}

/** bb's record of an agent provider when it has artwork, else null. */
function useProviderArt(): (id: string) => { id: string; logoUrl?: string | null; icon?: { glyph: string } | null } | null {
  const { providers } = experimental_useProviders();
  return (id) => {
    const p = providers.find((x) => x.id === id);
    if (p === undefined || (!p.logoUrl && !p.icon)) return null;
    return { id: p.id, logoUrl: p.logoUrl, icon: p.icon };
  };
}

type ProviderArt = ReturnType<typeof useProviderArt>;

function ProviderItem({ g, artOf }: { g: ProviderGauge; artOf: ProviderArt }) {
  const art = artOf(g.providerId);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={g.title} data-provider={g.providerId} data-tone={g.view.tone}>
      {art === null ? (
        <span className="font-semibold" data-provider-label="">
          {g.short}
        </span>
      ) : (
        <ProviderIcon providerKind="agent" provider={art} className="size-3.5 shrink-0" aria-label={g.name} />
      )}
      <Ink tone={g.view.tone} className="font-semibold tabular-nums">
        {formatPercent(g.percent)}
      </Ink>
      {g.reset === null ? null : <span className="font-normal text-muted-foreground tabular-nums">{g.reset}</span>}
    </span>
  );
}

/** B5, below 40rem: a dot in the worst window's tone and its percent. */
function PhoneDot({ view, percent }: { view: WindowView | null; percent: number | null }) {
  if (view === null || percent === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" data-phone="" data-tone={view.tone}>
      <Ink tone={view.tone} className="text-[10px] leading-none">
        ●
      </Ink>
      <Ink tone={view.tone} className="font-semibold tabular-nums">
        {formatPercent(percent)}
      </Ink>
    </span>
  );
}

/** The app overlay; renders into the header, or nothing when `headerShow` is off. */
export function HeaderLimits() {
  const style = useHeaderShow();
  const host = useHeaderHost(style !== "off");
  if (style === "off" || host === null) return null;
  return createPortal(<HeaderPill style={style} />, host);
}

function HeaderPill({ style }: { style: Exclude<HeaderShow, "off"> }) {
  const s = useStrings();
  const threadId = usePathThreadId();
  const now = useNow();
  const hidden = useHiddenProviders();
  const snapshot = useSnapshot().data;
  const thread = useThreadState(threadId).data;
  const artOf = useProviderArt();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);

  // The thread's own state only once it is the open thread's.
  const own = thread?.threadId === threadId ? thread : undefined;
  const view = headerView(s, snapshot, own, now, hidden);

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

  const windowGauges =
    view === null ? [] : [view.session, view.weekly].flatMap((w, i) => (w === null ? [] : [gauge(s, w, now, i === 0)]));
  const gauges = style === "forecast" ? forecastGauges(windowGauges) : windowGauges;
  const providers =
    style === "providers" ? headerProviders(s, snapshot, own, now, hidden).flatMap((p) => providerGauge(s, p, now) ?? []) : [];
  const empty = style === "providers" ? providers.length === 0 : gauges.length === 0;

  // The phone's dot: the worst of what the desktop pill shows.
  const candidates =
    style === "providers"
      ? providers.map((g) => g.view.window)
      : [view?.session ?? null, view?.weekly ?? null].filter((w): w is LimitWindow => w !== null);
  const worst = worstWindowOf(candidates, now);
  const worstView = worst === null ? null : windowView(worst, now);

  const name = view === null ? null : providerName(s, view.provider.providerId);
  const staleAt = view === null || snapshot === undefined ? null : providerStaleAt(snapshot, view.provider.providerId);
  const label = empty
    ? `${s.indicatorLabel}: ${s.noLimitsData}`
    : style === "providers"
      ? providers.map((g) => g.title).join(" · ")
      : `${name} · ${windowGauges.map((g) => g.title).join(" · ")}${staleNote(s, staleAt, now)}`;

  return (
    <>
      <button
        ref={button}
        type="button"
        className="inline-flex h-8 cursor-pointer items-center justify-center gap-3 rounded-full border border-border bg-muted/60 px-2 text-[13px] leading-none text-foreground sm:px-3 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={label}
        title={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="header-limits"
        data-style={style}
        data-data={empty ? "none" : staleAt === null ? "current" : "stale"}
        onClick={() => setOpen(!open)}
      >
        {/* Narrower than 40rem (a phone) the header has no room for the windows: B5, a dot and the worst percent. */}
        <span className="sm:hidden" data-testid="header-limits-phone">
          <PhoneDot view={empty ? null : worstView} percent={worst === null ? null : Math.max(0, Math.min(100, worst.usedPercent))} />
        </span>
        <span className="hidden items-center gap-3 sm:inline-flex" data-testid="header-limits-desktop">
          {empty ? <span className="text-muted-foreground">—</span> : null}
          {style === "providers"
            ? providers.map((g) => <ProviderItem key={g.providerId} g={g} artOf={artOf} />)
            : gauges.map((g) => <HeaderGauge key={g.key} g={g} style={style} />)}
        </span>
      </button>
      {open ? <Popover anchor={button.current} cardRef={card} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** The limits card, fixed below the pill and kept inside the viewport. */
function Popover({ anchor, cardRef, onClose }: { anchor: HTMLElement | null; cardRef: React.RefObject<HTMLDivElement | null>; onClose: () => void }) {
  const s = useStrings();
  const pluginId = experimental_usePluginId();
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
      data-bb-plugin={pluginId}
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
