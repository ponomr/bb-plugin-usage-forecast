// Formatters for the UI text: provider names, statuses, spans, token counts,
// times. Each takes the string table of the current language.

import type { CompactLogEntry, ProviderStatus } from "../shared/contract";
import { formatPercent } from "../shared/thresholds";
import { DAY_MS, HOUR_MS, MIN_MS, showsModelTag } from "../shared/windows";
import type { Strings } from "./i18n";

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export function providerName(s: Strings, providerId: string | null): string {
  if (providerId === null) return s.provider;
  return Object.hasOwn(PROVIDER_NAMES, providerId) ? PROVIDER_NAMES[providerId]! : providerId;
}

/** Why a provider has no fresh data, or null for `ok`. */
export function statusText(s: Strings, status: ProviderStatus, message: string | null = null): string | null {
  if (status === "ok") return null;
  if (status === "error" && message) return s.statusError(message);
  return s.status[status];
}

/** 90000 → "90 000" with a plain space, so the text is the same in every locale build. */
export function formatTokens(tokens: number): string {
  return String(Math.round(tokens)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** 1 000 000 → "1M", 1 500 000 → "1.5M", 190 000 → "190k", 999 → "999". */
export function shortTokens(tokens: number): string {
  const n = Math.max(0, Math.round(tokens));
  if (n < 1000) return String(n);
  const k = Math.round(n / 1000);
  if (k < 1000) return `${k}k`;
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

const DAY_MIN = DAY_MS / MIN_MS;
const HOUR_MIN = HOUR_MS / MIN_MS;

/** A span rounded to minutes: "2d 20h", "4h 17m", "23m", "<1m". */
export function formatSpan(s: Strings, ms: number): string {
  const total = Math.round(ms / MIN_MS);
  if (total < 1) return `<1${s.unit.m}`;
  const days = Math.floor(total / DAY_MIN);
  const hours = Math.floor((total % DAY_MIN) / HOUR_MIN);
  const minutes = total % HOUR_MIN;
  if (days > 0) return hours > 0 ? `${days}${s.unit.d} ${hours}${s.unit.h}` : `${days}${s.unit.d}`;
  if (hours > 0) return minutes > 0 ? `${hours}${s.unit.h} ${minutes}${s.unit.m}` : `${hours}${s.unit.h}`;
  return `${minutes}${s.unit.m}`;
}

export function formatResetIn(s: Strings, resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  if (resetsAt <= now) return s.resetNow;
  return s.resetsIn(formatSpan(s, resetsAt - now));
}

export function formatAgo(s: Strings, at: number, now: number): string {
  const ms = now - at;
  if (ms < MIN_MS) return s.justNow;
  return s.ago(formatSpan(s, ms));
}

/** Local time of day: "4:30 PM" or "16:30". */
export function formatTime(s: Strings, at: number): string {
  return new Date(at).toLocaleTimeString(s.locale, { hour: "numeric", minute: "2-digit" });
}

/** Local clock time, with the date when it is not today. */
export function formatClock(s: Strings, at: number, now: number): string {
  const date = new Date(at);
  const time = formatTime(s, at);
  if (new Date(now).toDateString() === date.toDateString()) return time;
  return `${date.toLocaleDateString(s.locale, { day: "numeric", month: "short" })}, ${time}`;
}

export function formatCost(s: Strings, cost: { usedUsdCents: number; limitUsdCents: number }): string {
  return s.cost(`$${(cost.usedUsdCents / 100).toFixed(2)}`, `$${(cost.limitUsdCents / 100).toFixed(2)}`);
}

export function compactEntryText(s: Strings, entry: CompactLogEntry): string {
  const fill =
    entry.beforePercent === null
      ? ""
      : entry.afterPercent === null
        ? ` ${formatPercent(entry.beforePercent)}`
        : ` ${formatPercent(entry.beforePercent)} → ${formatPercent(entry.afterPercent)}`;
  return `${entry.threadId} (${providerName(s, entry.providerId)}), ${s.trigger[entry.trigger]}:${fill}, ${s.result[entry.result]}`;
}


function withModel(name: string, label: string, model: string | null): string {
  return showsModelTag(label, model) ? `${name} [${model}]` : name;
}

/** "Current session" → "5 Hour"; the model tag, when any, goes in brackets. */
export function windowLabel(s: Strings, label: string, model: string | null = null): string {
  return withModel(Object.hasOwn(s.fullWindow, label) ? s.fullWindow[label]! : label, label, model);
}

/** The collapsed row's label: "Current session" → "5H"; a label with no short form, such as "Fable", → its first letter. */
export function shortWindowLabel(s: Strings, label: string, model: string | null = null): string {
  const short = Object.hasOwn(s.shortWindow, label) ? s.shortWindow[label]! : (Array.from(label)[0] ?? "").toUpperCase();
  return withModel(short, label, model);
}
