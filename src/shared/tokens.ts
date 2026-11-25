// Token totals from BB's `thread/tokenUsage/updated` thread events: the pure
// core shared by the server counter, the RPC, the CLI and the app. No SDK
// import. Host facts behind the rules are in AGENTS.md «Token usage».
//
// Each event carries a cumulative `total`. The counter remembers the last
// total it saw per thread and adds the growth to the hour (UTC) the event was
// written in, under the thread's provider. bb keeps only a thread's newest
// event and Claude Code's total restarts with each provider runtime run, so a
// total below the remembered one is a fresh counter and counts in full.

import type { Lang } from "./language";
import { DAY_MS, HOUR_MS } from "./windows";

/** Hourly buckets and thread entries older than this are dropped. */
export const TOKEN_RETENTION_MS = 40 * DAY_MS;
/** Byte bound for each stored token value; the host's limit is 256 KB. */
const TOKEN_VALUE_BYTES = 200 * 1024;

/** `work` leaves cache reads out; `all` is the provider's `totalTokens`. */
export interface TokenPair {
  work: number;
  all: number;
}

/** `[hourStartMs, work, all]` for one provider and one UTC hour. */
export type HourEntry = [number, number, number];

export interface ThreadEntry {
  providerId: string;
  /** The remembered cumulative values of the thread's newest applied event. */
  work: number;
  all: number;
  /** The thread's own totals: the sum of every growth applied, bucketed or not. */
  sumWork: number;
  sumAll: number;
  /** Epoch ms the newest applied event was written. */
  updatedAt: number;
  /** Sequence number of that event; events at or below it are skipped. */
  seq: number;
}

interface BackfillState {
  done: boolean;
  threadsRead: number;
  threadsFailed: number;
  startedAt: number | null;
}

export interface TokenState {
  /** Keyed by provider id; entries ascending by hour. */
  hours: Record<string, HourEntry[]>;
  threads: Record<string, ThreadEntry>;
  backfill: BackfillState;
  /** The latest `updatedAt` among threads dropped from the table; null before any drop. */
  evictedBefore: number | null;
}

export function emptyTokenState(): TokenState {
  return {
    hours: {},
    threads: {},
    backfill: { done: false, threadsRead: 0, threadsFailed: 0, startedAt: null },
    evictedBefore: null,
  };
}

/** One token-usage event reduced to what the counter needs. */
export interface TokenEvent extends TokenPair {
  seq: number;
  /** Epoch ms the event was written. */
  at: number;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * R1: `all` = `totalTokens`; `work` = `totalTokens` minus
 * `cacheReadInputTokens` (or `cachedInputTokens` when that is absent), never
 * below 0. Null for a total without a usable `totalTokens`.
 */
export function tokenTotals(total: unknown): TokenPair | null {
  if (typeof total !== "object" || total === null) return null;
  const t = total as Record<string, unknown>;
  if (!isCount(t.totalTokens)) return null;
  const cacheRead = isCount(t.cacheReadInputTokens) ? t.cacheReadInputTokens : isCount(t.cachedInputTokens) ? t.cachedInputTokens : 0;
  return { work: Math.max(0, t.totalTokens - cacheRead), all: t.totalTokens };
}

/** A `threads.events.list` row of type `thread/tokenUsage/updated`, or null. */
export function tokenEventFromRow(row: unknown): TokenEvent | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as { seq?: unknown; createdAt?: unknown; data?: { tokenUsage?: { total?: unknown } } };
  if (typeof r.seq !== "number" || !Number.isFinite(r.seq) || typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt)) return null;
  const totals = tokenTotals(r.data?.tokenUsage?.total);
  return totals === null ? null : { seq: r.seq, at: r.createdAt, ...totals };
}

const hourStart = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

interface ThreadRef {
  threadId: string;
  providerId: string;
  /** Epoch ms the thread was created; null when unknown. */
  createdAt: number | null;
}

interface ApplyResult {
  state: TokenState;
  /** True when a bucket grew. */
  counted: boolean;
}

function addToHour(list: readonly HourEntry[], at: number, work: number, all: number): HourEntry[] {
  const hour = hourStart(at);
  const index = list.findIndex((e) => e[0] === hour);
  if (index !== -1) {
    const next = [...list];
    const e = next[index]!;
    next[index] = [hour, e[1] + work, e[2] + all];
    return next;
  }
  return [...list, [hour, work, all] as HourEntry].sort((a, b) => a[0] - b[0]);
}

/**
 * R2–R4: applies a thread's events (any order; sorted by sequence) and trims
 * by R6. An event at or below the remembered sequence is skipped, so feeding
 * the same events again changes nothing. Events older than the retention, and
 * events of a thread that may have been dropped from the table (not in it and
 * written at or before `evictedBefore`, or the first event of a thread created
 * at or before it), only advance the remembered values.
 */
export function applyEvents(state: TokenState, thread: ThreadRef, events: readonly TokenEvent[], now: number, maxBytes = TOKEN_VALUE_BYTES): ApplyResult {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const cutoff = now - TOKEN_RETENTION_MS;
  const wasKnown = Object.hasOwn(state.threads, thread.threadId);
  const evicted = state.evictedBefore;
  // A thread created before the last drop may be one that was dropped: its
  // newest event's total holds what was counted before, so it is a baseline.
  const mayBeDropped = !wasKnown && evicted !== null && (thread.createdAt === null || thread.createdAt <= evicted);
  let entry: ThreadEntry | undefined = state.threads[thread.threadId];
  let providerHours = state.hours[thread.providerId] ?? [];
  let counted = false;
  let first = true;
  for (const event of sorted) {
    if (entry !== undefined && event.seq <= entry.seq) continue;
    const base: TokenPair = entry ?? { work: 0, all: 0 };
    // A lower total is a counter that restarted after the last read: all of it is new.
    const restarted: boolean = event.all < base.all;
    const work: number = restarted ? event.work : Math.max(0, event.work - base.work);
    const all: number = restarted ? event.all : event.all - base.all;
    const baselineOnly =
      event.at <= cutoff || (!wasKnown && evicted !== null && event.at <= evicted) || (first && mayBeDropped);
    if (!baselineOnly && (work > 0 || all > 0)) {
      providerHours = addToHour(providerHours, event.at, work, all);
      counted = true;
    }
    entry = {
      providerId: thread.providerId,
      work: event.work,
      all: event.all,
      sumWork: (entry?.sumWork ?? 0) + work,
      sumAll: (entry?.sumAll ?? 0) + all,
      updatedAt: event.at,
      seq: event.seq,
    };
    first = false;
  }
  if (entry === undefined) return { state, counted: false };
  const next: TokenState = {
    ...state,
    hours: counted ? { ...state.hours, [thread.providerId]: providerHours } : state.hours,
    threads: { ...state.threads, [thread.threadId]: entry },
  };
  return { state: trimTokenState(next, now, maxBytes), counted };
}

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * R6: drops hours and threads older than the retention, then the oldest hours
 * and the least recently updated threads until each value fits in
 * `maxBytes`. Every dropped thread moves `evictedBefore` forward.
 */
export function trimTokenState(state: TokenState, now: number, maxBytes = TOKEN_VALUE_BYTES): TokenState {
  const cutoff = now - TOKEN_RETENTION_MS;
  return { ...trimThreads(state, cutoff, maxBytes), hours: trimHours(state.hours, cutoff, maxBytes) };
}

function trimHours(hours: Record<string, HourEntry[]>, cutoff: number, maxBytes: number): Record<string, HourEntry[]> {
  let kept: Record<string, HourEntry[]> = {};
  for (const [providerId, list] of Object.entries(hours)) {
    const fresh = list.filter((e) => e[0] + HOUR_MS > cutoff);
    if (fresh.length > 0) kept[providerId] = fresh;
  }
  let size = byteLength(kept);
  while (size > maxBytes) {
    // Drop the oldest hours across providers, in proportion to the excess.
    const all = Object.values(kept).flat().sort((a, b) => a[0] - b[0]);
    if (all.length === 0) break;
    const drop = Math.max(1, Math.ceil(((size - maxBytes) / size) * all.length));
    const from = all[Math.min(drop, all.length) - 1]![0];
    const next: Record<string, HourEntry[]> = {};
    for (const [providerId, list] of Object.entries(kept)) {
      const rest = list.filter((e) => e[0] > from);
      if (rest.length > 0) next[providerId] = rest;
    }
    kept = next;
    size = byteLength(kept);
  }
  return kept;
}

/** The part stored under `tokens:threads`. */
export function threadsValue(state: TokenState) {
  return { threads: state.threads, backfill: state.backfill, evictedBefore: state.evictedBefore };
}

function trimThreads(state: TokenState, cutoff: number, maxBytes: number): TokenState {
  const entries = Object.entries(state.threads).sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  let keep = entries.filter(([, e]) => e.updatedAt > cutoff).length;
  const sized = (n: number) => byteLength(threadsValue({ ...state, threads: Object.fromEntries(entries.slice(0, n)) }));
  let size = sized(keep);
  while (size > maxBytes && keep > 0) {
    const drop = Math.max(1, Math.ceil(((size - maxBytes) / size) * keep));
    keep = Math.max(0, keep - drop);
    size = sized(keep);
  }
  if (keep === entries.length) return state;
  let evictedBefore = state.evictedBefore;
  for (const [, e] of entries.slice(keep)) evictedBefore = Math.max(evictedBefore ?? -Infinity, e.updatedAt);
  return { ...state, threads: Object.fromEntries(entries.slice(0, keep)), evictedBefore };
}

/** R7: the provider's buckets from the hour that holds `fromMs`. */
export function sumSince(hours: Record<string, readonly HourEntry[]>, providerId: string, fromMs: number): TokenPair {
  const from = hourStart(fromMs);
  let work = 0;
  let all = 0;
  for (const [hour, w, a] of hours[providerId] ?? []) {
    if (hour < from) continue;
    work += w;
    all += a;
  }
  return { work, all };
}

/** Local midnight of `now`'s day and of the first of its month, in the runtime's time zone. */
export function localPeriodStarts(now: number): { dayStart: number; monthStart: number } {
  const d = new Date(now);
  return {
    dayStart: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
    monthStart: new Date(d.getFullYear(), d.getMonth(), 1).getTime(),
  };
}

const UNITS = {
  en: [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ],
  ru: [
    [1e9, " млрд"],
    [1e6, " млн"],
    [1e3, " тыс."],
  ],
} as const satisfies Record<Lang, ReadonlyArray<readonly [number, string]>>;

/**
 * R11: below 1 000 as is, then three significant digits: "12.3k", "310k",
 * "4.2M", "1.25B"; Russian "12,3 тыс.", "310 тыс.", "4,2 млн", "1,25 млрд".
 */
export function formatTokenCount(tokens: number, language: Lang): string {
  const n = Math.max(0, Math.round(Number.isFinite(tokens) ? tokens : 0));
  if (n < 1000) return String(n);
  const units = UNITS[language];
  for (let i = 0; i < units.length; i++) {
    const [size, suffix] = units[i]!;
    if (n < size) continue;
    const value = Number((n / size).toPrecision(3));
    // 999 500 rounds to 1000k: show the next unit instead.
    if (value >= 1000 && i > 0) {
      const [upSize, upSuffix] = units[i - 1]!;
      return number(Number((n / upSize).toPrecision(3)), language) + upSuffix;
    }
    return number(value, language) + suffix;
  }
  return String(n);
}

const number = (value: number, language: Lang) => (language === "ru" ? String(value).replace(".", ",") : String(value));
