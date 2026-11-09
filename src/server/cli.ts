// `bb usage-forecast …`. Calls the same service as the RPC.

import { cliCommand, defineCli, PluginCliError, type PluginCliRegistration } from "@get-bb/plugin-sdk";
import {
  overrideSchema,
  threadIdSchema,
  THRESHOLD_MAX_PERCENT,
  THRESHOLD_MIN_PERCENT,
  type CompactLogEntry,
  type LimitsSnapshot,
  type LimitWindow,
  type ProviderLimits,
  type ThreadState,
} from "../shared/contract";
import { formatPercent } from "../shared/thresholds";
import { showsModelTag } from "../shared/windows";
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

function formatWindow(w: LimitWindow, now: number): string {
  const model = showsModelTag(w.label, w.model) ? ` [${w.model}]` : "";
  const parts = [`${w.label}${model}: ${formatPercent(w.usedPercent)}`];
  if (w.resetsAt !== null) parts.push(w.resetsAt > now ? `resets in ${formatDuration(w.resetsAt - now)}` : "reset passed");
  if (w.cost) parts.push(`$${(w.cost.usedUsdCents / 100).toFixed(2)} of $${(w.cost.limitUsdCents / 100).toFixed(2)}`);
  const f = w.forecast;
  if (f?.status === "hit") {
    parts.push("limit reached");
  } else if (f) {
    const at: string[] = [];
    if (f.current) {
      const out = f.current.runOutAt !== null ? `, runs out in ${formatDuration(f.current.runOutAt - now)}` : "";
      at.push(`current pace ${formatPercent(f.current.projectedPercent)}${out}`);
    }
    if (f.learned) at.push(`learned pace ${formatPercent(f.learned.projectedPercent)} (${f.learned.basedOnWindows} windows)`);
    if (at.length) parts.push(`forecast at reset: ${at.join("; ")}${f.warning ? " [over 100%]" : ""}`);
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

export function formatStatus(s: LimitsSnapshot, now: number): string {
  const lines: string[] = [];
  if (s.polledAt === null) lines.push("Limits: not polled yet.");
  else lines.push(`Limits, polled ${formatTime(s.polledAt)} (${formatDuration(now - s.polledAt)} ago)`);
  if (s.pollError) lines.push(`Last poll failed: ${s.pollError}`);
  for (const p of s.providers) {
    const plan = p.planLabel ? ` (${p.planLabel})` : "";
    const status = p.status === "error" && p.message ? `error: ${p.message}` : STATUS_WORDS[p.status];
    lines.push(`  ${p.providerId}${plan}: ${status}`);
    if (p.windows.length && p.status !== "ok" && p.measuredAt !== null) {
      lines.push(`    last good data from ${formatTime(p.measuredAt)}`);
    }
    for (const w of p.windows) lines.push(formatWindow(w, now));
  }
  lines.push(s.recentCompactions.length ? "Recent compacts:" : "Recent compacts: none");
  for (const e of s.recentCompactions) lines.push(formatEntry(e));
  return lines.join("\n");
}

export function formatThread(t: ThreadState, now: number): string {
  const lines = [`Thread ${t.threadId}${t.providerId ? ` (${t.providerId})` : ""}: ${t.active ? "answering" : "idle"}`];
  const c = t.context;
  if (c) {
    const tokens = `${c.usedTokens.toLocaleString("en-US")} of ${c.windowTokens.toLocaleString("en-US")} tokens`;
    lines.push(`Context: ${formatPercent(c.percent)} (${tokens}${c.estimated ? ", estimated" : ""})`);
    const providerAt = providerCompactsAtPercent(c);
    if (providerAt !== null) lines.push(`Provider compacts on its own at ${formatPercent(providerAt)}`);
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
  lines.push(
    a.enabled
      ? `Auto-compact: on at ${formatPercent(a.thresholdPercent)}${capped} (from ${source})`
      : `Auto-compact: off (from ${source})`,
  );
  lines.push(`Override: ${t.override.autoCompact}${t.override.thresholdPercent ? ` ${t.override.thresholdPercent}%` : ""}`);
  if (t.cooldownUntil !== null) lines.push(`Cooldown: ${formatDuration(t.cooldownUntil - now)} left`);
  if (!t.compactSupported) lines.push("Compact: not supported by this provider");
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
          const before = result.entry?.beforePercent;
          return {
            exitCode: 0,
            stdout: `Compact of ${threadId} started${before == null ? "" : ` at ${formatPercent(before)}`}.`,
          };
        },
      }),
      override: cliCommand({
        summary: "Set auto-compact for one thread: inherit the settings, off, or on",
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
        },
        async run({ positionals, options }) {
          const threadId = parseThreadId(positionals.threadId);
          const parsed = overrideSchema.safeParse({ autoCompact: positionals.mode, thresholdPercent: options.threshold });
          if (!parsed.success) throw new PluginCliError("Mode must be inherit, off or on", { code: "invalid" });
          if (parsed.data.autoCompact !== "on" && options.threshold !== undefined) {
            throw new PluginCliError("--threshold applies only to on", { code: "invalid" });
          }
          const { override } = await service.setThreadOverride(threadId, parsed.data);
          const detail = override.thresholdPercent ? ` at ${override.thresholdPercent}%` : "";
          return { exitCode: 0, stdout: `Auto-compact for ${threadId}: ${override.autoCompact}${detail}.` };
        },
      }),
    },
  });
}
