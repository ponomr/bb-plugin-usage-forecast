import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { AutoCompactor } from "../src/server/auto-compact";
import { createCli, formatDuration, formatStatus, formatThread, formatTime } from "../src/server/cli";
import { Poller } from "../src/server/poller";
import { createService } from "../src/server/rpc";
import { readThreadState } from "../src/server/threads";
import type { LimitsSnapshot } from "../src/shared/contract";
import { HOUR_MS } from "../src/shared/windows";
import { claudeContext, claudeLimits, Clock, codexContext, FakeThreads, makeStorage, MIN, NOW, settingsOf } from "./helpers";

const T = "thr_a";

function setup() {
  const clock = new Clock();
  const threads = new FakeThreads();
  const storage = makeStorage();
  const settings = settingsOf();
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
              forecast: { status: "hit", current: null, learned: null, warning: true },
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

describe("bb usage-forecast", () => {
  it("status prints the polled limits with a forecast, and JSON on request", async () => {
    const t = setup();
    const before = await t.run("status");
    expect(before).toMatchObject({ exitCode: 0, stdout: "Limits: not polled yet.\nRecent compacts: none" });

    const refreshed = await t.run("status", "--refresh");
    expect(refreshed.exitCode).toBe(0);
    expect(refreshed.stdout).toContain("  claude-code (Max): ok");
    expect(refreshed.stdout).toMatch(/Current session: 40%, resets in 2h 0m, forecast at reset: current pace \d+%/);
    expect(refreshed.stdout).not.toContain("owner@example.com");

    const json = await t.run("status", "--json");
    expect(JSON.parse(json.stdout).providers[0].providerId).toBe("claude-code");
  });

  it("thread shows the context, the cap and the cooldown", async () => {
    const t = setup();
    t.threads.thread(T, "claude-code", claudeContext(90_000));
    await t.storage.setCooldownUntil(T, NOW + 4 * MIN);
    const out = await t.run("thread", T);
    expect(out.stdout).toBe(
      [
        "Thread thr_a (claude-code): idle",
        "Context: 60% (90,000 of 150,000 tokens)",
        "Limit: 150,000 tokens (from settings), window 150,000",
        "Provider compacts on its own at 117,000 tokens (78% of the window)",
        "  Messages: 90,000",
        "Auto-compact: on at 80%, acts at 76% = 114,000 tokens (from settings)",
        "Override: inherit",
        "Cooldown: 4m left",
      ].join("\n"),
    );
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
