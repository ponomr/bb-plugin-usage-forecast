// KV keys and bounded buffers. Every buffer is trimmed before it is written,
// so no value comes near the host's 256 KB limit.

import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import type { ClosedWindow } from "../shared/forecast";
import type { HeldPace } from "../shared/pace";
import type { CompactLogEntry, ProviderLimits } from "../shared/contract";
import { emptyTokenState, type HourEntry, type ThreadEntry, type TokenState, threadsValue } from "../shared/tokens";

/** Upper bound for any serialized value, in bytes. */
export const MAX_VALUE_BYTES = 200 * 1024;
export const MAX_CLOSED_WINDOWS = 30;
export const MAX_LOG_ENTRIES = 100;
/** An unsupported mark expires so a provider that gains compact, or a misread error, recovers on its own. */
export const UNSUPPORTED_TTL_MS = 24 * 60 * 60_000;
/** Remembered compaction points (one per provider and window size). */
export const MAX_COMPACT_POINTS = 20;

/** Hosts kept in the host index; the ones polled longest ago are dropped first. */
export const MAX_HOSTS = 20;

const enc = encodeURIComponent;

/**
 * Limits keys. The legacy keys (no host id) belong to the host that owned
 * them before 0.4.6; every other host has its id in the key. Encoding removes
 * ":", so a scoped key never equals a legacy one.
 */
export const keys = {
  latest: "limits:latest",
  windows: (windowKey: string) => `limits:windows:${windowKey}`,
  hostLatest: (hostId: string) => `limits:latest:${enc(hostId)}`,
  hostWindows: (hostId: string, windowKey: string) => `limits:windows:${enc(hostId)}:${windowKey}`,
  hostIndex: "limits:hosts",
  log: "autocompact:log",
  cooldown: (threadId: string) => `autocompact:cooldown:${threadId}`,
  unsupported: "autocompact:unsupported",
  compactPoints: "context:compact-points",
  notified: "notify:sent",
  tokenHours: "tokens:hours",
  tokenThreads: "tokens:threads",
} as const;

/** The last compaction point bb reported for one provider and window size. */
export interface CompactPoint {
  tokens: number;
  /** Epoch ms of the last read that reported it. */
  seenAt: number;
}

/** Remembered limit notifications (one per host, provider and window label). */
export const MAX_NOTIFIED = 200;

/** The last push sent for one limit window: its period and how far it went. */
export interface Notified {
  resetsAt: number | null;
  level: "threshold" | "reached";
  at: number;
}

export const compactPointKey = (providerId: string, windowTokens: number) => `${providerId}|${windowTokens}`;

/** A window of the latest answer plus what the poller needs to close it later. */
export interface StoredWindow {
  /** Highest `usedPercent` seen in this window so far. */
  peakUsedPercent: number;
  /** Epoch ms of the first poll that saw this window. */
  firstSeenAt: number;
  /** The pace state and its hold; absent with no current pace or before 0.4.7. */
  pace?: HeldPace;
}

export interface StoredProvider extends ProviderLimits {
  /** Keyed by window label. */
  open: Record<string, StoredWindow>;
}

export interface StoredLatest {
  polledAt: number | null;
  pollError: string | null;
  providers: StoredProvider[];
}

export const EMPTY_LATEST: StoredLatest = { polledAt: null, pollError: null, providers: [] };

/**
 * Which keys a host's limits live on: null means the legacy keys. The legacy
 * owner and a host id that is not known (no marker yet) map to null.
 */
export type HostScope = string | null;

export function scopeOf(hostId: string | null, legacyOwner: string | null): HostScope {
  if (hostId === null || legacyOwner === null || hostId === legacyOwner) return null;
  return hostId;
}

/** One known host. Names and state only; no account fields. */
export interface HostEntry {
  hostId: string;
  name: string;
  connected: boolean;
  polledAt: number | null;
  pollError: string | null;
}

export interface HostIndex {
  /** The host that owns the legacy keys; written once and never changed. */
  legacyOwner: string;
  hosts: HostEntry[];
}

function isHostEntry(value: unknown): value is HostEntry {
  const v = value as HostEntry | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.hostId === "string" &&
    typeof v.name === "string" &&
    typeof v.connected === "boolean" &&
    (v.polledAt === null || typeof v.polledAt === "number") &&
    (v.pollError === null || typeof v.pollError === "string")
  );
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isHourEntry(value: unknown): value is HourEntry {
  return Array.isArray(value) && value.length === 3 && value.every(isNum);
}

function isThreadEntry(value: unknown): value is ThreadEntry {
  const v = value as ThreadEntry | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.providerId === "string" &&
    isNum(v.work) &&
    isNum(v.all) &&
    isNum(v.updatedAt) &&
    isNum(v.seq)
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `tokens:hours` and `tokens:threads` read back into one state; parts in another shape read as empty. */
export function parseTokenState(hoursValue: unknown, threadsStored: unknown): TokenState {
  const state = emptyTokenState();
  if (isRecord(hoursValue)) {
    for (const [providerId, list] of Object.entries(hoursValue)) {
      if (!Array.isArray(list)) continue;
      const kept = list.filter(isHourEntry).sort((a, b) => a[0] - b[0]);
      if (kept.length > 0) state.hours[providerId] = kept;
    }
  }
  if (isRecord(threadsStored)) {
    if (isRecord(threadsStored.threads)) {
      for (const [threadId, entry] of Object.entries(threadsStored.threads)) {
        if (!isThreadEntry(entry)) continue;
        const e = entry as ThreadEntry;
        state.threads[threadId] = {
          providerId: e.providerId,
          work: e.work,
          all: e.all,
          sumWork: isNum(e.sumWork) ? e.sumWork : e.work,
          sumAll: isNum(e.sumAll) ? e.sumAll : e.all,
          updatedAt: e.updatedAt,
          seq: e.seq,
        };
      }
    }
    const b = threadsStored.backfill as Partial<TokenState["backfill"]> | undefined;
    if (isRecord(b)) {
      state.backfill = {
        done: b.done === true,
        threadsRead: isNum(b.threadsRead) ? b.threadsRead : 0,
        threadsFailed: isNum(b.threadsFailed) ? b.threadsFailed : 0,
        startedAt: isNum(b.startedAt) ? b.startedAt : null,
      };
    }
    if (isNum(threadsStored.evictedBefore)) state.evictedBefore = threadsStored.evictedBefore;
  }
  return state;
}

function isLatest(value: unknown): value is StoredLatest {
  const v = value as StoredLatest | null;
  return typeof v === "object" && v !== null && Array.isArray(v.providers);
}

export function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export class Storage {
  constructor(private readonly kv: PluginKvStorage) {}

  async latest(scope: HostScope = null): Promise<StoredLatest> {
    const value = await this.kv.get<unknown>(scope === null ? keys.latest : keys.hostLatest(scope));
    return isLatest(value) ? value : EMPTY_LATEST;
  }

  async setLatest(latest: StoredLatest, scope: HostScope = null): Promise<void> {
    await this.kv.set(scope === null ? keys.latest : keys.hostLatest(scope), latest);
  }

  private windowsKey(windowKey: string, scope: HostScope): string {
    return scope === null ? keys.windows(windowKey) : keys.hostWindows(scope, windowKey);
  }

  /** Deletes the per-poll samples written before 0.4.16; nothing ever read them. */
  async dropSamples(): Promise<void> {
    for (const key of await this.kv.list("limits:samples:")) await this.kv.delete(key);
  }

  async closedWindows(windowKey: string, scope: HostScope = null): Promise<ClosedWindow[]> {
    const value = await this.kv.get<unknown>(this.windowsKey(windowKey, scope));
    return Array.isArray(value) ? (value as ClosedWindow[]) : [];
  }

  /** Returns the stored list. */
  async appendClosedWindow(windowKey: string, closed: ClosedWindow, scope: HostScope = null): Promise<ClosedWindow[]> {
    const kept = [...(await this.closedWindows(windowKey, scope)), closed].slice(-MAX_CLOSED_WINDOWS);
    await this.kv.set(this.windowsKey(windowKey, scope), kept);
    return kept;
  }

  /** Null until the legacy owner is known. Entries in another shape are dropped. */
  async hostIndex(): Promise<HostIndex | null> {
    const value = await this.kv.get<unknown>(keys.hostIndex);
    const v = value as HostIndex | null;
    if (typeof v !== "object" || v === null || typeof v.legacyOwner !== "string" || !Array.isArray(v.hosts)) return null;
    return { legacyOwner: v.legacyOwner, hosts: v.hosts.filter(isHostEntry) };
  }

  /**
   * Keeps at most MAX_HOSTS hosts: the legacy owner always, then the most
   * recently polled. Returns the ids it dropped; their keys are the caller's
   * to remove.
   */
  async setHostIndex(index: HostIndex): Promise<string[]> {
    const owner = index.hosts.filter((h) => h.hostId === index.legacyOwner);
    const others = index.hosts
      .filter((h) => h.hostId !== index.legacyOwner)
      .sort((a, b) => (b.polledAt ?? -Infinity) - (a.polledAt ?? -Infinity));
    const room = MAX_HOSTS - owner.length;
    const kept = [...owner, ...others.slice(0, room)];
    const keptIds = new Set(kept.map((h) => h.hostId));
    await this.kv.set(keys.hostIndex, { legacyOwner: index.legacyOwner, hosts: index.hosts.filter((h) => keptIds.has(h.hostId)) });
    return others.slice(room).map((h) => h.hostId);
  }

  /** Deletes one host's scoped keys. The legacy keys are never touched. */
  async removeHost(hostId: string): Promise<void> {
    const host = enc(hostId);
    const windows = `limits:windows:${host}:`;
    // A legacy window key is `limits:windows:<provider>:<label>`; a provider id
    // equal to this host id would match the prefix, but its rest has no ":".
    const doomed = [
      keys.hostLatest(hostId),
      ...(await this.kv.list(windows)).filter((k) => k.slice(windows.length).includes(":")),
    ];
    for (const key of doomed) await this.kv.delete(key);
  }

  /** Newest first. */
  async log(): Promise<CompactLogEntry[]> {
    return (await this.kv.get<CompactLogEntry[]>(keys.log)) ?? [];
  }

  async prependLog(entry: CompactLogEntry): Promise<void> {
    const all = [entry, ...(await this.log())];
    await this.kv.set(keys.log, all.slice(0, MAX_LOG_ENTRIES));
  }

  /** Replaces the newest entry of a thread written at `at`; used to add the after-fill. */
  async updateLog(threadId: string, at: number, patch: Partial<CompactLogEntry>): Promise<void> {
    const all = await this.log();
    const index = all.findIndex((e) => e.threadId === threadId && e.at === at);
    if (index === -1) return;
    all[index] = { ...all[index]!, ...patch };
    await this.kv.set(keys.log, all);
  }

  async cooldownUntil(threadId: string): Promise<number | null> {
    return (await this.kv.get<number>(keys.cooldown(threadId))) ?? null;
  }

  async setCooldownUntil(threadId: string, until: number): Promise<void> {
    await this.kv.set(keys.cooldown(threadId), until);
  }

  /** Epoch ms of each provider's unsupported mark. A value in another shape (0.1.0 stored a list) reads as no marks. */
  private async unsupportedMarks(): Promise<Record<string, number>> {
    const value = await this.kv.get<unknown>(keys.unsupported);
    if (!isRecord(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    );
  }

  /** Providers whose compact failed as unsupported within the last UNSUPPORTED_TTL_MS. */
  async unsupportedProviders(now: number): Promise<string[]> {
    const marks = await this.unsupportedMarks();
    return Object.keys(marks).filter((id) => now - marks[id]! < UNSUPPORTED_TTL_MS);
  }

  async markUnsupported(providerId: string, at: number): Promise<void> {
    const marks = await this.unsupportedMarks();
    const kept = Object.entries({ ...marks, [providerId]: at })
      .filter(([, markedAt]) => at - markedAt < UNSUPPORTED_TTL_MS)
      .slice(-100);
    await this.kv.set(keys.unsupported, Object.fromEntries(kept));
  }

  async clearUnsupported(providerId: string): Promise<void> {
    const marks = await this.unsupportedMarks();
    if (!(providerId in marks)) return;
    delete marks[providerId];
    await this.kv.set(keys.unsupported, marks);
  }

  /** Keyed by `compactPointKey`. A value in another shape reads as empty. */
  async compactPoints(): Promise<Record<string, CompactPoint>> {
    const value = await this.kv.get<unknown>(keys.compactPoints);
    if (!isRecord(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, CompactPoint] =>
          typeof (entry[1] as CompactPoint | null)?.tokens === "number" && typeof (entry[1] as CompactPoint).seenAt === "number",
      ),
    );
  }

  async compactPoint(providerId: string, windowTokens: number): Promise<number | null> {
    return (await this.compactPoints())[compactPointKey(providerId, windowTokens)]?.tokens ?? null;
  }

  /**
   * Stores the point when it changed, or when the stored one is older than an
   * hour; keeps the MAX_COMPACT_POINTS most recently seen.
   */
  async rememberCompactPoint(providerId: string, windowTokens: number, tokens: number, at: number): Promise<void> {
    const points = await this.compactPoints();
    const key = compactPointKey(providerId, windowTokens);
    const old = points[key];
    if (old !== undefined && old.tokens === tokens && at - old.seenAt < 60 * 60_000) return;
    points[key] = { tokens, seenAt: at };
    const kept = Object.entries(points)
      .sort((a, b) => b[1].seenAt - a[1].seenAt)
      .slice(0, MAX_COMPACT_POINTS);
    await this.kv.set(keys.compactPoints, Object.fromEntries(kept));
  }

  /** Keyed by `windowKey`. A value in another shape reads as empty. */
  async notified(): Promise<Record<string, Notified>> {
    const value = await this.kv.get<unknown>(keys.notified);
    if (!isRecord(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, Notified] => typeof (entry[1] as Notified | null)?.at === "number",
      ),
    );
  }

  /** Keeps the MAX_NOTIFIED most recent entries. */
  async setNotified(notified: Record<string, Notified>): Promise<void> {
    const kept = Object.entries(notified)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_NOTIFIED);
    await this.kv.set(keys.notified, Object.fromEntries(kept));
  }

  /** Token totals: the hourly buckets and the thread table. */
  async tokenState(): Promise<TokenState> {
    const [hours, threads] = await Promise.all([this.kv.get<unknown>(keys.tokenHours), this.kv.get<unknown>(keys.tokenThreads)]);
    return parseTokenState(hours, threads);
  }

  /** The caller trims first (`trimTokenState`); the byte bound is checked again here. */
  async setTokenHours(hours: TokenState["hours"]): Promise<void> {
    if (byteLength(hours) > MAX_VALUE_BYTES) throw new Error("token hours exceed the value limit");
    await this.kv.set(keys.tokenHours, hours);
  }

  async setTokenThreads(state: TokenState): Promise<void> {
    const value = threadsValue(state);
    if (byteLength(value) > MAX_VALUE_BYTES) throw new Error("token threads exceed the value limit");
    await this.kv.set(keys.tokenThreads, value);
  }
}
