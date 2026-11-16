import { describe, expect, it } from "vitest";
import {
  applyEvents,
  emptyTokenState,
  formatTokenCount,
  localPeriodStarts,
  sumSince,
  threadsValue,
  TOKEN_RETENTION_MS,
  tokenEventFromRow,
  tokenTotals,
  trimTokenState,
  type HourEntry,
  type ThreadEntry,
  type TokenEvent,
  type TokenState,
} from "../src/shared/tokens";
import { DAY_MS, HOUR_MS, MIN_MS } from "../src/shared/windows";

const DAY = Date.UTC(2026, 10, 16);
const NOW = DAY + 13 * HOUR_MS;
const at = (h: number, m = 0) => DAY + h * HOUR_MS + m * MIN_MS;
const ref = (threadId = "thr_a", providerId = "claude-code", createdAt: number | null = DAY) => ({ threadId, providerId, createdAt });
/** An event whose `all` and `work` are the same (no cache reads). */
const ev = (seq: number, all: number, time: number, work = all): TokenEvent => ({ seq, at: time, work, all });
const hoursOf = (state: TokenState, providerId = "claude-code") => state.hours[providerId] ?? [];

describe("tokenTotals (R1)", () => {
  it("AE1: Claude Code leaves cache reads out of work", () => {
    expect(tokenTotals({ totalTokens: 144_636, cacheReadInputTokens: 144_015 })).toEqual({ work: 621, all: 144_636 });
  });

  it("AE1: Codex uses cacheReadInputTokens over cachedInputTokens", () => {
    const total = { totalTokens: 130_671, inputTokens: 130_343, cachedInputTokens: 130_048, cacheReadInputTokens: 130_048, outputTokens: 328 };
    expect(tokenTotals(total)).toEqual({ work: 623, all: 130_671 });
  });

  it("falls back to cachedInputTokens without cacheReadInputTokens", () => {
    expect(tokenTotals({ totalTokens: 1000, cachedInputTokens: 900 })).toEqual({ work: 100, all: 1000 });
  });

  it("counts everything as work without any cache field, and never goes below 0", () => {
    expect(tokenTotals({ totalTokens: 500 })).toEqual({ work: 500, all: 500 });
    expect(tokenTotals({ totalTokens: 500, cacheReadInputTokens: 900 })).toEqual({ work: 0, all: 500 });
  });

  it("ignores a total with a missing or non-numeric totalTokens", () => {
    expect(tokenTotals(null)).toBeNull();
    expect(tokenTotals({})).toBeNull();
    expect(tokenTotals({ totalTokens: "12" })).toBeNull();
    expect(tokenTotals({ totalTokens: Number.NaN })).toBeNull();
    expect(tokenTotals({ totalTokens: -1 })).toBeNull();
    // A non-numeric cache field is treated as absent.
    expect(tokenTotals({ totalTokens: 10, cacheReadInputTokens: "x" })).toEqual({ work: 10, all: 10 });
  });

  it("reads a thread event row", () => {
    const row = { seq: 7, createdAt: at(10), type: "thread/tokenUsage/updated", data: { tokenUsage: { total: { totalTokens: 50, cacheReadInputTokens: 20 } } } };
    expect(tokenEventFromRow(row)).toEqual({ seq: 7, at: at(10), work: 30, all: 50 });
    expect(tokenEventFromRow({ ...row, seq: "7" })).toBeNull();
    expect(tokenEventFromRow({ ...row, data: {} })).toBeNull();
  });
});

describe("applyEvents (R2–R4)", () => {
  it("AE2: growth lands in the hour of each event, and a second feed changes nothing", () => {
    const events = [ev(1, 100, at(10, 5)), ev(2, 250, at(10, 40)), ev(3, 250, at(10, 41)), ev(4, 400, at(12, 10))];
    const first = applyEvents(emptyTokenState(), ref(), events, NOW);
    expect(first.counted).toBe(true);
    expect(hoursOf(first.state)).toEqual([
      [at(10), 250, 250],
      [at(12), 150, 150],
    ]);
    const again = applyEvents(first.state, ref(), events, NOW);
    expect(again.counted).toBe(false);
    expect(again.state.hours).toEqual(first.state.hours);
    expect(again.state.threads).toEqual(first.state.threads);
  });

  it("sorts events by sequence before use", () => {
    const events = [ev(4, 400, at(12, 10)), ev(1, 100, at(10, 5)), ev(2, 250, at(10, 40))];
    expect(hoursOf(applyEvents(emptyTokenState(), ref(), events, NOW).state)).toEqual([
      [at(10), 250, 250],
      [at(12), 150, 150],
    ]);
  });

  it("an event at or below the remembered sequence is skipped", () => {
    const one = applyEvents(emptyTokenState(), ref(), [ev(5, 400, at(10))], NOW).state;
    const old = applyEvents(one, ref(), [ev(3, 100, at(9))], NOW);
    expect(old.counted).toBe(false);
    expect(old.state.threads.thr_a!.all).toBe(400);
  });

  it("an event equal to the remembered value changes no bucket", () => {
    const one = applyEvents(emptyTokenState(), ref(), [ev(1, 400, at(10))], NOW).state;
    const same = applyEvents(one, ref(), [ev(2, 400, at(11))], NOW);
    expect(same.counted).toBe(false);
    expect(same.state.hours).toEqual(one.hours);
    expect(same.state.threads.thr_a!.seq).toBe(2);
  });

  it("AE3 (adapted): a lower total is a restarted counter and counts in full", () => {
    // Claude Code's total restarts with each runtime run (AGENTS.md «Token usage»).
    const one = applyEvents(emptyTokenState(), ref(), [ev(1, 400, at(10))], NOW).state;
    const drop = applyEvents(one, ref(), [ev(2, 120, at(11))], NOW).state;
    expect(drop.threads.thr_a!.all).toBe(120);
    expect(hoursOf(drop)).toEqual([
      [at(10), 400, 400],
      [at(11), 120, 120],
    ]);
    const next = applyEvents(drop, ref(), [ev(3, 200, at(12))], NOW).state;
    expect(hoursOf(next).at(-1)).toEqual([at(12), 80, 80]);
  });

  it("keeps work and all apart", () => {
    const state = applyEvents(emptyTokenState(), ref(), [ev(1, 1000, at(10), 100), ev(2, 3000, at(11), 150)], NOW).state;
    expect(hoursOf(state)).toEqual([
      [at(10), 100, 1000],
      [at(11), 50, 2000],
    ]);
    expect(sumSince(state.hours, "claude-code", DAY)).toEqual({ work: 150, all: 3000 });
  });

  it("hours older than 40 days advance the remembered value and create no bucket", () => {
    const old = NOW - TOKEN_RETENTION_MS - HOUR_MS;
    const result = applyEvents(emptyTokenState(), ref("thr_a", "codex", old - DAY_MS), [ev(1, 500, old), ev(2, 700, at(10))], NOW);
    expect(hoursOf(result.state, "codex")).toEqual([[at(10), 200, 200]]);
    expect(result.state.threads.thr_a).toMatchObject({ all: 700, updatedAt: at(10) });
  });

  it("a thread aged out of the table and met again adds nothing for its earlier total, and counts later events once", () => {
    const old = NOW - TOKEN_RETENTION_MS - DAY_MS;
    const aged = applyEvents(emptyTokenState(), ref("thr_old", "codex", old - DAY_MS), [ev(1, 5000, old)], NOW).state;
    expect(aged.threads.thr_old).toBeUndefined();
    expect(aged.evictedBefore).toBe(old);
    // bb keeps one event per thread: the newest one carries the old total too.
    const back = applyEvents(aged, ref("thr_old", "codex", old - DAY_MS), [ev(9, 5600, at(10))], NOW);
    expect(back.counted).toBe(false);
    const later = applyEvents(back.state, ref("thr_old", "codex", old - DAY_MS), [ev(10, 5900, at(11)), ev(10, 5900, at(11))], NOW).state;
    expect(hoursOf(later, "codex")).toEqual([[at(11), 300, 300]]);
  });

  it("a thread created after the last drop counts in full", () => {
    const state: TokenState = { ...emptyTokenState(), evictedBefore: at(1) };
    const result = applyEvents(state, ref("thr_new", "codex", at(2)), [ev(1, 300, at(10))], NOW);
    expect(hoursOf(result.state, "codex")).toEqual([[at(10), 300, 300]]);
  });

  it("with an unknown creation time and a past drop, the first event is a baseline", () => {
    const state: TokenState = { ...emptyTokenState(), evictedBefore: at(1) };
    const result = applyEvents(state, ref("thr_x", "codex", null), [ev(1, 300, at(10)), ev(2, 350, at(11))], NOW);
    expect(hoursOf(result.state, "codex")).toEqual([[at(11), 50, 50]]);
  });

  it("returns the same state for no usable event", () => {
    const state = emptyTokenState();
    expect(applyEvents(state, ref(), [], NOW)).toEqual({ state, counted: false });
  });
});

describe("trims (R6)", () => {
  it("AE8: 4 000 hours and 500 threads, 100 of them older than 40 days", () => {
    const hours: HourEntry[] = Array.from({ length: 4000 }, (_, i) => [hourOf(NOW - (3999 - i) * HOUR_MS), 10, 100]);
    const threads: Record<string, ThreadEntry> = {};
    for (let i = 0; i < 500; i++) {
      const updatedAt = i < 100 ? NOW - TOKEN_RETENTION_MS - (i + 1) * HOUR_MS : NOW - i * MIN_MS;
      threads[`thr_${i}`] = { providerId: "claude-code", work: 1, all: 2, updatedAt, seq: i };
    }
    const state = trimTokenState({ ...emptyTokenState(), hours: { "claude-code": hours }, threads }, NOW);
    const kept = state.hours["claude-code"]!;
    // 40 days of whole hours plus the current one.
    expect(kept.length).toBeLessThanOrEqual(40 * 24 + 1);
    expect(kept[0]![0]).toBeGreaterThan(NOW - TOKEN_RETENTION_MS - HOUR_MS);
    expect(Object.keys(state.threads)).toHaveLength(400);
    expect(state.threads.thr_99).toBeUndefined();
    expect(state.threads.thr_100).toBeDefined();
    expect(state.evictedBefore).toBe(NOW - TOKEN_RETENTION_MS - HOUR_MS);
    expect(bytes(state.hours)).toBeLessThan(256 * 1024);
    expect(bytes(threadsValue(state))).toBeLessThan(256 * 1024);
  });

  it("AE8: a table over the byte limit drops the oldest threads and stores their latest updatedAt", () => {
    let state = emptyTokenState();
    for (let i = 0; i < 40; i++) {
      state = applyEvents(state, ref(`thr_${i}`, "codex", at(0)), [ev(1, 100, at(1) + i * MIN_MS)], NOW, 2000).state;
    }
    const kept = Object.keys(state.threads);
    expect(bytes(threadsValue(state))).toBeLessThanOrEqual(2000);
    expect(kept.length).toBeLessThan(40);
    expect(kept).toContain("thr_39");
    const dropped = Array.from({ length: 40 }, (_, i) => `thr_${i}`).filter((id) => !kept.includes(id));
    const latestDropped = Math.max(...dropped.map((id) => at(1) + Number(id.slice(4)) * MIN_MS));
    expect(state.evictedBefore).toBe(latestDropped);

    // A dropped thread that reports again adds only the growth after evictedBefore.
    const id = dropped[0]!;
    const before = sumSince(state.hours, "codex", DAY).all;
    const back = applyEvents(state, ref(id, "codex", at(0)), [ev(1, 100, at(1)), ev(2, 160, at(5))], NOW, 2000).state;
    expect(sumSince(back.hours, "codex", DAY).all).toBe(before + 60);
  });

  it("evictedBefore only moves forward", () => {
    const state: TokenState = {
      ...emptyTokenState(),
      evictedBefore: at(12),
      threads: { thr_a: { providerId: "codex", work: 1, all: 1, updatedAt: NOW - TOKEN_RETENTION_MS - DAY_MS, seq: 1 } },
    };
    expect(trimTokenState(state, NOW).evictedBefore).toBe(at(12));
  });

  it("drops the oldest hours across providers when the hours value is too large", () => {
    const list = (n: number): HourEntry[] => Array.from({ length: n }, (_, i) => [NOW - (n - i) * HOUR_MS, 1, 1]);
    const state = trimTokenState({ ...emptyTokenState(), hours: { a: list(300), b: list(300) } }, NOW, 4000);
    expect(bytes(state.hours)).toBeLessThanOrEqual(4000);
    expect(state.hours.a!.at(-1)).toEqual([NOW - HOUR_MS, 1, 1]);
  });
});

describe("sums (R7)", () => {
  it("AE6: UTC+4 at 16 Nov 01:30 local sums from 15 Nov 20:00 UTC and from 31 Oct 20:00 UTC", () => {
    const hours = {
      codex: [
        [Date.UTC(2026, 9, 31, 19), 1, 1],
        [Date.UTC(2026, 9, 31, 20), 10, 10],
        [Date.UTC(2026, 10, 15, 19), 100, 100],
        [Date.UTC(2026, 10, 15, 20), 1000, 1000],
      ] as HourEntry[],
    };
    // Local midnights at UTC+4, as the app would send them.
    const dayStart = Date.UTC(2026, 10, 15, 20);
    const monthStart = Date.UTC(2026, 9, 31, 20);
    expect(sumSince(hours, "codex", dayStart)).toEqual({ work: 1000, all: 1000 });
    expect(sumSince(hours, "codex", monthStart)).toEqual({ work: 1110, all: 1110 });
    expect(sumSince(hours, "claude-code", monthStart)).toEqual({ work: 0, all: 0 });
  });

  it("a half-hour offset rounds down to the UTC hour bucket", () => {
    const hours = { codex: [[Date.UTC(2026, 10, 15, 20), 5, 5]] as HourEntry[] };
    expect(sumSince(hours, "codex", Date.UTC(2026, 10, 15, 20, 30))).toEqual({ work: 5, all: 5 });
  });

  it("local period starts are local midnights", () => {
    const now = new Date(2026, 10, 16, 1, 30).getTime();
    expect(localPeriodStarts(now)).toEqual({
      dayStart: new Date(2026, 10, 16).getTime(),
      monthStart: new Date(2026, 10, 1).getTime(),
    });
  });
});

describe("formatTokenCount (R11)", () => {
  const cases: Array<[number, string, string]> = [
    [0, "0", "0"],
    [999, "999", "999"],
    [1000, "1k", "1 тыс."],
    [12_345, "12.3k", "12,3 тыс."],
    [310_000, "310k", "310 тыс."],
    [999_600, "1M", "1 млн"],
    [4_200_000, "4.2M", "4,2 млн"],
    [1_250_000_000, "1.25B", "1,25 млрд"],
  ];
  it.each(cases)("%d → %s / %s", (n, en, ru) => {
    expect(formatTokenCount(n, "en")).toBe(en);
    expect(formatTokenCount(n, "ru")).toBe(ru);
  });
});

function hourOf(ms: number) {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
