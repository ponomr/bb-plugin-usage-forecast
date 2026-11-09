// Limits poller. The `poll-limits` schedule ticks every minute; `tick` decides
// whether a poll is due. bb 0.49 throws when a schedule name is registered
// twice, so the backoff skips ticks instead of re-registering:
// the user's interval normally, 5 minutes after one failed poll in a row,
// 15 minutes after two or more. A poll fails when the bb call or plugin
// storage fails, or when every provider reports an error. A success resets it, and so does a restart:
// the count lives in memory. A skipped tick during backoff rethrows the last
// error so `bb plugin list` keeps showing it.
//
// The answer of `system.usageLimits` is parsed field by field: account
// identifiers (`accountEmail`, `accountKey`) are never copied, and error
// texts have e-mail addresses masked before they are stored.

import { z } from "zod";
import { forecastWindow, isNewWindow, type ClosedWindow } from "../shared/forecast";
import { windowDurationMs, windowKey } from "../shared/windows";
import type { LimitsSnapshot, LimitWindow, ProviderStatus } from "../shared/contract";
import { PROVIDER_STATUSES, RECENT_COMPACTIONS } from "../shared/contract";
import { cleanMessage } from "./messages";
import { EMPTY_LATEST, type Sample, type Storage, type StoredLatest, type StoredProvider, type StoredWindow } from "./storage";

export const TICK_CRON = "* * * * *";
export const BACKOFF_MINUTES = [5, 15] as const;
/** Ticks fire on minute boundaries; a poll that ran a little late still counts as on time. */
const TICK_SLACK_MS = 5_000;

export function backoffMinutes(failures: number, intervalMinutes: number): number {
  if (failures <= 0) return intervalMinutes;
  // Back-off never polls more often than the user's interval.
  return Math.max(intervalMinutes, BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1]!);
}

const windowInput = z.object({
  label: z.string(),
  usedPercent: z.number().finite(),
  resetsAt: z.string().nullish(),
  cost: z.object({ limitUsdCents: z.number(), usedUsdCents: z.number() }).nullish(),
  kind: z.unknown().optional(),
  model: z.unknown().optional(),
});

const providerInput = z.object({
  status: z.enum(PROVIDER_STATUSES),
  planLabel: z.string().nullish(),
  message: z.string().nullish(),
  windows: z.array(windowInput).optional(),
});

function parseResetsAt(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Why the poll counts as failed: only when every provider reports an error.
 * One provider's error stays on its own row and does not slow the others.
 */
export function pollError(providers: readonly StoredProvider[]): string | null {
  if (providers.length === 0 || providers.some((p) => p.status !== "error")) return null;
  return providers.map((p) => `${p.providerId}: ${p.message}`).join("; ");
}

export interface PollResult {
  latest: StoredLatest;
  /** Why this poll counts as failed, or null. */
  error: string | null;
}

export interface PollerDeps {
  usageLimits: (args: { refresh: boolean }) => Promise<unknown>;
  storage: Storage;
  intervalMinutes: () => Promise<number>;
  invalidate: () => void;
  now?: () => number;
}

export class Poller {
  private failures = 0;
  private lastAttemptAt: number | null = null;
  private lastError: string | null = null;
  private inFlight: Promise<PollResult> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: PollerDeps) {
    this.now = deps.now ?? Date.now;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Schedule entry. Throws when the poll fails, or while backing off after one. */
  async tick(): Promise<void> {
    const wait = backoffMinutes(this.failures, await this.deps.intervalMinutes()) * 60_000;
    if (this.lastAttemptAt !== null && this.now() - this.lastAttemptAt < wait - TICK_SLACK_MS) {
      if (this.failures > 0) {
        const resumeAt = new Date(this.lastAttemptAt + wait).toISOString();
        throw new Error(`Polling paused until ${resumeAt} after ${this.failures} failed polls: ${this.lastError}`);
      }
      return;
    }
    const { error } = await this.poll();
    if (error) throw new Error(error);
  }

  /** Polls now. Concurrent calls share one request. Never throws. */
  poll(): Promise<PollResult> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<PollResult> {
    const { storage } = this.deps;
    const now = this.now();
    this.lastAttemptAt = now;

    let latest: StoredLatest;
    let error: string | null;
    try {
      const previous = await storage.latest();
      try {
        const answer = await this.deps.usageLimits({ refresh: true });
        const applied = await this.apply(previous, answer, now);
        error = pollError(applied.providers);
        latest = { ...applied, pollError: error };
      } catch (cause) {
        error = cleanMessage(cause);
        latest = { ...previous, polledAt: now, pollError: error };
      }
      await storage.setLatest(latest);
    } catch (cause) {
      // Plugin storage failed: nothing was saved, the poll still counts as failed.
      error = cleanMessage(cause);
      latest = { ...EMPTY_LATEST, polledAt: now, pollError: error };
    }

    if (error) {
      this.failures += 1;
      this.lastError = error;
    } else {
      this.failures = 0;
      this.lastError = null;
    }
    this.deps.invalidate();
    return { latest, error };
  }

  private async apply(previous: StoredLatest, answer: unknown, now: number): Promise<StoredLatest> {
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
      throw new Error("usageLimits returned an unexpected answer");
    }
    const providers: StoredProvider[] = [];
    for (const [providerId, raw] of Object.entries(answer)) {
      const before = previous.providers.find((p) => p.providerId === providerId);
      const parsed = providerInput.safeParse(raw);
      if (!parsed.success) {
        providers.push(this.notOk(providerId, before, "error", "Unexpected answer for this provider", null, now));
      } else if (parsed.data.status !== "ok") {
        const { status, message, planLabel } = parsed.data;
        providers.push(this.notOk(providerId, before, status, message ?? null, planLabel ?? null, now));
      } else {
        providers.push(await this.ok(providerId, before, parsed.data, now));
      }
    }
    return { polledAt: now, pollError: null, providers };
  }

  private notOk(
    providerId: string,
    before: StoredProvider | undefined,
    status: Exclude<ProviderStatus, "ok">,
    message: string | null,
    planLabel: string | null,
    now: number,
  ): StoredProvider {
    return {
      providerId,
      status,
      message: status === "error" ? cleanMessage(message ?? "Unknown error") : null,
      planLabel: planLabel ?? before?.planLabel ?? null,
      checkedAt: now,
      measuredAt: before?.measuredAt ?? null,
      windows: before?.windows ?? [],
      open: before?.open ?? {},
    };
  }

  private async ok(
    providerId: string,
    before: StoredProvider | undefined,
    data: z.infer<typeof providerInput>,
    now: number,
  ): Promise<StoredProvider> {
    const { storage } = this.deps;
    const windows: LimitWindow[] = [];
    const open: Record<string, StoredWindow> = {};
    const samples: Sample[] = [];
    // A label seen twice in one answer keeps its first window.
    const seen = new Set<string>();

    for (const w of data.windows ?? []) {
      if (seen.has(w.label)) continue;
      seen.add(w.label);
      const resetsAt = parseResetsAt(w.resetsAt);
      const durationMs = windowDurationMs(w.label, w.kind);
      const key = windowKey(providerId, w.label);
      const prevWindow = before?.windows.find((x) => x.label === w.label);
      const prevOpen = before?.open[w.label];

      let closedWindows: ClosedWindow[] | null = null;
      if (prevWindow && prevOpen && isNewWindow(prevWindow.resetsAt, resetsAt)) {
        if (prevWindow.resetsAt !== null) {
          closedWindows = await storage.appendClosedWindow(key, {
            startedAt: durationMs !== null ? prevWindow.resetsAt - durationMs : prevOpen.firstSeenAt,
            resetAt: prevWindow.resetsAt,
            peakUsedPercent: prevOpen.peakUsedPercent,
          });
        }
        open[w.label] = { peakUsedPercent: w.usedPercent, firstSeenAt: now };
      } else {
        open[w.label] = {
          peakUsedPercent: Math.max(prevOpen?.peakUsedPercent ?? w.usedPercent, w.usedPercent),
          firstSeenAt: prevOpen?.firstSeenAt ?? now,
        };
      }

      closedWindows ??= await storage.closedWindows(key);
      windows.push({
        label: w.label,
        usedPercent: w.usedPercent,
        resetsAt,
        model: typeof w.model === "string" ? w.model : null,
        cost: w.cost ? { usedUsdCents: w.cost.usedUsdCents, limitUsdCents: w.cost.limitUsdCents } : null,
        durationMs,
        forecast: forecastWindow({ usedPercent: w.usedPercent, resetsAt, durationMs, now, closedWindows }),
      });
      samples.push({ at: now, label: w.label, usedPercent: w.usedPercent, resetsAt });
    }

    await storage.appendSamples(providerId, samples);
    return {
      providerId,
      status: "ok",
      message: null,
      planLabel: data.planLabel ?? null,
      checkedAt: now,
      measuredAt: now,
      windows,
      open,
    };
  }
}

/** The client view of the stored state. A window whose reset has passed loses its forecast. */
export function toSnapshot(latest: StoredLatest, log: LimitsSnapshot["recentCompactions"], now: number): LimitsSnapshot {
  return {
    polledAt: latest.polledAt,
    pollError: latest.pollError,
    providers: latest.providers.map(({ open: _open, ...provider }) => ({
      ...provider,
      windows: provider.windows.map((w) =>
        w.resetsAt !== null && w.resetsAt <= now ? { ...w, forecast: null } : w,
      ),
    })),
    recentCompactions: log.slice(0, RECENT_COMPACTIONS),
  };
}
