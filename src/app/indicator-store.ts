// The ring's state outside the plugin slot. The host renders a footer item's
// icon outside the plugin's slot, where SDK hooks throw (see AGENTS.md, Host
// facts, Sidebar footer), so an app overlay that renders nothing reads the
// snapshot and the settings and writes them here; the icon subscribes.

import { useEffect, useSyncExternalStore } from "react";
import { en } from "./i18n";
import { indicatorTitle, indicatorView, type WorstWindow } from "./indicator";
import { createStore } from "./store";
import { useHiddenProviders, useLimitsShow, useNow, useSnapshot, useStrings } from "./hooks";

export interface IndicatorState {
  worst: WorstWindow | null;
  title: string;
}

/** Everything the ring draws; an equal state does not notify. */
function drawn(s: IndicatorState): string {
  return JSON.stringify([s.title, s.worst?.usedPercent ?? null, s.worst?.tone ?? null]);
}

const store = createStore<IndicatorState>({ worst: null, title: en.indicatorLabel }, (a, b) => drawn(a) === drawn(b));

export const getIndicatorState = store.get;
export const setIndicatorState = store.set;

export function useIndicatorState(): IndicatorState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** The app overlay that feeds the store; it renders nothing. */
export function IndicatorFeeder() {
  const s = useStrings();
  const show = useLimitsShow();
  const now = useNow();
  const hidden = useHiddenProviders();
  const snapshot = useSnapshot().data;
  const worst = snapshot === undefined ? null : indicatorView(snapshot, now, hidden).worst;
  const title = snapshot === undefined ? s.indicatorLabel : indicatorTitle(s, worst, show);
  useEffect(() => setIndicatorState({ worst, title }));
  return null;
}
