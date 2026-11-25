// The ring's state outside the plugin slot. The host renders a footer item's
// icon outside the plugin's slot, where SDK hooks throw (see AGENTS.md, Host
// facts, Sidebar footer), so an app overlay that renders nothing reads the
// snapshot and the settings and writes them here; the icon subscribes.

import { useEffect, useSyncExternalStore } from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";
import type { LimitWindow } from "../shared/contract";
import { parseSidebarShow, type SidebarShow } from "../shared/sidebar-show";
import { limitPercent, limitPercentText, providerName, windowLabel } from "./format";
import { headerView } from "./header-model";
import { en, type Strings } from "./i18n";
import { indicatorTitle, indicatorView, providerStaleAt, staleNote } from "./indicator";
import { ringWindow, windowView } from "./model";
import type { RingWindow } from "./ring-icon";
import { createStore } from "./store";
import { useHiddenProviders, useNow, useSnapshot, useStrings } from "./hooks";

interface IndicatorState {
  /** C5: the worst window as its ring draws it, and the even-pace tick on that ring. */
  worst: RingWindow | null;
  even?: number | null;
  title: string;
  /** The `sidebarShow` setting; two rings when absent. */
  style?: SidebarShow;
  /** C1: the 5-hour (outer) and weekly (inner) windows of the worst window's provider. */
  outer?: RingWindow | null;
  inner?: RingWindow | null;
}

/** Everything the icon draws; an equal state does not notify. */
function drawn(s: IndicatorState): string {
  const ring = (w: RingWindow | null | undefined) => (w == null ? null : [w.percent, w.tone]);
  return JSON.stringify([
    s.title,
    s.style ?? null,
    ring(s.worst),
    s.even == null ? null : Math.round(s.even),
    ring(s.outer),
    ring(s.inner),
  ]);
}

const store = createStore<IndicatorState>({ worst: null, title: en.indicatorLabel }, (a, b) => drawn(a) === drawn(b));

export const getIndicatorState = store.get;
export const setIndicatorState = store.set;

export function useIndicatorState(): IndicatorState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** C1's title: the provider, then each ring, e.g. "Claude Code · 5 Hour: 29%, tight · Weekly: 41%". */
function ringsTitle(s: Strings, host: string | null, provider: string, windows: (LimitWindow | null)[], now: number, stale: number | null): string {
  const parts = windows.flatMap((w) => {
    if (w === null) return [];
    const pace = windowView(w, now).pace;
    return [`${windowLabel(s, w.label, w.model)}: ${limitPercentText(s, w.usedPercent)}${pace === null ? "" : `, ${s.paceStateName[pace]}`}`];
  });
  const head = host === null ? providerName(s, provider) : `${host} · ${providerName(s, provider)}`;
  return `${head} · ${parts.join(" · ")}${staleNote(s, stale, now)}`;
}

/** The app overlay that feeds the store; it renders nothing. */
export function IndicatorFeeder() {
  const s = useStrings();
  const now = useNow();
  const hidden = useHiddenProviders();
  const style = parseSidebarShow(useSettings().values?.sidebarShow);
  const snapshot = useSnapshot().data;
  const worst = snapshot === undefined ? null : indicatorView(snapshot, now, hidden).worst;
  let title = snapshot === undefined ? s.indicatorLabel : indicatorTitle(s, worst, now);
  let outer: RingWindow | null = null;
  let inner: RingWindow | null = null;
  if (style === "rings" && snapshot !== undefined) {
    const view = headerView(s, snapshot, undefined, now, hidden);
    if (view !== null) {
      outer = ringWindow(s, view.session, now);
      inner = ringWindow(s, view.weekly, now);
      const id = view.provider.providerId;
      title = ringsTitle(s, worst?.hostName ?? null, id, [view.session, view.weekly], now, providerStaleAt(snapshot, id));
    }
  }
  const ring = worst === null ? null : { percent: limitPercent(s, worst.usedPercent), tone: worst.tone };
  const even = worst === null || worst.even === null ? null : limitPercent(s, worst.even);
  useEffect(() => setIndicatorState({ worst: ring, even, title, style, outer, inner }));
  return null;
}
