// Pure view logic for the band: which provider it shows, each window's pace
// status, the headline, and the context bar segments. The headline and pace
// rules follow the band of claude-code-usage-quota-mod (see NOTICE).

import type { HostLimits, LimitsSnapshot, LimitWindow, ProviderLimits, ThreadContext } from "../shared/contract";
import { contextTone, forecastWarns, limitTone, paceTone, worseTone, type Tone } from "../shared/thresholds";
import { shownPercent, type LimitsShow } from "../shared/limits-show";
import { lastingBudget, mainProjection } from "../shared/forecast";
import { DAY_MS } from "../shared/windows";
import { formatClock, formatResetIn, formatRunOut, formatSpan, formatTime, providerName, statusText } from "./format";
import type { Strings } from "./i18n";

// --- Which provider --------------------------------------------------------

/** The higher of the used percent and the current-pace projection. */
function windowScore(window: LimitWindow): number {
  const projected = window.forecast?.current?.projectedPercent ?? null;
  return projected === null ? window.usedPercent : Math.max(window.usedPercent, projected);
}

/**
 * The provider of the worst window: the highest score, and on a tie the window
 * that resets later, since it stays a problem longer.
 */
export function worstProvider(providers: readonly ProviderLimits[]): ProviderLimits | null {
  let worst: { provider: ProviderLimits; score: number; resetsAt: number } | null = null;
  for (const provider of providers) {
    for (const window of provider.windows) {
      const score = windowScore(window);
      const resetsAt = window.resetsAt ?? -Infinity;
      if (worst === null || score > worst.score || (score === worst.score && resetsAt > worst.resetsAt)) {
        worst = { provider, score, resetsAt };
      }
    }
  }
  return worst?.provider ?? null;
}

export type BannerView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "reasons"; text: string }
  /**
   * `primary` is the thread's provider when it has windows, else the worst
   * one. `staleSince` is the time of the host's last good data while the host
   * is disconnected or its last poll failed, else null.
   */
  | { kind: "limits"; primary: ProviderLimits; others: ProviderLimits[]; staleSince: number | null };

/** One line of reasons, e.g. "Claude Code: sign-in expired · Codex: not installed". */
export function reasonsLine(s: Strings, providers: readonly ProviderLimits[]): string {
  return providers
    .map((p) => `${providerName(s, p.providerId)}: ${statusText(s, p.status, p.message) ?? s.noWindows}`)
    .join(" · ");
}

/** Every provider of the hosts once, as the first host (the default one) reports it. */
export function providersOfHosts(hosts: readonly HostLimits[]): ProviderLimits[] {
  const seen = new Map<string, ProviderLimits>();
  for (const h of hosts) for (const p of h.providers) if (!seen.has(p.providerId)) seen.set(p.providerId, p);
  return [...seen.values()];
}

/**
 * The host record a thread reads its limits from, `"unknown"` when no record
 * may be shown, or `"loading"` while the thread's host is not known yet and
 * several hosts are. `threadHostId` is undefined while the thread state loads.
 * A single record without a host id (hosts not known yet) serves every thread;
 * a thread whose host did not resolve uses the only host when there is one; a
 * resolved host without a record is unknown, never another host's windows.
 */
export function threadHost(
  hosts: readonly HostLimits[],
  threadHostId: string | null | undefined,
): HostLimits | "unknown" | "loading" {
  const only = hosts.length === 1 ? hosts[0]! : null;
  if (only !== null && only.hostId === null) return only;
  if (threadHostId === undefined) return only ?? (hosts.length === 0 ? "unknown" : "loading");
  if (threadHostId === null) return only ?? "unknown";
  return hosts.find((h) => h.hostId === threadHostId) ?? "unknown";
}

/** True when a host's values are not current: it is disconnected or its last poll failed. */
export function hostStale(host: HostLimits): boolean {
  return !host.connected || host.pollError !== null;
}

/** The time of a host's newest measured data, else its last poll. */
function dataTime(host: HostLimits): number | null {
  const measured = host.providers.map((p) => p.measuredAt).filter((t): t is number => t !== null);
  return measured.length > 0 ? Math.max(...measured) : host.polledAt;
}

export function bannerView(
  s: Strings,
  snapshot: LimitsSnapshot | undefined,
  errorMessage: string | null,
  thread: { providerId: string | null; hostId: string | null } | undefined,
  now: number,
): BannerView {
  if (snapshot === undefined) return errorMessage === null ? { kind: "loading" } : { kind: "error", message: errorMessage };
  if (snapshot.polledAt === null) return { kind: "empty" };
  const host = threadHost(snapshot.hosts, thread?.hostId);
  if (host === "loading") return { kind: "loading" };
  if (host === "unknown") return { kind: "reasons", text: s.hostUnknown };
  if (host.polledAt === null) return { kind: "empty" };
  const stale = hostStale(host);
  // A stale host shows no forecast as current (the server drops them too).
  const providers = stale
    ? host.providers.map((p) => ({ ...p, windows: p.windows.map((w) => ({ ...w, forecast: null })) }))
    : host.providers;
  const staleSince = stale ? dataTime(host) : null;
  const primary =
    providers.find((p) => p.providerId === (thread?.providerId ?? null) && p.windows.length > 0) ?? worstProvider(providers);
  if (primary !== null) return { kind: "limits", primary, others: providers.filter((p) => p !== primary), staleSince };
  if (!host.connected) return { kind: "reasons", text: s.hostStale(formatClock(s, staleSince ?? host.polledAt, now)) };
  if (providers.length === 0) {
    return host.pollError === null ? { kind: "reasons", text: s.noProviders } : { kind: "error", message: host.pollError };
  }
  return { kind: "reasons", text: reasonsLine(s, providers) };
}

// --- Windows -----------------------------------------------------------------

/**
 * `hit`: the limit is used up. `out`: on course to run out before the reset.
 * `ok`: on course to reach the reset. `early`: too early in the window to
 * judge; it never warns. `idle`: no forecast (unknown duration or no reset time).
 */
export type WindowStatus = "hit" | "out" | "ok" | "early" | "idle";

export interface WindowView {
  window: LimitWindow;
  status: WindowStatus;
  /** Projected percent at the reset by the main projection; for `early`, the learned one. */
  projected: number | null;
  runOutAt: number | null;
  tone: Tone;
  /** Where the bar's forecast tick sits, in percent, or null for none. */
  marker: number | null;
}

export function windowView(window: LimitWindow): WindowView {
  const used = window.usedPercent;
  const f = window.forecast;
  const base = { window, projected: null, runOutAt: null, marker: null };
  if (used >= 100 || f?.status === "hit") return { ...base, status: "hit", tone: "red" };
  if (f?.early) return { ...base, status: "early", projected: f.learned?.projectedPercent ?? null, tone: limitTone(used) };
  const pace = f ? mainProjection(f) : null;
  if (pace === null) return { ...base, status: "idle", tone: limitTone(used) };
  const projected = pace.projectedPercent;
  const at = Math.min(100, projected);
  const view = { window, projected, runOutAt: pace.runOutAt, marker: at - used >= 1 ? at : null };
  if (forecastWarns(projected)) return { ...view, status: "out", tone: worseTone(limitTone(used), paceTone(projected)) };
  return { ...view, status: "ok", tone: limitTone(used) };
}

export function isWeekly(window: LimitWindow): boolean {
  return window.label === "Weekly limit" || (window.durationMs ?? 0) >= 7 * DAY_MS;
}

/** The note under a window: what its pace means before the reset, as used or as left. */
export function windowNote(s: Strings, view: WindowView, now: number, show: LimitsShow = "used"): string {
  const reset = formatResetIn(s, view.window.resetsAt, now);
  // A projection as the note shows it: capped at 100 %, used or left.
  const shown = (projected: number) => Math.round(shownPercent(show, Math.min(100, projected)));
  const lasts = (projected: number) => (show === "used" ? s.lastsUsed : s.lastsLeft)(shown(projected), reset);
  const idle = reset === null ? s.noReset : `${s.noForecast} – ${reset}`;
  switch (view.status) {
    case "hit":
      return s.hitNote(reset);
    case "out": {
      const resetsAt = view.window.resetsAt;
      // A projection above 100 % always has a run-out time; this guards a malformed forecast.
      if (view.runOutAt === null || resetsAt === null) return idle;
      const { time, weekday } = formatRunOut(s, view.runOutAt, now);
      return s.runsOut(time, weekday, formatSpan(s, Math.max(0, resetsAt - view.runOutAt)));
    }
    case "ok":
      return lasts(view.projected!);
    case "early": {
      const usual = view.projected === null ? null : (show === "used" ? s.usuallyUsed : s.usuallyLeft)(shown(view.projected));
      return s.tooEarly(usual, reset);
    }
    case "idle":
      return idle;
  }
}

/** The budget line under a window that runs out: the rate that lasts to the reset, or null. */
export function windowBudget(s: Strings, view: WindowView, now: number): string | null {
  if (view.status !== "out") return null;
  const { usedPercent, resetsAt, durationMs } = view.window;
  const budget = lastingBudget({ usedPercent, resetsAt, durationMs, now });
  return budget === null ? null : s.budget(Math.round(budget.percent), budget.per);
}

/** Both projections, for the window's tooltip. */
export function paceDetails(s: Strings, window: LimitWindow, show: LimitsShow = "used"): string | undefined {
  const f = window.forecast;
  if (f === null || f.status === "hit") return undefined;
  const pct = (projected: number) => {
    const text = `${Math.round(shownPercent(show, projected))}%`;
    return show === "used" ? text : s.percentLeft(text);
  };
  const main = mainProjection(f);
  const both = f.current !== null && f.learned !== null;
  // With both lines, the one the band speaks from is marked.
  const mark = (line: string, p: object) => (both && p === main ? s.mainPace(line) : line);
  const lines: string[] = [];
  if (f.current !== null) lines.push(mark(s.currentPace(pct(f.current.projectedPercent)), f.current));
  if (f.learned !== null) lines.push(mark(s.usualPace(pct(f.learned.projectedPercent), f.learned.basedOnWindows), f.learned));
  return lines.length === 0 ? undefined : lines.join("\n");
}

// --- Headline ----------------------------------------------------------------

export interface Headline {
  text: string;
  tone: Tone;
}

/** "the 4:30 PM reset" within a day, else "Wednesday's reset". */
export function resetName(s: Strings, at: number, now: number): string {
  return at - now < DAY_MS ? s.resetAtTime(formatTime(s, at)) : s.resetOnDay(new Date(at).getDay());
}

function resumesAt(s: Strings, at: number, now: number): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return s.resumesAt(formatTime(s, at), sameDay ? null : new Date(at).getDay());
}

/**
 * Limit reached (when usage resumes), else the window that runs out first,
 * else on track to the weekly reset. Null when no window has a forecast.
 */
export function headline(s: Strings, views: readonly WindowView[], now: number): Headline | null {
  const hit = views.filter((v) => v.status === "hit");
  if (hit.length > 0) {
    const resets = hit.map((v) => v.window.resetsAt).filter((at): at is number => at !== null);
    const at = resets.length === hit.length ? Math.max(...resets) : null;
    return { text: s.limitReached(at === null ? null : resumesAt(s, at, now)), tone: "red" };
  }
  const out = views
    .filter((v) => v.status === "out" && v.window.resetsAt !== null)
    .sort((a, b) => (a.runOutAt ?? Infinity) - (b.runOutAt ?? Infinity));
  if (out.length > 0) return { text: s.willRunOut(resetName(s, out[0]!.window.resetsAt!, now)), tone: out[0]!.tone };
  const ok = views.filter((v) => v.status === "ok" && v.window.resetsAt !== null);
  const lead = ok.find((v) => isWeekly(v.window)) ?? ok[0];
  return lead === undefined ? null : { text: s.onTrack(resetName(s, lead.window.resetsAt!, now)), tone: "normal" };
}

// --- Context -----------------------------------------------------------------

export type SegmentKey = "messages" | "tools" | "other" | "used";

export interface ContextView {
  /** Of the working limit. */
  percent: number;
  tone: Tone;
  estimated: boolean;
  usedTokens: number;
  /** The working limit: the bar's full width. */
  limitTokens: number;
  /** The model window, shown when it is larger than the limit. */
  windowTokens: number;
  /** Free tokens below the limit (and the buffer). */
  freeTokens: number;
  /** Used parts left to right; one `used` part when the provider gives no breakdown. */
  segments: { key: SegmentKey; tokens: number }[];
  /** The part of the reserved tokens (Claude Code's auto-compact buffer) that falls inside the limit, drawn at the right end. */
  bufferTokens: number;
}

const TOOL_LABELS = new Set(["System tools", "MCP tools"]);

function groupOf(label: string): Exclude<SegmentKey, "used"> {
  if (label === "Messages") return "messages";
  return TOOL_LABELS.has(label) ? "tools" : "other";
}

export function contextView(ctx: ThreadContext): ContextView {
  const sums = { messages: 0, tools: 0, other: 0 };
  let bufferTokens = 0;
  let free: number | null = null;
  for (const c of ctx.categories) {
    if (c.tokens <= 0) continue;
    if (c.kind === "used") sums[groupOf(c.label)] += c.tokens;
    else if (c.kind === "reserved") bufferTokens += c.tokens;
    else if (c.kind === "free") free = (free ?? 0) + c.tokens;
  }
  const grouped = (["messages", "tools", "other"] as const)
    .filter((key) => sums[key] > 0)
    .map((key) => ({ key, tokens: sums[key] }));
  // The buffer sits at the top of the window; only its part below the limit is shown.
  const shownBuffer = Math.max(0, ctx.limitTokens - (ctx.windowTokens - bufferTokens));
  const freeInLimit = Math.max(0, ctx.limitTokens - ctx.usedTokens - shownBuffer);
  return {
    percent: ctx.percent,
    tone: contextTone(ctx.percent),
    estimated: ctx.estimated,
    usedTokens: ctx.usedTokens,
    limitTokens: ctx.limitTokens,
    windowTokens: ctx.windowTokens,
    freeTokens: free === null ? freeInLimit : Math.min(free, freeInLimit),
    segments: grouped.length > 0 ? grouped : [{ key: "used", tokens: ctx.usedTokens }],
    bufferTokens: shownBuffer,
  };
}
