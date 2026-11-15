// Auto-compact on `thread.idle` and the manual compact of the RPC and CLI.
//
// Order on idle: policy (settings + thread override), cooldown, busy state,
// unsupported mark (24 h; skips the thread unless summary and clear is on), context fill against the effective threshold, a recheck
// that the thread is still idle, then `threads.compact`. The compact only
// queues a `/compact` turn, so the after-fill is read on the thread's next
// idle (or after AFTER_WAIT_MS), with one more read when the host has no
// measurement yet. An unknown after-fill leaves the cooldown normal; a known
// fill that did not drop doubles it.
//
// The effective threshold is capped below the provider's own compaction
// point; see `effectiveThreshold` in threads.ts.
//
// A provider that cannot compact (its compact fails as unsupported, e.g. the
// Hermes ACP agents) gets summary and clear when `summaryClearEnabled` is on:
// the plugin asks the agent for a summary, waits for that turn, checks the
// answer is one, clears the context (`threads.clearContext`; the history
// stays visible) and sends the summary back as the next turn. Nothing is
// cleared without a summary, and a turn the user starts meanwhile cancels it.

import { type CompactLogEntry, type CompactMethod, type CompactResult, type ThreadContext } from "../shared/contract";
import { STRINGS } from "../app/i18n";
import { readSummary } from "../shared/summary";
import type { Storage } from "./storage";
import {
  effectivePolicy,
  effectiveThreshold,
  measureThread,
  parseOverride,
  readThreadInfo,
  type PluginSettings,
  type ThreadsSdk,
} from "./threads";
import { cleanMessage } from "./messages";

export const COOLDOWN_MS = 10 * 60_000;
export const AFTER_WAIT_MS = 2 * 60_000;
export const AFTER_RETRY_MS = 5_000;
/** How long the agent may take to write the summary before the plugin gives up. */
export const SUMMARY_WAIT_MS = 10 * 60_000;

export const SUMMARY_STARTED = "Asking the agent for a summary; the context is cleared after it answers";

export function isUnsupportedError(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /not supported|unsupported|does not support/i.test(text);
}

export interface AutoCompactDeps {
  threads: ThreadsSdk;
  storage: Storage;
  settings: () => Promise<PluginSettings>;
  /** Called after a log entry or cooldown changes, with the thread id. */
  invalidate: (threadId: string) => void;
  log: { info(message: string): void; warn(message: string): void };
  now?: () => number;
}

interface Waiter {
  /** `activity` of the thread when the waiter was added; only a later idle wakes it. */
  generation: number;
  /** True on the thread's idle, false on the timeout or dispose. */
  resolve: (idle: boolean) => void;
}

/** A pending wait for the end of a turn; see `idleAfter`. */
interface IdleWait {
  promise: Promise<boolean>;
  cancel: () => void;
}

export class AutoCompactor {
  private readonly now: () => number;
  /** Threads with a check, compact, or summary and clear in progress. */
  private readonly busy = new Set<string>();
  /** Bumped on every `thread.active`; a change cancels a pending compact. */
  private readonly activity = new Map<string, number>();
  private readonly idleWaiters = new Map<string, Waiter[]>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly followUps = new Set<Promise<void>>();
  /** Threads with summary and clear running; busy like `busy`, but past the caller's return. */
  private readonly summaries = new Set<string>();
  private disposed = false;

  constructor(private readonly deps: AutoCompactDeps) {
    this.now = deps.now ?? Date.now;
  }

  private isBusy(threadId: string): boolean {
    return this.busy.has(threadId) || this.summaries.has(threadId);
  }

  onActive(threadId: string): void {
    this.activity.set(threadId, (this.activity.get(threadId) ?? 0) + 1);
  }

  /** `thread.idle` handler. Never throws: failures are logged. */
  async onIdle(threadId: string): Promise<void> {
    this.wakeIdleWaiters(threadId);
    if (this.disposed || this.isBusy(threadId)) return;
    this.busy.add(threadId);
    try {
      await this.checkIdle(threadId);
    } catch (cause) {
      this.deps.log.warn(`auto-compact check failed for ${threadId}: ${cleanMessage(cause)}`);
    } finally {
      this.busy.delete(threadId);
    }
  }

  private async checkIdle(threadId: string): Promise<void> {
    const { threads, storage } = this.deps;
    const [settings, metadata] = await Promise.all([this.deps.settings(), threads.getPluginMetadata({ threadId })]);
    const override = parseOverride(metadata);
    const policy = effectivePolicy(override, settings);
    if (!policy.enabled) return;

    const cooldown = await storage.cooldownUntil(threadId);
    if (cooldown !== null && cooldown > this.now()) return;

    const generation = this.activity.get(threadId) ?? 0;
    const info = readThreadInfo(await threads.get({ threadId }));
    if (info.active) return;
    const unsupported = info.providerId !== null && (await storage.unsupportedProviders(this.now())).includes(info.providerId);
    if (unsupported && !settings.summaryClearEnabled) return;

    const context = await measureThread(storage, await threads.context({ threadId }), info.providerId, override, settings, this.now());
    if (context === null) return;
    if (context.percent < effectiveThreshold(policy.thresholdPercent, context)) return;

    // The agent may have started answering while the context was read.
    const again = readThreadInfo(await threads.get({ threadId }));
    if (again.active || (this.activity.get(threadId) ?? 0) !== generation) {
      await this.record({
        threadId,
        providerId: info.providerId,
        trigger: "auto",
        before: context,
        result: "cancelled",
        message: "The agent started answering",
        method: unsupported ? "summary" : "compact",
      });
      return;
    }

    if (unsupported) this.startSummary(threadId, info.providerId, context, "auto");
    else await this.compactNow(threadId, info.providerId, context, "auto", settings.summaryClearEnabled);
  }

  /** Manual compact from the RPC or CLI. */
  async manual(threadId: string): Promise<CompactResult> {
    if (this.isBusy(threadId)) return { ok: false, message: "A compact of this thread is already running", entry: null };
    this.busy.add(threadId);
    try {
      const { threads, storage } = this.deps;
      const info = readThreadInfo(await threads.get({ threadId }));
      if (info.active) return { ok: false, message: "The agent is answering; try again when it is idle", entry: null };
      const [context, settings] = await Promise.all([this.measure(threadId, info.providerId), this.deps.settings()]);
      const unsupported = info.providerId !== null && (await storage.unsupportedProviders(this.now())).includes(info.providerId);
      // A marked provider is tried again without the fallback: a compact that now works lifts the mark.
      if (unsupported && settings.summaryClearEnabled) {
        this.startSummary(threadId, info.providerId, context, "manual");
        return { ok: true, message: SUMMARY_STARTED, entry: null };
      }
      const entry = await this.compactNow(threadId, info.providerId, context, "manual", settings.summaryClearEnabled);
      if (entry === null) return { ok: true, message: SUMMARY_STARTED, entry: null };
      return { ok: entry.result === "compacted", message: entry.message, entry };
    } finally {
      this.busy.delete(threadId);
    }
  }

  /**
   * `threads.compact`, then the after-fill in the background. With
   * `fallback`, a compact that fails as unsupported starts summary and clear
   * instead and returns null.
   */
  private async compactNow(
    threadId: string,
    providerId: string | null,
    before: ThreadContext | null,
    trigger: CompactLogEntry["trigger"],
    fallback: boolean,
  ): Promise<CompactLogEntry | null> {
    const { threads, storage } = this.deps;
    const waitForIdle = this.idleAfter(threadId, AFTER_WAIT_MS);
    try {
      await threads.compact({ threadId });
    } catch (cause) {
      waitForIdle.cancel();
      const unsupported = isUnsupportedError(cause);
      if (unsupported && providerId !== null) await storage.markUnsupported(providerId, this.now());
      if (unsupported && fallback) {
        this.startSummary(threadId, providerId, before, trigger);
        return null;
      }
      // A failed compact still waits out a cooldown so idle events do not retry it every turn.
      if (!unsupported) await storage.setCooldownUntil(threadId, this.now() + COOLDOWN_MS);
      return this.record({ threadId, providerId, trigger, before, result: unsupported ? "unsupported" : "failed", message: cleanMessage(cause) });
    }

    await storage.setCooldownUntil(threadId, this.now() + COOLDOWN_MS);
    // A manual compact can run on a marked provider; its success lifts the mark.
    if (providerId !== null) await storage.clearUnsupported(providerId);
    const entry = await this.record({ threadId, providerId, trigger, before, result: "compacted", message: null });
    this.deps.log.info(`compacted ${threadId} (${trigger}) at ${before ? before.percent.toFixed(0) : "?"}%`);
    this.track(this.finishAfter(entry, waitForIdle.promise));
    return entry;
  }

  /**
   * Summary and clear in the background. The thread stays busy until the
   * summary is back in the thread, so its idle events start no other check.
   */
  private startSummary(threadId: string, providerId: string | null, before: ThreadContext | null, trigger: CompactLogEntry["trigger"]): void {
    // The caller's `busy` mark ends when it returns; this one holds until the run ends.
    this.summaries.add(threadId);
    const run = this.summarizeAndClear(threadId, providerId, before, trigger)
      .catch((cause) => this.deps.log.warn(`summary and clear failed for ${threadId}: ${cleanMessage(cause)}`))
      .finally(() => this.summaries.delete(threadId));
    this.track(run);
  }

  private async summarizeAndClear(
    threadId: string,
    providerId: string | null,
    before: ThreadContext | null,
    trigger: CompactLogEntry["trigger"],
  ): Promise<void> {
    const { threads, storage } = this.deps;
    const strings = STRINGS[(await this.deps.settings()).language];
    const fail = async (result: CompactLogEntry["result"], message: string) => {
      // A failed attempt waits out a cooldown so idle events do not retry it every turn.
      if (result === "failed") await storage.setCooldownUntil(threadId, this.now() + COOLDOWN_MS);
      await this.record({ threadId, providerId, trigger, before, result, message, method: "summary" });
    };

    // 1. Ask for the summary and wait for that turn to end.
    const summaryTurn = this.idleAfter(threadId, SUMMARY_WAIT_MS);
    try {
      await threads.send({ threadId, input: [{ type: "text", text: strings.summaryRequest }], mode: "start" });
    } catch (cause) {
      summaryTurn.cancel();
      return fail("failed", `Could not ask for a summary: ${cleanMessage(cause)}`);
    }
    const ended = await summaryTurn.promise;
    if (this.disposed) return;
    if (!ended) return fail("failed", `No summary within ${SUMMARY_WAIT_MS / 60_000} min; the context was not cleared`);

    // 2. The turn must have ended cleanly with a summary, and nothing new may have started.
    const generation = this.activity.get(threadId) ?? 0;
    const info = readThreadInfo(await threads.get({ threadId }));
    if (info.active) return fail("cancelled", "The agent started answering; the context was not cleared");
    if (info.failed) return fail("failed", "The summary turn failed; the context was not cleared");
    const summary = readSummary(await threads.output({ threadId }));
    if (summary === null) return fail("failed", "The agent's answer is not a summary; the context was not cleared");
    if ((this.activity.get(threadId) ?? 0) !== generation) {
      return fail("cancelled", "The agent started answering; the context was not cleared");
    }

    // 3. Clear. The host refuses when the thread is no longer idle.
    try {
      await threads.clearContext({ threadId });
    } catch (cause) {
      return fail("failed", `Could not clear the context: ${cleanMessage(cause)}`);
    }

    // 4. Send the summary back; one retry, as the context is already gone.
    const restoreTurn = this.idleAfter(threadId, AFTER_WAIT_MS);
    const restore = { threadId, input: [{ type: "text" as const, text: strings.summaryRestore(summary) }], mode: "queue-if-active" as const };
    try {
      await threads.send(restore);
    } catch {
      await this.sleep(AFTER_RETRY_MS);
      try {
        if (this.disposed) throw new Error("the plugin was stopped");
        await threads.send(restore);
      } catch (cause) {
        restoreTurn.cancel();
        this.deps.log.warn(`cleared ${threadId} but could not send the summary back: ${cleanMessage(cause)}`);
        return fail(
          "failed",
          `The context was cleared but the summary could not be sent back (${cleanMessage(cause)}); it is the agent's last answer in the thread history`,
        );
      }
    }

    await storage.setCooldownUntil(threadId, this.now() + COOLDOWN_MS);
    const entry = await this.record({ threadId, providerId, trigger, before, result: "compacted", message: null, method: "summary" });
    this.deps.log.info(`summarised and cleared ${threadId} (${trigger}) at ${before ? before.percent.toFixed(0) : "?"}%`);
    await this.finishAfter(entry, restoreTurn.promise);
  }

  /** The thread's context against its working limit (override, settings, provider). */
  private async measure(threadId: string, providerId: string | null): Promise<ThreadContext | null> {
    const { threads, storage } = this.deps;
    const [settings, metadata, answer] = await Promise.all([
      this.deps.settings(),
      threads.getPluginMetadata({ threadId }),
      threads.context({ threadId }),
    ]);
    return measureThread(storage, answer, providerId, parseOverride(metadata), settings, this.now());
  }

  /** Reads the after-fill once the compact turn is over and updates the log and cooldown. */
  private async finishAfter(entry: CompactLogEntry, idle: Promise<boolean>): Promise<void> {
    const { threads, storage } = this.deps;
    try {
      await idle;
      if (this.disposed) return;
      let after = await this.measure(entry.threadId, entry.providerId);
      if (after === null) {
        await this.sleep(AFTER_RETRY_MS);
        if (this.disposed) return;
        after = await this.measure(entry.threadId, entry.providerId);
      }
      if (after === null) return; // Unknown: the entry keeps a null after-fill, the cooldown stays.
      await storage.updateLog(entry.threadId, entry.at, { afterPercent: after.percent });
      if (entry.beforePercent !== null && after.percent >= entry.beforePercent) {
        await storage.setCooldownUntil(entry.threadId, entry.at + 2 * COOLDOWN_MS);
      }
      this.deps.invalidate(entry.threadId);
    } catch (cause) {
      this.deps.log.warn(`could not read the fill after compacting ${entry.threadId}: ${cleanMessage(cause)}`);
    }
  }

  private async record(args: {
    threadId: string;
    providerId: string | null;
    trigger: CompactLogEntry["trigger"];
    before: ThreadContext | null;
    result: CompactLogEntry["result"];
    message: string | null;
    method?: CompactMethod;
  }): Promise<CompactLogEntry> {
    const entry: CompactLogEntry = {
      threadId: args.threadId,
      providerId: args.providerId,
      at: this.now(),
      trigger: args.trigger,
      beforePercent: args.before?.percent ?? null,
      afterPercent: null,
      result: args.result,
      message: args.message,
      method: args.method ?? "compact",
    };
    await this.deps.storage.prependLog(entry);
    this.deps.invalidate(args.threadId);
    return entry;
  }

  /**
   * Resolves true on the thread's next idle after a `thread.active`, false
   * after `ms` or on dispose. Register before starting the turn.
   */
  private idleAfter(threadId: string, ms: number): IdleWait {
    let waiter!: Waiter;
    const promise = new Promise<boolean>((resolve) => {
      waiter = { generation: this.activity.get(threadId) ?? 0, resolve };
    });
    const list = this.idleWaiters.get(threadId) ?? [];
    list.push(waiter);
    this.idleWaiters.set(threadId, list);
    const timer = this.timer(ms, () => this.removeWaiter(threadId, waiter));
    const done = (idle: boolean) => {
      clearTimeout(timer);
      this.timers.delete(timer);
      return idle;
    };
    return {
      promise: promise.then(done),
      cancel: () => {
        done(false);
        this.removeWaiter(threadId, waiter, false);
      },
    };
  }

  private removeWaiter(threadId: string, waiter: Waiter, resolve = true): void {
    const list = this.idleWaiters.get(threadId)?.filter((w) => w !== waiter) ?? [];
    if (list.length) this.idleWaiters.set(threadId, list);
    else this.idleWaiters.delete(threadId);
    if (resolve) waiter.resolve(false);
  }

  private wakeIdleWaiters(threadId: string): void {
    const list = this.idleWaiters.get(threadId);
    if (!list) return;
    // An idle with no `thread.active` since the compact is not the end of the compact turn.
    const generation = this.activity.get(threadId) ?? 0;
    const woken = list.filter((w) => generation > w.generation);
    const rest = list.filter((w) => generation <= w.generation);
    if (rest.length) this.idleWaiters.set(threadId, rest);
    else this.idleWaiters.delete(threadId);
    for (const w of woken) w.resolve(true);
  }

  private timer(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.timer(ms, resolve));
  }

  private track(work: Promise<void>): void {
    this.followUps.add(work);
    void work.finally(() => this.followUps.delete(work));
  }

  /** For tests: resolves when every after-fill read has finished. */
  async settled(): Promise<void> {
    while (this.followUps.size) await Promise.all([...this.followUps]);
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const list of this.idleWaiters.values()) for (const w of list) w.resolve(false);
    this.idleWaiters.clear();
  }
}
