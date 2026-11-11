// server.ts through the fake host: RPC, schedule, thread events, settings and
// invalidation tags.

import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { CONTEXT_INVALIDATE_MIN_MS, POLL_SCHEDULE } from "../server";
import { LIMITS_TAG, threadTag, type LimitsSnapshot, type ThreadState } from "../src/shared/contract";
import { claudeContext, claudeLimits, codexContext, FakeThreads } from "./helpers";

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
      threads: {
        get: (args) => threads.get(args),
        context: (args) => threads.context(args),
        getPluginMetadata: (args) => threads.getPluginMetadata(args),
        updatePluginMetadata: (args) => threads.updatePluginMetadata(args as never),
        compact: (args) => threads.compact(args),
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
    expect(empty).toMatchObject({ polledAt: null, providers: [] });

    await harness.runSchedule(POLL_SCHEDULE);
    const snapshot = (await harness.callRpc("snapshot", null)) as LimitsSnapshot;
    expect(snapshot.providers[0]!.windows.map((w) => w.usedPercent)).toEqual([40, 20]);
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("owner@example.com");
    expect(text).not.toContain("secret-account-key");
    expect(invalidations()).toContainEqual([LIMITS_TAG]);
    expect(harness.sdk.callsTo("system.usageLimits")).toHaveLength(1);
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

  it("serves the thread state with the 78% cap and the override", async () => {
    const { harness, threads, invalidations } = await load({ autoCompactEnabled: true });
    threads.thread(T, "claude-code", claudeContext(90_000));
    const state = (await harness.callRpc("thread", { threadId: T })) as ThreadState;
    expect(state).toMatchObject({
      threadId: T,
      providerId: "claude-code",
      active: false,
      context: { percent: 60, autoCompactAtTokens: 117_000 },
      override: { autoCompact: "inherit" },
      autoCompact: { enabled: true, thresholdPercent: 80, effectiveThresholdPercent: 76, source: "settings" },
      compactSupported: true,
      cooldownUntil: null,
    });

    await harness.callRpc("setThreadOverride", { threadId: T, override: { autoCompact: "on", thresholdPercent: 60 } });
    expect(threads.metadata.get(T)).toEqual({ override: { autoCompact: "on", thresholdPercent: 60 } });
    expect(invalidations()).toContainEqual([LIMITS_TAG, threadTag(T)]);
    const on = (await harness.callRpc("thread", { threadId: T })) as ThreadState;
    expect(on.autoCompact).toEqual({ enabled: true, thresholdPercent: 60, effectiveThresholdPercent: 60, source: "thread" });

    // A threshold with off is dropped; inherit removes the key.
    const off = await harness.callRpc("setThreadOverride", { threadId: T, override: { autoCompact: "off", thresholdPercent: 60 } });
    expect(off).toEqual({ override: { autoCompact: "off" } });
    await harness.callRpc("setThreadOverride", { threadId: T, override: { autoCompact: "inherit" } });
    expect(threads.metadata.get(T)).toEqual({});
    expect(harness.sdk.callsTo("threads.updatePluginMetadata").at(-1)).toEqual([{ pluginId: "usage-forecast", threadId: T, remove: ["override"] }]);
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

  it("compacts manually through the RPC", async () => {
    const { harness, threads } = await load();
    threads.thread(T, "claude-code", claudeContext(30_000));
    const result = await harness.callRpc("compact", { threadId: T });
    expect(result).toMatchObject({ ok: true, entry: { trigger: "manual", beforePercent: 20 } });
    await harness.lifecycle.dispose();
  });
});
