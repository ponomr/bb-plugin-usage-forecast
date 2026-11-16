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
import { providerCompactsAtPercent } from "./threads";
import type { Service } from "./rpc";

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
function hostName(h: HostLimits): string {
  return h.name ?? h.hostId ?? "default host";
}

function formatProvider(lines: string[], p: ProviderLimits, now: number, on: string): void {
  const plan = p.planLabel ? ` (${p.planLabel})` : "";
  const status = p.status === "error" && p.message ? `error: ${p.message}` : STATUS_WORDS[p.status];
  lines.push(`  ${p.providerId}${plan}${on}: ${status}`);
  if (p.windows.length && p.status !== "ok" && p.measuredAt !== null) {
    lines.push(`    last good data from ${formatTime(p.measuredAt)}`);
  }
  for (const w of p.windows) lines.push(formatWindow(w, now));
}

export function formatStatus(s: LimitsSnapshot, now: number): string {
  const lines: string[] = [];
  if (s.polledAt === null) lines.push("Limits: not polled yet.");
  else lines.push(`Limits, polled ${formatTime(s.polledAt)} (${formatDuration(now - s.polledAt)} ago)`);
  if (s.pollError) lines.push(`Last poll failed: ${s.pollError}`);
  if (s.hosts.length <= 1) {
    for (const p of s.hosts[0]?.providers ?? []) formatProvider(lines, p, now, "");
  } else {
    for (const block of accountBlocks(s.hosts)) {
      formatProvider(lines, block.provider, now, ` on ${block.members.map((m) => hostName(m.host)).join(", ")}`);
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

export function formatThread(t: ThreadState, now: number): string {
  const lines = [`Thread ${t.threadId}${t.providerId ? ` (${t.providerId})` : ""}: ${t.active ? "answering" : "idle"}`];
  const c = t.context;
  if (c) {
    const n = (v: number) => v.toLocaleString("en-US");
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
      lines.push(`  ${cat.label}: ${cat.tokens.toLocaleString("en-US")}`);
    }
  } else {
    lines.push("Context: no measurement yet");
  }
  const a = t.autoCompact;
  const source = a.source === "thread" ? "this thread" : "settings";
  const capped =
    a.effectiveThresholdPercent !== a.thresholdPercent ? `, acts at ${formatPercent(a.effectiveThresholdPercent)}` : "";
  const atTokens = a.effectiveThresholdTokens === null ? "" : ` = ${a.effectiveThresholdTokens.toLocaleString("en-US")} tokens`;
  lines.push(
    a.enabled
      ? `Auto-compact: on at ${formatPercent(a.thresholdPercent)}${capped}${atTokens} (from ${source})`
      : `Auto-compact: off (from ${source})`,
  );
  const limitOverride = t.override.limitTokens === undefined ? "" : `, limit ${t.override.limitTokens.toLocaleString("en-US")} tokens`;
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

export function createCli(service: Service, now: () => number = Date.now): PluginCliRegistration {
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
          return { exitCode: 0, stdout: options.json ? JSON.stringify(snapshot, null, 2) : formatStatus(snapshot, now()) };
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
          const limit = override.limitTokens === undefined ? "" : ` Context limit: ${override.limitTokens.toLocaleString("en-US")} tokens.`;
          return { exitCode: 0, stdout: `Auto-compact for ${threadId}: ${override.autoCompact}${detail}.${limit}` };
        },
      }),
    },
  });
}
