// Data hooks for the app. Reads refresh on server invalidation: the server
// invalidates a thread on every context event (see CONTEXT_EVENT_TYPES in
// server.ts). The intervals below are a backstop for hosts where realtime
// does not reach the client (the phone on bb 0.49).

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  experimental_usePluginId,
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  useComposer,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { STRINGS, type Strings } from "./i18n";
import { createStore } from "./store";
import { parseLang } from "../shared/language";
import { parseHeaderShow, type HeaderShow } from "../shared/header-show";
import { parseHiddenProviders } from "../shared/hidden-providers";
import { localPeriodStarts } from "../shared/tokens";
import { normalizeOverride, usageForecastContract, type CompactResult, type ThreadOverride } from "../shared/contract";

export const SNAPSHOT_REFETCH_MS = 60_000;
export const THREAD_ACTIVE_REFETCH_MS = 30_000;
export const THREAD_IDLE_REFETCH_MS = 60_000;
export const TOKENS_REFETCH_MS = 5 * 60_000;

function useInterval(callback: () => void, ms: number | null) {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** The table for the `language` setting; English until the settings load. */
export function useStrings(): Strings {
  return STRINGS[parseLang(useSettings().values?.language)];
}

/** The `headerShow` setting; numbers until the settings load. */
export function useHeaderShow(): HeaderShow {
  return parseHeaderShow(useSettings().values?.headerShow);
}

/** The `showFloat` setting; off until the settings load and unless it is switched on. */
export function useFloatShown(): boolean {
  return useSettings().values?.showFloat === true;
}

/** The `showBand` setting; on until the settings load and unless it is switched off. */
export function useBandShown(): boolean {
  return useSettings().values?.showBand !== false;
}

// A press on Hide takes the provider out at once, before the settings follow
// the save. The ids pressed in this session live here; an id goes once the
// settings list it (so un-hiding it later on the settings page works) or when
// the save fails.

const hiddenHere = createStore<readonly string[]>([], (a, b) => a.length === b.length && a.every((id, i) => id === b[i]));

/** Drops every pressed Hide; for tests, whose renders share this module. */
export function clearHiddenOverrides() {
  hiddenHere.set([]);
}

/** The `hiddenProviders` setting, parsed, with the ids just pressed; none until the settings load. */
export function useHiddenProviders(): string[] {
  const raw = useSettings().values?.hiddenProviders;
  const setting = useMemo(() => parseHiddenProviders(raw), [raw]);
  const here = useSyncExternalStore(hiddenHere.subscribe, hiddenHere.get, hiddenHere.get);
  const landed = here.some((id) => setting.includes(id));
  useEffect(() => {
    if (landed) hiddenHere.set(hiddenHere.get().filter((id) => !setting.includes(id)));
  }, [landed, setting]);
  return useMemo(() => (here.length === 0 ? setting : [...new Set([...setting, ...here])]), [setting, here]);
}

/** Hides one provider from a press: at once in this app, then in the setting. */
export function useHideProvider() {
  const mutation = experimental_useRpcMutation({ contract: usageForecastContract, method: "hideProvider" });
  return useCallback(
    (providerId: string) => {
      const [id] = parseHiddenProviders(providerId);
      if (id === undefined) return;
      if (!hiddenHere.get().includes(id)) hiddenHere.set([...hiddenHere.get(), id]);
      mutation.mutate({ providerId: id }).catch(() => {
        // No error banner: the block comes back as it was before the press.
        hiddenHere.set(hiddenHere.get().filter((x) => x !== id));
      });
    },
    [mutation],
  );
}

export function useSnapshot() {
  const query = experimental_useRpcQuery({ contract: usageForecastContract, method: "snapshot", input: null });
  useInterval(() => void query.refetch(), SNAPSHOT_REFETCH_MS);
  return query;
}

export function useThreadState(threadId: string | null) {
  const query = experimental_useRpcQuery({
    contract: usageForecastContract,
    method: "thread",
    input: { threadId: threadId ?? "-" },
    enabled: threadId !== null,
  });
  const ms = threadId === null ? null : query.data?.active ? THREAD_ACTIVE_REFETCH_MS : THREAD_IDLE_REFETCH_MS;
  useInterval(() => void query.refetch(), ms);
  return query;
}

/**
 * UF-12: the thread's token total (null for none) and each provider's sums for
 * the local day and month. The starts change only at local midnight, so the
 * query keeps its key between minutes; the server invalidates on every count.
 */
export function useTokens(threadId: string | null) {
  const { dayStart, monthStart } = localPeriodStarts(useNow());
  const query = experimental_useRpcQuery({
    contract: usageForecastContract,
    method: "tokens",
    input: { threadId, dayStart, monthStart },
  });
  useInterval(() => void query.refetch(), TOKENS_REFETCH_MS);
  return query;
}

/** The thread of the composer, or null outside a thread. */
export function useComposerThreadId(): string | null {
  const { scope } = useComposer();
  return scope.kind === "thread" ? scope.threadId : null;
}

export interface CompactState {
  pending: boolean;
  /** Why the last compact did not start, until the next attempt. */
  error: string | null;
  compact(): void;
}

/** A manual compact; a second click while one is pending does nothing. */
export function useCompact(threadId: string | null): CompactState {
  const didNotStart = useStrings().compactDidNotStart;
  const mutation = experimental_useRpcMutation({ contract: usageForecastContract, method: "compact" });
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const compact = useCallback(() => {
    if (threadId === null || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    mutation.mutate({ threadId }).then(
      (result: CompactResult) => {
        if (!result.ok) setError(result.message ?? didNotStart);
      },
      (e: unknown) => setError(errorText(e)),
    ).finally(() => {
      inFlight.current = false;
      setPending(false);
    });
  }, [didNotStart, mutation, threadId]);
  return { pending, error, compact };
}

export function useSetOverride(threadId: string) {
  const mutation = experimental_useRpcMutation({
    contract: usageForecastContract,
    method: "setThreadOverride",
    // Show the new mode at once; the server's invalidation brings the
    // effective threshold.
    optimistic: (input, cache) =>
      cache.update("thread", { threadId: input.threadId }, (current) => ({
        ...current,
        override: normalizeOverride(input.override),
      })),
  });
  const [error, setError] = useState<string | null>(null);
  const set = useCallback(
    (override: ThreadOverride) => {
      setError(null);
      mutation.mutate({ threadId, override }).catch((e: unknown) => setError(errorText(e)));
    },
    [mutation, threadId],
  );
  return { set, pending: mutation.isPending, error };
}

/** Banner expanded/collapsed, kept per device. Collapsed by default. */
export function useExpanded(): [boolean, (expanded: boolean) => void] {
  const key = `${experimental_usePluginId()}:banner-expanded`;
  const [expanded, setExpanded] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const update = useCallback(
    (next: boolean) => {
      setExpanded(next);
      try {
        globalThis.localStorage?.setItem(key, next ? "1" : "0");
      } catch {
        // Storage can be unavailable (private mode); the state still works in memory.
      }
    },
    [key],
  );
  return [expanded, update];
}

/** Re-renders every minute so "resets in 2h" and "5m ago" stay current. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 60_000);
  return now;
}

export interface RefreshState {
  refresh(): void;
  pending: boolean;
  error: string | null;
}

/** Polls the limits now (RPC `refresh`) and reloads the snapshot. */
export function useRefreshLimits(): RefreshState {
  const mutation = experimental_useRpcMutation({ contract: usageForecastContract, method: "refresh" });
  const snapshot = useSnapshot();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    setPending(true);
    setError(null);
    mutation
      .mutate(null)
      .then(() => snapshot.refetch())
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setPending(false));
  }, [mutation, snapshot]);
  return { refresh, pending, error };
}

/** The app path of a plugin's settings page (bb 0.50: `/settings/plugins/:pluginId`). */
export function pluginSettingsPath(pluginId: string): string {
  return `/settings/plugins/${encodeURIComponent(pluginId)}`;
}

/**
 * Opens this plugin's settings page. The SDK has no navigation to settings,
 * so this pushes the app route and lets the app's router follow the
 * `popstate` event.
 */
export function useOpenSettings(): () => void {
  const pluginId = experimental_usePluginId();
  return useCallback(() => {
    window.history.pushState(window.history.state, "", pluginSettingsPath(pluginId));
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, [pluginId]);
}
