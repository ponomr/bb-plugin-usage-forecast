import { afterEach, describe, expect, it, vi } from "vitest";
import { AFTER_RETRY_MS, AutoCompactor, COOLDOWN_MS, SUMMARY_STARTED, SUMMARY_WAIT_MS } from "../src/server/auto-compact";
import { readThreadState, type PluginSettings } from "../src/server/threads";
import { en, ru } from "../src/app/i18n";
import { compactEntryText } from "../src/app/format";
import { readSummary, SUMMARY_CUT_NOTE, SUMMARY_MARKER, SUMMARY_MAX_CHARS } from "../src/shared/summary";
import { Clock, FakeThreads, makeStorage, NOW } from "./helpers";
import { settingsOf } from "./helpers";

const T = "thr_acp";
const KAYA = "acp-kaya";
const BODY = "Goal: ship UF-4. Decisions: summary and clear for ACP agents. Next: run the checks. Code word: PELICAN-42.";
const SUMMARY_ANSWER = { output: `${SUMMARY_MARKER}\n\n${BODY}` };
const UNSUPPORTED = new Error(`Provider "${KAYA}" does not support manual context compaction`);

/** An ACP answer: usage only, like a Hermes agent on bb 0.49. 150 000 is the default limit. */
const acp = (usedTokens: number) => ({ usage: { usedTokens, modelContextWindow: 500_000, estimated: false } });

function setup(over: Partial<PluginSettings> = {}) {
  const clock = new Clock();
  const threads = new FakeThreads();
  const storage = makeStorage();
  const warnings: string[] = [];
  const compactor = new AutoCompactor({
    threads,
    storage,
    settings: settingsOf({ summaryClearEnabled: true, ...over }),
    invalidate: () => {},
    log: { info: () => {}, warn: (m) => warnings.push(m) },
    now: clock.now,
  });
  threads.thread(T, KAYA, acp(135_000)); // 90 % of 150 000
  threads.compactError = UNSUPPORTED;
  threads.outputs.set(T, SUMMARY_ANSWER);
  /** Every turn the plugin starts runs at once: active, then idle; the restore turn leaves `afterTokens`. */
  const playTurns = (afterTokens = 20_000) => {
    threads.onSend = (_id, text) => {
      if (text.startsWith(en.summaryRestore("").slice(0, 40))) threads.contexts.set(T, [acp(afterTokens)]);
      compactor.onActive(T);
      void compactor.onIdle(T);
    };
  };
  return { clock, threads, storage, compactor, warnings, playTurns };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("summary and clear for a provider that cannot compact", () => {
  it("asks for a summary, clears and sends the summary back, then logs before and after", async () => {
    const t = setup();
    t.playTurns(30_000);
    await t.compactor.onIdle(T);
    await t.compactor.settled();

    expect(t.threads.compactCalls).toEqual([T]);
    expect(await t.storage.unsupportedProviders(NOW)).toEqual([KAYA]);
    expect(t.threads.sends.map((s) => s.mode)).toEqual(["start", "queue-if-active"]);
    expect(t.threads.sends[0]!.text).toBe(en.summaryRequest);
    expect(t.threads.sends[1]!.text).toBe(en.summaryRestore(BODY));
    expect(t.threads.sends[1]!.text).toContain("PELICAN-42");
    expect(t.threads.clearCalls).toEqual([T]);
    const [entry] = await t.storage.log();
    expect(entry).toMatchObject({ trigger: "auto", result: "compacted", method: "summary", beforePercent: 90, afterPercent: 20 });
    expect(await t.storage.cooldownUntil(T)).toBe(NOW + COOLDOWN_MS);
    expect(compactEntryText(en, entry!)).toContain("compacted (summary and clear)");
  });

  it("goes straight to the summary for a provider already marked unsupported", async () => {
    const t = setup();
    await t.storage.markUnsupported(KAYA, NOW);
    t.playTurns();
    await t.compactor.onIdle(T);
    await t.compactor.settled();
    expect(t.threads.compactCalls).toEqual([]);
    expect(t.threads.clearCalls).toEqual([T]);
  });

  it("skips a marked provider when the setting is off, as before", async () => {
    const t = setup({ summaryClearEnabled: false });
    await t.storage.markUnsupported(KAYA, NOW);
    t.playTurns();
    await t.compactor.onIdle(T);
    await t.compactor.settled();
    expect(t.threads.sends).toEqual([]);
    expect(t.threads.clearCalls).toEqual([]);
  });

  it("with the setting off, an unsupported compact is logged and nothing is sent", async () => {
    const t = setup({ summaryClearEnabled: false });
    await t.compactor.onIdle(T);
    await t.compactor.settled();
    expect(t.threads.sends).toEqual([]);
    expect((await t.storage.log())[0]).toMatchObject({ result: "unsupported", method: "compact" });
  });

  it("does not clear when the answer is not a summary", async () => {
    const t = setup();
    t.threads.outputs.set(T, { output: "I can't summarise right now." });
    t.playTurns();
    await t.compactor.onIdle(T);
    await t.compactor.settled();
    expect(t.threads.clearCalls).toEqual([]);
    expect(t.threads.sends).toHaveLength(1);
    expect((await t.storage.log())[0]).toMatchObject({ result: "failed", method: "summary" });
    expect((await t.storage.log())[0]!.message).toContain("not a summary");
    expect(await t.storage.cooldownUntil(T)).toBe(NOW + COOLDOWN_MS);
  });

  it("does not clear when the summary turn failed", async () => {
    const t = setup();
    t.playTurns();
    t.threads.onGet = (_id, call) => {
      if (call > 2) t.threads.status.set(T, "error");
    };
    await t.compactor.onIdle(T);
    await t.compactor.settled();
    expect(t.threads.clearCalls).toEqual([]);
    expect((await t.storage.log())[0]!.message).toContain("summary turn failed");
  });

  it("cancels when the user starts a turn after the summary", async () => {
    const t = setup();
    t.playTurns();
    // Reads 1 and 2 are the idle checks; read 3 follows the summary turn.
    t.threads.onGet = (_id, call) => {
      if (call > 2) t.threads.status.set(T, "running");
    };
    await t.compactor.onIdle(T);
    await t.compactor.settled();
    expect(t.threads.clearCalls).toEqual([]);
    expect((await t.storage.log())[0]).toMatchObject({ result: "cancelled", method: "summary" });
  });

  it("gives up without clearing when no summary arrives in time", async () => {
    vi.useFakeTimers();
    const t = setup();
    // The summary turn never ends.
    await t.compactor.onIdle(T);
    expect(t.threads.sends).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SUMMARY_WAIT_MS);
    await t.compactor.settled();
    expect(t.threads.clearCalls).toEqual([]);
    expect((await t.storage.log())[0]!.message).toContain("No summary within 10 min");
  });

  it("records a failed clear and sends nothing more", async () => {
    const t = setup();
    t.threads.clearError = new Error("Thread became active while clearing context");
    t.playTurns();
    await t.compactor.onIdle(T);
    await t.compactor.settled();
    expect(t.threads.sends).toHaveLength(1);
    expect((await t.storage.log())[0]).toMatchObject({ result: "failed", method: "summary" });
  });

  it("retries the summary send once after the clear", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.playTurns();
    t.threads.sendErrors = [null, new Error("busy")];
    await t.compactor.onIdle(T);
    await vi.advanceTimersByTimeAsync(AFTER_RETRY_MS);
    await t.compactor.settled();
    expect(t.threads.sends.map((s) => s.mode)).toEqual(["start", "queue-if-active", "queue-if-active"]);
    expect((await t.storage.log())[0]).toMatchObject({ result: "compacted", method: "summary" });
  });

  it("says where the summary is when it cannot be sent back", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.playTurns();
    t.threads.sendErrors = [null, new Error("down"), new Error("still down")];
    await t.compactor.onIdle(T);
    await vi.advanceTimersByTimeAsync(AFTER_RETRY_MS);
    await t.compactor.settled();
    const [entry] = await t.storage.log();
    expect(entry).toMatchObject({ result: "failed", method: "summary" });
    expect(entry!.message).toContain("thread history");
    expect(t.warnings.some((w) => w.includes("could not send the summary back"))).toBe(true);
  });

  it("writes the messages in the plugin's language", async () => {
    const t = setup({ language: "ru" });
    t.playTurns();
    await t.compactor.onIdle(T);
    await t.compactor.settled();
    expect(t.threads.sends.map((s) => s.text)).toEqual([ru.summaryRequest, ru.summaryRestore(BODY)]);
  });

  it("ignores idle events while the summary runs", async () => {
    const t = setup();
    await t.compactor.onIdle(T); // the summary turn is now pending
    await t.compactor.onIdle(T);
    expect(t.threads.sends).toHaveLength(1);
    expect(await t.compactor.manual(T)).toMatchObject({ ok: false });
    t.compactor.dispose();
    await t.compactor.settled();
  });
});

describe("manual compact on a provider that cannot compact", () => {
  it("starts summary and clear and returns at once", async () => {
    const t = setup({ autoCompactEnabled: false });
    t.threads.contexts.set(T, [acp(10_000)]); // the threshold does not apply to a manual compact
    t.playTurns();
    const result = await t.compactor.manual(T);
    expect(result).toEqual({ ok: true, message: SUMMARY_STARTED, entry: null });
    await t.compactor.settled();
    expect(t.threads.clearCalls).toEqual([T]);
    expect((await t.storage.log())[0]).toMatchObject({ trigger: "manual", result: "compacted", method: "summary" });
  });

  it("uses the summary right away for a marked provider", async () => {
    const t = setup();
    await t.storage.markUnsupported(KAYA, NOW);
    t.playTurns();
    expect((await t.compactor.manual(T)).message).toBe(SUMMARY_STARTED);
    await t.compactor.settled();
    expect(t.threads.compactCalls).toEqual([]);
  });
});

describe("thread state", () => {
  it("offers summary and clear only for a marked provider with the setting on", async () => {
    for (const [enabled, expected] of [
      [true, true],
      [false, false],
    ] as const) {
      const t = setup({ summaryClearEnabled: enabled });
      await t.storage.markUnsupported(KAYA, NOW);
      const state = await readThreadState({ threads: t.threads, storage: t.storage, settings: settingsOf({ summaryClearEnabled: enabled }), now: t.clock.now }, T);
      expect(state).toMatchObject({ compactSupported: false, summaryClear: expected });
    }
  });
});

describe("readSummary", () => {
  it("takes the text after the marker", () => {
    expect(readSummary(SUMMARY_ANSWER)).toBe(BODY);
    expect(readSummary({ output: `Here it is.\n${SUMMARY_MARKER}\n${BODY}` })).toBe(BODY);
  });

  it("refuses an answer without the marker near its start, a short one or a missing one", () => {
    expect(readSummary({ output: BODY })).toBeNull();
    expect(readSummary({ output: `${"x".repeat(300)}${SUMMARY_MARKER}${BODY}` })).toBeNull();
    expect(readSummary({ output: `${SUMMARY_MARKER} ok` })).toBeNull();
    expect(readSummary({ output: null })).toBeNull();
    expect(readSummary(null)).toBeNull();
  });

  it("cuts a very long summary and says so", () => {
    const long = readSummary({ output: `${SUMMARY_MARKER}\n${"a".repeat(SUMMARY_MAX_CHARS + 10)}` });
    expect(long).toBe(`${"a".repeat(SUMMARY_MAX_CHARS)}${SUMMARY_CUT_NOTE}`);
  });

  it("is asked for in both languages", () => {
    expect(en.summaryRequest).toContain(SUMMARY_MARKER);
    expect(ru.summaryRequest).toContain(SUMMARY_MARKER);
  });
});
