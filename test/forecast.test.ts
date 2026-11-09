import { describe, expect, it } from "vitest";
import {
  type ClosedWindow,
  forecastWindow,
  isNewWindow,
  LEARNED_WINDOWS_USED,
  median,
  typicalPeak,
} from "../src/shared/forecast";
import { contextTone, forecastTone, forecastWarns, limitTone, worseTone } from "../src/shared/thresholds";
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

  it("warns on the learned pace alone", () => {
    const f = forecastWindow({
      usedPercent: 60,
      resetsAt: NOW + 4 * HOUR_MS,
      durationMs: FIVE_HOURS,
      now: NOW,
      closedWindows: closed([90, 90, 90]),
    });
    expect(f?.learned?.projectedPercent).toBeGreaterThan(100);
    expect(f?.warning).toBe(true);
  });

  it("marks a hit limit", () => {
    const f = forecastWindow({ usedPercent: 100, resetsAt: NOW + HOUR_MS, durationMs: FIVE_HOURS, now: NOW });
    expect(f).toMatchObject({ status: "hit", warning: true, current: { projectedPercent: 100, runOutAt: NOW } });
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

  it.each([
    [74, "normal"],
    [75, "amber"],
    [89, "amber"],
    [90, "red"],
  ] as const)("colours a limit at %s %% as %s", (percent, tone) => {
    expect(limitTone(percent)).toBe(tone);
  });

  it("colours a forecast above 100 % red", () => {
    expect(forecastWarns(100)).toBe(false);
    expect(forecastWarns(100.1)).toBe(true);
    expect(forecastTone(101)).toBe("red");
    expect(forecastTone(99)).toBe("normal");
  });

  it("picks the worse tone", () => {
    expect(worseTone("amber", "red")).toBe("red");
    expect(worseTone("normal", "amber")).toBe("amber");
    expect(worseTone("normal", "normal")).toBe("normal");
  });
});
