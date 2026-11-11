// Auto-compact on `thread.idle` and the manual compact of the RPC and CLI.
//
// Order on idle: policy (settings + thread override), cooldown, busy state,
// unsupported mark (24 h), context fill against the effective threshold, a recheck
// that the thread is still idle, then `threads.compact`. The compact only
// queues a `/compact` turn, so the after-fill is read on the thread's next
// idle (or after AFTER_WAIT_MS), with one more read when the host has no
// measurement yet. An unknown after-fill leaves the cooldown normal; a known
// fill that did not drop doubles it.
//
// The effective threshold is capped below the provider's own compaction
// point; see `effectiveThreshold` in threads.ts.

import { type CompactLogEntry, type CompactResult, type ThreadContext } from "../shared/contract";
import type { Storage } from "./storage";
import {
  contextLimitOf,
  effectivePolicy,
  effectiveThreshold,
  parseOverride,
  readContext,
  readThreadInfo,
  type PluginSettings,
  type ThreadsSdk,
} from "./threads";
import { cleanMessage } from "./messages";

export const COOLDOWN_MS = 10 * 60_000;
export const AFTER_WAIT_MS = 2 * 60_000;
export const AFTER_RETRY_MS = 5_000;

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
  resolve: () => void;
}

export class AutoCompactor {
  private readonly now: () => number;
  /** Threads with a check or compact in progress. */
  private readonly busy = new Set<string>();
  /** Bumped on every `thread.active`; a change cancels a pending compact. */
  private readonly activity = new Map<string, number>();
  private readonly idleWaiters = new Map<string, Waiter[]>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly followUps = new Set<Promise<void>>();
  private disposed = false;

  constructor(private readonly deps: AutoCompactDeps) {
    this.now = deps.now ?? Date.now;
  }

  onActive(threadId: string): void {
    this.activity.set(threadId, (this.activity.get(threadId) ?? 0) + 1);
  }

  /** `thread.idle` handler. Never throws: failures are logged. */
  async onIdle(threadId: string): Promise<void> {
    this.wakeIdleWaiters(threadId);
    if (this.disposed || this.busy.has(threadId)) return;
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
    const limit = contextLimitOf(override, settings);

    const cooldown = await storage.cooldownUntil(threadId);
    if (cooldown !== null && cooldown > this.now()) return;

    const generation = this.activity.get(threadId) ?? 0;
    const info = readThreadInfo(await threads.get({ threadId }));
    if (info.active) return;
    if (info.providerId !== null && (await storage.unsupportedProviders(this.now())).includes(info.providerId)) return;

    const context = readContext(await threads.context({ threadId }), limit);
    if (context === null) return;
    if (context.percent < effectiveThreshold(policy.thresholdPercent, context)) return;

    // The agent may have started answering while the context was read.
    const again = readThreadInfo(await threads.get({ threadId }));
    if (again.active || (this.activity.get(threadId) ?? 0) !== generation) {
      await this.record({ threadId, providerId: info.providerId, trigger: "auto", before: context, result: "cancelled", message: "The agent started answering" });
      return;
    }

    await this.compactNow(threadId, info.providerId, context, "auto");
  }

  /** Manual compact from the RPC or CLI. */
  async manual(threadId: string): Promise<CompactResult> {
    if (this.busy.has(threadId)) return { ok: false, message: "A compact of this thread is already running", entry: null };
    this.busy.add(threadId);
    try {
      const { threads } = this.deps;
      const info = readThreadInfo(await threads.get({ threadId }));
      if (info.active) return { ok: false, message: "The agent is answering; try again when it is idle", entry: null };
      const context = readContext(await threads.context({ threadId }), await this.limitOf(threadId));
      const entry = await this.compactNow(threadId, info.providerId, context, "manual");
      return { ok: entry.result === "compacted", message: entry.message, entry };
    } finally {
      this.busy.delete(threadId);
    }
  }

  private async compactNow(
    threadId: string,
    providerId: string | null,
    before: ThreadContext | null,
    trigger: CompactLogEntry["trigger"],
  ): Promise<CompactLogEntry> {
    const { threads, storage } = this.deps;
    const waitForIdle = this.idleAfter(threadId);
    try {
      await threads.compact({ threadId });
    } catch (cause) {
      waitForIdle.cancel();
      const unsupported = isUnsupportedError(cause);
      if (unsupported && providerId !== null) await storage.markUnsupported(providerId, this.now());
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

  /** The thread's working limit: its override or the settings. */
  private async limitOf(threadId: string) {
    const [settings, metadata] = await Promise.all([this.deps.settings(), this.deps.threads.getPluginMetadata({ threadId })]);
    return contextLimitOf(parseOverride(metadata), settings);
  }

  /** Reads the after-fill once the compact turn is over and updates the log and cooldown. */
  private async finishAfter(entry: CompactLogEntry, idle: Promise<void>): Promise<void> {
    const { threads, storage } = this.deps;
    try {
      await idle;
      if (this.disposed) return;
      const limit = await this.limitOf(entry.threadId);
      let after = readContext(await threads.context({ threadId: entry.threadId }), limit);
      if (after === null) {
        await this.sleep(AFTER_RETRY_MS);
        if (this.disposed) return;
        after = readContext(await threads.context({ threadId: entry.threadId }), limit);
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
    };
    await this.deps.storage.prependLog(entry);
    this.deps.invalidate(args.threadId);
    return entry;
  }

  /** Resolves on the thread's next idle, or after AFTER_WAIT_MS. Register before compacting. */
  private idleAfter(threadId: string): { promise: Promise<void>; cancel: () => void } {
    let waiter!: Waiter;
    const promise = new Promise<void>((resolve) => {
      waiter = { generation: this.activity.get(threadId) ?? 0, resolve };
    });
    const list = this.idleWaiters.get(threadId) ?? [];
    list.push(waiter);
    this.idleWaiters.set(threadId, list);
    const timer = this.timer(AFTER_WAIT_MS, () => this.removeWaiter(threadId, waiter));
    const done = () => {
      clearTimeout(timer);
      this.timers.delete(timer);
    };
    return {
      promise: promise.then(done),
      cancel: () => {
        done();
        this.removeWaiter(threadId, waiter, false);
      },
    };
  }

  private removeWaiter(threadId: string, waiter: Waiter, resolve = true): void {
    const list = this.idleWaiters.get(threadId)?.filter((w) => w !== waiter) ?? [];
    if (list.length) this.idleWaiters.set(threadId, list);
    else this.idleWaiters.delete(threadId);
    if (resolve) waiter.resolve();
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
    for (const w of woken) w.resolve();
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
    for (const list of this.idleWaiters.values()) for (const w of list) w.resolve();
    this.idleWaiters.clear();
  }
}
