import { describe, expect, it } from "vitest";
import {
  type ClosedWindow,
  forecastWindow,
  isNewWindow,
  lastingBudget,
  LEARNED_WINDOWS_USED,
  median,
  typicalPeak,
} from "../src/shared/forecast";
import { windowForecastSchema } from "../src/shared/contract";
import { contextTone, forecastWarns } from "../src/shared/thresholds";
import { DAY_MS, HOUR_MS, windowDurationMs, windowKey } from "../src/shared/windows";

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const FIVE_HOURS = 5 * HOUR_MS;

function closed(peaks: number[]): ClosedWindow[] {
  return peaks.map((peakUsedPercent, i) => ({
    startedAt: NOW - (peaks.length - i + 1) * FIVE_HOURS,
    resetAt: NOW - (peaks.length - i) * FIVE_HOURS,
    peakUsedPercent,
  }));
}

describe("forecastWindow", () => {
  it("projects 40 % at half the window to 80 % at the reset", () => {
    const f = forecastWindow({ usedPercent: 40, resetsAt: NOW + FIVE_HOURS / 2, durationMs: FIVE_HOURS, now: NOW });
    expect(f?.current?.projectedPercent).toBeCloseTo(80);
    expect(f?.current?.runOutAt).toBeNull();
    expect(f?.warning).toBe(false);
  });

  it("gives the current pace and no learned pace without history", () => {
    const f = forecastWindow({ usedPercent: 10, resetsAt: NOW + 4 * HOUR_MS, durationMs: FIVE_HOURS, now: NOW });
    expect(f?.current?.projectedPercent).toBeCloseTo(50);
    expect(f?.learned).toBeNull();
  });

  it("learns the median peak of past windows", () => {
    const history = closed([30, 50, 50, 70, 90]);
    expect(typicalPeak(history)).toBe(50);
    // 20 % used with half the window left: 20 + 50 * 0.5 = 45.
    const f = forecastWindow({
      usedPercent: 20,
      resetsAt: NOW + FIVE_HOURS / 2,
      durationMs: FIVE_HOURS,
      now: NOW,
      closedWindows: history,
    });
    expect(f?.learned?.projectedPercent).toBeCloseTo(45);
    expect(f?.learned?.basedOnWindows).toBe(5);
  });

  it("shows learned next to current 20 minutes into a window (AE2)", () => {
    const f = forecastWindow({
      usedPercent: 5,
      resetsAt: NOW + FIVE_HOURS - 20 * 60_000,
      durationMs: FIVE_HOURS,
      now: NOW,
      closedWindows: closed([30, 50, 50, 70, 90]),
    });
    expect(f?.current).not.toBeNull();
    expect(f?.learned).not.toBeNull();
  });

  it("withholds the current pace in the first 5 % of a window", () => {
    const f = forecastWindow({
      usedPercent: 2,
      resetsAt: NOW + FIVE_HOURS - 5 * 60_000,
      durationMs: FIVE_HOURS,
      now: NOW,
    });
    expect(f?.status).toBe("running");
    expect(f?.current).toBeNull();
    expect(f?.warning).toBe(false);
  });

  it("uses only the most recent windows for the learned pace", () => {
    const history = closed([...Array(20).fill(10), ...Array(LEARNED_WINDOWS_USED).fill(60)]);
    expect(typicalPeak(history)).toBe(60);
  });

  it("warns above 100 % and gives the run-out time", () => {
    // 80 % after 2 h of 5 is 40 %/h; 3 h left gives 200 %, out after 0.5 h.
    const f = forecastWindow({ usedPercent: 80, resetsAt: NOW + 3 * HOUR_MS, durationMs: FIVE_HOURS, now: NOW });
    expect(f?.current?.projectedPercent).toBeCloseTo(200);
    expect(f?.current?.runOutAt).toBe(NOW + HOUR_MS / 2);
    expect(f?.warning).toBe(true);
  });

  it("does not warn at exactly 100 %", () => {
    const f = forecastWindow({ usedPercent: 50, resetsAt: NOW + FIVE_HOURS / 2, durationMs: FIVE_HOURS, now: NOW });
    expect(f?.current?.projectedPercent).toBeCloseTo(100);
    expect(f?.warning).toBe(false);
  });

  it("does not warn on the learned pace alone (AE2)", () => {
    // 20 % after 2.5 h is 8 %/h: 40 % at the reset. Learned: 20 + 200 * 0.5 = 120.
    const f = forecastWindow({
      usedPercent: 20,
      resetsAt: NOW + FIVE_HOURS / 2,
      durationMs: FIVE_HOURS,
      now: NOW,
      closedWindows: closed([200, 200, 200]),
    });
    expect(f?.current?.projectedPercent).toBeCloseTo(40);
    expect(f?.learned?.projectedPercent).toBeCloseTo(120);
    expect(f?.main).toBe("current");
    expect(f?.warning).toBe(false);
  });

  it("warns on the current pace even when the learned one lasts (AE2)", () => {
    // 60 % after 2.5 h: 120 % at the reset. Learned: 60 + 40 * 0.5 = 80.
    const f = forecastWindow({
      usedPercent: 60,
      resetsAt: NOW + FIVE_HOURS / 2,
      durationMs: FIVE_HOURS,
      now: NOW,
      closedWindows: closed([40, 40, 40]),
    });
    expect(f?.current?.projectedPercent).toBeCloseTo(120);
    expect(f?.learned?.projectedPercent).toBeCloseTo(80);
    expect(f?.warning).toBe(true);
  });

  it("names the current pace as main once 5 % of the window has passed", () => {
    const f = forecastWindow({
      usedPercent: 20,
      resetsAt: NOW + FIVE_HOURS / 2,
      durationMs: FIVE_HOURS,
      now: NOW,
      closedWindows: closed([50]),
    });
    expect(f).toMatchObject({ main: "current", early: false });
  });

  it("names the learned pace as main and never warns while early (AE4)", () => {
    // 6 minutes of 5 h is 2 %; a usual peak of 110 % projects above 100 %.
    const f = forecastWindow({
      usedPercent: 3,
      resetsAt: NOW + FIVE_HOURS - 6 * 60_000,
      durationMs: FIVE_HOURS,
      now: NOW,
      closedWindows: closed([110, 110, 110]),
    });
    expect(f?.learned?.projectedPercent).toBeGreaterThan(100);
    expect(f).toMatchObject({ status: "running", main: "learned", early: true, warning: false, current: null });
  });

  it("has no main projection while early without history", () => {
    const f = forecastWindow({ usedPercent: 2, resetsAt: NOW + FIVE_HOURS - 5 * 60_000, durationMs: FIVE_HOURS, now: NOW });
    expect(f).toMatchObject({ main: null, early: true, warning: false });
  });

  it("marks a hit limit", () => {
    const f = forecastWindow({ usedPercent: 100, resetsAt: NOW + HOUR_MS, durationMs: FIVE_HOURS, now: NOW });
    expect(f).toMatchObject({
      status: "hit",
      warning: true,
      early: false,
      main: "current",
      current: { projectedPercent: 100, runOutAt: NOW },
    });
  });

  it.each([
    ["a null reset", null],
    ["a past reset", NOW - 1],
    ["a reset now", NOW],
  ])("has no forecast for %s", (_name, resetsAt) => {
    expect(forecastWindow({ usedPercent: 40, resetsAt, durationMs: FIVE_HOURS, now: NOW })).toBeNull();
  });

  it("has no forecast for an unknown window duration", () => {
    expect(forecastWindow({ usedPercent: 40, resetsAt: NOW + HOUR_MS, durationMs: null, now: NOW })).toBeNull();
  });

  it("keeps only the learned pace when the reset is further than one duration away", () => {
    const f = forecastWindow({
      usedPercent: 10,
      resetsAt: NOW + 6 * HOUR_MS,
      durationMs: FIVE_HOURS,
      now: NOW,
      closedWindows: closed([50]),
    });
    expect(f?.current).toBeNull();
    expect(f?.learned?.projectedPercent).toBeCloseTo(70);
    expect(f).toMatchObject({ early: true, main: "learned", warning: false });
  });

  it("parses a forecast stored before main and early existed", () => {
    const parsed = windowForecastSchema.parse({ status: "running", current: null, learned: null, warning: false });
    expect(parsed).toMatchObject({ main: null, early: false });
  });
});

describe("lastingBudget", () => {
  const WEEK = 7 * DAY_MS;

  it("gives a daily budget for a week (AE1)", () => {
    const b = lastingBudget({ usedPercent: 60, resetsAt: NOW + 3 * DAY_MS, durationMs: WEEK, now: NOW });
    expect(b?.per).toBe("day");
    expect(b?.percent).toBeCloseTo(13.33, 1);
  });

  it("gives an hourly budget for a five-hour window", () => {
    const b = lastingBudget({ usedPercent: 50, resetsAt: NOW + 2 * HOUR_MS, durationMs: FIVE_HOURS, now: NOW });
    expect(b?.per).toBe("hour");
    expect(b?.percent).toBeCloseTo(25);
  });

  it("gives the percent left when less than one unit remains (AE5)", () => {
    expect(lastingBudget({ usedPercent: 95, resetsAt: NOW + 30 * 60_000, durationMs: FIVE_HOURS, now: NOW })).toEqual({
      percent: 5,
      per: "rest",
    });
    expect(lastingBudget({ usedPercent: 90, resetsAt: NOW + 20 * HOUR_MS, durationMs: WEEK, now: NOW })).toEqual({
      percent: 10,
      per: "rest",
    });
  });

  it.each([
    ["no reset", { usedPercent: 40, resetsAt: null, durationMs: FIVE_HOURS }],
    ["a passed reset", { usedPercent: 40, resetsAt: NOW - 1, durationMs: FIVE_HOURS }],
    ["an unknown duration", { usedPercent: 40, resetsAt: NOW + HOUR_MS, durationMs: null }],
    ["a used-up limit", { usedPercent: 100, resetsAt: NOW + HOUR_MS, durationMs: FIVE_HOURS }],
  ])("has no budget for %s", (_name, input) => {
    expect(lastingBudget({ ...input, now: NOW })).toBeNull();
  });
});

describe("median and window changes", () => {
  it("takes the middle of an odd list and the mean of the middle pair", () => {
    expect(median([])).toBeNull();
    expect(median([90, 30, 50])).toBe(50);
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it("treats resets within 10 minutes as the same window", () => {
    expect(isNewWindow(NOW, NOW + 9 * 60_000)).toBe(false);
    expect(isNewWindow(NOW, NOW + 11 * 60_000)).toBe(true);
    expect(isNewWindow(null, NOW)).toBe(true);
    expect(isNewWindow(NOW, null)).toBe(true);
    expect(isNewWindow(null, null)).toBe(false);
  });
});

describe("windows", () => {
  it("maps the labels seen on the host", () => {
    expect(windowDurationMs("Current session")).toBe(FIVE_HOURS);
    expect(windowDurationMs("Weekly limit")).toBe(7 * DAY_MS);
    expect(windowDurationMs("Fable")).toBe(7 * DAY_MS);
  });

  it("falls back to the kind hint, then to null", () => {
    expect(windowDurationMs("Opus", "weekly")).toBe(7 * DAY_MS);
    expect(windowDurationMs("Something", "five-hour")).toBe(FIVE_HOURS);
    expect(windowDurationMs("Something", "monthly")).toBeNull();
    expect(windowDurationMs("Something")).toBeNull();
    expect(windowDurationMs("toString")).toBeNull();
  });

  it("encodes provider and label in the key", () => {
    expect(windowKey("claude-code", "Weekly limit")).toBe("claude-code:Weekly%20limit");
    expect(windowKey("a:b", "c")).toBe("a%3Ab:c");
  });
});

describe("thresholds", () => {
  it.each([
    [49, "normal"],
    [49.6, "amber"],
    [50, "amber"],
    [79, "amber"],
    [80, "red"],
    [85, "red"],
  ] as const)("colours context %s %% as %s", (percent, tone) => {
    expect(contextTone(percent)).toBe(tone);
  });

  it("warns on a forecast above 100 %", () => {
    expect(forecastWarns(100)).toBe(false);
    expect(forecastWarns(100.1)).toBe(true);
  });
});
