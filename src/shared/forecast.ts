// Usage forecast for one limit window.
//
// Adapted from claude-code-usage-quota-mod (hooks/register.tsx, `forecast`,
// `trackPace`, `median`), https://github.com/anantraghunath/claude-code-usage-quota-mod,
// Copyright (c) 2026 Anant Raghunath, MIT License. See NOTICE.
//
// Changes from the mod: the mod blends the window's own pace with the usual
// one into a single projection; here the two are separate.
// `current` extrapolates the window's own pace, `learned` the median peak of
// past windows of the same (providerId, label). The mod's blend damped early
// jumps; instead `current` stays null for the first 5 % of a window.
//
// One of the two is the main projection: `current` once 5 % of the window has
// passed, `learned` before that. The warning, the colour and the wording all
// follow the main one; an early window never warns.
//
// Pure: no SDK, no clock. Callers pass `now` and the closed windows.

import { forecastWarns } from "./thresholds";
import { DAY_MS, HOUR_MS } from "./windows";

/** A closed window kept for the learned pace. Times are epoch ms. */
export interface ClosedWindow {
  startedAt: number;
  resetAt: number;
  peakUsedPercent: number;
}

export interface Projection {
  /** Percent of the limit used at the reset at this pace. */
  projectedPercent: number;
  /** When the limit runs out at this pace, or null when it lasts to the reset. */
  runOutAt: number | null;
}

export interface WindowForecast {
  /** `hit`: already at 100 %. `running`: in progress. */
  status: "hit" | "running";
  current: Projection | null;
  learned: (Projection & { basedOnWindows: number }) | null;
  /**
   * The projection that speaks for the window: `current` when it exists,
   * `learned` while the window is early, null with neither.
   */
  main: "current" | "learned" | null;
  /** Less than `MIN_ELAPSED_FRACTION` of a running window has passed, or elapsed is unknown. */
  early: boolean;
  /** True when the limit is hit, or the window is not early and the main projection is above 100 %. */
  warning: boolean;
}

export interface ForecastInput {
  usedPercent: number;
  /** Epoch ms of the reset, or null when the host gives none. */
  resetsAt: number | null;
  /** From `windowDurationMs`; null for an unknown window. */
  durationMs: number | null;
  now: number;
  /** Closed windows of the same (providerId, label), oldest first. */
  closedWindows?: readonly ClosedWindow[];
}

/** The learned pace uses the most recent windows only (the mod's FINALS_KEPT). */
export const LEARNED_WINDOWS_USED = 8;
/** `current` is withheld until this share of the window has passed. */
export const MIN_ELAPSED_FRACTION = 0.05;
/** Two resets closer than this are one window seen twice (the mod's SAME_WINDOW_MS). */
export const SAME_WINDOW_MS = 10 * 60_000;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Median peak of the most recent closed windows, or null with no history. */
export function typicalPeak(closedWindows: readonly ClosedWindow[]): number | null {
  return median(closedWindows.slice(-LEARNED_WINDOWS_USED).map((w) => w.peakUsedPercent));
}

/** True when `next` is a reset of a different window than `previous`. */
export function isNewWindow(previous: number | null, next: number | null): boolean {
  if (previous === null || next === null) return previous !== next;
  return Math.abs(next - previous) > SAME_WINDOW_MS;
}

function project(used: number, ratePerMs: number, now: number, remaining: number): Projection {
  const projectedPercent = used + ratePerMs * remaining;
  const runOutAt = projectedPercent >= 100 && ratePerMs > 0 ? now + (100 - used) / ratePerMs : null;
  return { projectedPercent, runOutAt };
}

/**
 * Forecast for one window, or null when there is none: an unknown duration,
 * no reset time, or a reset already in the past.
 */
export function forecastWindow(input: ForecastInput): WindowForecast | null {
  const { usedPercent: used, resetsAt, durationMs, now } = input;
  if (durationMs === null || durationMs <= 0) return null;
  if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= now) return null;

  if (used >= 100) {
    const hit: Projection = { projectedPercent: used, runOutAt: now };
    return { status: "hit", current: hit, learned: null, main: "current", early: false, warning: true };
  }

  const remaining = resetsAt - now;
  // A reset further away than one duration means the label table is wrong
  // for this window; elapsed is then unknown and only `learned` applies.
  const elapsed = durationMs - remaining;

  const early = elapsed < durationMs * MIN_ELAPSED_FRACTION;
  const current = early ? null : project(used, used / elapsed, now, remaining);

  const history = input.closedWindows ?? [];
  const typical = typicalPeak(history);
  const learned =
    typical === null
      ? null
      : {
          ...project(used, typical / durationMs, now, remaining),
          basedOnWindows: Math.min(history.length, LEARNED_WINDOWS_USED),
        };

  const main = current ? "current" : learned ? "learned" : null;
  const warning = current !== null && forecastWarns(current.projectedPercent);
  return { status: "running", current, learned, main, early, warning };
}

export interface LastingBudget {
  /** Percent of the limit per `per` that lasts to the reset; for `rest`, the percent left. */
  percent: number;
  /** `day` for windows of two days or more, else `hour`; `rest` when less than one unit remains. */
  per: "day" | "hour" | "rest";
}

/**
 * The spending rate that makes the limit last to the reset, or null when
 * there is none: no reset, a passed reset, an unknown duration or no limit left.
 */
export function lastingBudget(input: Omit<ForecastInput, "closedWindows">): LastingBudget | null {
  const { usedPercent: used, resetsAt, durationMs, now } = input;
  if (durationMs === null || durationMs <= 0 || used >= 100) return null;
  if (resetsAt === null || !Number.isFinite(resetsAt) || resetsAt <= now) return null;
  const left = 100 - Math.max(0, used);
  const remaining = resetsAt - now;
  const unit = durationMs >= 2 * DAY_MS ? DAY_MS : HOUR_MS;
  if (remaining < unit) return { percent: left, per: "rest" };
  return { percent: (left / remaining) * unit, per: unit === DAY_MS ? "day" : "hour" };
}
