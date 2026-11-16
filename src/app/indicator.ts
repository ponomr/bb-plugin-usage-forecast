// Pure view logic for the sidebar-footer indicator: the worst window across
// every host, which the ring draws, and the providers grouped by host, which
// the card lists, one host per tab. A provider shared by several hosts
// (`sharedWith`) is one account: every one of its hosts lists it, from its
// newest answer, and the ring counts it once.

import type { HostLimits, LimitsSnapshot, ProviderLimits } from "../shared/contract";
import { shownPercent, type LimitsShow } from "../shared/limits-show";
import { paceRank, type PaceState } from "../shared/pace";
import { formatPercent, type Tone } from "../shared/thresholds";
import { providerName, windowLabel } from "./format";
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

  for (const { providerId, members } of accountGroups(hosts.map((h, i) => ({ hostId: h.hostId, providers: providersOf[i]! })))) {
    // Unlike the CLI's blocks, the card shows the newest answer that has data.
    let best: ProviderLimits | null = null;
    for (const i of members) {
      const p = providersOf[i]!.find((x) => x.providerId === providerId);
      if (p?.status !== "ok") continue;
      if (best === null || (p.measuredAt ?? -Infinity) > (best.measuredAt ?? -Infinity)) best = p;
    }
    if (best === null || best.windows.length === 0) continue;
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

/** The ring's title, e.g. "laptop · Claude Code · 5 Hour: 92%, critical". */
export function indicatorTitle(s: Strings, worst: WorstWindow | null, show: LimitsShow = "used"): string {
  if (worst === null) return `${s.indicatorLabel}: ${s.noLimitsData}`;
  const percent = formatPercent(shownPercent(show, worst.usedPercent));
  const value = show === "used" ? percent : s.percentLeft(percent);
  const parts = [providerName(s, worst.providerId), windowLabel(s, worst.label, worst.model)];
  if (worst.hostName !== null) parts.unshift(worst.hostName);
  const state = worst.state === null ? "" : `, ${s.paceStateName[worst.state]}`;
  return `${parts.join(" · ")}: ${value}${state}`;
}
