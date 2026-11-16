// `bb usage-forecast …`. Calls the same service as the RPC.

import { cliCommand, defineCli, PluginCliError, type PluginCliRegistration } from "@get-bb/plugin-sdk";
import {
  CONTEXT_LIMIT_MAX_TOKENS,
  CONTEXT_LIMIT_MIN_TOKENS,
  overrideSchema,
  threadIdSchema,
  THRESHOLD_MAX_PERCENT,
  THRESHOLD_MIN_PERCENT,
  type CompactLogEntry,
  type HostLimits,
  type LimitsSnapshot,
  type LimitWindow,
  type ProviderLimits,
  type ThreadState,
} from "../shared/contract";
import { lastingBudget, mainProjection, type LastingBudget } from "../shared/forecast";
import { forecastWarns, formatPercent } from "../shared/thresholds";
import { showsModelTag } from "../shared/windows";
import type { PaceState } from "../shared/pace";
import { accountBlocks } from "../shared/accounts";
import { planText } from "../shared/plan";
import { isHidden } from "../shared/hidden-providers";
import { headroomReport, windowVerdict, type HeadroomEntry, type HeadroomReport } from "../shared/headroom";
import { formatTokenCount, localPeriodStarts, type TokenPair } from "../shared/tokens";
import { providerCompactsAtPercent } from "./threads";
import type { Service } from "./rpc";
import type { TokenCounter, TokenThreadRow, TokenView } from "./token-counter";

const STATUS_WORDS: Record<ProviderLimits["status"], string> = {
  ok: "ok",
  not_installed: "not installed",
  unauthenticated: "not signed in",
  expired: "session expired",
  error: "error",
};

export function formatTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatBudget(b: LastingBudget): string {
  return b.per === "rest" ? `${formatPercent(b.percent)} until reset` : `${formatPercent(b.percent)}/${b.per}`;
}

/** The main projection worded as the band words it; `runs out` only strictly above 100 %. */
function formatPace(w: LimitWindow, f: NonNullable<LimitWindow["forecast"]>, now: number): string | null {
  if (f.early) return "too early to judge";
  const main = mainProjection(f);
  if (main === null) return null;
  if (!forecastWarns(main.projectedPercent)) return `at this pace lasts to reset (${formatPercent(main.projectedPercent)} at reset)`;
  // A projection above 100 % always has a run-out time; this guards a malformed forecast.
  if (main.runOutAt === null || w.resetsAt === null) return null;
  const budget = lastingBudget({ usedPercent: w.usedPercent, resetsAt: w.resetsAt, durationMs: w.durationMs, now });
  // "8h", not "8h 0m": the shortfall reads as the band's.
  const before = formatDuration(w.resetsAt - main.runOutAt).replace(/ 0[hm]$/, "");
  return `at this pace runs out ${formatTime(main.runOutAt)} (${before} before reset)${
    budget === null ? "" : `, budget ${formatBudget(budget)}`
  }`;
}

const PACE_WORDS: Record<PaceState, string> = {
  calm: "calm",
  tight: "tight",
  short: "will not last",
  critical: "critical",
  hit: "used up",
};

function formatWindow(w: LimitWindow, now: number): string {
  const model = showsModelTag(w.label, w.model) ? ` [${w.model}]` : "";
  const state = w.pace != null ? ` [${PACE_WORDS[w.pace]}]` : "";
  const parts = [`${w.label}${model}: ${formatPercent(w.usedPercent)}${state}`];
  if (w.resetsAt !== null) parts.push(w.resetsAt > now ? `resets in ${formatDuration(w.resetsAt - now)}` : "reset passed");
  if (w.cost) parts.push(`$${(w.cost.usedUsdCents / 100).toFixed(2)} of $${(w.cost.limitUsdCents / 100).toFixed(2)}`);
  const f = w.forecast;
  if (f?.status === "hit") {
    parts.push("limit reached");
  } else if (f) {
    const at: string[] = [];
    const pace = formatPace(w, f, now);
    if (pace !== null) at.push(pace);
    // The usual pace is a reference, unless it is what `pace` already worded.
    if (f.learned && (f.early || mainProjection(f) !== f.learned)) {
      at.push(`usual pace ${formatPercent(f.learned.projectedPercent)} (${f.learned.basedOnWindows} windows)`);
    }
    if (at.length) parts.push(`${at.join("; ")}${f.warning ? " [over 100%]" : ""}`);
  } else if (w.durationMs === null) {
    parts.push("no forecast: unknown window length");
  }
  return `    ${parts.join(", ")}`;
}

function formatEntry(e: CompactLogEntry): string {
  const before = e.beforePercent === null ? "?" : formatPercent(e.beforePercent);
  const after = e.afterPercent === null ? "?" : formatPercent(e.afterPercent);
  const message = e.message ? `: ${e.message}` : "";
  return `  ${formatTime(e.at)}  ${e.threadId}  ${before} -> ${after}  ${e.result} (${e.trigger})${message}`;
}

/** A host's name for the CLI. */
const n = (v: number) => v.toLocaleString("en-US");

function hostName(h: HostLimits): string {
  return h.name ?? h.hostId ?? "default host";
}

function formatProvider(lines: string[], p: ProviderLimits, now: number, on: string, hidden: readonly string[]): void {
  const name = planText(p.planLabel, p.planMultiplier);
  const plan = name === null ? "" : ` (${name})`;
  const status = p.status === "error" && p.message ? `error: ${p.message}` : STATUS_WORDS[p.status];
  const mark = isHidden(hidden, p.providerId) ? " [hidden]" : "";
  lines.push(`  ${p.providerId}${plan}${on}: ${status}${mark}`);
  if (p.windows.length && p.status !== "ok" && p.measuredAt !== null) {
    lines.push(`    last good data from ${formatTime(p.measuredAt)}`);
  }
  for (const w of p.windows) lines.push(formatWindow(w, now));
}

/** `hidden`: the parsed `hiddenProviders` setting; those providers get the mark `[hidden]`. */
export function formatStatus(s: LimitsSnapshot, now: number, hidden: readonly string[] = []): string {
  const lines: string[] = [];
  if (s.polledAt === null) lines.push("Limits: not polled yet.");
  else lines.push(`Limits, polled ${formatTime(s.polledAt)} (${formatDuration(now - s.polledAt)} ago)`);
  if (s.pollError) lines.push(`Last poll failed: ${s.pollError}`);
  if (s.hosts.length <= 1) {
    for (const p of s.hosts[0]?.providers ?? []) formatProvider(lines, p, now, "", hidden);
  } else {
    for (const block of accountBlocks(s.hosts)) {
      formatProvider(lines, block.provider, now, ` on ${block.members.map((m) => hostName(m.host)).join(", ")}`, hidden);
      for (const { host, provider } of block.members) {
        if (host.connected) continue;
        const at = provider.measuredAt ?? host.polledAt;
        lines.push(`    ${hostName(host)}: not connected${at === null ? "" : `, data from ${formatTime(at)}`}`);
      }
    }
  }
  lines.push(s.recentCompactions.length ? "Recent compacts:" : "Recent compacts: none");
  for (const e of s.recentCompactions) lines.push(formatEntry(e));
  return lines.join("\n");
}

/**
 * The snapshot for `status --json`: every window with its verdict at `now`
 * and every provider with `hidden` from the setting, added at print time.
 */
export function statusJson(s: LimitsSnapshot, now: number, hidden: readonly string[] = []) {
  return {
    ...s,
    hosts: s.hosts.map((h) => ({
      ...h,
      providers: h.providers.map((p) => ({
        ...p,
        hidden: isHidden(hidden, p.providerId),
        windows: p.windows.map((w) => ({ ...w, verdict: windowVerdict(w, now) })),
      })),
    })),
  };
}

/** What the tightest window says, after the verdict. */
function formatWorst(e: HeadroomEntry, now: number): string {
  const w = e.worstWindow;
  if (w === null) {
    if (e.status === "ok") return "no current windows";
    return e.status === "error" && e.message ? `error: ${e.message}` : STATUS_WORDS[e.status];
  }
  const model = showsModelTag(w.label, w.model) ? ` [${w.model}]` : "";
  const head = `${w.label}${model} ${formatPercent(w.usedPercent)}`;
  const resets = w.resetsInMs === null ? [] : [`resets in ${formatDuration(w.resetsInMs)}`];
  if (e.verdict === "hit") {
    return `${head}, limit reached${e.availableAt === null ? "" : `, available again in ${formatDuration(e.availableAt - now)}`}`;
  }
  if (e.verdict === "short" || e.verdict === "critical") {
    const out = w.runsOutAt === null ? "will not last to the reset" : `runs out in ${formatDuration(w.runsOutAt - now)}`;
    return [head, out, ...resets].join(", ");
  }
  if (w.state === "early") return [head, "too early to judge", ...resets].join(", ");
  if (w.projectedPercent === null) return [head, ...resets].join(", ");
  const at = w.resetsInMs === null ? "at reset" : `at reset in ${formatDuration(w.resetsInMs)}`;
  return `${head}, on pace for ${formatPercent(w.projectedPercent)} ${at}`;
}

export function formatHeadroom(r: HeadroomReport, s: LimitsSnapshot, now: number): string {
  if (r.polledAt === null) return "Headroom: not polled yet.";
  const lines = [`Headroom, polled ${formatTime(r.polledAt)} (${formatDuration(now - r.polledAt)} ago)`];
  if (r.stale) lines.push(`Stale: data is ${formatDuration(r.ageMs ?? 0)} old; run with --refresh to poll now.`);
  const several = s.hosts.length > 1;
  r.entries.forEach((e, i) => {
    const on = several ? ` on ${e.hosts.map((h) => h.hostName ?? h.hostId ?? "default host").join(", ")}` : "";
    const name = planText(e.planLabel, e.planMultiplier);
    const plan = name === null ? "" : ` (${name})`;
    // The whole report's stale line already covers an old poll; this marks one old account, as on a host that is not connected.
    const old = e.stale && !r.stale && e.measuredAt !== null ? `; measured ${formatDuration(now - e.measuredAt)} ago` : "";
    lines.push(`  ${i + 1}. ${e.providerId}${on}${plan}: ${e.verdict} – ${formatWorst(e, now)}${old}`);
  });
  if (r.entries.length === 0) lines.push("  No providers to rank.");
  if (r.hidden.length > 0) lines.push(`hidden: ${r.hidden.join(", ")}`);
  return lines.join("\n");
}

/**
 * What `--host` or `--thread` limits `headroom` to: the host id (undefined for
 * every host) and, for `--thread`, the thread's own provider, which stays in
 * the ranking when hidden, as in the band.
 */
async function headroomTarget(
  service: Service,
  s: LimitsSnapshot,
  host: string | undefined,
  thread: string | undefined,
  hidden: readonly string[],
): Promise<{ hostId: string | undefined; keep: string | null }> {
  if (thread === undefined) return { hostId: headroomHost(s, host), keep: null };
  const threadId = parseThreadId(thread);
  // One host answers for every thread; the thread is read only to keep its hidden provider.
  if (s.hosts.length <= 1) {
    if (hidden.length === 0) return { hostId: undefined, keep: null };
    return { hostId: undefined, keep: (await service.thread(threadId)).providerId ?? null };
  }
  const state = await service.thread(threadId);
  if (state.hostId === null) throw new PluginCliError(`Could not resolve the host of thread ${threadId}`, { code: "not_found" });
  if (!s.hosts.some((h) => h.hostId === state.hostId)) {
    throw new PluginCliError(`The host of thread ${threadId} has no limits yet`, { code: "not_found" });
  }
  return { hostId: state.hostId, keep: state.providerId ?? null };
}

/** The host id `--host` limits `headroom` to; undefined for every host. */
function headroomHost(s: LimitsSnapshot, host: string | undefined): string | undefined {
  if (host === undefined) return undefined;
  const lower = host.toLowerCase();
  const found = s.hosts.find((h) => h.hostId === host) ?? s.hosts.find((h) => h.name?.toLowerCase() === lower);
  if (found === undefined) {
    const known = s.hosts.map(hostName).join(", ") || "none";
    throw new PluginCliError(`Unknown host "${host}"; known hosts: ${known}`, { code: "not_found" });
  }
  return found.hostId ?? undefined;
}

export function formatThread(t: ThreadState, now: number): string {
  const lines = [`Thread ${t.threadId}${t.providerId ? ` (${t.providerId})` : ""}: ${t.active ? "answering" : "idle"}`];
  const c = t.context;
  if (c) {
    const tokens = `${c.estimated ? "~" : ""}${n(c.usedTokens)} of ${n(c.limitTokens)} tokens`;
    lines.push(`Context: ${formatPercent(c.percent)} (${tokens}${c.estimated ? ", estimated" : ""})`);
    const providerName = t.providerId ?? "provider";
    const limitFrom = {
      thread: "from this thread",
      provider: `from the ${providerName} setting`,
      reported: `where ${providerName} compacts on its own`,
      settings: "from the global setting",
      window: "the model window",
    }[c.limitSource];
    lines.push(`Limit: ${n(c.limitTokens)} tokens (${limitFrom}), window ${n(c.windowTokens)}`);
    const providerAt = providerCompactsAtPercent(c);
    if (providerAt !== null && c.autoCompactAtTokens !== null) {
      lines.push(`Provider compacts on its own at ${n(c.autoCompactAtTokens)} tokens (${formatPercent(providerAt)} of the window)`);
    }
    for (const cat of c.categories.filter((x) => x.kind === "used" && x.tokens > 0)) {
      lines.push(`  ${cat.label}: ${n(cat.tokens)}`);
    }
  } else {
    lines.push("Context: no measurement yet");
  }
  const a = t.autoCompact;
  const source = a.source === "thread" ? "this thread" : "settings";
  const capped =
    a.effectiveThresholdPercent !== a.thresholdPercent ? `, acts at ${formatPercent(a.effectiveThresholdPercent)}` : "";
  const atTokens = a.effectiveThresholdTokens === null ? "" : ` = ${n(a.effectiveThresholdTokens)} tokens`;
  lines.push(
    a.enabled
      ? `Auto-compact: on at ${formatPercent(a.thresholdPercent)}${capped}${atTokens} (from ${source})`
      : `Auto-compact: off (from ${source})`,
  );
  const limitOverride = t.override.limitTokens === undefined ? "" : `, limit ${n(t.override.limitTokens)} tokens`;
  lines.push(`Override: ${t.override.autoCompact}${t.override.thresholdPercent ? ` ${t.override.thresholdPercent}%` : ""}${limitOverride}`);
  if (t.cooldownUntil !== null) lines.push(`Cooldown: ${formatDuration(t.cooldownUntil - now)} left`);
  if (!t.compactSupported) {
    lines.push(
      t.summaryClear
        ? "Compact: not supported by this provider; compact summarises and clears the context instead"
        : "Compact: not supported by this provider",
    );
  }
  return lines.join("\n");
}

function parseThreadId(value: string): string {
  const parsed = threadIdSchema.safeParse(value);
  if (!parsed.success) throw new PluginCliError("Thread id must be 1-128 characters", { code: "invalid" });
  return parsed.data;
}

// --- Tokens ------------------------------------------------------------------

/** Threads listed by `tokens`, most recently updated first. */
export const TOKENS_RECENT_THREADS = 10;

/** What `tokens` reads: the counter, and the process's time zone. */
export interface CliTokens {
  counter: Pick<TokenCounter, "view" | "recentThreads" | "backfillState">;
  /** IANA name of the time zone the day and month starts are in. */
  timeZone?: () => string;
  /** Local day and month starts of `now`; the process's local time by default. */
  periods?: (now: number) => { dayStart: number; monthStart: number };
}

export interface TokensReport {
  timeZone: string;
  dayStart: number;
  monthStart: number;
  providers: TokenView["providers"];
  threads: TokenThreadRow[];
  backfill: { done: boolean; threadsRead: number; threadsFailed: number };
}

export async function tokensReport(tokens: CliTokens, now: number): Promise<TokensReport> {
  const { dayStart, monthStart } = (tokens.periods ?? localPeriodStarts)(now);
  const [view, threads, backfill] = await Promise.all([
    tokens.counter.view(null, dayStart, monthStart),
    tokens.counter.recentThreads(TOKENS_RECENT_THREADS),
    tokens.counter.backfillState(),
  ]);
  return {
    timeZone: (tokens.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone))(),
    dayStart,
    monthStart,
    providers: view.providers,
    threads,
    backfill: { done: backfill.done, threadsRead: backfill.threadsRead, threadsFailed: backfill.threadsFailed },
  };
}

const pairText = (p: TokenPair) => `${formatTokenCount(p.work, "en")} (${formatTokenCount(p.all, "en")})`;

export function formatTokensReport(r: TokensReport): string {
  const collecting = r.backfill.done
    ? []
    : [`First collection of past threads is running: ${r.backfill.threadsRead} read, ${r.backfill.threadsFailed} failed.`];
  if (r.providers.length === 0 && r.threads.length === 0) return ["No token data yet.", ...collecting].join("\n");
  const lines = [`Tokens in BB threads without cache reads (with them in brackets); day and month in ${r.timeZone}.`];
  for (const p of r.providers) lines.push(`  ${p.providerId}: today ${pairText(p.today)}, month ${pairText(p.month)}`);
  if (r.threads.length > 0) {
    lines.push("Recent threads:");
    for (const t of r.threads) lines.push(`  ${t.threadId} ${t.providerId} ${formatTokenCount(t.work, "en")}`);
  }
  lines.push(...collecting);
  return lines.join("\n");
}

/**
 * `hidden` reads the parsed `hiddenProviders` setting: `status` marks those
 * providers and `headroom` leaves them out. Without `tokens` there is no
 * `tokens` command.
 */
export function createCli(
  service: Service,
  now: () => number = Date.now,
  hidden: () => Promise<readonly string[]> = async () => [],
  tokens: CliTokens | null = null,
): PluginCliRegistration {
  const json = { json: { type: "boolean", description: "Print JSON" } } as const;
  return defineCli({
    name: "usage-forecast",
    summary: "Provider usage limits with forecasts, thread context and auto-compact",
    description:
      "Limits come from bb (system.usageLimits) and are polled on the server. Auto-compact runs when a thread goes idle with its context at or above the threshold.",
    commands: {
      status: cliCommand({
        summary: "Show limits of every provider, forecasts and the last compacts",
        options: {
          ...json,
          refresh: { type: "boolean", description: "Poll the providers now instead of showing the stored data" },
        },
        async run({ options }) {
          const snapshot = options.refresh ? await service.refresh() : await service.snapshot();
          const at = now();
          const ids = await hidden();
          return {
            exitCode: 0,
            stdout: options.json ? JSON.stringify(statusJson(snapshot, at, ids), null, 2) : formatStatus(snapshot, at, ids),
          };
        },
      }),
      headroom: cliCommand({
        summary: "Rank providers from the most headroom to the tightest",
        description:
          "One entry per provider account with a verdict (headroom, tight, short, critical, hit, unknown) from its tightest window. Data polled more than 30 minutes ago is marked stale.",
        options: {
          ...json,
          refresh: { type: "boolean", description: "Poll the providers now instead of using the stored data" },
          host: { type: "string", description: "Only accounts on this host (id or name)" },
          thread: { type: "string", description: "Only accounts on this thread's host" },
        },
        async run({ options }) {
          if (options.host !== undefined && options.thread !== undefined) {
            throw new PluginCliError("Give either --host or --thread, not both", { code: "invalid" });
          }
          const snapshot = options.refresh ? await service.refresh() : await service.snapshot();
          const at = now();
          const ids = await hidden();
          const { hostId, keep } = await headroomTarget(service, snapshot, options.host, options.thread, ids);
          const report = headroomReport(snapshot, at, { hostId, hidden: ids, keep });
          return { exitCode: 0, stdout: options.json ? JSON.stringify(report, null, 2) : formatHeadroom(report, snapshot, at) };
        },
      }),
      thread: cliCommand({
        summary: "Show a thread's context fill and its auto-compact settings",
        positionals: [{ name: "threadId", description: "thread id", required: true }],
        options: json,
        async run({ positionals, options }) {
          const state = await service.thread(parseThreadId(positionals.threadId));
          return { exitCode: 0, stdout: options.json ? JSON.stringify(state, null, 2) : formatThread(state, now()) };
        },
      }),
      compact: cliCommand({
        summary: "Compact a thread now",
        positionals: [{ name: "threadId", description: "thread id", required: true }],
        async run({ positionals }) {
          const threadId = parseThreadId(positionals.threadId);
          const result = await service.compact(threadId);
          if (!result.ok) throw new PluginCliError(result.message ?? "Compact failed", { code: "failed" });
          // Summary and clear runs in the background and returns no entry, only its message.
          if (result.entry === null && result.message !== null) return { exitCode: 0, stdout: `${threadId}: ${result.message}.` };
          const before = result.entry?.beforePercent;
          return {
            exitCode: 0,
            stdout: `Compact of ${threadId} started${before == null ? "" : ` at ${formatPercent(before)}`}.`,
          };
        },
      }),
      ...(tokens === null
        ? {}
        : {
            tokens: cliCommand({
              summary: "Show tokens spent in BB threads today, this month and per thread",
              description:
                "Counted from bb's token-usage events of each thread, without cache reads; the full sums are in brackets and in --json. Covers BB threads only. Today and this month are in the server's time zone.",
              options: json,
              async run({ options }) {
                const report = await tokensReport(tokens, now());
                return { exitCode: 0, stdout: options.json ? JSON.stringify(report, null, 2) : formatTokensReport(report) };
              },
            }),
          }),
      override: cliCommand({
        summary: "Set auto-compact and the context limit for one thread",
        description:
          "Mode inherit, off or on sets auto-compact for the thread. --limit sets the thread's working context limit in tokens, ahead of the provider and global limits (0 returns to them); without --limit the stored limit is kept.",
        positionals: [
          { name: "threadId", description: "thread id", required: true },
          { name: "mode", description: "inherit, off or on", required: true },
        ],
        options: {
          threshold: {
            type: "integer",
            min: THRESHOLD_MIN_PERCENT,
            max: THRESHOLD_MAX_PERCENT,
            description: `Threshold in percent for "on" (${THRESHOLD_MIN_PERCENT}-${THRESHOLD_MAX_PERCENT})`,
          },
          limit: {
            type: "integer",
            min: 0,
            max: CONTEXT_LIMIT_MAX_TOKENS,
            description: `Working context limit in tokens for this thread (${CONTEXT_LIMIT_MIN_TOKENS}-${CONTEXT_LIMIT_MAX_TOKENS}); 0 returns to the provider and global limits`,
          },
        },
        async run({ positionals, options }) {
          const threadId = parseThreadId(positionals.threadId);
          if (options.limit !== undefined && options.limit !== 0 && options.limit < CONTEXT_LIMIT_MIN_TOKENS) {
            throw new PluginCliError(`--limit must be 0 or ${CONTEXT_LIMIT_MIN_TOKENS}-${CONTEXT_LIMIT_MAX_TOKENS}`, { code: "invalid" });
          }
          // Without --limit the thread keeps its stored limit.
          const stored = options.limit === undefined ? (await service.thread(threadId)).override.limitTokens : undefined;
          const limitTokens = options.limit === undefined ? stored : options.limit === 0 ? undefined : options.limit;
          const parsed = overrideSchema.safeParse({ autoCompact: positionals.mode, thresholdPercent: options.threshold, limitTokens });
          if (!parsed.success) throw new PluginCliError("Mode must be inherit, off or on", { code: "invalid" });
          if (parsed.data.autoCompact !== "on" && options.threshold !== undefined) {
            throw new PluginCliError("--threshold applies only to on", { code: "invalid" });
          }
          const { override } = await service.setThreadOverride(threadId, parsed.data);
          const detail = override.thresholdPercent ? ` at ${override.thresholdPercent}%` : "";
          const limit = override.limitTokens === undefined ? "" : ` Context limit: ${n(override.limitTokens)} tokens.`;
          return { exitCode: 0, stdout: `Auto-compact for ${threadId}: ${override.autoCompact}${detail}.${limit}` };
        },
      }),
    },
  });
}
