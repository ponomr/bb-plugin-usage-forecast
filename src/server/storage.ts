// KV keys and bounded buffers. Every buffer is trimmed before it is written,
// so no value comes near the host's 256 KB limit.

import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import type { ClosedWindow } from "../shared/forecast";
import type { CompactLogEntry, ProviderLimits } from "../shared/contract";

/** Upper bound for any serialized value, in bytes. */
export const MAX_VALUE_BYTES = 200 * 1024;
export const MAX_CLOSED_WINDOWS = 30;
export const MAX_LOG_ENTRIES = 100;
/** An unsupported mark expires so a provider that gains compact, or a misread error, recovers on its own. */
export const UNSUPPORTED_TTL_MS = 24 * 60 * 60_000;
/** Remembered compaction points (one per provider and window size). */
export const MAX_COMPACT_POINTS = 20;

export const keys = {
  latest: "limits:latest",
  samples: (providerId: string) => `limits:samples:${encodeURIComponent(providerId)}`,
  windows: (windowKey: string) => `limits:windows:${windowKey}`,
  log: "autocompact:log",
  cooldown: (threadId: string) => `autocompact:cooldown:${threadId}`,
  unsupported: "autocompact:unsupported",
  compactPoints: "context:compact-points",
} as const;

/** The last compaction point bb reported for one provider and window size. */
export interface CompactPoint {
  tokens: number;
  /** Epoch ms of the last read that reported it. */
  seenAt: number;
}

export const compactPointKey = (providerId: string, windowTokens: number) => `${providerId}|${windowTokens}`;

export interface Sample {
  at: number;
  label: string;
  usedPercent: number;
  resetsAt: number | null;
}

/** A window of the latest answer plus what the poller needs to close it later. */
export interface StoredWindow {
  /** Highest `usedPercent` seen in this window so far. */
  peakUsedPercent: number;
  /** Epoch ms of the first poll that saw this window. */
  firstSeenAt: number;
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

export function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Drops the oldest items until the serialized array fits in `maxBytes`.
 * Keeps the newest items; returns a new array.
 */
export function trimToBytes<T>(items: readonly T[], maxBytes = MAX_VALUE_BYTES): T[] {
  let kept = [...items];
  let size = byteLength(kept);
  while (size > maxBytes && kept.length > 0) {
    // Drop in proportion to the excess so large buffers need few passes.
    const average = size / kept.length;
    const drop = Math.max(1, Math.ceil((size - maxBytes) / average));
    kept = kept.slice(drop);
    size = byteLength(kept);
  }
  return kept;
}

export class Storage {
  constructor(private readonly kv: PluginKvStorage) {}

  async latest(): Promise<StoredLatest> {
    return (await this.kv.get<StoredLatest>(keys.latest)) ?? EMPTY_LATEST;
  }

  async setLatest(latest: StoredLatest): Promise<void> {
    await this.kv.set(keys.latest, latest);
  }

  async samples(providerId: string): Promise<Sample[]> {
    return (await this.kv.get<Sample[]>(keys.samples(providerId))) ?? [];
  }

  async appendSamples(providerId: string, added: readonly Sample[]): Promise<void> {
    if (added.length === 0) return;
    const all = [...(await this.samples(providerId)), ...added];
    await this.kv.set(keys.samples(providerId), trimToBytes(all));
  }

  async closedWindows(windowKey: string): Promise<ClosedWindow[]> {
    return (await this.kv.get<ClosedWindow[]>(keys.windows(windowKey))) ?? [];
  }

  /** Returns the stored list. */
  async appendClosedWindow(windowKey: string, closed: ClosedWindow): Promise<ClosedWindow[]> {
    const kept = [...(await this.closedWindows(windowKey)), closed].slice(-MAX_CLOSED_WINDOWS);
    await this.kv.set(keys.windows(windowKey), kept);
    return kept;
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
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
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
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
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
}
