// server.ts through the fake host: RPC, schedule, thread events, settings and
// invalidation tags.

import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { CONTEXT_INVALIDATE_MIN_MS, POLL_SCHEDULE } from "../server";
import { LIMITS_TAG, threadTag, TOKENS_TAG, type LimitsSnapshot, type ThreadState, type Tokens } from "../src/shared/contract";
import { HOUR_MS } from "../src/shared/windows";
import { claudeContext, claudeLimits, codexContext, FakeThreads, NOW } from "./helpers";

/** Lets the background listeners and the first collection finish. */
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const T = "thr_a";

type ThreadChanged = { entity: "thread"; id?: string; metadata?: { eventTypes?: readonly string[] } };

async function load(settings: Record<string, boolean | number> = {}, limits: () => unknown = () => claudeLimits(40, 20)) {
  const threads = new FakeThreads();
  const subscriptions: { event: string; callback: (event: ThreadChanged) => void }[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "usage-forecast",
    settings,
    sdk: {
      subscribe: ((args: { event: string; callback: (event: ThreadChanged) => void }) => {
        subscriptions.push(args);
        return () => subscriptions.splice(subscriptions.indexOf(args), 1);
      }) as never,
      system: { usageLimits: () => limits() },
      plugins: { callRpc: (async () => ({ ok: true, channels: ["mobile"] })) as never },
      threads: {
        get: (args) => threads.get(args),
        context: (args) => threads.context(args),
        getPluginMetadata: (args) => threads.getPluginMetadata(args),
        updatePluginMetadata: (args) => threads.updatePluginMetadata(args as never),
        compact: (args) => threads.compact(args),
        list: ((args: never) => threads.list(args ?? {})) as never,
        events: { list: ((args: never) => threads.events(args)) as never },
      },
    },
  });
  await plugin(bb);
  const invalidations = () => harness.inspection.experimental_rpcInvalidations;
  return { harness, threads, invalidations, subscriptions };
}

describe("plugin wiring", () => {
  afterEach(() => vi.useRealTimers());

  it("polls on the schedule and serves the snapshot without account identifiers", async () => {
    const { harness, invalidations } = await load();
    const empty = (await harness.callRpc("snapshot", null)) as LimitsSnapshot;
    expect(empty).toMatchObject({ polledAt: null, hosts: [{ hostId: null, providers: [] }] });

    await harness.runSchedule(POLL_SCHEDULE);
    const snapshot = (await harness.callRpc("snapshot", null)) as LimitsSnapshot;
    expect(snapshot.hosts[0]!.providers[0]!.windows.map((w) => w.usedPercent)).toEqual([40, 20]);
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("owner@example.com");
    expect(text).not.toContain("secret-account-key");
    expect(invalidations()).toContainEqual([LIMITS_TAG]);
    expect(harness.sdk.callsTo("system.usageLimits")).toHaveLength(1);
  });

  it("pushes through push-notifications once a limit window crosses the threshold", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    let session = 40;
    const { harness } = await load({}, () => claudeLimits(session, 20));
    await harness.runSchedule(POLL_SCHEDULE);
    expect(harness.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
    session = 92;
    await harness.callRpc("refresh", null);
    await harness.callRpc("refresh", null);
    const calls = harness.sdk.callsTo("plugins.callRpc");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject([{ pluginId: "push-notifications", method: "notifications.send", input: { title: "Claude Code: 5 Hour limit at 92%" } }]);
    expect(JSON.stringify(calls[0])).not.toContain("owner@example.com");
  });

  it("refresh polls now", async () => {
    const { harness } = await load();
    const snapshot = (await harness.callRpc("refresh", null)) as LimitsSnapshot;
    expect(snapshot.polledAt).not.toBeNull();
  });

  it("keeps auto-compact off by default", async () => {
    const { harness, threads } = await load();
    threads.thread(T, "codex", codexContext(0.95 * 258_400));
    await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: T }) } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(threads.compactCalls).toEqual([]);
  });

  it("compacts on thread.idle once enabled in the settings, and invalidates on a settings change", async () => {
    const { harness, threads, invalidations } = await load();
    threads.thread(T, "codex", codexContext(0.95 * 258_400));
    await harness.setSettings({ autoCompactEnabled: true });
    expect(invalidations()).toContainEqual(null);
    const { errors } = await harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: T }) } as never);
    expect(errors).toEqual([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(threads.compactCalls).toEqual([T]);
    expect(invalidations()).toContainEqual([LIMITS_TAG, threadTag(T)]);
    const snapshot = (await harness.callRpc("snapshot", null)) as LimitsSnapshot;
    expect(snapshot.recentCompactions[0]).toMatchObject({ threadId: T, result: "compacted", trigger: "auto" });
    await harness.lifecycle.dispose();
  });

  it("rejects an out-of-range threshold in the settings", async () => {
    const { harness } = await load();
    await expect(harness.setSettings({ autoCompactThresholdPercent: 40 })).rejects.toThrow();
  });

  it("rejects a per-provider limit below the range but accepts 0 (auto)", async () => {
    const { harness } = await load();
    await expect(harness.setSettings({ codexContextLimitTokens: 5_000 })).rejects.toThrow();
    await harness.setSettings({ codexContextLimitTokens: 250_000, claudeCodeContextLimitTokens: 0 });
  });

  it("serves the thread state measured against the provider's own compaction point, and the override", async () => {
    const { harness, threads, invalidations } = await load({ autoCompactEnabled: true });
    // 80 % of the 117 000 point where Claude Code compacts in a 150 000 window.
    threads.thread(T, "claude-code", claudeContext(93_600));
    const state = (await harness.callRpc("thread", { threadId: T })) as ThreadState;
    expect(state).toMatchObject({
      threadId: T,
      providerId: "claude-code",
      active: false,
      context: { percent: 80, limitTokens: 117_000, limitSource: "reported", autoCompactAtTokens: 117_000 },
      override: { autoCompact: "inherit" },
      autoCompact: { enabled: true, thresholdPercent: 80, effectiveThresholdPercent: 80, effectiveThresholdTokens: 93_600, source: "settings" },
      compactSupported: true,
      cooldownUntil: null,
    });

    await harness.callRpc("setThreadOverride", { threadId: T, override: { autoCompact: "on", thresholdPercent: 60 } });
    expect(threads.metadata.get(T)).toEqual({ override: { autoCompact: "on", thresholdPercent: 60 } });
    expect(invalidations()).toContainEqual([LIMITS_TAG, threadTag(T)]);
    const on = (await harness.callRpc("thread", { threadId: T })) as ThreadState;
    expect(on.autoCompact).toEqual({ enabled: true, thresholdPercent: 60, effectiveThresholdPercent: 60, effectiveThresholdTokens: 70_200, source: "thread" });

    // A threshold with off is dropped; inherit removes the key.
    const off = await harness.callRpc("setThreadOverride", { threadId: T, override: { autoCompact: "off", thresholdPercent: 60 } });
    expect(off).toEqual({ override: { autoCompact: "off" } });
    await harness.callRpc("setThreadOverride", { threadId: T, override: { autoCompact: "inherit" } });
    expect(threads.metadata.get(T)).toEqual({});
    expect(harness.sdk.callsTo("threads.updatePluginMetadata").at(-1)).toEqual([{ pluginId: "usage-forecast", threadId: T, remove: ["override"] }]);

    // A per-thread limit is kept with inherit; the fill is measured against it.
    await harness.callRpc("setThreadOverride", { threadId: T, override: { autoCompact: "inherit", limitTokens: 100_000 } });
    expect(threads.metadata.get(T)).toEqual({ override: { autoCompact: "inherit", limitTokens: 100_000 } });
    const limited = (await harness.callRpc("thread", { threadId: T })) as ThreadState;
    expect(limited.context).toMatchObject({ limitTokens: 100_000, limitSource: "thread" });
    expect(limited.context!.percent).toBeCloseTo(93.6);
    expect(limited.autoCompact).toMatchObject({ thresholdPercent: 80, effectiveThresholdPercent: 80, effectiveThresholdTokens: 80_000 });
  });

  it("invalidates a thread on its context events, coalesced, and unsubscribes on dispose", async () => {
    const { harness, invalidations, subscriptions } = await load();
    expect(subscriptions.map((s) => s.event)).toEqual(["thread:changed"]);
    const emit = (event: ThreadChanged) => subscriptions[0]!.callback(event);
    const since = invalidations().length;
    const fresh = () => invalidations().slice(since);
    vi.useFakeTimers();

    emit({ entity: "thread", id: T, metadata: { eventTypes: ["item/completed", "turn/completed"] } });
    emit({ entity: "thread", metadata: { eventTypes: ["thread/contextWindowUsage/updated"] } });
    emit({ entity: "thread", id: T });
    await vi.advanceTimersByTimeAsync(CONTEXT_INVALIDATE_MIN_MS);
    expect(fresh()).toEqual([]);

    // The first event invalidates at once; the rest of a burst waits for the gap.
    emit({ entity: "thread", id: T, metadata: { eventTypes: ["thread/contextWindowUsage/updated", "item/started"] } });
    emit({ entity: "thread", id: "thr_b", metadata: { eventTypes: ["thread/compacted"] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(fresh()).toEqual([
      [LIMITS_TAG, threadTag(T)],
      [LIMITS_TAG, threadTag("thr_b")],
    ]);
    emit({ entity: "thread", id: T, metadata: { eventTypes: ["thread/tokenUsage/updated"] } });
    emit({ entity: "thread", id: T, metadata: { eventTypes: ["thread/tokenUsage/updated"] } });
    await vi.advanceTimersByTimeAsync(CONTEXT_INVALIDATE_MIN_MS - 1);
    expect(fresh()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fresh()).toHaveLength(3);

    // A pending invalidation is dropped on dispose.
    emit({ entity: "thread", id: T, metadata: { eventTypes: ["thread/context/cleared"] } });
    await harness.lifecycle.dispose();
    await vi.advanceTimersByTimeAsync(CONTEXT_INVALIDATE_MIN_MS);
    expect(fresh()).toHaveLength(3);
    expect(subscriptions).toEqual([]);
  });

  it("validates RPC input", async () => {
    const { harness } = await load();
    await expect(harness.callRpc("thread", { threadId: "" })).rejects.toThrow();
    await expect(
      harness.callRpc("setThreadOverride", { threadId: T, override: { autoCompact: "on", thresholdPercent: 99 } }),
    ).rejects.toThrow();
  });

  it("declares resetShow next to limitsShow, countdown by default", async () => {
    const { harness } = await load();
    const descriptors = harness.registrations.settingsDescriptors;
    const keys = Object.keys(descriptors);
    expect(keys.indexOf("resetShow")).toBe(keys.indexOf("limitsShow") + 1);
    expect(descriptors.resetShow).toMatchObject({ type: "select", options: ["countdown", "time"], default: "countdown" });
  });

  it("setDisplay writes only the given key, answers both effective values and invalidates", async () => {
    const { harness, invalidations } = await load();
    expect(await harness.callRpc("setDisplay", { resetShow: "time" })).toEqual({ limitsShow: "used", resetShow: "time" });
    expect(invalidations()).toContainEqual(null);
    expect(await harness.callRpc("setDisplay", { limitsShow: "remaining" })).toEqual({ limitsShow: "remaining", resetShow: "time" });
    expect(await harness.callRpc("setDisplay", { limitsShow: "used", resetShow: "countdown" })).toEqual({
      limitsShow: "used",
      resetShow: "countdown",
    });
  });

  it("setDisplay rejects an empty input, an unknown value and an unknown key", async () => {
    const { harness } = await load();
    await expect(harness.callRpc("setDisplay", {})).rejects.toThrow();
    await expect(harness.callRpc("setDisplay", { resetShow: "clock" })).rejects.toThrow();
    await expect(harness.callRpc("setDisplay", { limitsShow: "left" })).rejects.toThrow();
    await expect(harness.callRpc("setDisplay", { language: "ru" })).rejects.toThrow();
    expect(await harness.callRpc("setDisplay", { resetShow: "countdown" })).toEqual({ limitsShow: "used", resetShow: "countdown" });
  });

  it("hideProvider appends the id once, keeps the other ids and invalidates (UF-11 R11)", async () => {
    const { harness, invalidations } = await load({ hiddenProviders: " Codex ,, nope" } as never);
    expect(await harness.callRpc("hideProvider", { providerId: "acp-opencode" })).toEqual({ hiddenProviders: ["codex", "nope", "acp-opencode"] });
    expect(invalidations()).toContainEqual(null);
    expect(await harness.callRpc("hideProvider", { providerId: "ACP-OpenCode" })).toEqual({ hiddenProviders: ["codex", "nope", "acp-opencode"] });
    expect(await harness.callRpc("hideProvider", { providerId: "codex" })).toEqual({ hiddenProviders: ["codex", "nope", "acp-opencode"] });
  });

  it("hideProvider starts the setting when it is empty and rejects an empty or a list id", async () => {
    const { harness } = await load();
    await expect(harness.callRpc("hideProvider", { providerId: "" })).rejects.toThrow();
    await expect(harness.callRpc("hideProvider", { providerId: "  " })).rejects.toThrow();
    await expect(harness.callRpc("hideProvider", { providerId: "codex, acp-opencode" })).rejects.toThrow();
    await expect(harness.callRpc("hideProvider", {})).rejects.toThrow();
    expect(await harness.callRpc("hideProvider", { providerId: "codex" })).toEqual({ hiddenProviders: ["codex"] });
  });

  it("compacts manually through the RPC", async () => {
    const { harness, threads } = await load();
    // 20 % of the 117 000 point where Claude Code compacts on its own.
    threads.thread(T, "claude-code", claudeContext(23_400));
    const result = await harness.callRpc("compact", { threadId: T });
    expect(result).toMatchObject({ ok: true, entry: { trigger: "manual", beforePercent: 20 } });
    await harness.lifecycle.dispose();
  });
});

describe("token totals wiring", () => {
  const idle = (harness: Awaited<ReturnType<typeof load>>["harness"], id = T) =>
    harness.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id }) } as never);

  it("counts a thread on idle, invalidates the tokens tag and serves the sums from the given starts", async () => {
    const { harness, threads, invalidations } = await load();
    await settle();
    threads.thread(T, "codex", codexContext(1000));
    threads.tokenEvent(T, NOW - 2 * 24 * HOUR_MS, { totalTokens: 1_000 });
    threads.tokenEvent(T, NOW - 30 * 60_000, { totalTokens: 9_000, cacheReadInputTokens: 6_000 });
    await idle(harness);
    await settle();
    expect(invalidations()).toContainEqual([TOKENS_TAG]);
    const dayStart = NOW - 12 * HOUR_MS;
    const monthStart = NOW - 7 * 24 * HOUR_MS;
    const tokens = (await harness.callRpc("tokens", { threadId: T, dayStart, monthStart })) as Tokens;
    expect(tokens.thread).toEqual({ work: 3_000, all: 9_000 });
    expect(tokens.providers).toEqual([{ providerId: "codex", today: { work: 2_000, all: 8_000 }, month: { work: 3_000, all: 9_000 } }]);
    expect(tokens.backfillDone).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("answers null for an unknown thread, leaves out providers without buckets and rejects bad starts", async () => {
    const { harness, threads } = await load();
    await settle();
    threads.thread("thr_h", "acp-hera", null);
    await idle(harness, "thr_h");
    await settle();
    expect(await harness.callRpc("tokens", { threadId: "thr_h", dayStart: NOW, monthStart: NOW })).toEqual({
      thread: null,
      providers: [],
      backfillDone: true,
    });
    expect(await harness.callRpc("tokens", { dayStart: NOW, monthStart: NOW })).toMatchObject({ thread: null });
    await expect(harness.callRpc("tokens", { dayStart: Number.POSITIVE_INFINITY, monthStart: NOW })).rejects.toThrow();
    await expect(harness.callRpc("tokens", { dayStart: Number.NaN, monthStart: NOW })).rejects.toThrow();
    await expect(harness.callRpc("tokens", { monthStart: NOW })).rejects.toThrow();
    await harness.lifecycle.dispose();
  });

  it("auto-compact still runs on idle when the token count throws", async () => {
    const { harness, threads } = await load({ autoCompactEnabled: true });
    await settle();
    threads.thread(T, "codex", codexContext(0.95 * 258_400));
    threads.eventErrors.add(T);
    const { errors } = await idle(harness);
    expect(errors).toEqual([]);
    await settle();
    expect(threads.compactCalls).toEqual([T]);
    await harness.lifecycle.dispose();
  });

  it("runs the first collection at load over the listed threads", async () => {
    const threads = new FakeThreads();
    threads.thread("thr_x", "claude-code", null).tokenEvent("thr_x", NOW - HOUR_MS, { totalTokens: 500 });
    const { bb, harness } = createFakePluginHost({
      pluginId: "usage-forecast",
      sdk: {
        subscribe: (() => () => undefined) as never,
        system: { usageLimits: () => ({}) },
        threads: {
          get: (args) => threads.get(args),
          list: ((args: never) => threads.list(args ?? {})) as never,
          events: { list: ((args: never) => threads.events(args)) as never },
        },
      },
    });
    await plugin(bb);
    // The collection pauses BACKFILL_PAUSE_MS after each thread.
    await settle(150);
    const tokens = (await harness.callRpc("tokens", { threadId: "thr_x", dayStart: 0, monthStart: 0 })) as Tokens;
    expect(tokens).toMatchObject({ thread: { work: 500, all: 500 }, backfillDone: true });
    expect(threads.listCalls[0]).toMatchObject({ includeHidden: true });
    await harness.lifecycle.dispose();
  });
});
