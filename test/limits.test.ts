// The working limit per provider: thread override, per-provider setting, the
// provider's own compaction point, the global setting, capped by the window;
// and the effective auto-compact threshold that results.

import { describe, expect, it } from "vitest";
import {
  contextLimitOf,
  effectiveThreshold,
  effectiveThresholdTokens,
  measureThread,
  parseSettings,
  readContext,
  readThreadState,
  type PluginSettings,
} from "../src/server/threads";
import type { ThreadContext, ThreadOverride } from "../src/shared/contract";
import { claudeActiveContext, claudeContext, codexContext, FakeThreads, makeStorage, NOW, settingsOf } from "./helpers";

const INHERIT: ThreadOverride = { autoCompact: "inherit" };
const settings = (over: Partial<PluginSettings> = {}) => parseSettings({ ...over });
const withProviders = (claude: number, codex: number): PluginSettings => ({
  ...settings(),
  providerLimitTokens: { "claude-code": claude, codex },
});

/** The threshold auto-compact acts on, in tokens, for a context and a setting. */
const actsAt = (thresholdPercent: number, ctx: ThreadContext | null) => effectiveThresholdTokens(thresholdPercent, ctx);

describe("per-provider settings", () => {
  it("defaults both providers to auto and keeps the global default", () => {
    expect(settings()).toMatchObject({ contextLimitTokens: 150_000, providerLimitTokens: { "claude-code": 0, codex: 0 } });
  });

  it("reads 0, negatives and junk as auto and clamps other values to the range", () => {
    const parsed = parseSettings({ claudeCodeContextLimitTokens: -5, codexContextLimitTokens: "250000" });
    expect(parsed.providerLimitTokens).toEqual({ "claude-code": 0, codex: 0 });
    expect(parseSettings({ claudeCodeContextLimitTokens: 5_000, codexContextLimitTokens: 3_000_000 }).providerLimitTokens).toEqual({
      "claude-code": 10_000,
      codex: 2_000_000,
    });
    expect(parseSettings({ codexContextLimitTokens: 250_000 }).providerLimitTokens.codex).toBe(250_000);
  });
});

describe("limit precedence", () => {
  it("orders thread, provider setting, reported point, global", () => {
    const s = withProviders(180_000, 0);
    expect(contextLimitOf({ autoCompact: "inherit", limitTokens: 90_000 }, s, "claude-code", 167_000)).toEqual({ tokens: 90_000, source: "thread" });
    expect(contextLimitOf(INHERIT, s, "claude-code", 167_000)).toEqual({ tokens: 180_000, source: "provider" });
    expect(contextLimitOf(INHERIT, settings(), "claude-code", 167_000)).toEqual({ tokens: 167_000, source: "reported" });
    expect(contextLimitOf(INHERIT, settings(), "claude-code", null)).toEqual({ tokens: 150_000, source: "settings" });
  });

  it("ignores per-provider settings for other providers", () => {
    expect(contextLimitOf(INHERIT, withProviders(180_000, 250_000), "acp-x", null)).toEqual({ tokens: 150_000, source: "settings" });
  });
});

describe("Claude Code, 200 000 window", () => {
  it("compacting at 200 000: the limit is that point, auto-compact acts below it", () => {
    const ctx = readContext(claudeContext(100_000, 200_000, 200_000), INHERIT, settings(), "claude-code")!;
    expect(ctx).toMatchObject({ limitTokens: 200_000, limitSource: "reported", percent: 50, autoCompactAtTokens: 200_000 });
    expect(actsAt(80, ctx)).toBe(160_000);
    // The highest threshold still lands below the point where Claude compacts.
    expect(actsAt(95, ctx)).toBe(190_000);
    expect(actsAt(95, ctx)!).toBeLessThan(200_000);
  });

  it("compacting at 167 000 (what bb 0.49 reports): the bar is full there", () => {
    const ctx = readContext(claudeContext(167_000, 200_000), INHERIT, settings(), "claude-code")!;
    expect(ctx).toMatchObject({ limitTokens: 167_000, limitSource: "reported", percent: 100 });
    expect(actsAt(80, ctx)).toBe(133_600);
    expect(actsAt(95, ctx)!).toBeLessThan(167_000);
  });

  it("a thread override above the point is capped below it", () => {
    const override: ThreadOverride = { autoCompact: "on", thresholdPercent: 90, limitTokens: 200_000 };
    const ctx = readContext(claudeContext(150_000, 200_000), override, settings(), "claude-code")!;
    expect(ctx).toMatchObject({ limitTokens: 200_000, limitSource: "thread", percent: 75 });
    // (167 000 - 2 % of 200 000) / 200 000 = 81.5 %, floored to 81 %.
    expect(effectiveThreshold(90, ctx)).toBe(81);
    expect(actsAt(90, ctx)).toBe(162_000);
    expect(actsAt(90, ctx)!).toBeLessThan(167_000);
  });

  it("a per-provider setting wins over the reported point", () => {
    const ctx = readContext(claudeContext(100_000, 200_000), INHERIT, withProviders(120_000, 0), "claude-code")!;
    expect(ctx).toMatchObject({ limitTokens: 120_000, limitSource: "provider" });
    expect(actsAt(80, ctx)).toBe(96_000);
  });
});

describe("Codex, 500 000 window", () => {
  it("compacting at 250 000 set per provider: the limit is 250 000, auto-compact acts below it", () => {
    const ctx = readContext(codexContext(125_000, 500_000), INHERIT, withProviders(0, 250_000), "codex")!;
    expect(ctx).toMatchObject({ limitTokens: 250_000, limitSource: "provider", percent: 50, autoCompactAtTokens: null });
    expect(actsAt(80, ctx)).toBe(200_000);
    expect(actsAt(95, ctx)!).toBeLessThan(250_000);
  });

  it("without the setting it falls back to the global limit, since Codex reports no point", () => {
    const ctx = readContext(codexContext(125_000, 500_000), INHERIT, settings(), "codex")!;
    expect(ctx).toMatchObject({ limitTokens: 150_000, limitSource: "settings" });
    expect(actsAt(80, ctx)).toBe(120_000);
  });

  it("a thread override wins over the per-provider setting", () => {
    const override: ThreadOverride = { autoCompact: "inherit", limitTokens: 100_000 };
    const ctx = readContext(codexContext(50_000, 500_000), override, withProviders(0, 250_000), "codex")!;
    expect(ctx).toMatchObject({ limitTokens: 100_000, limitSource: "thread", percent: 50 });
  });

  it("a setting above the window is capped by it", () => {
    const ctx = readContext(codexContext(237_500, 475_000), INHERIT, withProviders(0, 600_000), "codex")!;
    expect(ctx).toMatchObject({ limitTokens: 475_000, limitSource: "window", percent: 50 });
  });
});

describe("a provider that reports nothing", () => {
  it("uses the global limit, capped by the window, with the threshold as set", () => {
    const ctx = readContext({ usage: { usedTokens: 60_000, modelContextWindow: 128_000 } }, INHERIT, withProviders(180_000, 250_000), "acp-x")!;
    expect(ctx).toMatchObject({ limitTokens: 128_000, limitSource: "window", autoCompactAtTokens: null });
    expect(effectiveThreshold(80, ctx)).toBe(80);
    const wide = readContext({ usage: { usedTokens: 60_000, modelContextWindow: 400_000 } }, INHERIT, settings(), "acp-x")!;
    expect(wide).toMatchObject({ limitTokens: 150_000, limitSource: "settings", percent: 40 });
  });

  it("has no measurement without a window", () => {
    expect(readContext({ usage: { usedTokens: 10 } }, INHERIT, settings(), "acp-x")).toBeNull();
  });
});

describe("remembered compaction point", () => {
  it("keeps a Claude Code thread on its reported point while a turn runs", async () => {
    const storage = makeStorage();
    const s = settings();
    const idle = await measureThread(storage, claudeContext(100_000, 200_000), "claude-code", INHERIT, s, NOW);
    expect(idle).toMatchObject({ limitTokens: 167_000, limitSource: "reported" });
    // An answering thread has no snapshot; the same provider and window reuse the point.
    const active = await measureThread(storage, claudeActiveContext(120_000, 200_000), "claude-code", INHERIT, s, NOW + 1);
    expect(active).toMatchObject({ limitTokens: 167_000, limitSource: "reported", autoCompactAtTokens: 167_000 });
    // Another window size has its own point; none is known yet.
    const other = await measureThread(storage, claudeActiveContext(60_000, 150_000), "claude-code", INHERIT, s, NOW + 2);
    expect(other).toMatchObject({ limitTokens: 150_000, limitSource: "settings", autoCompactAtTokens: null });
    // Other providers do not share it.
    const codex = await measureThread(storage, codexContext(60_000, 200_000), "codex", INHERIT, s, NOW + 3);
    expect(codex).toMatchObject({ limitSource: "settings" });
  });

  it("follows a new reported point and writes the stored value only when it changes or ages", async () => {
    const storage = makeStorage();
    await storage.rememberCompactPoint("claude-code", 200_000, 167_000, NOW);
    await storage.rememberCompactPoint("claude-code", 200_000, 167_000, NOW + 60_000);
    expect((await storage.compactPoints())["claude-code|200000"]).toEqual({ tokens: 167_000, seenAt: NOW });
    await storage.rememberCompactPoint("claude-code", 200_000, 180_000, NOW + 120_000);
    expect(await storage.compactPoint("claude-code", 200_000)).toBe(180_000);
  });

  it("keeps at most 20 points, the most recently seen", async () => {
    const storage = makeStorage();
    for (let i = 0; i < 25; i++) await storage.rememberCompactPoint("p", 100_000 + i, 50_000, NOW + i);
    const points = await storage.compactPoints();
    expect(Object.keys(points)).toHaveLength(20);
    expect(points["p|100000"]).toBeUndefined();
    expect(points["p|100024"]).toBeDefined();
  });

  it("is used by the thread RPC state", async () => {
    const threads = new FakeThreads().thread("thr_a", "claude-code", claudeContext(100_000, 200_000));
    const storage = makeStorage();
    const deps = { threads, storage, settings: settingsOf(), now: () => NOW };
    await readThreadState(deps, "thr_a");
    threads.thread("thr_a", "claude-code", claudeActiveContext(133_600, 200_000), "running");
    const state = await readThreadState(deps, "thr_a");
    expect(state.context).toMatchObject({ limitTokens: 167_000, limitSource: "reported", percent: 80 });
    expect(state.autoCompact).toMatchObject({ effectiveThresholdPercent: 80, effectiveThresholdTokens: 133_600 });
  });
});
