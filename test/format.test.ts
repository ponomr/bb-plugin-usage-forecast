import { describe, expect, it } from "vitest";
import { formatResetAt, formatResetIn, formatTime } from "../src/app/format";
import { en, ru } from "../src/app/i18n";
import { DAY_MS, HOUR_MS } from "../src/shared/windows";

// Local noon on a Monday: a reset a few hours away is today, one two days away is Wednesday.
const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const TODAY = NOW + 4 * HOUR_MS;
const WEDNESDAY = NOW + 2 * DAY_MS + 3 * HOUR_MS;

describe("reset time", () => {
  it("AE4: a reset later today is the time alone", () => {
    expect(formatResetAt(en, TODAY, NOW)).toBe(formatTime(en, TODAY));
  });

  it("a reset on another day carries the short weekday", () => {
    expect(formatResetAt(en, WEDNESDAY, NOW)).toBe(`Wed ${formatTime(en, WEDNESDAY)}`);
    expect(formatResetAt(ru, WEDNESDAY, NOW)).toBe(`ср ${formatTime(ru, WEDNESDAY)}`);
  });

  it("P3: the reset in a line is a countdown", () => {
    expect(formatResetIn(en, TODAY, NOW)).toBe("resets in 4h");
    expect(formatResetIn(ru, WEDNESDAY, NOW)).toBe("сброс через 2д 3ч");
  });

  it("a reset already passed reads as now", () => {
    expect(formatResetIn(en, NOW - 1, NOW)).toBe("resets now");
    expect(formatResetIn(ru, NOW, NOW)).toBe("сброс сейчас");
  });

  it("no reset time gives null", () => {
    expect(formatResetIn(en, null, NOW)).toBeNull();
  });
});
