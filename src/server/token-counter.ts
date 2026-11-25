// Token totals on the server: one writer over `tokens:hours` and
// `tokens:threads`. Live reads come from `thread.idle`; the first collection
// walks every thread once. Both go through one promise chain, so a
// read-modify-write never interleaves with another. Every failure is caught
// and logged with the thread id and the error class only (R12, R13).

import { applyEvents, sumSince, tokenEventFromRow, type TokenEvent, type TokenPair, type TokenState } from "../shared/tokens";
import { MAX_VALUE_BYTES, type Storage } from "./storage";
import { readThreadInfo, type ThreadsSdk } from "./threads";

const TOKEN_TYPES: ["thread/tokenUsage/updated"] = ["thread/tokenUsage/updated"];
/** The host's cap for `threads.events.list`. */
const EVENTS_PAGE = 100;
const LIST_PAGE = 200;
/** Pause between threads of the first collection. */
export const BACKFILL_PAUSE_MS = 50;
/** During the first collection the app is told at most this often. */
const BACKFILL_INVALIDATE_MS = 10_000;

interface TokenCounterDeps {
  threads: Pick<ThreadsSdk, "get" | "list" | "events">;
  storage: Pick<Storage, "tokenState" | "setTokenHours" | "setTokenThreads">;
  /** Called after a write that grew a bucket (throttled during the first collection). */
  invalidate: () => void;
  log: { info(message: string): void; warn(message: string): void };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TokenView {
  thread: TokenPair | null;
  providers: Array<{ providerId: string; today: TokenPair; month: TokenPair }>;
  backfillDone: boolean;
}

export interface TokenThreadRow extends TokenPair {
  threadId: string;
  providerId: string;
  updatedAt: number;
}

/** The error's class name, never its message: messages can quote thread text. */
function errorClass(cause: unknown): string {
  if (cause instanceof Error) return cause.name || "Error";
  return typeof cause;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function createdAtOf(thread: unknown): number | null {
  const value = (thread as { createdAt?: unknown } | null)?.createdAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export class TokenCounter {
  private state: TokenState | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private backfilling = false;
  private lastInvalidateAt = -Infinity;
  private pendingInvalidate = false;
  private disposed = false;

  constructor(private readonly deps: TokenCounterDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Runs `task` after every earlier one; its failure does not break the chain. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async loaded(): Promise<TokenState> {
    if (this.state === null) this.state = await this.deps.storage.tokenState();
    return this.state;
  }

  dispose(): void {
    this.disposed = true;
  }

  /** `thread.idle` handler. Never throws. */
  async onIdle(threadId: string): Promise<void> {
    try {
      const counted = await this.serial(() => this.ingestThread(threadId, null));
      if (counted) this.notify();
    } catch (cause) {
      this.deps.log.warn(`token count failed for ${threadId}: ${errorClass(cause)}`);
    }
  }

  /**
   * Reads a thread's token-usage events and applies them. A thread in the
   * table needs only its newest event; a new one is paged through in full.
   * `listed` is the thread as `threads.list` gave it, which saves a `get`.
   * Returns true when a bucket grew.
   */
  private async ingestThread(threadId: string, listed: unknown): Promise<boolean> {
    const state = await this.loaded();
    const info = listed ?? (await this.deps.threads.get({ threadId }));
    const { providerId } = readThreadInfo(info);
    if (providerId === null) return false;
    const known = Object.hasOwn(state.threads, threadId);
    const rows = known ? await this.newestRow(threadId) : await this.allRows(threadId);
    const events = rows.map(tokenEventFromRow).filter((e): e is TokenEvent => e !== null);
    if (events.length === 0) return false;
    const { state: next, counted } = applyEvents(state, { threadId, providerId, createdAt: createdAtOf(info) }, events, this.now(), MAX_VALUE_BYTES);
    await this.write(state, next);
    return counted;
  }

  private async newestRow(threadId: string): Promise<unknown[]> {
    const page = await this.deps.threads.events({ threadId, types: TOKEN_TYPES, order: "desc", limit: "1" });
    return Array.isArray(page) ? page : [];
  }

  private async allRows(threadId: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    let afterSeq: string | undefined;
    for (;;) {
      const page = await this.deps.threads.events({
        threadId,
        types: TOKEN_TYPES,
        order: "asc",
        limit: String(EVENTS_PAGE),
        ...(afterSeq === undefined ? {} : { afterSeq }),
      });
      if (!Array.isArray(page) || page.length === 0) break;
      rows.push(...page);
      const last = (page.at(-1) as { seq?: unknown }).seq;
      if (page.length < EVENTS_PAGE || typeof last !== "number") break;
      afterSeq = String(last);
    }
    return rows;
  }

  /**
   * Writes the parts that changed; the in-memory state moves only after both
   * writes succeed, so a failure is retried from the old state. The threads
   * go first: a reload between the two writes then undercounts, never counts
   * twice.
   */
  private async write(before: TokenState, next: TokenState): Promise<void> {
    if (next === before) return;
    await this.deps.storage.setTokenThreads(next);
    if (next.hours !== before.hours) await this.deps.storage.setTokenHours(next.hours);
    this.state = next;
  }

  private notify(): void {
    if (!this.backfilling) {
      this.deps.invalidate();
      return;
    }
    const now = this.now();
    if (now - this.lastInvalidateAt >= BACKFILL_INVALIDATE_MS) {
      this.lastInvalidateAt = now;
      this.pendingInvalidate = false;
      this.deps.invalidate();
    } else {
      this.pendingInvalidate = true;
    }
  }

  /**
   * R5: the first collection, once. Walks every thread (archived and hidden
   * included), one at a time; a thread that fails is skipped and counted.
   * Never throws and never runs twice at once.
   */
  async backfill(): Promise<void> {
    if (this.backfilling) return;
    this.backfilling = true;
    try {
      const start = await this.serial(async () => {
        const state = await this.loaded();
        if (state.backfill.done) return false;
        // A reload before completion starts again; R2 keeps the result the same.
        await this.write(state, { ...state, backfill: { done: false, threadsRead: 0, threadsFailed: 0, startedAt: this.now() } });
        return true;
      });
      if (!start) return;
      const listed = await this.listAll();
      let read = 0;
      let failed = 0;
      let counted = false;
      for (const thread of listed) {
        if (this.disposed) return;
        const threadId = (thread as { id: string }).id;
        try {
          if (await this.serial(() => this.ingestThread(threadId, thread))) {
            counted = true;
            this.notify();
          }
          read++;
        } catch (cause) {
          failed++;
          this.deps.log.warn(`token collection skipped ${threadId}: ${errorClass(cause)}`);
        }
        await this.serial(async () => {
          const state = await this.loaded();
          await this.write(state, { ...state, backfill: { ...state.backfill, threadsRead: read, threadsFailed: failed } });
        });
        await (this.deps.sleep ?? sleepFor)(BACKFILL_PAUSE_MS);
      }
      await this.serial(async () => {
        const state = await this.loaded();
        await this.write(state, { ...state, backfill: { ...state.backfill, done: true, threadsRead: read, threadsFailed: failed } });
      });
      this.deps.log.info(`token collection done: ${read} threads read, ${failed} failed`);
      this.backfilling = false;
      if (counted || this.pendingInvalidate) this.deps.invalidate();
      this.pendingInvalidate = false;
    } catch (cause) {
      this.deps.log.warn(`token collection stopped: ${errorClass(cause)}`);
    } finally {
      this.backfilling = false;
    }
  }

  private async listAll(): Promise<unknown[]> {
    const all: unknown[] = [];
    const seen = new Set<string>();
    for (let offset = 0; ; offset += LIST_PAGE) {
      const page = await this.deps.threads.list({ includeHidden: true, limit: LIST_PAGE, offset });
      if (!Array.isArray(page)) break;
      for (const thread of page) {
        const id = (thread as { id?: unknown } | null)?.id;
        if (typeof id !== "string" || id === "" || seen.has(id)) continue;
        seen.add(id);
        all.push(thread);
      }
      if (page.length < LIST_PAGE) break;
    }
    return all;
  }

  /** R7: the thread's lifetime totals and each provider's sums from the given starts. */
  async view(threadId: string | null, dayStart: number, monthStart: number): Promise<TokenView> {
    const state = await this.serial(() => this.loaded());
    const entry = threadId === null ? undefined : state.threads[threadId];
    const providers = Object.keys(state.hours)
      .sort()
      .map((providerId) => ({
        providerId,
        today: sumSince(state.hours, providerId, dayStart),
        month: sumSince(state.hours, providerId, monthStart),
      }))
      .filter((p) => p.month.all > 0 || p.month.work > 0 || p.today.all > 0);
    return {
      thread: entry === undefined ? null : { work: entry.sumWork, all: entry.sumAll },
      providers,
      backfillDone: state.backfill.done,
    };
  }

  /** The most recently updated threads, newest first. */
  async recentThreads(limit: number): Promise<TokenThreadRow[]> {
    const state = await this.serial(() => this.loaded());
    return Object.entries(state.threads)
      .map(([threadId, e]) => ({ threadId, providerId: e.providerId, work: e.sumWork, all: e.sumAll, updatedAt: e.updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  async backfillState(): Promise<TokenState["backfill"]> {
    return (await this.serial(() => this.loaded())).backfill;
  }
}
