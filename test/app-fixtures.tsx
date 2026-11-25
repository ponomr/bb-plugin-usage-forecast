// Fixtures for the app tests: snapshots, thread states and a render helper
// with counting RPC handlers.

import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ComponentType } from "react";
import {
  usageForecastContract,
  type CompactLogEntry,
  type CompactResult,
  type HostLimits,
  type LimitsSnapshot,
  type LimitWindow,
  type ProviderLimits,
  type ThreadOverride,
  type ThreadState,
  type Tokens,
  type TokensInput,
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
    forecast: {
      status: "running",
      current: { projectedPercent: usedPercent, runOutAt: null },
      learned: null,
      main: "current",
      early: false,
      warning: false,
    },
    pace: null,
    ...over,
  };
}

export function forecastOf(current: number, learned: number | null = null): LimitWindow["forecast"] {
  return {
    status: "running",
    current: { projectedPercent: current, runOutAt: null },
    learned: learned === null ? null : { projectedPercent: learned, runOutAt: null, basedOnWindows: 3 },
    main: "current",
    early: false,
    warning: current > 100,
  };
}

export function provider(providerId: string, windows: LimitWindow[], over: Partial<ProviderLimits> = {}): ProviderLimits {
  return {
    providerId,
    status: "ok",
    message: null,
    planLabel: null,
    planMultiplier: null,
    checkedAt: Date.now(),
    measuredAt: Date.now(),
    windows,
    ...over,
  };
}

export function snapshot(providers: ProviderLimits[], over: Partial<LimitsSnapshot> = {}): LimitsSnapshot {
  return { polledAt: Date.now(), pollError: null, hosts: [host(null, providers)], recentCompactions: [], ...over };
}

/** One host's record; `hostId` null is the record of an install whose hosts are not known yet. */
export function host(hostId: string | null, providers: ProviderLimits[], over: Partial<HostLimits> = {}): HostLimits {
  return {
    hostId,
    name: hostId,
    connected: true,
    primary: hostId === null,
    polledAt: Date.now(),
    pollError: null,
    providers,
    ...over,
  };
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
    hostId: null,
    active: false,
    context: {
      usedTokens: 90_000,
      windowTokens: 150_000,
      limitTokens: 150_000,
      // A Claude Code limit set above the point where it compacts on its own.
      limitSource: "provider",
      percent: 60,
      estimated: false,
      autoCompactAtTokens: 117_000,
      categories: [{ id: "messages", label: "Messages", tokens: 90_000, kind: "used" }],
    },
    override: { autoCompact: "inherit" },
    autoCompact: { enabled: false, thresholdPercent: 80, effectiveThresholdPercent: 76, effectiveThresholdTokens: 114_000, source: "settings" },
    compactSupported: true,
    summaryClear: false,
    cooldownUntil: null,
    ...over,
  };
}

export interface Backend {
  snapshot: LimitsSnapshot;
  thread: ThreadState;
  compact: () => Promise<CompactResult>;
  hideProvider: (input: { providerId: string }) => Promise<{ hiddenProviders: string[] }>;
  /** The `tokens` answer; nothing counted by default. */
  tokens: (input: TokensInput) => Promise<Tokens>;
  calls: { method: string; input: unknown }[];
  overrides: ThreadOverride[];
}

export function backend(over: Partial<Pick<Backend, "snapshot" | "thread" | "compact" | "hideProvider" | "tokens">> = {}): Backend {
  return {
    snapshot: over.snapshot ?? snapshot([provider("claude-code", [win("Current session", 40)])]),
    thread: over.thread ?? threadState(),
    compact: over.compact ?? (async () => ({ ok: true, message: null, entry: null })),
    hideProvider: over.hideProvider ?? (async (input) => ({ hiddenProviders: [input.providerId] })),
    tokens: over.tokens ?? (async () => ({ thread: null, providers: [], backfillDone: true })),
    calls: [],
    overrides: [],
  };
}

export function render<P extends object>(
  component: ComponentType<P>,
  props: P,
  b: Backend,
  options: {
    threadContextKind?: "banner" | "card";
    settings?: Record<string, string | number | boolean>;
    providers?: NonNullable<Parameters<typeof renderSlot>[2]>["providers"];
  } = {},
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
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    // The tests below were written for the share used; the share left (the default) has its own tests.
    settings: { percentMode: "used", ...(options.settings ?? { autoCompactEnabled: false, autoCompactThresholdPercent: 80, pollIntervalMinutes: 2 }) },
    rpc: {
      snapshot: log("snapshot", () => b.snapshot),
      refresh: log("refresh", () => b.snapshot),
      thread: log("thread", () => b.thread),
      compact: log("compact", () => b.compact()),
      hideProvider: log("hideProvider", (input: { providerId: string }) => b.hideProvider(input)),
      tokens: log("tokens", (input: TokensInput) => b.tokens(input)),
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
