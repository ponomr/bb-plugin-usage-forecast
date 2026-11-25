// The floating limits widget, by the `showFloat` setting (off by default).
// F4: a mini panel at the window's right edge, one line per provider with
// its 5-hour and weekly percents in their tones («Claude 5H 41% W 38%»). A
// press folds it into F2, a 44 px round badge with two rings (the 5-hour
// window outside, the weekly one inside), and a press on the badge opens
// the panel again. It sits at mid-height and is dragged up or down; the
// place and the fold are kept per device. The providers follow the header:
// in a thread its own provider first, else the host of the worst window.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { experimental_usePluginId } from "@get-bb/plugin-sdk/app";
import type { ProviderLimits } from "../shared/contract";
import { formatPercent } from "../shared/thresholds";
import { limitPercent, limitPercentText, providerName, shortWindowLabel } from "./format";
import { headerProviders, headerView, headerWindows } from "./header-model";
import { readStored, useFloatShown, useHiddenProviders, useNow, usePathThreadId, useSnapshot, useStrings, useThreadState, writeStored } from "./hooks";
import type { Strings } from "./i18n";
import { ringWindow, windowView } from "./model";
import { Rings } from "./ring-icon";
import { Ink } from "./ui";

/** A move shorter than this is a press, not a drag. */
const DRAG_PX = 4;
/** The widget keeps this far from the top and bottom of the window. */
const EDGE_PX = 8;
/** The default place: the widget's middle at mid-height. */
const DEFAULT_TOP = 0.5;

/** The app overlay; renders the widget into the page body, or nothing while `showFloat` is off. */
export function FloatLimits() {
  if (!useFloatShown()) return null;
  return createPortal(<FloatWidget />, document.body);
}

/** The stored place: the widget's middle as a share of the window height, 0–1. */
export function parseFloatTop(raw: string | null): number {
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_TOP;
}

/** The widget's middle in px for a share of the window height, kept inside the window. */
export function floatTopPx(share: number, viewport: number, height: number): number {
  const half = height / 2;
  const min = EDGE_PX + half;
  const max = Math.max(min, viewport - EDGE_PX - half);
  return Math.round(Math.max(min, Math.min(max, share * viewport)));
}

function briefName(s: Strings, providerId: string): string {
  return Object.hasOwn(s.providerBrief, providerId) ? s.providerBrief[providerId]! : providerName(s, providerId);
}

/** One provider's line: «Claude 5H 41% W 38%». */
function lineText(s: Strings, p: ProviderLimits): string {
  const { session, weekly } = headerWindows(p);
  const parts = [session, weekly].flatMap((w) => (w === null ? [] : [`${shortWindowLabel(s, w.label, w.model)} ${limitPercentText(s, w.usedPercent)}`]));
  return [briefName(s, p.providerId), ...parts].join(" ");
}

function FloatLine({ s, provider, now }: { s: Strings; provider: ProviderLimits; now: number }) {
  const { session, weekly } = headerWindows(provider);
  return (
    <span className="flex items-baseline gap-1.5 whitespace-nowrap" data-provider={provider.providerId}>
      <span className="font-medium">{briefName(s, provider.providerId)}</span>
      {[session, weekly].map((w) =>
        w === null ? null : (
          <span key={w.label} className="inline-flex items-baseline gap-0.5" data-window={w.label}>
            <span className="text-muted-foreground">{shortWindowLabel(s, w.label, w.model)}</span>
            <Ink tone={windowView(w, now).tone} className="font-semibold tabular-nums">
              {formatPercent(limitPercent(s, w.usedPercent))}
            </Ink>
          </span>
        ),
      )}
    </span>
  );
}

function FloatWidget() {
  const s = useStrings();
  const now = useNow();
  const hidden = useHiddenProviders();
  const snapshot = useSnapshot().data;
  const threadId = usePathThreadId();
  const thread = useThreadState(threadId).data;
  const pluginId = experimental_usePluginId();
  const topKey = `${pluginId}:float-top`;
  const foldKey = `${pluginId}:float-folded`;

  const [folded, setFolded] = useState(() => readStored(foldKey) === "1");
  const [share, setShare] = useState(() => parseFloatTop(readStored(topKey)));
  const [viewport, setViewport] = useState(() => window.innerHeight);
  const [height, setHeight] = useState(0);
  const root = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; startTop: number; moved: boolean } | null>(null);
  const dragged = useRef(false);

  useEffect(() => {
    const resize = () => setViewport(window.innerHeight);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    const h = root.current?.getBoundingClientRect().height ?? 0;
    if (h !== height) setHeight(h);
  });

  const save = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(1, next));
      setShare(clamped);
      writeStored(topKey, String(Math.round(clamped * 1000) / 1000));
    },
    [topKey],
  );
  const toggle = () => {
    setFolded(!folded);
    writeStored(foldKey, folded ? "0" : "1");
  };

  // The thread's own state only once it is the open thread's.
  const own = thread?.threadId === threadId ? thread : undefined;
  const providers = headerProviders(s, snapshot, own, now, hidden);
  const badge = headerView(s, snapshot, own, now, hidden);
  const outer = ringWindow(s, badge?.session ?? null, now);
  const inner = ringWindow(s, badge?.weekly ?? null, now);
  const summary = providers.length === 0 ? `${s.indicatorLabel}: ${s.noLimitsData}` : providers.map((p) => lineText(s, p)).join(" · ");
  const top = floatTopPx(share, viewport, height);

  return (
    <button
      ref={root}
      type="button"
      data-bb-plugin={pluginId}
      data-bb-plugin-root=""
      data-testid="float-limits"
      data-folded={folded ? "true" : "false"}
      aria-label={`${summary}. ${folded ? s.floatOpen : s.floatFold}`}
      title={`${summary}\n${folded ? s.floatOpen : s.floatFold}`}
      className={
        folded
          ? "flex size-11 cursor-grab items-center justify-center rounded-full border border-border bg-popover text-popover-foreground shadow-lg"
          : "flex min-w-[120px] cursor-grab flex-col items-start gap-0.5 rounded-l-lg border border-r-0 border-border bg-popover px-2 py-1.5 text-left text-[11px] leading-tight text-popover-foreground shadow-lg"
      }
      style={{
        position: "fixed",
        right: folded ? 4 : 0,
        top,
        transform: "translateY(-50%)",
        zIndex: 95,
        touchAction: "none",
        userSelect: "none",
      }}
      onPointerDown={(e) => {
        drag.current = { pointerId: e.pointerId, startY: e.clientY, startTop: top, moved: false };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d === null || d.pointerId !== e.pointerId) return;
        const dy = e.clientY - d.startY;
        if (!d.moved && Math.abs(dy) < DRAG_PX) return;
        d.moved = true;
        setShare((d.startTop + dy) / Math.max(1, viewport));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d === null || d.pointerId !== e.pointerId) return;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        dragged.current = d.moved;
        if (d.moved) save((d.startTop + e.clientY - d.startY) / Math.max(1, viewport));
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onClick={() => {
        // The click after a drag is not a press.
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        toggle();
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        // From where it is drawn, so a place kept inside the window moves at once.
        save(top / Math.max(1, viewport) + (e.key === "ArrowUp" ? -0.05 : 0.05));
      }}
    >
      {folded ? (
        <Rings outer={outer} inner={inner} title={summary} style={{ width: 36, height: 36 }} />
      ) : providers.length === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        providers.map((p) => <FloatLine key={p.providerId} s={s} provider={p} now={now} />)
      )}
    </button>
  );
}
