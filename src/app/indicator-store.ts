// The ring's state outside the plugin slot. The host renders a footer item's
// icon outside the plugin's slot, where SDK hooks throw (see AGENTS.md, Host
// facts, Sidebar footer), so an app overlay that renders nothing reads the
// snapshot and the settings and writes them here; the icon subscribes.

import { useEffect, useSyncExternalStore } from "react";
import { en } from "./i18n";
import { indicatorTitle, indicatorView, type WorstWindow } from "./indicator";
import { useLimitsShow, useNow, useSnapshot, useStrings } from "./hooks";

export interface IndicatorState {
  worst: WorstWindow | null;
  title: string;
}

let state: IndicatorState = { worst: null, title: en.indicatorLabel };
const listeners = new Set<() => void>();

export function getIndicatorState(): IndicatorState {
  return state;
}

/** Everything the ring draws; an equal state does not notify. */
function drawn(s: IndicatorState): string {
  return JSON.stringify([s.title, s.worst?.usedPercent ?? null, s.worst?.tone ?? null]);
}

export function setIndicatorState(next: IndicatorState): void {
  if (drawn(next) === drawn(state)) return;
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useIndicatorState(): IndicatorState {
  return useSyncExternalStore(subscribe, getIndicatorState, getIndicatorState);
}

/** The app overlay that feeds the store; it renders nothing. */
export function IndicatorFeeder() {
  const s = useStrings();
  const show = useLimitsShow();
  const now = useNow();
  const snapshot = useSnapshot().data;
  const worst = snapshot === undefined ? null : indicatorView(snapshot, now).worst;
  const title = snapshot === undefined ? s.indicatorLabel : indicatorTitle(s, worst, show);
  useEffect(() => setIndicatorState({ worst, title }));
  return null;
}
