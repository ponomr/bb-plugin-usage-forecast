import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { AutoCompactor, SUMMARY_STARTED } from "../src/server/auto-compact";
import { createCli, formatDuration, formatStatus, formatThread, formatTime } from "../src/server/cli";
import { Poller } from "../src/server/poller";
import { createService } from "../src/server/rpc";
import { readThreadState } from "../src/server/threads";
import type { LimitsSnapshot, LimitWindow } from "../src/shared/contract";
import { forecastWindow, type ClosedWindow } from "../src/shared/forecast";
import { DAY_MS, HOUR_MS } from "../src/shared/windows";
import { claudeContext, claudeLimits, Clock, codexContext, FakeThreads, makeStorage, MIN, NOW, settingsOf } from "./helpers";

const T = "thr_a";

function setup(over: Parameters<typeof settingsOf>[0] = {}) {
  const clock = new Clock();
  const threads = new FakeThreads();
  const storage = makeStorage();
  const settings = settingsOf(over);
  const poller = new Poller({
    usageLimits: async () => claudeLimits(40, 20),
    storage,
    intervalMinutes: async () => 2,
    invalidate: () => {},
    now: clock.now,
  });
  const compactor = new AutoCompactor({ threads, storage, settings, invalidate: () => {}, log: { info() {}, warn() {} }, now: clock.now });
  const service = createService({ threads, storage, settings, poller, compactor, invalidateThread: () => {}, now: clock.now });
  const { bb, harness } = createFakePluginHost({ pluginId: "usage-forecast" });
  bb.cli.register(createCli(service, clock.now));
  return { clock, threads, storage, service, harness, run: (...argv: string[]) => harness.runCli(argv) };
}

describe("formatters", () => {
  it("formats times and durations", () => {
    expect(formatTime(NOW)).toBe("2026-11-08 12:00 UTC");
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(90 * MIN)).toBe("1h 30m");
    expect(formatDuration(26 * HOUR_MS)).toBe("1d 2h");
    expect(formatDuration(-5)).toBe("0m");
  });

  it("formats an empty snapshot", () => {
    expect(formatStatus({ polledAt: null, pollError: null, providers: [], recentCompactions: [] }, NOW)).toBe(
      "Limits: not polled yet.\nRecent compacts: none",
    );
  });

  it("formats stale data, a poll error and a reached limit", () => {
    const s: LimitsSnapshot = {
      polledAt: NOW,
      pollError: "codex: boom",
      providers: [
        {
          providerId: "claude-code",
          status: "expired",
          planLabel: "Max",
          message: null,
          measuredAt: NOW - HOUR_MS,
          checkedAt: NOW,
          windows: [
            {
              label: "Current session",
              usedPercent: 100,
              resetsAt: NOW + HOUR_MS,
              durationMs: 5 * HOUR_MS,
              kind: "five-hour",
              model: null,
              cost: null,
              forecast: { status: "hit", current: { projectedPercent: 100, runOutAt: NOW }, learned: null, main: "current", early: false, warning: true },
            },
            {
              label: "Extra",
              usedPercent: 3,
              resetsAt: null,
              durationMs: null,
              kind: null,
              model: "opus",
              cost: { usedUsdCents: 150, limitUsdCents: 1000 },
              forecast: null,
            },
            {
              label: "Fable",
              usedPercent: 34,
              resetsAt: null,
              durationMs: null,
              kind: null,
              model: "fable",
              cost: null,
              forecast: null,
            },
          ],
        },
      ],
      recentCompactions: [],
    } as unknown as LimitsSnapshot;
    expect(formatStatus(s, NOW + 3 * MIN)).toBe(
      [
        "Limits, polled 2026-11-08 12:00 UTC (3m ago)",
        "Last poll failed: codex: boom",
        "  claude-code (Max): session expired",
        "    last good data from 2026-11-08 11:00 UTC",
        "    Current session: 100%, resets in 57m, limit reached",
        "    Extra [opus]: 3%, $1.50 of $10.00, no forecast: unknown window length",
        "    Fable: 34%, no forecast: unknown window length",
        "Recent compacts: none",
      ].join("\n"),
    );
  });
});

describe("forecast wording", () => {
  const history = (peak: number, count: number): ClosedWindow[] =>
    Array.from({ length: count }, (_, i) => ({ startedAt: NOW - (i + 2) * DAY_MS, resetAt: NOW - (i + 1) * DAY_MS, peakUsedPercent: peak }));

  function line(label: string, used: number, remaining: number, durationMs: number, closedWindows: ClosedWindow[] = []): string {
    const resetsAt = NOW + remaining;
    const w = {
      label,
      usedPercent: used,
      resetsAt,
      model: null,
      cost: null,
      durationMs,
      forecast: forecastWindow({ usedPercent: used, resetsAt, durationMs, now: NOW, closedWindows }),
    } as LimitWindow;
    const s: LimitsSnapshot = {
      polledAt: NOW,
      pollError: null,
      providers: [{ providerId: "codex", status: "ok", planLabel: null, message: null, measuredAt: NOW, checkedAt: NOW, windows: [w] }],
      recentCompactions: [],
    } as unknown as LimitsSnapshot;
    return formatStatus(s, NOW).split("\n")[2]!;
  }

  it("AE7: gives the run-out time, the shortfall and the budget", () => {
    // 60 % after 4 of 7 days is 15 % a day: out in 2d 16h, 8h before the reset.
    expect(line("Weekly limit", 60, 3 * DAY_MS, 7 * DAY_MS)).toBe(
      "    Weekly limit: 60%, resets in 3d 0h, at this pace runs out 2026-11-11 04:00 UTC (8h before reset), budget 13%/day [over 100%]",
    );
  });

  it("gives an hourly budget, and the percent left when under an hour remains", () => {
    expect(line("Current session", 80, 3 * HOUR_MS, 5 * HOUR_MS)).toBe(
      "    Current session: 80%, resets in 3h 0m, at this pace runs out 2026-11-08 12:30 UTC (2h 30m before reset), budget 7%/hour [over 100%]",
    );
    expect(line("Current session", 95, 30 * MIN, 5 * HOUR_MS)).toContain(", budget 5% until reset [over 100%]");
  });

  it("says a window lasts, and keeps the usual pace as a reference", () => {
    expect(line("Current session", 38, 3 * HOUR_MS, 5 * HOUR_MS)).toBe(
      "    Current session: 38%, resets in 3h 0m, at this pace lasts to reset (95% at reset)",
    );
    // AE2: 40 % by the current pace, 120 % by the usual one; no over-100 mark.
    expect(line("Current session", 20, 2.5 * HOUR_MS, 5 * HOUR_MS, history(200, 3))).toBe(
      "    Current session: 20%, resets in 2h 30m, at this pace lasts to reset (40% at reset); usual pace 120% (3 windows)",
    );
  });

  it("reads exactly 100 % as lasting, with no budget", () => {
    expect(line("Current session", 40, 3 * HOUR_MS, 5 * HOUR_MS)).toBe(
      "    Current session: 40%, resets in 3h 0m, at this pace lasts to reset (100% at reset)",
    );
  });

  it("says it is too early to judge, with and without past windows", () => {
    // 10 minutes into the window; a usual peak of 37 % adds 35.8 % for the rest.
    expect(line("Current session", 3, 5 * HOUR_MS - 10 * MIN, 5 * HOUR_MS, history(37, 8))).toBe(
      "    Current session: 3%, resets in 4h 50m, too early to judge; usual pace 39% (8 windows)",
    );
    expect(line("Current session", 3, 5 * HOUR_MS - 10 * MIN, 5 * HOUR_MS)).toBe(
      "    Current session: 3%, resets in 4h 50m, too early to judge",
    );
    // AE4: early with a usual pace above 100 %: no mark.
    expect(line("Current session", 3, 5 * HOUR_MS - 6 * MIN, 5 * HOUR_MS, history(110, 8))).not.toContain("[over 100%]");
  });

  it("reads a forecast stored before main and early as before", () => {
    const resetsAt = NOW + 3 * HOUR_MS;
    const w = {
      label: "Current session",
      usedPercent: 80,
      resetsAt,
      model: null,
      cost: null,
      durationMs: 5 * HOUR_MS,
      forecast: { status: "running", current: { projectedPercent: 200, runOutAt: NOW + 30 * MIN }, learned: null, warning: true },
    };
    const s = {
      polledAt: NOW,
      pollError: null,
      providers: [{ providerId: "codex", status: "ok", planLabel: null, message: null, measuredAt: NOW, checkedAt: NOW, windows: [w] }],
      recentCompactions: [],
    } as unknown as LimitsSnapshot;
    expect(formatStatus(s, NOW)).toContain("at this pace runs out 2026-11-08 12:30 UTC (2h 30m before reset), budget 7%/hour [over 100%]");
  });
});

describe("pace state word", () => {
  function line(pace: LimitWindow["pace"], used = 60): string {
    const w: LimitWindow = {
      label: "Weekly limit",
      usedPercent: used,
      resetsAt: NOW + 3 * DAY_MS,
      model: null,
      cost: null,
      durationMs: 7 * DAY_MS,
      forecast: null,
      pace,
    };
    const s = {
      polledAt: NOW,
      pollError: null,
      providers: [{ providerId: "codex", status: "ok", planLabel: null, message: null, measuredAt: NOW, checkedAt: NOW, windows: [w] }],
      recentCompactions: [],
    } as LimitsSnapshot;
    return formatStatus(s, NOW).split("\n")[2]!;
  }

  it("names each state after the percent", () => {
    expect(line("calm")).toBe("    Weekly limit: 60% [calm], resets in 3d 0h");
    expect(line("tight")).toBe("    Weekly limit: 60% [tight], resets in 3d 0h");
    expect(line("short")).toBe("    Weekly limit: 60% [will not last], resets in 3d 0h");
    expect(line("critical")).toBe("    Weekly limit: 60% [critical], resets in 3d 0h");
    expect(line("hit", 100)).toBe("    Weekly limit: 100% [used up], resets in 3d 0h");
  });

  it("prints no bracket for a window without a state", () => {
    expect(line(null)).toBe("    Weekly limit: 60%, resets in 3d 0h");
  });
});

describe("bb usage-forecast", () => {
  it("status prints the polled limits with a forecast, and JSON on request", async () => {
    const t = setup();
    const before = await t.run("status");
    expect(before).toMatchObject({ exitCode: 0, stdout: "Limits: not polled yet.\nRecent compacts: none" });

    const refreshed = await t.run("status", "--refresh");
    expect(refreshed.exitCode).toBe(0);
    expect(refreshed.stdout).toContain("  claude-code (Max): ok");
    expect(refreshed.stdout).toMatch(/Current session: 40% \[calm\], resets in 2h 0m, at this pace lasts to reset/);
    expect(refreshed.stdout).not.toContain("owner@example.com");

    const json = await t.run("status", "--json");
    expect(JSON.parse(json.stdout).providers[0].providerId).toBe("claude-code");
  });

  it("thread shows the context, the limit source and the cooldown", async () => {
    const t = setup();
    // A 200 000 window where Claude Code compacts on its own at 167 000.
    t.threads.thread(T, "claude-code", claudeContext(100_200, 200_000));
    await t.storage.setCooldownUntil(T, NOW + 4 * MIN);
    const out = await t.run("thread", T);
    expect(out.stdout).toBe(
      [
        "Thread thr_a (claude-code): idle",
        "Context: 60% (100,200 of 167,000 tokens)",
        "Limit: 167,000 tokens (where claude-code compacts on its own), window 200,000",
        "Provider compacts on its own at 167,000 tokens (84% of the window)",
        "  Messages: 100,200",
        "Auto-compact: on at 80% = 133,600 tokens (from settings)",
        "Override: inherit",
        "Cooldown: 4m left",
      ].join("\n"),
    );
  });

  it("thread names a per-provider limit and caps the threshold below the provider's own point", async () => {
    const t = setup({ providerLimitTokens: { "claude-code": 150_000, codex: 250_000 } });
    t.threads.thread(T, "claude-code", claudeContext(90_000));
    const claude = (await t.run("thread", T)).stdout;
    expect(claude).toContain("Limit: 150,000 tokens (from the claude-code setting), window 150,000");
    expect(claude).toContain("Auto-compact: on at 80%, acts at 76% = 114,000 tokens (from settings)");

    t.threads.thread(T, "codex", codexContext(100_000, 475_000));
    const codex = (await t.run("thread", T)).stdout;
    expect(codex).toContain("Context: 40% (100,000 of 250,000 tokens)");
    expect(codex).toContain("Limit: 250,000 tokens (from the codex setting), window 475,000");
    expect(codex).toContain("Auto-compact: on at 80% = 200,000 tokens (from settings)");
    expect(codex).not.toContain("Provider compacts");
  });

  it("thread reports an unknown context and an unsupported provider", async () => {
    const t = setup();
    t.threads.thread(T, "acp-x", { usage: null }, "running");
    await t.storage.markUnsupported("acp-x", NOW);
    const state = await readThreadState({ threads: t.threads, storage: t.storage, settings: settingsOf(), now: () => NOW }, T);
    const text = formatThread(state, NOW);
    expect(text).toContain("Thread thr_a (acp-x): answering");
    expect(text).toContain("Context: no measurement yet");
    expect(text).toContain("Compact: not supported by this provider");
  });

  it("compact starts a compact, and fails with a message when the agent is answering", async () => {
    const t = setup();
    t.threads.thread(T, "codex", codexContext(75_000)); // 50 % of the 150 000 limit
    expect(await t.run("compact", T)).toMatchObject({ exitCode: 0, stdout: "Compact of thr_a started at 50%." });
    t.threads.status.set(T, "running");
    const busy = await t.run("compact", T);
    expect(busy.exitCode).not.toBe(0);
    expect(busy.stderr).toContain("The agent is answering");
  });

  it("compact says when it starts summary and clear instead", async () => {
    const t = setup({ summaryClearEnabled: true });
    t.threads.thread(T, "acp-x", codexContext(75_000));
    await t.storage.markUnsupported("acp-x", NOW);
    expect(await t.run("compact", T)).toMatchObject({ exitCode: 0, stdout: `thr_a: ${SUMMARY_STARTED}.` });
  });

  it("override sets and validates the mode and threshold", async () => {
    const t = setup();
    expect(await t.run("override", T, "on", "--threshold", "70")).toMatchObject({
      exitCode: 0,
      stdout: "Auto-compact for thr_a: on at 70%.",
    });
    expect(t.threads.metadata.get(T)).toEqual({ override: { autoCompact: "on", thresholdPercent: 70 } });
    expect((await t.run("override", T, "inherit")).stdout).toBe("Auto-compact for thr_a: inherit.");
    expect(t.threads.metadata.get(T)).toEqual({});

    const bad = await t.run("override", T, "sometimes");
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("Mode must be inherit, off or on");
    const misplaced = await t.run("override", T, "off", "--threshold", "70");
    expect(misplaced.stderr).toContain("--threshold applies only to on");
  });

  it("override sets, keeps and clears the thread's context limit", async () => {
    const t = setup();
    t.threads.thread(T, "codex", codexContext(50_000));
    expect((await t.run("override", T, "inherit", "--limit", "100000")).stdout).toBe(
      "Auto-compact for thr_a: inherit. Context limit: 100,000 tokens.",
    );
    expect(t.threads.metadata.get(T)).toEqual({ override: { autoCompact: "inherit", limitTokens: 100_000 } });
    // Without --limit the stored limit stays.
    expect((await t.run("override", T, "on", "--threshold", "70")).stdout).toBe("Auto-compact for thr_a: on at 70%. Context limit: 100,000 tokens.");
    expect(t.threads.metadata.get(T)).toEqual({ override: { autoCompact: "on", thresholdPercent: 70, limitTokens: 100_000 } });
    const shown = await t.run("thread", T);
    expect(shown.stdout).toContain("Context: 50% (50,000 of 100,000 tokens)");
    expect(shown.stdout).toContain("Limit: 100,000 tokens (from this thread), window 258,400");
    expect(shown.stdout).toContain("Override: on 70%, limit 100,000 tokens");
    const small = await t.run("override", T, "on", "--limit", "5000");
    expect(small.exitCode).not.toBe(0);
    expect(small.stderr).toContain("--limit must be 0 or 10000-2000000");
    expect((await t.run("override", T, "inherit", "--limit", "0")).stdout).toBe("Auto-compact for thr_a: inherit.");
    expect(t.threads.metadata.get(T)).toEqual({});
    const outOfRange = await t.run("override", T, "on", "--threshold", "99");
    expect(outOfRange.exitCode).not.toBe(0);
  });

  it("rejects an over-long thread id", async () => {
    const t = setup();
    const out = await t.run("thread", "x".repeat(129));
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("Thread id must be 1-128 characters");
  });
});
