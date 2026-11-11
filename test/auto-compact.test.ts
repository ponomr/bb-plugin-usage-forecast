import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { AFTER_RETRY_MS, AFTER_WAIT_MS, AutoCompactor, COOLDOWN_MS, isUnsupportedError } from "../src/server/auto-compact";
import type { PluginSettings } from "../src/server/threads";
import { keys, Storage, UNSUPPORTED_TTL_MS } from "../src/server/storage";
import { claudeContext, Clock, codexContext, FakeThreads, makeStorage, MIN, NOW, settingsOf } from "./helpers";

const T = "thr_a";

function setup(over: Partial<PluginSettings> = {}) {
  const clock = new Clock();
  const threads = new FakeThreads();
  const storage = makeStorage();
  const invalidated: string[] = [];
  const warnings: string[] = [];
  const compactor = new AutoCompactor({
    threads,
    storage,
    // The Codex fixtures are percentages of its 258 400 window: the limit matches it.
    settings: settingsOf({ contextLimitTokens: 258_400, ...over }),
    invalidate: (id) => invalidated.push(id),
    log: { info: () => {}, warn: (m) => warnings.push(m) },
    now: clock.now,
  });
  /** The compact turn: active, then idle with the given fill. */
  const finishTurn = async (after: unknown) => {
    threads.contexts.set(T, [after]);
    compactor.onActive(T);
    await compactor.onIdle(T);
    await compactor.settled();
  };
  return { clock, threads, storage, compactor, invalidated, warnings, finishTurn };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("auto-compact on idle", () => {
  it("compacts a Claude Code thread above the capped threshold and logs before and after", async () => {
    // A Claude Code limit of 150 000 lies above its own compaction point (117 000).
    const t = setup({ providerLimitTokens: { "claude-code": 150_000, codex: 0 } });
    // 77 % of 150 000: under the 80 % setting, but over the effective 76 %.
    t.threads.thread(T, "claude-code", claudeContext(115_500));
    await t.compactor.onIdle(T);
    expect(t.threads.compactCalls).toEqual([T]);
    await t.finishTurn(claudeContext(30_000));
    const [entry] = await t.storage.log();
    expect(entry).toMatchObject({ threadId: T, providerId: "claude-code", trigger: "auto", result: "compacted", beforePercent: 77, afterPercent: 20 });
    expect(await t.storage.cooldownUntil(T)).toBe(t.clock.value + COOLDOWN_MS);
    expect(t.invalidated).toContain(T);
  });

  it("does nothing below the effective threshold", async () => {
    const t = setup({ providerLimitTokens: { "claude-code": 150_000, codex: 0 } });
    t.threads.thread(T, "claude-code", claudeContext(112_500)); // 75 %
    await t.compactor.onIdle(T);
    expect(t.threads.compactCalls).toEqual([]);
    expect(await t.storage.log()).toEqual([]);
  });

  it("uses the threshold as is for Codex, which has no own compaction point", async () => {
    const t = setup();
    t.threads.thread(T, "codex", codexContext(0.79 * 258_400));
    await t.compactor.onIdle(T);
    expect(t.threads.compactCalls).toEqual([]);
    t.threads.contexts.set(T, [codexContext(0.81 * 258_400)]);
    await t.compactor.onIdle(T);
    expect(t.threads.compactCalls).toEqual([T]);
  });

  it("does nothing when the host has no measurement", async () => {
    const t = setup();
    t.threads.thread(T, "claude-code", { usage: null });
    await t.compactor.onIdle(T);
    t.threads.contexts.set(T, [{ usage: { usedTokens: 10, modelContextWindow: null } }]);
    await t.compactor.onIdle(T);
    expect(t.threads.compactCalls).toEqual([]);
  });

  it("follows the settings switch and the per-thread override", async () => {
    const off = setup({ autoCompactEnabled: false });
    off.threads.thread(T, "codex", codexContext(0.9 * 258_400));
    await off.compactor.onIdle(T);
    expect(off.threads.compactCalls).toEqual([]);

    off.threads.metadata.set(T, { override: { autoCompact: "on", thresholdPercent: 85 } });
    await off.compactor.onIdle(T);
    expect(off.threads.compactCalls).toEqual([T]);

    const on = setup();
    on.threads.thread(T, "codex", codexContext(0.9 * 258_400));
    on.threads.metadata.set(T, { override: { autoCompact: "off" } });
    await on.compactor.onIdle(T);
    expect(on.threads.compactCalls).toEqual([]);

    // A thread threshold above the fill keeps it from compacting.
    on.threads.metadata.set(T, { override: { autoCompact: "on", thresholdPercent: 95 } });
    await on.compactor.onIdle(T);
    expect(on.threads.compactCalls).toEqual([]);

    // A malformed override falls back to the settings.
    on.threads.metadata.set(T, { override: { autoCompact: "sometimes" } });
    await on.compactor.onIdle(T);
    expect(on.threads.compactCalls).toEqual([T]);
  });

  it("waits out the cooldown: no compact at 3 minutes, a compact at 11", async () => {
    const t = setup();
    t.threads.thread(T, "codex", codexContext(0.9 * 258_400));
    await t.compactor.onIdle(T);
    await t.finishTurn(codexContext(0.1 * 258_400));
    // The thread fills up again quickly.
    t.threads.contexts.set(T, [codexContext(0.9 * 258_400)]);
    t.clock.advance(3 * MIN);
    await t.compactor.onIdle(T);
    expect(t.threads.compactCalls).toHaveLength(1);
    t.clock.advance(8 * MIN);
    await t.compactor.onIdle(T);
    expect(t.threads.compactCalls).toHaveLength(2);
  });

  it("doubles the cooldown when the fill did not drop", async () => {
    const t = setup();
    t.threads.thread(T, "codex", codexContext(0.9 * 258_400));
    const at = t.clock.value;
    await t.compactor.onIdle(T);
    await t.finishTurn(codexContext(0.9 * 258_400));
    expect(await t.storage.cooldownUntil(T)).toBe(at + 2 * COOLDOWN_MS);
    expect((await t.storage.log())[0]).toMatchObject({ beforePercent: 90, afterPercent: 90 });
  });

  it("skips a thread that is answering", async () => {
    const t = setup();
    t.threads.thread(T, "codex", codexContext(0.9 * 258_400), "running");
    await t.compactor.onIdle(T);
    expect(t.threads.contextCalls).toEqual([]);
    expect(t.threads.compactCalls).toEqual([]);
  });

  it("cancels when the agent starts answering while the context is read", async () => {
    const t = setup();
    t.threads.thread(T, "codex", codexContext(0.9 * 258_400));
    t.threads.onGet = (id, call) => {
      if (call === 2) t.threads.status.set(id, "running");
    };
    await t.compactor.onIdle(T);
    expect(t.threads.compactCalls).toEqual([]);
    expect((await t.storage.log())[0]).toMatchObject({ result: "cancelled", trigger: "auto" });
  });

  it("cancels on a thread.active event between the two reads", async () => {
    const t = setup();
    t.threads.thread(T, "codex", () => {
      t.compactor.onActive(T);
      return codexContext(0.9 * 258_400);
    });
    await t.compactor.onIdle(T);
    expect(t.threads.compactCalls).toEqual([]);
    expect((await t.storage.log())[0]!.result).toBe("cancelled");
  });

  it("marks a provider unsupported and stops reading its context", async () => {
    const t = setup();
    t.threads.thread(T, "acp-x", codexContext(0.9 * 258_400));
    t.threads.compactError = new Error("Compact is not supported by this provider");
    await t.compactor.onIdle(T);
    expect(await t.storage.unsupportedProviders(t.clock.value)).toEqual(["acp-x"]);
    expect((await t.storage.log())[0]!.result).toBe("unsupported");
    // No cooldown for unsupported; the mark alone stops further attempts.
    expect(await t.storage.cooldownUntil(T)).toBeNull();
    t.threads.contextCalls.length = 0;
    await t.compactor.onIdle(T);
    expect(t.threads.contextCalls).toEqual([]);
    expect(t.threads.compactCalls).toHaveLength(1);
  });

  it("lets an unsupported mark expire after a day", async () => {
    const t = setup();
    t.threads.thread(T, "acp-x", codexContext(0.9 * 258_400));
    t.threads.compactError = new Error("Compact is not supported by this provider");
    await t.compactor.onIdle(T);
    t.threads.compactError = null;
    t.clock.advance(UNSUPPORTED_TTL_MS);
    expect(await t.storage.unsupportedProviders(t.clock.value)).toEqual([]);
    await t.compactor.onIdle(T);
    expect(t.threads.compactCalls).toHaveLength(2);
    expect((await t.storage.log())[0]!.result).toBe("compacted");
  });

  it("reads a list stored by 0.1.0 as no marks", async () => {
    const { kv } = createFakePluginHost({ pluginId: "usage-forecast" }).bb.storage;
    await kv.set(keys.unsupported, ["acp-x"]);
    expect(await new Storage(kv).unsupportedProviders(NOW)).toEqual([]);
  });

  it("records a failed compact with a cooldown and a masked message", async () => {
    const t = setup();
    t.threads.thread(T, "codex", codexContext(0.9 * 258_400));
    t.threads.compactError = new Error("queue full for owner@example.com");
    await t.compactor.onIdle(T);
    expect((await t.storage.log())[0]).toMatchObject({ result: "failed", message: "queue full for <email>" });
    expect(await t.storage.cooldownUntil(T)).toBe(t.clock.value + COOLDOWN_MS);
  });

  it("logs and survives a failing host call", async () => {
    const t = setup();
    t.threads.thread(T, "codex", () => {
      throw new Error("host gone");
    });
    await expect(t.compactor.onIdle(T)).resolves.toBeUndefined();
    expect(t.warnings[0]).toContain("host gone");
  });

  it("ignores an idle that is not preceded by thread.active as the end of the compact turn", async () => {
    const t = setup();
    t.threads.thread(T, "codex", codexContext(0.9 * 258_400));
    await t.compactor.onIdle(T);
    // A second idle without an active in between: the compact turn has not run yet.
    t.threads.contexts.set(T, [codexContext(0.2 * 258_400)]);
    await t.compactor.onIdle(T);
    expect((await t.storage.log())[0]!.afterPercent).toBeNull();
    await t.finishTurn(codexContext(0.2 * 258_400));
    expect((await t.storage.log())[0]!.afterPercent).toBeCloseTo(20);
  });
});

describe("after-fill timing", () => {
  it("retries once after AFTER_RETRY_MS and leaves an unknown fill null", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.threads.thread(T, "codex", codexContext(0.9 * 258_400));
    await t.compactor.onIdle(T);
    t.threads.contexts.set(T, [{ usage: null }]);
    t.compactor.onActive(T);
    await t.compactor.onIdle(T);
    const before = t.threads.contextCalls.length;
    await vi.advanceTimersByTimeAsync(AFTER_RETRY_MS);
    await t.compactor.settled();
    expect(t.threads.contextCalls.length).toBe(before + 1);
    expect((await t.storage.log())[0]!.afterPercent).toBeNull();
    expect(await t.storage.cooldownUntil(T)).toBe(t.clock.value + COOLDOWN_MS);
  });

  it("reads the fill after AFTER_WAIT_MS when no idle arrives", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.threads.thread(T, "codex", codexContext(0.9 * 258_400));
    await t.compactor.onIdle(T);
    t.threads.contexts.set(T, [codexContext(0.3 * 258_400)]);
    await vi.advanceTimersByTimeAsync(AFTER_WAIT_MS);
    await t.compactor.settled();
    expect((await t.storage.log())[0]!.afterPercent).toBeCloseTo(30);
  });

  it("stops pending reads on dispose", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.threads.thread(T, "codex", codexContext(0.9 * 258_400));
    await t.compactor.onIdle(T);
    const before = t.threads.contextCalls.length;
    t.compactor.dispose();
    await vi.advanceTimersByTimeAsync(AFTER_WAIT_MS);
    await t.compactor.settled();
    expect(t.threads.contextCalls.length).toBe(before);
    await t.compactor.onIdle(T);
    expect(t.threads.compactCalls).toHaveLength(1);
  });
});

describe("manual compact", () => {
  it("compacts an idle thread regardless of the threshold and settings", async () => {
    const t = setup({ autoCompactEnabled: false });
    // 20 % of the 117 000 point where Claude Code compacts on its own.
    t.threads.thread(T, "claude-code", claudeContext(23_400));
    const result = await t.compactor.manual(T);
    expect(result).toMatchObject({ ok: true, message: null, entry: { trigger: "manual", beforePercent: 20 } });
  });

  it("lifts the unsupported mark when a manual compact succeeds", async () => {
    const t = setup();
    t.threads.thread(T, "acp-x", codexContext(0.3 * 258_400));
    await t.storage.markUnsupported("acp-x", t.clock.value);
    expect(await t.compactor.manual(T)).toMatchObject({ ok: true });
    expect(await t.storage.unsupportedProviders(t.clock.value)).toEqual([]);
  });

  it("refuses while the agent is answering", async () => {
    const t = setup();
    t.threads.thread(T, "claude-code", claudeContext(30_000), "running");
    expect(await t.compactor.manual(T)).toEqual({
      ok: false,
      message: "The agent is answering; try again when it is idle",
      entry: null,
    });
    expect(t.threads.compactCalls).toEqual([]);
  });

  it("refuses a second compact while one is running", async () => {
    const t = setup();
    t.threads.thread(T, "claude-code", claudeContext(30_000));
    const [a, b] = await Promise.all([t.compactor.manual(T), t.compactor.manual(T)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(t.threads.compactCalls).toHaveLength(1);
  });

  it("reports a failure", async () => {
    const t = setup();
    t.threads.thread(T, "claude-code", claudeContext(30_000));
    t.threads.compactError = new Error("boom");
    expect(await t.compactor.manual(T)).toMatchObject({ ok: false, message: "boom", entry: { result: "failed" } });
  });
});

describe("isUnsupportedError", () => {
  it("recognises the wording", () => {
    expect(isUnsupportedError(new Error("Provider does not support compact"))).toBe(true);
    expect(isUnsupportedError("unsupported operation")).toBe(true);
    expect(isUnsupportedError(new Error("timeout"))).toBe(false);
  });
});
