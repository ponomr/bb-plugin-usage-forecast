// Snapshots shared by the CLI headroom tests.
import type { HostLimits, LimitsSnapshot, LimitWindow, ProviderLimits } from "../src/shared/contract";
import type { WindowForecast } from "../src/shared/forecast";
import { DAY_MS, HOUR_MS, MIN_MS } from "../src/shared/windows";

export const NOW = Date.UTC(2026, 10, 16, 0, 10);
const FIVE_H = 5 * HOUR_MS;
const WEEK = 7 * DAY_MS;

export function current(projectedPercent: number, runOutAt: number | null = null): WindowForecast {
  return { status: "running", current: { projectedPercent, runOutAt }, learned: null, main: "current", early: false, warning: projectedPercent > 100 };
}

export const HIT: WindowForecast = {
  status: "hit",
  current: { projectedPercent: 100, runOutAt: NOW },
  learned: null,
  main: "current",
  early: false,
  warning: true,
};

export function win(label: string, usedPercent: number, over: Partial<LimitWindow> = {}): LimitWindow {
  const weekly = label !== "Current session";
  return {
    label,
    usedPercent,
    resetsAt: NOW + (weekly ? DAY_MS + 6 * HOUR_MS : HOUR_MS + 40 * MIN_MS),
    model: null,
    cost: null,
    durationMs: weekly ? WEEK : FIVE_H,
    forecast: null,
    pace: null,
    ...over,
  };
}

export function paced(label: string, usedPercent: number, projected: number, over: Partial<LimitWindow> = {}): LimitWindow {
  const runOutAt = projected > 100 ? NOW + HOUR_MS : null;
  const pace = projected > 100 ? "short" : Math.round(projected) >= 85 ? "tight" : "calm";
  return win(label, usedPercent, { forecast: current(projected, runOutAt), pace, ...over });
}

export function provider(providerId: string, windows: LimitWindow[], over: Partial<ProviderLimits> = {}): ProviderLimits {
  return { providerId, status: "ok", message: null, planLabel: null, checkedAt: NOW, measuredAt: NOW, windows, ...over };
}

export function host(hostId: string | null, name: string | null, providers: ProviderLimits[], over: Partial<HostLimits> = {}): HostLimits {
  return { hostId, name, connected: true, primary: hostId === "host_server", polledAt: NOW, pollError: null, providers, ...over };
}

export function snap(hosts: HostLimits[], polledAt: number | null = NOW - MIN_MS): LimitsSnapshot {
  return { polledAt, pollError: null, hosts, recentCompactions: [] };
}

/** AE1 on one host: Codex calm, Claude Code tight on its session. */
export function ae1Providers(): ProviderLimits[] {
  return [
    provider("claude-code", [paced("Current session", 62, 95), paced("Weekly limit", 40, 64)], { planLabel: "Max" }),
    provider("codex", [paced("Current session", 10, 21), paced("Weekly limit", 57, 69)], { planLabel: "Plus" }),
    provider("acp-x", [], { status: "not_installed", measuredAt: null }),
  ];
}
