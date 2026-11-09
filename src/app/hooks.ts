// Data hooks for the app. Reads refresh on server invalidation; the intervals
// below are a fallback for hosts where realtime does not reach the client
// (the phone on bb 0.49).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_usePluginId,
  experimental_useRpcMutation,
  experimental_useRpcQuery,
  useComposer,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { useStrings } from "./i18n";
import { parseLimitsShow, type LimitsShow } from "../shared/limits-show";
import { normalizeOverride, usageForecastContract, type CompactResult, type ThreadOverride } from "../shared/contract";

export const SNAPSHOT_REFETCH_MS = 60_000;
export const THREAD_ACTIVE_REFETCH_MS = 5_000;
export const THREAD_IDLE_REFETCH_MS = 60_000;

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

/** The `limitsShow` setting; used until the settings load. */
export function useLimitsShow(): LimitsShow {
  return parseLimitsShow(useSettings().values?.limitsShow);
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
