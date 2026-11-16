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
    pace: null,
  };
}

const note = (w: LimitWindow, s = en, show: "used" | "remaining" = "used") => windowNote(s, windowView(w, NOW), NOW, show);
const budget = (w: LimitWindow, s = en) => windowBudget(s, windowView(w, NOW), NOW);

describe("window note and budget", () => {
  // AE1: 60 % after 4 of 7 days is 15 % a day; it runs out in 2d 16h, 8h before the reset.
  const ae1 = win("Weekly limit", 60, 3 * DAY_MS, WEEK);
  const ae1RunOut = NOW + (40 / 15) * DAY_MS;

  it("AE1: gives the run-out weekday and time, the shortfall and the daily budget", () => {
    const v = windowView(ae1, NOW);
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
    expect(windowView(w, NOW).status).toBe("out");
    expect(budget(w)).toBe("5% left until reset");
    expect(budget(w, ru)).toBe("до сброса осталось 5%");
  });

  it("AE6: a window that lasts, as used and as left, and has no budget", () => {
    // 30 % after 2 of 5 hours: 75 % at the reset.
    const w = win("Current session", 30, 3 * HOUR_MS, FIVE_HOURS);
    expect(note(w)).toBe("At this pace lasts to reset – about 75% used, resets in 3h");
    expect(note(w, en, "remaining")).toBe("At this pace lasts to reset – about 25% left, resets in 3h");
    expect(note(w, ru, "remaining")).toBe("При текущем темпе хватит до сброса – останется примерно 25%, сброс через 3ч");
    expect(budget(w)).toBeNull();
    // 57 % at the reset: about 43 % left.
    const ae6 = win("Current session", 22.8, 3 * HOUR_MS, FIVE_HOURS);
    expect(note(ae6, en, "remaining")).toContain("At this pace lasts to reset – about 43% left");
  });

  it("reads exactly 100 % as lasting, tight", () => {
    const w = win("Current session", 40, 3 * HOUR_MS, FIVE_HOURS);
    expect(windowView(w, NOW)).toMatchObject({ status: "ok", raw: "tight", pace: "tight", tone: "amber" });
    expect(note(w)).toBe("Tight – at this pace about 100% used, resets in 3h");
    expect(budget(w)).toBeNull();
  });

  it("AE3: too early to judge, with and without past windows", () => {
    // 10 minutes into a five-hour window; a usual peak of 40 % adds 38.7 % for the rest.
    const early = (history: ClosedWindow[]) => win("Current session", 3, FIVE_HOURS - 10 * MIN_MS, FIVE_HOURS, history);
    const withHistory = early(closed(37, 8));
    expect(windowView(withHistory, NOW).status).toBe("early");
    expect(note(withHistory)).toBe("Too early to judge – usually ends at about 39%, resets in 4h 50m");
    expect(note(withHistory, ru)).toBe("Пока рано судить – обычно к сбросу примерно 39%, сброс через 4ч 50м");
    expect(note(withHistory, en, "remaining")).toBe("Too early to judge – usually ends with about 61% left, resets in 4h 50m");
    expect(note(early([]))).toBe("Too early to judge – resets in 4h 50m");
    expect(note(early([]), ru)).toBe("Пока рано судить – сброс через 4ч 50м");
  });

  it("AE4: an early window above 100 % by the usual pace does not warn", () => {
    const w = win("Current session", 3, FIVE_HOURS - 6 * MIN_MS, FIVE_HOURS, closed(110, 8));
    const v = windowView(w, NOW);
    expect(v).toMatchObject({ status: "early", tone: "normal", marker: null, runOutAt: null });
    expect(budget(w)).toBeNull();
    expect(headline(en, [v], NOW)).toBeNull();
  });

  it("AE2: the current pace speaks when the usual one runs out", () => {
    // 20 % after 2.5 h: 40 % at the reset; a usual peak of 200 % gives 120 %.
    const w = win("Current session", 20, FIVE_HOURS / 2, FIVE_HOURS, closed(200, 3));
    const v = windowView(w, NOW);
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

describe("window note with the exact reset time", () => {
  const timed = (w: LimitWindow, s = en, show: "used" | "remaining" = "used") => windowNote(s, windowView(w, NOW), NOW, show, "time");
  const at = (s = en, ms: number) => formatTime(s, NOW + ms);

  it("names the reset time in every status that has one", () => {
    expect(timed(win("Current session", 100, 2 * HOUR_MS, FIVE_HOURS))).toBe(`Limit reached – resets at ${at(en, 2 * HOUR_MS)}`);
    expect(timed(win("Current session", 30, 3 * HOUR_MS, FIVE_HOURS))).toBe(
      `At this pace lasts to reset – about 75% used, resets at ${at(en, 3 * HOUR_MS)}`,
    );
    expect(timed(win("Current session", 30, 3 * HOUR_MS, FIVE_HOURS), ru, "remaining")).toBe(
      `При текущем темпе хватит до сброса – останется примерно 25%, сброс в ${at(ru, 3 * HOUR_MS)}`,
    );
    expect(timed(win("Current session", 40, 3 * HOUR_MS, FIVE_HOURS))).toBe(`Tight – at this pace about 100% used, resets at ${at(en, 3 * HOUR_MS)}`);
    expect(timed(win("Current session", 3, FIVE_HOURS - 10 * MIN_MS, FIVE_HOURS))).toBe(
      `Too early to judge – resets at ${at(en, FIVE_HOURS - 10 * MIN_MS)}`,
    );
    const unknown: LimitWindow = { ...win("Opus", 40, 2 * HOUR_MS, FIVE_HOURS), durationMs: null, forecast: null };
    expect(timed(unknown)).toBe(`No forecast yet – resets at ${at(en, 2 * HOUR_MS)}`);
    expect(timed({ ...unknown, resetsAt: null })).toBe("No reset time");
  });

  it("gives the weekday for a reset on another day", () => {
    // 10 % after 1 of 7 days: about 70 % at the reset, which is on Sunday.
    const w = win("Weekly limit", 10, 6 * DAY_MS, WEEK);
    expect(timed(w)).toBe(`At this pace lasts to reset – about 70% used, resets Sun ${at(en, 6 * DAY_MS)}`);
    expect(timed(w, ru)).toBe(`При текущем темпе хватит до сброса – будет использовано примерно 70%, сброс в вс ${at(ru, 6 * DAY_MS)}`);
  });

  it("leaves the run-out wording and the budget line as they are", () => {
    const w = win("Weekly limit", 60, 3 * DAY_MS, WEEK);
    expect(timed(w)).toBe(note(w));
    expect(timed(w, ru)).toBe(note(w, ru));
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

describe("pace state", () => {
  const view = (w: LimitWindow) => windowView(w, NOW);
  const head = (ws: LimitWindow[], s = en) => headline(s, ws.map(view), NOW);
  // 40 % one hour into five hours: 200 % at the reset, out in 1 h 30 m.
  const short = () => win("Current session", 40, 4 * HOUR_MS, FIVE_HOURS);

  it("AE1: 80 % ten minutes before the reset on an even pace is calm", () => {
    const w = win("Current session", 80, 10 * MIN_MS, FIVE_HOURS);
    expect(view(w)).toMatchObject({ status: "ok", raw: "calm", pace: "calm", tone: "normal" });
    expect(note(w)).toBe("At this pace lasts to reset – about 83% used, resets in 10m");
    expect(head([w])?.tone).toBe("normal");
  });

  it("AE3: 92 % five minutes before the reset is tight, amber, with the tight note", () => {
    const w = win("Current session", 92, 5 * MIN_MS, FIVE_HOURS);
    expect(view(w)).toMatchObject({ status: "ok", raw: "tight", tone: "amber" });
    expect(note(w)).toBe("Tight – at this pace about 94% used, resets in 5m");
    expect(note(w, en, "remaining")).toBe("Tight – at this pace about 6% left, resets in 5m");
    expect(note(w, ru)).toBe("Впритык – при текущем темпе будет использовано примерно 94%, сброс через 5м");
    expect(note(w, ru, "remaining")).toBe("Впритык – при текущем темпе останется примерно 6%, сброс через 5м");
    expect(head([w])).toEqual({ text: `Tight. At this pace about 94% will be used by the ${formatTime(en, NOW + 5 * MIN_MS)} reset.`, tone: "amber" });
    expect(head([w], ru)?.text).toBe(`Впритык. При таком темпе до сброса в ${formatTime(ru, NOW + 5 * MIN_MS)} уйдёт примерно 94% лимита.`);
  });

  it("AE2: will not last is amber; thirty minutes before the run-out it is critical and red", () => {
    expect(view(short())).toMatchObject({ status: "out", raw: "short", tone: "amber" });
    expect(head([short()])).toEqual({ text: `At this pace you'll run out before the ${formatTime(en, NOW + 4 * HOUR_MS)} reset.`, tone: "amber" });
    // 90 % after 4 h: 22.5 %/h, out in 27 minutes.
    const w = win("Current session", 90, HOUR_MS, FIVE_HOURS);
    expect(view(w)).toMatchObject({ status: "out", raw: "critical", pace: "critical", tone: "red" });
    expect(note(w)).toMatch(/^At this pace runs out at .+ – 33m before reset$/);
    expect(head([w])).toEqual({ text: "At this pace you'll run out in 27m.", tone: "red" });
    expect(head([w], ru)?.text).toBe("При таком темпе лимит закончится через 27м.");
  });

  it("AE6: without a pace the used-percent thresholds colour the window", () => {
    const early = win("Current session", 3, FIVE_HOURS - 5 * MIN_MS, FIVE_HOURS);
    expect(view(early)).toMatchObject({ status: "early", raw: null, pace: null, tone: "normal" });
    const unknown = (used: number): LimitWindow => ({ ...win("Opus", used, 2 * DAY_MS, WEEK), durationMs: null, forecast: null });
    expect(view(unknown(80))).toMatchObject({ status: "idle", pace: null, tone: "amber" });
    expect(view(unknown(92))).toMatchObject({ status: "idle", pace: null, tone: "red" });
    expect(view(unknown(100))).toMatchObject({ status: "hit", pace: "hit", tone: "red" });
  });

  it("a held state colours the window while every text follows the current pace", () => {
    // Calm now (32 % after 2 h: 80 % at the reset), still held as will-not-last by the server.
    const w = { ...win("Current session", 32, 3 * HOUR_MS, FIVE_HOURS), pace: "short" as const };
    expect(w.forecast!.current).toMatchObject({ runOutAt: null });
    expect(view(w)).toMatchObject({ status: "ok", raw: "calm", pace: "short", tone: "amber" });
    expect(note(w)).toBe("At this pace lasts to reset – about 80% used, resets in 3h");
    expect(budget(w)).toBeNull();
    expect(head([w])?.text).toMatch(/^On track/);
  });

  it("reads a window stored before the upgrade from its raw state", () => {
    const { pace: _pace, ...old } = short();
    expect(view(old as LimitWindow)).toMatchObject({ status: "out", raw: "short", pace: "short", tone: "amber" });
  });

  it("turns critical between polls when the run-out comes within a tenth of the window", () => {
    const w = { ...win("Current session", 90, HOUR_MS, FIVE_HOURS), pace: "short" as const };
    expect(view(w)).toMatchObject({ raw: "critical", pace: "critical", tone: "red" });
    expect(head([w])?.text).toBe("At this pace you'll run out in 27m.");
  });

  it("AE8: a tight weekly window speaks over a calm session", () => {
    const session = win("Current session", 20, 3 * HOUR_MS, FIVE_HOURS);
    const weekly = win("Weekly limit", 87, DAY_MS / 2, WEEK);
    expect(view(session).raw).toBe("calm");
    expect(view(weekly).raw).toBe("tight");
    expect(head([session, weekly])?.text).toMatch(/^Tight\. At this pace about 94% will be used by/);
  });

  it("orders the headline: hit, critical, short, tight, calm", () => {
    const hit = win("Weekly limit", 100, DAY_MS, WEEK);
    const crit = win("Current session", 90, HOUR_MS, FIVE_HOURS);
    const tight = win("Weekly limit", 87, DAY_MS / 2, WEEK);
    const calm = win("Current session", 20, 3 * HOUR_MS, FIVE_HOURS);
    expect(head([calm, tight, short(), crit, hit])?.text).toMatch(/^Limit reached/);
    expect(head([calm, tight, short(), crit])?.text).toMatch(/run out in/);
    expect(head([calm, tight, short()])?.text).toMatch(/run out before/);
    expect(head([calm, tight])?.text).toMatch(/^Tight/);
    expect(head([calm])?.text).toMatch(/^On track/);
  });
});
