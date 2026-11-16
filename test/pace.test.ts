import { describe, expect, it } from "vitest";
import type { WindowForecast } from "../src/shared/forecast";
import {
  CALM_HOLD_MS,
  nextPace,
  paceStateTone,
  rawPaceState,
  worsePace,
  type HeldPace,
  type PaceState,
} from "../src/shared/pace";
import { HOUR_MS, MIN_MS } from "../src/shared/windows";

const NOW = Date.UTC(2026, 10, 16, 12, 0);
const FIVE_H = 5 * HOUR_MS;

function current(projectedPercent: number, runOutAt: number | null = null): WindowForecast {
  return {
    status: "running",
    current: { projectedPercent, runOutAt },
    learned: null,
    main: "current",
    early: false,
    warning: projectedPercent > 100,
  };
}

const raw = (usedPercent: number, forecast: WindowForecast | null, durationMs: number | null = FIVE_H) =>
  rawPaceState({ usedPercent, durationMs, forecast }, NOW);

describe("rawPaceState", () => {
  it("is calm or tight by the projection as shown (AE1, AE3)", () => {
    expect(raw(80, current(83))).toBe("calm");
    expect(raw(80, current(84.4))).toBe("calm");
    expect(raw(80, current(84.6))).toBe("tight");
    expect(raw(92, current(94))).toBe("tight");
    expect(raw(92, current(100))).toBe("tight");
  });

  it("will not last strictly above 100 %", () => {
    expect(raw(92, current(100.4, NOW + HOUR_MS))).toBe("short");
  });

  it("is critical when the run-out is within a tenth of the window (AE2)", () => {
    expect(raw(40, current(200, NOW + 90 * MIN_MS))).toBe("short");
    expect(raw(40, current(200, NOW + 30 * MIN_MS))).toBe("critical");
    expect(raw(40, current(200, NOW + FIVE_H / 10))).toBe("critical");
    expect(raw(40, current(200, NOW + FIVE_H / 10 + 1))).toBe("short");
    // A run-out already passed between polls is critical, not used up.
    expect(raw(95, current(110, NOW - MIN_MS))).toBe("critical");
  });

  it("stays short without a run-out time", () => {
    expect(raw(40, current(200, null))).toBe("short");
    expect(raw(40, current(200, NOW + MIN_MS), null)).toBe("short");
  });

  it("is used up at 100 % with or without a forecast", () => {
    expect(raw(100, null)).toBe("hit");
    expect(raw(100, { ...current(100, NOW), status: "hit" })).toBe("hit");
    expect(raw(100, current(50))).toBe("hit");
  });

  it("has no state early or without a forecast (AE6)", () => {
    const early: WindowForecast = {
      status: "running",
      current: null,
      learned: { projectedPercent: 300, runOutAt: NOW + MIN_MS, basedOnWindows: 3 },
      main: "learned",
      early: true,
      warning: false,
    };
    expect(raw(3, early)).toBeNull();
    expect(raw(3, { ...early, learned: null, main: null })).toBeNull();
    expect(raw(80, null)).toBeNull();
  });

  it("reads a forecast stored before `main` from the current pace", () => {
    const old = { status: "running" as const, current: { projectedPercent: 150, runOutAt: NOW + HOUR_MS * 3 }, learned: null, warning: true };
    expect(rawPaceState({ usedPercent: 40, durationMs: FIVE_H, forecast: old }, NOW)).toBe("short");
  });
});

describe("nextPace", () => {
  // Polls `states` every `stepMs` starting at NOW, from `start`.
  function run(states: (PaceState | null)[], stepMs = 2 * MIN_MS, start: HeldPace | null = null) {
    let held = start;
    const seen: (HeldPace | null)[] = [];
    states.forEach((state, i) => {
      held = nextPace(held, state, NOW + i * stepMs);
      seen.push(held);
    });
    return seen;
  }

  it("takes the first reading at once", () => {
    expect(nextPace(null, "tight", NOW)).toEqual({ state: "tight", calmer: null });
    expect(nextPace(undefined, null, NOW)).toBeNull();
  });

  it("calms down only after ten minutes of calmer readings (AE4)", () => {
    const seen = run(["short", "calm", "calm", "calm", "calm", "calm", "calm"]);
    expect(seen[1]).toEqual({ state: "short", calmer: { state: "calm", since: NOW + 2 * MIN_MS } });
    // 2 + 8 minutes: still held.
    expect(seen[5]?.state).toBe("short");
    // 2 + 10 minutes: calm.
    expect(seen[6]).toEqual({ state: "calm", calmer: null });
  });

  it("switches to the worst state read during the hold (AE5)", () => {
    // Polled every minute: critical, tight from minute 1 to 4, short from minute 5.
    const states: PaceState[] = ["critical", ...Array<PaceState>(4).fill("tight"), ...Array<PaceState>(7).fill("short")];
    const seen = run(states, MIN_MS);
    expect(seen[10]?.state).toBe("critical");
    // Ten minutes after the first calmer reading.
    expect(seen[11]).toEqual({ state: "short", calmer: null });
  });

  it("applies a reading as bad as the held state at once and drops the hold", () => {
    const held: HeldPace = { state: "short", calmer: { state: "calm", since: NOW } };
    expect(nextPace(held, "short", NOW + MIN_MS)).toEqual({ state: "short", calmer: null });
    expect(nextPace(held, "critical", NOW + MIN_MS)).toEqual({ state: "critical", calmer: null });
  });

  it("updates only the remembered state for a reading between the two", () => {
    const held: HeldPace = { state: "critical", calmer: { state: "calm", since: NOW } };
    expect(nextPace(held, "short", NOW + MIN_MS)).toEqual({ state: "critical", calmer: { state: "short", since: NOW } });
    // A calmer reading after that keeps the worse remembered state.
    const after = nextPace(nextPace(held, "short", NOW + MIN_MS), "tight", NOW + 2 * MIN_MS);
    expect(after).toEqual({ state: "critical", calmer: { state: "short", since: NOW } });
  });

  it("is satisfied by the first calmer poll after the hold with a long interval", () => {
    const seen = run(["short", "calm", "calm"], 15 * MIN_MS);
    expect(seen[1]?.state).toBe("short");
    expect(seen[2]).toEqual({ state: "calm", calmer: null });
    expect(CALM_HOLD_MS).toBe(10 * MIN_MS);
  });

  it("drops the state when the window loses its pace", () => {
    expect(nextPace({ state: "short", calmer: null }, null, NOW)).toBeNull();
  });
});

describe("pace tone and order", () => {
  it("colours red only the urgent states", () => {
    expect(paceStateTone("calm")).toBe("normal");
    expect(paceStateTone("tight")).toBe("amber");
    expect(paceStateTone("short")).toBe("amber");
    expect(paceStateTone("critical")).toBe("red");
    expect(paceStateTone("hit")).toBe("red");
  });

  it("orders calm < tight < short < critical < hit", () => {
    expect(worsePace("calm", "tight")).toBe("tight");
    expect(worsePace("critical", "short")).toBe("critical");
    expect(worsePace("hit", "critical")).toBe("hit");
    expect(worsePace("tight", null)).toBe("tight");
  });
});
