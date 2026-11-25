// Pace state of a limit window: whether the limit lasts to the reset at the
// window's current pace. It sets the window's colour and the band's headline.
//
//   calm      the projection at the reset, as shown, is below TIGHT_PERCENT
//   tight     it is TIGHT_PERCENT or more, up to 100 %
//   short     it is above 100 %: the limit will not last
//   critical  above 100 % and the limit runs out within
//             CRITICAL_WINDOW_FRACTION of the window's duration from now
//   hit       the limit is used up
//
// Only the current pace gives a state. An early window (the learned pace
// speaks for it) or a window without a forecast has none and is `muted` (not
// coloured), except at 100 %, which is always `hit`.
//
// A worse state applies on the poll that reads it. A calmer one applies only
// after every reading for CALM_HOLD_MS was calmer, and then it is the worst
// state read during that hold.
//
// Pure: no SDK, no clock. Callers pass `now`.

import { mainProjection, type WindowForecast } from "./forecast";
import { forecastWarns, type Tone } from "./thresholds";

export const PACE_STATES = ["calm", "tight", "short", "critical", "hit"] as const;
export type PaceState = (typeof PACE_STATES)[number];

/** A projection at or above this percent, as shown, is tight. */
const TIGHT_PERCENT = 85;
/** A run-out within this share of the window's duration from now is critical. */
const CRITICAL_WINDOW_FRACTION = 0.1;
/** How long every reading must be calmer before the state calms down. */
export const CALM_HOLD_MS = 10 * 60_000;

const RANK: Record<PaceState, number> = { calm: 0, tight: 1, short: 2, critical: 3, hit: 4 };

export function paceRank(state: PaceState): number {
  return RANK[state];
}

/** The worse of two states; a missing one loses. */
export function worsePace(a: PaceState, b: PaceState | null | undefined): PaceState {
  return b == null || RANK[a] >= RANK[b] ? a : b;
}

export function paceStateTone(state: PaceState): Tone {
  switch (state) {
    case "calm":
      return "normal";
    case "tight":
    case "short":
      return "amber";
    case "critical":
    case "hit":
      return "red";
  }
}

interface PaceInput {
  usedPercent: number;
  durationMs: number | null;
  /** A forecast stored before `main` and `early` existed reads as `mainProjection` says. */
  forecast:
    | (Pick<WindowForecast, "current" | "learned"> & Partial<Pick<WindowForecast, "status" | "main" | "early">>)
    | null;
}

/** The state this reading gives, or null when the window has no current pace. */
export function rawPaceState(input: PaceInput, now: number): PaceState | null {
  const { usedPercent, durationMs, forecast: f } = input;
  if (usedPercent >= 100 || f?.status === "hit") return "hit";
  if (f == null) return null;
  const main = mainProjection(f);
  if (main === null || main !== f.current) return null;
  const projected = main.projectedPercent;
  if (forecastWarns(projected)) {
    const soon =
      main.runOutAt !== null && durationMs !== null && main.runOutAt - now <= durationMs * CRITICAL_WINDOW_FRACTION;
    return soon ? "critical" : "short";
  }
  return Math.round(projected) >= TIGHT_PERCENT ? "tight" : "calm";
}

/** The state shown and, while it waits to calm down, the hold. Stored with the open window. */
export interface HeldPace {
  state: PaceState;
  /** The worst calmer state read since `since`, or null when no hold runs. */
  calmer: { state: PaceState; since: number } | null;
}

/** The held state after a reading; null when the window has no pace. */
export function nextPace(previous: HeldPace | null | undefined, raw: PaceState | null, now: number): HeldPace | null {
  if (raw === null) return null;
  if (previous == null || RANK[raw] >= RANK[previous.state]) return { state: raw, calmer: null };
  const calmer = previous.calmer
    ? { state: worsePace(raw, previous.calmer.state), since: previous.calmer.since }
    : { state: raw, since: now };
  if (now - calmer.since >= CALM_HOLD_MS) return { state: calmer.state, calmer: null };
  return { state: previous.state, calmer };
}
