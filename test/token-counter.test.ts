import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { Storage } from "../src/server/storage";
import { TokenCounter } from "../src/server/token-counter";
import { HOUR_MS, MIN_MS } from "../src/shared/windows";
import { FakeThreads, NOW } from "./helpers";

const DAY_START = NOW - 12 * HOUR_MS;

function setup(threads = new FakeThreads(), kv = createFakePluginHost({ pluginId: "usage-forecast" }).bb.storage.kv) {
  const storage = new Storage(kv);
  const logs: string[] = [];
  let invalidations = 0;
  let clock = NOW;
  const counter = new TokenCounter({
    threads,
    storage,
    invalidate: () => invalidations++,
    log: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`) },
    now: () => clock,
    sleep: async () => undefined,
  });
  return {
    threads,
    kv,
    storage,
    counter,
    logs,
    invalidations: () => invalidations,
    advance: (ms: number) => (clock += ms),
    view: (threadId: string | null = null) => counter.view(threadId, DAY_START, DAY_START),
  };
}

const total = (totalTokens: number, cacheReadInputTokens = 0) => ({ totalTokens, cacheReadInputTokens });

/** Three threads: Claude Code, Codex and a Hermes agent with no token events. */
function threeThreads() {
  const threads = new FakeThreads();
  threads.thread("thr_a", "claude-code", null).thread("thr_b", "codex", null).thread("thr_c", "acp-hera", null);
  threads.tokenEvent("thr_a", NOW - 2 * HOUR_MS, total(10_000, 9_000)).tokenEvent("thr_a", NOW - HOUR_MS, total(30_000, 27_000));
  threads.tokenEvent("thr_b", NOW - 30 * MIN_MS, total(5_000, 4_000));
  return threads;
}

describe("TokenCounter", () => {
  it("counts a thread on idle: a new one is paged in full, a known one reads its newest event", async () => {
    const threads = new FakeThreads().thread("thr_a", "codex", null);
    for (let i = 0; i < 150; i++) threads.tokenEvent("thr_a", NOW - (150 - i) * MIN_MS, total((i + 1) * 100));
    const { counter, view, invalidations } = setup(threads);
    await counter.onIdle("thr_a");
    expect(threads.eventCalls).toEqual([
      { threadId: "thr_a", order: "asc", limit: "100" },
      { threadId: "thr_a", order: "asc", limit: "100", afterSeq: "199" },
    ]);
    expect((await view("thr_a")).thread).toEqual({ work: 15_000, all: 15_000 });
    expect(invalidations()).toBe(1);

    threads.eventCalls.length = 0;
    threads.tokenEvent("thr_a", NOW, total(16_000));
    await counter.onIdle("thr_a");
    expect(threads.eventCalls).toEqual([{ threadId: "thr_a", order: "desc", limit: "1" }]);
    const v = await view("thr_a");
    expect(v.thread).toEqual({ work: 16_000, all: 16_000 });
    expect(v.providers).toEqual([{ providerId: "codex", today: { work: 16_000, all: 16_000 }, month: { work: 16_000, all: 16_000 } }]);
  });

  it("AE4: the first collection skips a thread that fails, counts the rest and records completion", async () => {
    const threads = threeThreads();
    threads.eventErrors.add("thr_b");
    const { counter, view, logs, storage } = setup(threads);
    await counter.backfill();
    const v = await view();
    expect(v.providers.map((p) => p.providerId)).toEqual(["claude-code"]);
    expect((await storage.tokenState()).backfill).toMatchObject({ done: true, threadsRead: 2, threadsFailed: 1 });
    expect(threads.listCalls[0]).toMatchObject({ includeHidden: true });
    const warn = logs.find((l) => l.startsWith("warn"));
    expect(warn).toBe("warn token collection skipped thr_b: Error");
    expect(logs.join("\n")).not.toContain("secret message text");
  });

  it("AE5: a thread counted on idle before the collection reaches it adds nothing later", async () => {
    const threads = threeThreads();
    const { counter, view } = setup(threads);
    await counter.onIdle("thr_a");
    const after = await view();
    await counter.backfill();
    const done = await view();
    expect(done.providers.find((p) => p.providerId === "claude-code")).toEqual(after.providers.find((p) => p.providerId === "claude-code"));
    expect(done.providers.find((p) => p.providerId === "codex")?.month.all).toBe(5_000);
    expect(done.backfillDone).toBe(true);
  });

  it("idle and the collection running together give the same buckets as either order alone", async () => {
    const together = setup(threeThreads());
    await Promise.all([together.counter.backfill(), together.counter.onIdle("thr_a"), together.counter.onIdle("thr_b")]);
    const idleFirst = setup(threeThreads());
    await idleFirst.counter.onIdle("thr_a");
    await idleFirst.counter.onIdle("thr_b");
    await idleFirst.counter.backfill();
    const collectFirst = setup(threeThreads());
    await collectFirst.counter.backfill();
    await collectFirst.counter.onIdle("thr_a");
    await collectFirst.counter.onIdle("thr_b");
    const hours = async (s: ReturnType<typeof setup>) => (await s.storage.tokenState()).hours;
    expect(await hours(together)).toEqual(await hours(idleFirst));
    expect(await hours(together)).toEqual(await hours(collectFirst));
  });

  it("the collection does not start when storage says done, and never runs twice at once", async () => {
    const threads = threeThreads();
    const { counter, kv } = setup(threads);
    await Promise.all([counter.backfill(), counter.backfill()]);
    expect(threads.listCalls).toHaveLength(1);
    const again = setup(threads, kv);
    await again.counter.backfill();
    expect(threads.listCalls).toHaveLength(1);
  });

  it("a reload mid-collection ends with the same buckets", async () => {
    const threads = threeThreads();
    const first = setup(threads);
    // The first load reads one thread, then the plugin reloads.
    await first.counter.onIdle("thr_a");
    first.counter.dispose();
    const second = setup(threads, first.kv);
    await second.counter.backfill();
    const clean = setup(threeThreads());
    await clean.counter.backfill();
    expect((await second.storage.tokenState()).hours).toEqual((await clean.storage.tokenState()).hours);
  });

  it("a failing get, events read or KV write is caught, logged by class, and leaves the state intact", async () => {
    const threads = threeThreads();
    const { counter, view, logs, kv } = setup(threads);
    await counter.onIdle("thr_b");
    const before = await view("thr_b");

    threads.tokenEvent("thr_b", NOW, total(9_000, 4_000));
    threads.eventErrors.add("thr_b");
    await expect(counter.onIdle("thr_b")).resolves.toBeUndefined();
    threads.eventErrors.clear();

    const get = threads.get.bind(threads);
    threads.get = async () => {
      throw new TypeError("thread text");
    };
    await counter.onIdle("thr_b");
    threads.get = get;

    const set = kv.set.bind(kv);
    kv.set = async () => {
      throw new RangeError("kv full");
    };
    await counter.onIdle("thr_b");
    kv.set = set;

    expect(await view("thr_b")).toEqual(before);
    expect(logs.filter((l) => l.startsWith("warn"))).toEqual([
      "warn token count failed for thr_b: Error",
      "warn token count failed for thr_b: TypeError",
      "warn token count failed for thr_b: RangeError",
    ]);
    // The next idle counts the growth once.
    await counter.onIdle("thr_b");
    expect((await view("thr_b")).thread).toEqual({ work: 5_000, all: 9_000 });
  });

  it("a failing listing stops the collection without recording completion", async () => {
    const threads = threeThreads();
    threads.listError = new Error("down");
    const { counter, storage, logs } = setup(threads);
    await counter.backfill();
    expect((await storage.tokenState()).backfill.done).toBe(false);
    expect(logs).toContain("warn token collection stopped: Error");
  });

  it("a thread without a provider or without events is skipped quietly", async () => {
    const threads = new FakeThreads();
    threads.thread("thr_c", "acp-hera", null);
    const { counter, view, logs } = setup(threads);
    await counter.onIdle("thr_c");
    await counter.onIdle("thr_unknown");
    expect(await view("thr_c")).toEqual({ thread: null, providers: [], backfillDone: false });
    expect(logs).toEqual([]);
  });

  it("invalidates at most once per 10 seconds during the collection, and once at the end", async () => {
    const threads = new FakeThreads();
    for (let i = 0; i < 5; i++) {
      threads.thread(`thr_${i}`, "codex", null).tokenEvent(`thr_${i}`, NOW - HOUR_MS, total(100));
    }
    const { counter, invalidations } = setup(threads);
    await counter.backfill();
    // One at the first counted thread (clock fixed), one at completion.
    expect(invalidations()).toBe(2);
  });

  it("stores thread ids, provider ids and numbers only", async () => {
    const { counter, kv } = setup(threeThreads());
    await counter.backfill();
    const stored = JSON.stringify([await kv.get("tokens:hours"), await kv.get("tokens:threads")]);
    expect(stored).not.toMatch(/secret|text|@/);
    expect(Object.keys(JSON.parse(stored)[1].threads.thr_a).sort()).toEqual(["all", "providerId", "seq", "sumAll", "sumWork", "updatedAt", "work"]);
  });
});
