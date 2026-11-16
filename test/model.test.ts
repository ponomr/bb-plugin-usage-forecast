import { describe, expect, it } from "vitest";
import { formatTime } from "../src/app/format";
import { en, ru } from "../src/app/i18n";
import { headline, paceDetails, windowBudget, windowNote, windowView } from "../src/app/model";
import type { LimitWindow } from "../src/shared/contract";
import { type ClosedWindow, forecastWindow } from "../src/shared/forecast";
import { DAY_MS, HOUR_MS, MIN_MS } from "../src/shared/windows";

// Local noon on a Monday, so a run-out a few hours away is still today.
const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const FIVE_HOURS = 5 * HOUR_MS;
const WEEK = 7 * DAY_MS;

function closed(peak: number, count: number): ClosedWindow[] {
  return Array.from({ length: count }, (_, i) => ({
    startedAt: NOW - (count - i + 1) * FIVE_HOURS,
    resetAt: NOW - (count - i) * FIVE_HOURS,
    peakUsedPercent: peak,
  }));
}

function win(label: string, usedPercent: number, remaining: number, durationMs: number, history: ClosedWindow[] = []): LimitWindow {
  const resetsAt = NOW + remaining;
  return {
    label,
    usedPercent,
    resetsAt,
    model: null,
    cost: null,
    durationMs,
    forecast: forecastWindow({ usedPercent, resetsAt, durationMs, now: NOW, closedWindows: history }),
  };
}

const note = (w: LimitWindow, s = en, show: "used" | "remaining" = "used") => windowNote(s, windowView(w), NOW, show);
const budget = (w: LimitWindow, s = en) => windowBudget(s, windowView(w), NOW);

describe("window note and budget", () => {
  // AE1: 60 % after 4 of 7 days is 15 % a day; it runs out in 2d 16h, 8h before the reset.
  const ae1 = win("Weekly limit", 60, 3 * DAY_MS, WEEK);
  const ae1RunOut = NOW + (40 / 15) * DAY_MS;

  it("AE1: gives the run-out weekday and time, the shortfall and the daily budget", () => {
    const v = windowView(ae1);
    expect(v.status).toBe("out");
    expect(v.tone).not.toBe("normal");
    expect(note(ae1)).toBe(`At this pace runs out Thu ${formatTime(en, ae1RunOut)} – 8h before reset`);
    expect(budget(ae1)).toBe("to last: up to 13% a day");
  });

  it("AE1 in Russian", () => {
    expect(note(ae1, ru)).toBe(`При текущем темпе кончится в чт ${formatTime(ru, ae1RunOut)} – за 8ч до сброса`);
    expect(budget(ae1, ru)).toBe("чтобы хватило – не больше 13% в день");
  });

  it("gives the time alone when the run-out is today", () => {
    // 80 % after 2 h of 5 is 40 %/h: out in 30 minutes, 2h 30m before the reset.
    const w = win("Current session", 80, 3 * HOUR_MS, FIVE_HOURS);
    expect(note(w)).toBe(`At this pace runs out at ${formatTime(en, NOW + 30 * MIN_MS)} – 2h 30m before reset`);
    expect(note(w, ru)).toBe(`При текущем темпе кончится в ${formatTime(ru, NOW + 30 * MIN_MS)} – за 2ч 30м до сброса`);
    expect(budget(w)).toBe("to last: up to 7% an hour");
  });

  it("AE5: gives the percent left when less than an hour remains", () => {
    const w = win("Current session", 95, 30 * MIN_MS, FIVE_HOURS);
    expect(windowView(w).status).toBe("out");
    expect(budget(w)).toBe("5% left until reset");
    expect(budget(w, ru)).toBe("до сброса осталось 5%");
  });

  it("AE6: a window that lasts, as used and as left, and has no budget", () => {
    // 38 % after 2 of 5 hours: 95 % at the reset.
    const w = win("Current session", 38, 3 * HOUR_MS, FIVE_HOURS);
    expect(note(w)).toBe("At this pace lasts to reset – about 95% used, resets in 3h");
    expect(note(w, en, "remaining")).toBe("At this pace lasts to reset – about 5% left, resets in 3h");
    expect(note(w, ru, "remaining")).toBe("При текущем темпе хватит до сброса – останется примерно 5%, сброс через 3ч");
    expect(budget(w)).toBeNull();
    // 57 % at the reset: about 43 % left.
    const ae6 = win("Current session", 22.8, 3 * HOUR_MS, FIVE_HOURS);
    expect(note(ae6, en, "remaining")).toContain("At this pace lasts to reset – about 43% left");
  });

  it("reads exactly 100 % as lasting", () => {
    const w = win("Current session", 40, 3 * HOUR_MS, FIVE_HOURS);
    expect(windowView(w).status).toBe("ok");
    expect(note(w)).toBe("At this pace lasts to reset – about 100% used, resets in 3h");
    expect(budget(w)).toBeNull();
  });

  it("AE3: too early to judge, with and without past windows", () => {
    // 10 minutes into a five-hour window; a usual peak of 40 % adds 38.7 % for the rest.
    const early = (history: ClosedWindow[]) => win("Current session", 3, FIVE_HOURS - 10 * MIN_MS, FIVE_HOURS, history);
    const withHistory = early(closed(37, 8));
    expect(windowView(withHistory).status).toBe("early");
    expect(note(withHistory)).toBe("Too early to judge – usually ends at about 39%, resets in 4h 50m");
    expect(note(withHistory, ru)).toBe("Пока рано судить – обычно к сбросу примерно 39%, сброс через 4ч 50м");
    expect(note(withHistory, en, "remaining")).toBe("Too early to judge – usually ends with about 61% left, resets in 4h 50m");
    expect(note(early([]))).toBe("Too early to judge – resets in 4h 50m");
    expect(note(early([]), ru)).toBe("Пока рано судить – сброс через 4ч 50м");
  });

  it("AE4: an early window above 100 % by the usual pace does not warn", () => {
    const w = win("Current session", 3, FIVE_HOURS - 6 * MIN_MS, FIVE_HOURS, closed(110, 8));
    const v = windowView(w);
    expect(v).toMatchObject({ status: "early", tone: "normal", marker: null, runOutAt: null });
    expect(budget(w)).toBeNull();
    expect(headline(en, [v], NOW)).toBeNull();
  });

  it("AE2: the current pace speaks when the usual one runs out", () => {
    // 20 % after 2.5 h: 40 % at the reset; a usual peak of 200 % gives 120 %.
    const w = win("Current session", 20, FIVE_HOURS / 2, FIVE_HOURS, closed(200, 3));
    const v = windowView(w);
    expect(v).toMatchObject({ status: "ok", tone: "normal" });
    expect(headline(en, [v], NOW)?.text).toMatch(/^On track/);
  });

  it("keeps the hit and no-forecast notes", () => {
    expect(note(win("Current session", 100, 2 * HOUR_MS, FIVE_HOURS))).toBe("Limit reached – resets in 2h");
    const unknown: LimitWindow = { ...win("Opus", 40, 2 * HOUR_MS, FIVE_HOURS), durationMs: null, forecast: null };
    expect(note(unknown)).toBe("No forecast yet – resets in 2h");
    expect(note({ ...unknown, resetsAt: null })).toBe("No reset time");
  });
});

describe("pace details", () => {
  it("marks the main projection when both are shown", () => {
    const w = win("Current session", 20, FIVE_HOURS / 2, FIVE_HOURS, closed(200, 3));
    expect(paceDetails(en, w)).toBe("Current pace: 40% by reset (main forecast)\nUsual pace (3 past windows): 120%");
    expect(paceDetails(ru, w)).toBe("По текущему темпу к сбросу: 40% (основной прогноз)\nПо прошлым окнам (3): 120%");
  });

  it("shows one plain line with one projection", () => {
    expect(paceDetails(en, win("Current session", 20, FIVE_HOURS / 2, FIVE_HOURS))).toBe("Current pace: 40% by reset");
    const early = win("Current session", 3, FIVE_HOURS - 10 * MIN_MS, FIVE_HOURS, closed(37, 8));
    expect(paceDetails(en, early)).toBe("Usual pace (8 past windows): 39%");
  });
});
