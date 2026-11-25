// Limits poller. The `poll-limits` schedule ticks every minute; `tick` decides
// which hosts are due. bb 0.49 throws when a schedule name is registered
// twice, so the backoff skips ticks instead of re-registering. Each host has
// its own backoff: the user's interval normally, 5 minutes after one failed
// poll in a row, 15 minutes after two or more. A host's poll fails when the bb
// call or plugin storage fails, or when every provider reports an error. A
// success resets it, and so does a restart: the counts live in memory. A tick
// throws, naming the hosts, only while no connected host's last poll
// succeeded, so `bb plugin list` shows a plugin without fresh limits as
// failed. While another host answers, a failing or paused host is a log
// warning (written once per change) and stays on that host's `pollError`.
//
// Hosts: until the plugin knows which host owns the data stored before 0.4.6
// (the host bb answers for when no host is named), it makes that single call
// and keeps it on the legacy keys. Once `system.config().primaryHostId` (or
// the only listed host) names that owner, every connected, active host is
// polled in parallel and stored under its own keys; the owner keeps the
// legacy keys. Hosts that leave bb are removed with their keys.
//
// The answer of `system.usageLimits` is parsed field by field: account
// identifiers (`accountEmail`, `accountKey`) are never copied, and error
// texts have e-mail addresses masked before they are stored. `accountKey` is
// compared in memory to find hosts that share an account; only the host ids
// of such a group are stored.

import { z } from "zod";
import { forecastWindow, isNewWindow, type ClosedWindow } from "../shared/forecast";
import { nextPace, rawPaceState } from "../shared/pace";
import { planMultiplier } from "../shared/plan";
import { windowDurationMs, windowKey } from "../shared/windows";
import type { HostLimits, LimitsSnapshot, LimitWindow, ProviderStatus } from "../shared/contract";
import { PROVIDER_STATUSES, RECENT_COMPACTIONS } from "../shared/contract";
import { cleanMessage } from "./messages";
import {
  EMPTY_LATEST,
  scopeOf,
  type HostEntry,
  type HostIndex,
  type HostScope,
  type Storage,
  type StoredLatest,
  type StoredProvider,
  type StoredWindow,
} from "./storage";

export const TICK_CRON = "* * * * *";
const BACKOFF_MINUTES = [5, 15] as const;
/** Ticks fire on minute boundaries; a poll that ran a little late still counts as on time. */
const TICK_SLACK_MS = 5_000;
/** A host that has not answered by then counts as failed, so it cannot hold up the others. */
const HOST_TIMEOUT_MS = 30_000;
/** Backoff key of the single call made while the hosts are unknown. Host ids are never empty. */
const LEGACY_KEY = "";

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
  /** Undocumented `{id, multiplier}`; only the multiplier is read (`planMultiplier`). */
  plan: z.unknown().optional(),
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

/**
 * Each provider's `accountKey`, read from the raw answer for grouping only.
 * The result never leaves the poll that read it.
 */
function accountKeys(answer: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof answer !== "object" || answer === null) return out;
  for (const [providerId, raw] of Object.entries(answer)) {
    const key = (raw as { accountKey?: unknown } | null)?.accountKey;
    if (typeof key === "string" && key !== "") out.set(providerId, key);
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** What `hosts.list` reports about a host; only these fields are read. */
export interface HostInfo {
  id: string;
  name: string;
  status: string;
  lifecycle: { phase: string };
}

/** One host's stored limits as the snapshot, the CLI and the notifier see them. */
interface StoredHost {
  /** Null while the hosts are unknown: the record of the default host. */
  hostId: string | null;
  name: string | null;
  /** The owner of the legacy keys. */
  primary: boolean;
  connected: boolean;
  latest: StoredLatest;
}

export interface HostRecord extends StoredHost {
  /** True when this poll reached the host and stored its answer. */
  answered: boolean;
}

interface PollResult {
  /** The default host's record. */
  latest: StoredLatest;
  /** Errors of the hosts polled now, each named by its host when there are several; or null. */
  error: string | null;
  /** Every known host after this poll. */
  hosts: HostRecord[];
}

interface RunResult extends PollResult {
  /** The backoff of hosts skipped by this run, or null. */
  paused: string | null;
  /** True when the last poll of at least one connected host succeeded. */
  healthy: boolean;
}

interface PollerDeps {
  usageLimits: (args: { hostId?: string; refresh: boolean }) => Promise<unknown>;
  /** `hosts.list`. Without it the poller makes only the call without a host. */
  hosts?: () => Promise<readonly HostInfo[]>;
  /** `system.config().primaryHostId`. */
  primaryHostId?: () => Promise<string | null>;
  storage: Storage;
  intervalMinutes: () => Promise<number>;
  invalidate: () => void;
  /** Runs after a poll in which a host answered and was stored; must not throw. */
  afterPoll?: (hosts: readonly HostRecord[], now: number) => Promise<void>;
  now?: () => number;
  hostTimeoutMs?: number;
  /** Receives a failing host's text while another host still answers. */
  log?: { warn(message: string): void };
}

interface Backoff {
  failures: number;
  lastAttemptAt: number;
  lastError: string;
}

/** One host to poll: `hostId` undefined makes the call without a host. */
interface Target {
  key: string;
  hostId: string | undefined;
  scope: HostScope;
  label: string | null;
}

interface Fetched {
  latest: StoredLatest;
  error: string | null;
  answered: boolean;
  /** False when plugin storage failed and nothing is to be written. */
  writable: boolean;
  accounts: Map<string, string>;
}

const named = (label: string | null, text: string) => (label === null ? text : `${label}: ${text}`);

export class Poller {
  /** By host id; LEGACY_KEY while the hosts are unknown. */
  private readonly backoff = new Map<string, Backoff>();
  private inFlight: Promise<RunResult> | null = null;
  /** The last text written to the log by `tick`, so a pause is logged once. */
  private warned: string | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: PollerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The most failed polls in a row of any host. */
  get consecutiveFailures(): number {
    return Math.max(0, ...[...this.backoff.values()].map((b) => b.failures));
  }

  /**
   * Schedule entry. Throws while no connected host's last poll succeeded;
   * a host that fails or backs off while another answers is only logged.
   */
  async tick(): Promise<void> {
    const interval = await this.deps.intervalMinutes();
    const { error, paused, healthy } = await this.share(interval);
    const problems = [error, paused].filter((p): p is string => p !== null);
    if (problems.length === 0) {
      this.warned = null;
      return;
    }
    const text = problems.join("; ");
    if (!healthy) throw new Error(text);
    if (text !== this.warned) {
      this.warned = text;
      this.deps.log?.warn(`limits poll: ${text}`);
    }
  }

  /** Polls every connected host now. Concurrent calls share one request. Never throws. */
  poll(): Promise<PollResult> {
    return this.share(null);
  }

  private share(interval: number | null): Promise<RunResult> {
    this.inFlight ??= this.run(interval).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** True when the host is due; `interval` null means now. */
  private due(key: string, interval: number | null, now: number): boolean {
    const b = this.backoff.get(key);
    if (interval === null || b === undefined) return true;
    return now - b.lastAttemptAt >= backoffMinutes(b.failures, interval) * 60_000 - TICK_SLACK_MS;
  }

  private pausedText(key: string, interval: number): string | null {
    const b = this.backoff.get(key);
    if (b === undefined || b.failures === 0) return null;
    const resumeAt = new Date(b.lastAttemptAt + backoffMinutes(b.failures, interval) * 60_000).toISOString();
    return `Polling paused until ${resumeAt} after ${b.failures} failed polls: ${b.lastError}`;
  }

  private record(key: string, error: string | null, now: number): void {
    if (error === null) {
      this.backoff.set(key, { failures: 0, lastAttemptAt: now, lastError: "" });
    } else {
      this.backoff.set(key, { failures: (this.backoff.get(key)?.failures ?? 0) + 1, lastAttemptAt: now, lastError: error });
    }
  }

  private async listHosts(): Promise<HostInfo[] | null> {
    if (!this.deps.hosts) return null;
    try {
      return [...(await this.deps.hosts())];
    } catch {
      return null;
    }
  }

  /** The owner of the legacy keys, or null while it cannot be told (KTD1). */
  private async findOwner(listed: readonly HostInfo[]): Promise<string | null> {
    if (!this.deps.primaryHostId) return null;
    let primary: string | null;
    try {
      primary = await this.deps.primaryHostId();
    } catch {
      return null;
    }
    if (typeof primary === "string" && primary !== "") return primary;
    return primary === null && listed.length === 1 ? listed[0]!.id : null;
  }

  private async run(interval: number | null): Promise<RunResult> {
    const now = this.now();
    let index: HostIndex | null;
    try {
      index = await this.deps.storage.hostIndex();
    } catch (cause) {
      // Plugin storage failed: nothing was saved, the poll still counts as failed.
      const error = cleanMessage(cause);
      this.record(LEGACY_KEY, error, now);
      this.deps.invalidate();
      return { latest: { ...EMPTY_LATEST, polledAt: now, pollError: error }, error, hosts: [], paused: null, healthy: false };
    }
    const listed = await this.listHosts();
    const owner = index?.legacyOwner ?? (listed === null ? null : await this.findOwner(listed));
    if (owner === null || listed === null) return this.runSingle(index, owner, interval, now);
    return this.runHosts(index, owner, listed, interval, now);
  }

  /** The call without a host: while the hosts are unknown, or when `hosts.list` failed. */
  private async runSingle(index: HostIndex | null, owner: string | null, interval: number | null, now: number): Promise<RunResult> {
    const key = owner ?? LEGACY_KEY;
    if (!this.due(key, interval, now)) {
      return { latest: EMPTY_LATEST, error: null, hosts: [], paused: this.pausedText(key, interval!), healthy: false };
    }
    const fetched = await this.fetch({ key, hostId: undefined, scope: null, label: null }, now);
    await this.save(fetched, null, now);
    this.record(key, fetched.error, now);
    const entry = index?.hosts.find((h) => h.hostId === owner);
    if (index !== null && entry !== undefined) {
      try {
        const hosts = index.hosts.map((h) => (h === entry ? { ...h, polledAt: now, pollError: fetched.error } : h));
        await this.deps.storage.setHostIndex({ legacyOwner: index.legacyOwner, hosts });
      } catch {
        // The record itself is stored; the index catches up on the next poll.
      }
    }
    const record: HostRecord = {
      hostId: owner,
      name: entry?.name ?? null,
      primary: true,
      connected: true,
      answered: fetched.answered,
      latest: fetched.latest,
    };
    if (fetched.answered) await this.deps.afterPoll?.([record], now);
    this.deps.invalidate();
    return { latest: fetched.latest, error: fetched.error, hosts: [record], paused: null, healthy: fetched.error === null };
  }

  private async runHosts(
    index: HostIndex | null,
    owner: string,
    listed: readonly HostInfo[],
    interval: number | null,
    now: number,
  ): Promise<RunResult> {
    const { storage } = this.deps;
    const live = listed.filter((h) => h.lifecycle.phase !== "destroyed");
    const several = live.length > 1;
    const label = (h: HostInfo) => (several ? h.name : null);
    const connected = (h: HostInfo) => h.status === "connected" && h.lifecycle.phase === "active";
    const liveIds = new Set(live.map((h) => h.id));
    for (const key of [...this.backoff.keys()]) if (!liveIds.has(key)) this.backoff.delete(key);
    const healthy = () => live.some((h) => connected(h) && this.backoff.get(h.id)?.failures === 0);

    const targets = live.filter((h) => connected(h) && this.due(h.id, interval, now));
    const paused =
      interval === null
        ? null
        : live
            .filter((h) => connected(h) && !targets.includes(h))
            .map((h) => {
              const text = this.pausedText(h.id, interval);
              return text === null ? null : named(label(h), text);
            })
            .filter((t): t is string => t !== null)
            .join("; ") || null;

    const previous = new Map((index?.hosts ?? []).map((h) => [h.hostId, h]));
    const fetched = new Map<string, Fetched>();
    await Promise.all(
      targets.map(async (h) => {
        fetched.set(h.id, await this.fetch({ key: h.id, hostId: h.id, scope: scopeOf(h.id, owner), label: label(h) }, now));
      }),
    );
    if (several) groupAccounts(fetched);
    for (const h of targets) await this.save(fetched.get(h.id)!, scopeOf(h.id, owner), now);

    const entries: HostEntry[] = live.map((h) => {
      const f = fetched.get(h.id);
      const prev = previous.get(h.id);
      return {
        hostId: h.id,
        name: h.name,
        connected: connected(h),
        polledAt: f ? now : (prev?.polledAt ?? null),
        pollError: f ? f.error : (prev?.pollError ?? null),
      };
    });
    const indexChanged = index === null || JSON.stringify(index.hosts) !== JSON.stringify(entries);
    if (targets.length === 0 && !indexChanged) {
      return { latest: EMPTY_LATEST, error: null, hosts: [], paused, healthy: healthy() };
    }
    if (indexChanged) {
      try {
        const dropped = await storage.setHostIndex({ legacyOwner: owner, hosts: entries });
        const gone = [...previous.keys()].filter((id) => !liveIds.has(id)).concat(dropped);
        for (const id of gone) {
          await storage.removeHost(id);
          this.backoff.delete(id);
        }
      } catch (cause) {
        // Plugin storage failed: every host polled now counts as failed.
        const error = cleanMessage(cause);
        for (const f of fetched.values()) {
          f.error ??= error;
          f.answered = false;
        }
      }
    }
    for (const h of targets) this.record(h.id, fetched.get(h.id)!.error, now);

    const hosts: HostRecord[] = [];
    for (const h of live) {
      const f = fetched.get(h.id);
      let latest = f?.latest;
      if (latest === undefined) {
        try {
          latest = await storage.latest(scopeOf(h.id, owner));
        } catch {
          latest = EMPTY_LATEST;
        }
      }
      hosts.push({ hostId: h.id, name: h.name, primary: h.id === owner, connected: connected(h), answered: f?.answered ?? false, latest });
    }
    hosts.sort((a, b) => Number(b.primary) - Number(a.primary));
    if (hosts.some((h) => h.answered)) await this.deps.afterPoll?.(hosts, now);
    this.deps.invalidate();

    const errors = targets
      .map((h) => {
        const error = fetched.get(h.id)!.error;
        return error === null ? null : named(label(h), error);
      })
      .filter((e): e is string => e !== null);
    return {
      latest: hosts.find((h) => h.primary)?.latest ?? hosts[0]?.latest ?? EMPTY_LATEST,
      error: errors.length > 0 ? errors.join("; ") : null,
      hosts,
      paused,
      healthy: healthy(),
    };
  }

  /** Reads the host's previous record and asks bb. Never throws; writes only closed windows. */
  private async fetch(target: Target, now: number): Promise<Fetched> {
    const { storage } = this.deps;
    let previous: StoredLatest;
    try {
      previous = await storage.latest(target.scope);
    } catch (cause) {
      const error = cleanMessage(cause);
      return { latest: { ...EMPTY_LATEST, polledAt: now, pollError: error }, error, answered: false, writable: false, accounts: new Map() };
    }
    try {
      const args = target.hostId === undefined ? { refresh: true } : { hostId: target.hostId, refresh: true };
      const answer = await withTimeout(this.deps.usageLimits(args), this.deps.hostTimeoutMs ?? HOST_TIMEOUT_MS);
      const applied = await this.apply(previous, answer, now, target.scope);
      const error = pollError(applied.providers);
      return { latest: { ...applied, pollError: error }, error, answered: true, writable: true, accounts: accountKeys(answer) };
    } catch (cause) {
      const error = cleanMessage(cause);
      return { latest: { ...previous, polledAt: now, pollError: error }, error, answered: false, writable: true, accounts: new Map() };
    }
  }

  /** Stores the record; a storage failure turns it into a failed poll with nothing saved. */
  private async save(fetched: Fetched, scope: HostScope, now: number): Promise<void> {
    fetched.accounts.clear();
    if (!fetched.writable) return;
    try {
      await this.deps.storage.setLatest(fetched.latest, scope);
    } catch (cause) {
      const error = cleanMessage(cause);
      fetched.latest = { ...EMPTY_LATEST, polledAt: now, pollError: error };
      fetched.error = error;
      fetched.answered = false;
    }
  }

  private async apply(previous: StoredLatest, answer: unknown, now: number, scope: HostScope): Promise<StoredLatest> {
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
        const { status, message, planLabel, plan } = parsed.data;
        providers.push(this.notOk(providerId, before, status, message ?? null, planLabel ?? null, now, planMultiplier(plan)));
      } else {
        providers.push(await this.ok(providerId, before, parsed.data, now, scope));
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
    multiplier: number | null = null,
  ): StoredProvider {
    return {
      providerId,
      status,
      message: status === "error" ? cleanMessage(message ?? "Unknown error") : null,
      planLabel: planLabel ?? before?.planLabel ?? null,
      // Records stored before the multiplier have no such key.
      planMultiplier: multiplier ?? before?.planMultiplier ?? null,
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
    scope: HostScope,
  ): Promise<StoredProvider> {
    const { storage } = this.deps;
    const windows: LimitWindow[] = [];
    const open: Record<string, StoredWindow> = {};
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
      const reset = prevWindow && prevOpen && isNewWindow(prevWindow.resetsAt, resetsAt);
      if (reset) {
        if (prevWindow.resetsAt !== null) {
          closedWindows = await storage.appendClosedWindow(key, {
            startedAt: durationMs !== null ? prevWindow.resetsAt - durationMs : prevOpen.firstSeenAt,
            resetAt: prevWindow.resetsAt,
            peakUsedPercent: prevOpen.peakUsedPercent,
          }, scope);
        }
        open[w.label] = { peakUsedPercent: w.usedPercent, firstSeenAt: now };
      } else {
        open[w.label] = {
          peakUsedPercent: Math.max(prevOpen?.peakUsedPercent ?? w.usedPercent, w.usedPercent),
          firstSeenAt: prevOpen?.firstSeenAt ?? now,
        };
      }

      closedWindows ??= await storage.closedWindows(key, scope);
      const forecast = forecastWindow({ usedPercent: w.usedPercent, resetsAt, durationMs, now, closedWindows });
      // A new window starts without a held state.
      const pace = nextPace(reset ? null : prevOpen?.pace, rawPaceState({ usedPercent: w.usedPercent, durationMs, forecast }, now), now);
      if (pace !== null) open[w.label]!.pace = pace;
      windows.push({
        label: w.label,
        usedPercent: w.usedPercent,
        resetsAt,
        model: typeof w.model === "string" ? w.model : null,
        cost: w.cost ? { usedUsdCents: w.cost.usedUsdCents, limitUsdCents: w.cost.limitUsdCents } : null,
        durationMs,
        forecast,
        pace: pace?.state ?? null,
      });
    }

    return {
      providerId,
      status: "ok",
      message: null,
      planLabel: data.planLabel ?? null,
      planMultiplier: planMultiplier(data.plan),
      checkedAt: now,
      measuredAt: now,
      windows,
      open,
    };
  }
}

/**
 * Sets `sharedWith` on the providers of the hosts that answered: the other
 * answering hosts with the same `accountKey` for that provider. A provider
 * without a key is never grouped.
 */
function groupAccounts(fetched: ReadonlyMap<string, Fetched>): void {
  const byAccount = new Map<string, string[]>();
  for (const [hostId, f] of fetched) {
    if (!f.answered) continue;
    for (const [providerId, account] of f.accounts) {
      const key = JSON.stringify([providerId, account]);
      byAccount.set(key, [...(byAccount.get(key) ?? []), hostId]);
    }
  }
  for (const [hostId, f] of fetched) {
    if (!f.answered) continue;
    for (const provider of f.latest.providers) {
      const account = f.accounts.get(provider.providerId);
      const group = account === undefined ? [] : (byAccount.get(JSON.stringify([provider.providerId, account])) ?? []);
      const others = group.filter((id) => id !== hostId).sort();
      if (others.length > 0) provider.sharedWith = others;
      else delete provider.sharedWith;
    }
  }
}

/** Every known host's stored record, the default host first. */
export async function readHosts(storage: Storage): Promise<StoredHost[]> {
  const index = await storage.hostIndex();
  if (index === null) return [{ hostId: null, name: null, primary: true, connected: true, latest: await storage.latest() }];
  const hosts = await Promise.all(
    index.hosts.map(async (h) => ({
      hostId: h.hostId,
      name: h.name,
      primary: h.hostId === index.legacyOwner,
      connected: h.connected,
      latest: await storage.latest(scopeOf(h.hostId, index.legacyOwner)),
    })),
  );
  return hosts.sort((a, b) => Number(b.primary) - Number(a.primary));
}

/**
 * The client view of the stored state. A window whose reset has passed loses
 * its forecast, and so does every window of a host that is not connected or
 * whose last poll failed: its numbers are stale. Such a window loses its pace
 * too; a window stored before the pace state existed gets a null pace.
 */
export function toSnapshot(hosts: readonly StoredHost[], log: LimitsSnapshot["recentCompactions"], now: number): LimitsSnapshot {
  const several = hosts.length > 1;
  const out: HostLimits[] = hosts.map((h) => {
    const stale = !h.connected || h.latest.pollError !== null;
    return {
      hostId: h.hostId,
      name: h.name,
      connected: h.connected,
      primary: h.primary,
      polledAt: h.latest.polledAt,
      pollError: h.latest.pollError,
      providers: h.latest.providers.map(({ open: _open, ...provider }) => ({
        ...provider,
        planMultiplier: provider.planMultiplier ?? null,
        windows: provider.windows.map((w) =>
          stale || (w.resetsAt !== null && w.resetsAt <= now) ? { ...w, forecast: null, pace: null } : { ...w, pace: w.pace ?? null },
        ),
      })),
    };
  });
  const polled = out.map((h) => h.polledAt).filter((t): t is number => t !== null);
  const errors = out
    .filter((h) => h.pollError !== null)
    .map((h) => named(several ? h.name : null, h.pollError!));
  return {
    polledAt: polled.length > 0 ? Math.max(...polled) : null,
    pollError: errors.length > 0 ? errors.join("; ") : null,
    hosts: out,
    recentCompactions: log.slice(0, RECENT_COMPACTIONS),
  };
}
