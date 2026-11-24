// Pure view logic for the sidebar-footer indicator: the worst window across
// every host, which the ring draws, and the providers grouped by host, which
// the card lists, one host per tab. A provider shared by several hosts
// (`sharedWith`) is one account: every one of its hosts lists it, from its
// newest answer, and the ring counts it once.

import type { HostLimits, LimitsSnapshot, ProviderLimits } from "../shared/contract";
import { paceRank, type PaceState } from "../shared/pace";
import { formatPercent, type Tone } from "../shared/thresholds";
import { formatClock, providerName, windowLabel } from "./format";
import type { Strings } from "./i18n";
import { hostStale, windowView, withoutForecast } from "./model";
import { accountGroups } from "../shared/accounts";
import { isHidden } from "../shared/hidden-providers";

export interface WorstWindow {
  /** The host the window is listed under; null when only one host is known. */
  hostName: string | null;
  providerId: string;
  label: string;
  model: string | null;
  usedPercent: number;
  resetsAt: number | null;
  /** The shown pace state; null for a window without a current pace. */
  state: PaceState | null;
  tone: Tone;
  /** P4: when the window's data comes from a host that cannot be read now, the time it was measured; else null. */
  staleAt: number | null;
}

export interface IndicatorProvider {
  provider: ProviderLimits;
  /** The other hosts that share this provider's account. */
  alsoOn: string[];
}

export interface IndicatorGroup {
  hostId: string | null;
  hostName: string;
  providers: IndicatorProvider[];
}

export interface IndicatorView {
  worst: WorstWindow | null;
  groups: IndicatorGroup[];
  /** True when more than one host is known: the card shows one host at a time, picked by tabs. */
  showHosts: boolean;
  /** Hosts that cannot be read now and have nothing listed, by name. */
  unavailable: string[];
}

type Ranked = Pick<WorstWindow, "state" | "usedPercent" | "resetsAt">;

/**
 * Negative when `a` is worse than `b`: the worse shown state (no state ranks
 * as calm), then the higher used percent, then the nearer reset.
 */
export function compareWorst(a: Ranked, b: Ranked): number {
  const rank = (w: Ranked) => paceRank(w.state ?? "calm");
  return rank(b) - rank(a) || b.usedPercent - a.usedPercent || (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity);
}

function hostName(host: HostLimits): string {
  return host.name ?? host.hostId ?? "";
}

const EMPTY: IndicatorView = { worst: null, groups: [], showHosts: false, unavailable: [] };

/** `hidden`: provider ids the ring and the card leave out. */
export function indicatorView(snapshot: LimitsSnapshot | undefined, now: number, hidden: readonly string[] = []): IndicatorView {
  if (snapshot === undefined || snapshot.polledAt === null) return EMPTY;
  const hosts = snapshot.hosts;
  const showHosts = hosts.length > 1;
  const providersOf = hosts.map((h) => (hostStale(h) ? withoutForecast(h.providers) : h.providers).filter((p) => !isHidden(hidden, p.providerId)));
  const groups: IndicatorProvider[][] = hosts.map(() => []);
  const listed = new Set<number>();
  const staleAt = new Map<ProviderLimits, number | null>();

  for (const { providerId, members } of accountGroups(hosts.map((h, i) => ({ hostId: h.hostId, providers: providersOf[i]! })))) {
    // Unlike the CLI's blocks, the card shows the newest answer that has data.
    let best: ProviderLimits | null = null;
    let bestHost = -1;
    for (const i of members) {
      const p = providersOf[i]!.find((x) => x.providerId === providerId);
      if (p?.status !== "ok") continue;
      if (best === null || (p.measuredAt ?? -Infinity) > (best.measuredAt ?? -Infinity)) {
        best = p;
        bestHost = i;
      }
    }
    if (best === null || best.windows.length === 0) continue;
    staleAt.set(best, hostStale(hosts[bestHost]!) ? (best.measuredAt ?? hosts[bestHost]!.polledAt) : null);
    for (const i of members) {
      listed.add(i);
      groups[i]!.push({ provider: best, alsoOn: members.filter((j) => j !== i).map((j) => hostName(hosts[j]!)) });
    }
  }

  let worst: WorstWindow | null = null;
  groups.forEach((entries, i) => {
    for (const { provider } of entries) {
      for (const window of provider.windows) {
        // A passed reset: the percent belongs to the finished window.
        if (window.resetsAt !== null && window.resetsAt <= now) continue;
        const view = windowView(window, now);
        const candidate: WorstWindow = {
          hostName: showHosts ? hostName(hosts[i]!) : null,
          providerId: provider.providerId,
          label: window.label,
          model: window.model,
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt,
          state: view.pace,
          tone: view.tone,
          staleAt: staleAt.get(provider) ?? null,
        };
        if (worst === null || compareWorst(candidate, worst) < 0) worst = candidate;
      }
    }
  });

  return {
    worst,
    groups: groups.flatMap((providers, i) =>
      providers.length === 0 ? [] : [{ hostId: hosts[i]!.hostId, hostName: hostName(hosts[i]!), providers }],
    ),
    showHosts,
    unavailable: hosts.filter((h, i) => hostStale(h) && !listed.has(i)).map(hostName),
  };
}

/**
 * P4: when a provider's data is not current, the time it was measured: every
 * host that lists it with windows cannot be read now. Null while one can.
 */
export function providerStaleAt(snapshot: LimitsSnapshot, providerId: string): number | null {
  let latest: number | null = null;
  for (const host of snapshot.hosts) {
    const p = host.providers.find((x) => x.providerId === providerId);
    if (p?.status !== "ok" || p.windows.length === 0) continue;
    if (!hostStale(host)) return null;
    const at = p.measuredAt ?? host.polledAt;
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/** P4: the note a title carries for data that is not current, e.g. ". Host unavailable, data from 12:05". */
export function staleNote(s: Strings, staleAt: number | null, now: number): string {
  return staleAt === null ? "" : `. ${s.hostStale(formatClock(s, staleAt, now))}`;
}

/** The ring's title, e.g. "laptop · Claude Code · 5 Hour: 92%, critical". */
export function indicatorTitle(s: Strings, worst: WorstWindow | null, now: number): string {
  if (worst === null) return `${s.indicatorLabel}: ${s.noLimitsData}`;
  const value = formatPercent(worst.usedPercent);
  const parts = [providerName(s, worst.providerId), windowLabel(s, worst.label, worst.model)];
  if (worst.hostName !== null) parts.unshift(worst.hostName);
  const state = worst.state === null ? "" : `, ${s.paceStateName[worst.state]}`;
  return `${parts.join(" · ")}: ${value}${state}${staleNote(s, worst.staleAt, now)}`;
}
