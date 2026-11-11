// Fixtures for the app tests: snapshots, thread states and a render helper
// with counting RPC handlers.

import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ComponentType } from "react";
import {
  usageForecastContract,
  type CompactLogEntry,
  type CompactResult,
  type LimitsSnapshot,
  type LimitWindow,
  type ProviderLimits,
  type ThreadOverride,
  type ThreadState,
} from "../src/shared/contract";
import { HOUR_MS } from "../src/shared/windows";
import { normalizeOverride } from "../src/shared/contract";

export const T = "thr_a";

export function win(label: string, usedPercent: number, over: Partial<LimitWindow> = {}): LimitWindow {
  return {
    label,
    usedPercent,
    resetsAt: Date.now() + 2 * HOUR_MS,
    model: null,
    cost: null,
    durationMs: 5 * HOUR_MS,
    forecast: { status: "running", current: { projectedPercent: usedPercent, runOutAt: null }, learned: null, warning: false },
    ...over,
  };
}

export function forecastOf(current: number, learned: number | null = null): LimitWindow["forecast"] {
  return {
    status: "running",
    current: { projectedPercent: current, runOutAt: null },
    learned: learned === null ? null : { projectedPercent: learned, runOutAt: null, basedOnWindows: 3 },
    warning: current > 100 || (learned ?? 0) > 100,
  };
}

export function provider(providerId: string, windows: LimitWindow[], over: Partial<ProviderLimits> = {}): ProviderLimits {
  return {
    providerId,
    status: "ok",
    message: null,
    planLabel: null,
    checkedAt: Date.now(),
    measuredAt: Date.now(),
    windows,
    ...over,
  };
}

export function snapshot(providers: ProviderLimits[], over: Partial<LimitsSnapshot> = {}): LimitsSnapshot {
  return { polledAt: Date.now(), pollError: null, providers, recentCompactions: [], ...over };
}

export function entry(i: number, over: Partial<CompactLogEntry> = {}): CompactLogEntry {
  return {
    threadId: `thr_${i}`,
    providerId: "codex",
    at: Date.now() - i * 60_000,
    trigger: "auto",
    beforePercent: 85,
    afterPercent: 30,
    result: "compacted",
    message: null,
    ...over,
  };
}

export function threadState(over: Partial<ThreadState> = {}): ThreadState {
  return {
    threadId: T,
    providerId: "claude-code",
    active: false,
    context: {
      usedTokens: 90_000,
      windowTokens: 150_000,
      limitTokens: 150_000,
      limitSource: "settings",
      percent: 60,
      estimated: false,
      autoCompactAtTokens: 117_000,
      categories: [{ id: "messages", label: "Messages", tokens: 90_000, kind: "used" }],
    },
    override: { autoCompact: "inherit" },
    autoCompact: { enabled: false, thresholdPercent: 80, effectiveThresholdPercent: 76, effectiveThresholdTokens: 114_000, source: "settings" },
    compactSupported: true,
    cooldownUntil: null,
    ...over,
  };
}

export interface Backend {
  snapshot: LimitsSnapshot;
  thread: ThreadState;
  compact: () => Promise<CompactResult>;
  calls: { method: string; input: unknown }[];
  overrides: ThreadOverride[];
}

export function backend(over: Partial<Pick<Backend, "snapshot" | "thread" | "compact">> = {}): Backend {
  return {
    snapshot: over.snapshot ?? snapshot([provider("claude-code", [win("Current session", 40)])]),
    thread: over.thread ?? threadState(),
    compact: over.compact ?? (async () => ({ ok: true, message: null, entry: null })),
    calls: [],
    overrides: [],
  };
}

export function render<P extends object>(
  component: ComponentType<P>,
  props: P,
  b: Backend,
  options: { threadContextKind?: "banner" | "card"; settings?: Record<string, string | number | boolean> } = {},
) {
  const log =
    <R,>(method: string, fn: (input: never) => R | Promise<R>) =>
    async (input: unknown) => {
      b.calls.push({ method, input });
      return fn(input as never);
    };
  return renderSlot({ component }, props, {
    experimental_rpcContract: usageForecastContract,
    pluginId: "usage-forecast",
    composer: { scope: { kind: "thread", threadId: T } },
    threadContextKind: options.threadContextKind ?? "card",
    settings: options.settings ?? { autoCompactEnabled: false, autoCompactThresholdPercent: 80, pollIntervalMinutes: 2 },
    rpc: {
      snapshot: log("snapshot", () => b.snapshot),
      refresh: log("refresh", () => b.snapshot),
      thread: log("thread", () => b.thread),
      compact: log("compact", () => b.compact()),
      setThreadOverride: log("setThreadOverride", (input: { threadId: string; override: ThreadOverride }) => {
        b.overrides.push(input.override);
        const override = normalizeOverride(input.override);
        b.thread = { ...b.thread, override };
        return { override };
      }),
    },
  });
}

export const callsTo = (b: Backend, method: string) => b.calls.filter((c) => c.method === method);
