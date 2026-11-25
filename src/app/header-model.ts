// Pure view logic for the header limits: one provider's 5-hour and weekly
// windows. In a thread it is the provider the band shows (the thread's own
// provider when it has windows, else the worst one of the thread's host);
// elsewhere, or while the thread is not known, the provider of the worst
// window across every host.

import type { LimitWindow, LimitsSnapshot, ProviderLimits } from "../shared/contract";
import type { Strings } from "./i18n";
import { compareWorst, indicatorView } from "./indicator";
import { bannerView, isWeekly, windowView } from "./model";

export interface HeaderView {
  provider: ProviderLimits;
  /** The 5-hour window, or null when the provider has none. */
  session: LimitWindow | null;
  /** The weekly window of all models, or null when the provider has none. */
  weekly: LimitWindow | null;
}

/** The provider's 5-hour and all-model weekly windows. */
export function headerWindows(provider: ProviderLimits): { session: LimitWindow | null; weekly: LimitWindow | null } {
  const all = provider.windows.filter((w) => w.model === null);
  const session = all.find((w) => w.label === "Current session") ?? all.find((w) => !isWeekly(w)) ?? null;
  const weekly = all.find((w) => w.label === "Weekly limit") ?? all.find((w) => w !== session && isWeekly(w)) ?? null;
  return { session, weekly };
}

/**
 * `thread`: the open thread's state, undefined while it loads or outside a
 * thread. Null when no provider has windows.
 */
export function headerView(
  s: Strings,
  snapshot: LimitsSnapshot | undefined,
  thread: { providerId: string | null; hostId: string | null } | undefined,
  now: number,
  hidden: readonly string[] = [],
): HeaderView | null {
  if (snapshot === undefined) return null;
  let provider: ProviderLimits | null = null;
  if (thread !== undefined) {
    const band = bannerView(s, snapshot, null, thread, now, hidden);
    if (band.kind === "limits") provider = band.primary;
  }
  if (provider === null) {
    const view = indicatorView(snapshot, now, hidden);
    const worst = view.worst;
    if (worst !== null) {
      const group = view.groups.find((g) => worst.hostName === null || g.hostName === worst.hostName) ?? view.groups[0];
      provider = group?.providers.find((e) => e.provider.providerId === worst.providerId)?.provider ?? null;
    }
  }
  if (provider === null) return null;
  const { session, weekly } = headerWindows(provider);
  if (session === null && weekly === null) return null;
  return { provider, session, weekly };
}

/**
 * The providers the `providers` mode lists, each with windows: in a thread
 * the band's (its own provider first, then the others of its host), else
 * those of the host of the worst window.
 */
export function headerProviders(
  s: Strings,
  snapshot: LimitsSnapshot | undefined,
  thread: { providerId: string | null; hostId: string | null } | undefined,
  now: number,
  hidden: readonly string[] = [],
): ProviderLimits[] {
  if (snapshot === undefined) return [];
  if (thread !== undefined) {
    const band = bannerView(s, snapshot, null, thread, now, hidden);
    if (band.kind === "limits") return [band.primary, ...band.others].filter((p) => p.windows.length > 0);
  }
  const view = indicatorView(snapshot, now, hidden);
  const worst = view.worst;
  const group = view.groups.find((g) => worst === null || worst.hostName === null || g.hostName === worst.hostName) ?? view.groups[0];
  return (group?.providers ?? []).map((e) => e.provider).filter((p) => p.windows.length > 0);
}

/** The worst of the windows by the indicator's order (shown pace state, used percent, nearer reset), or null for none. */
export function worstWindowOf(windows: readonly LimitWindow[], now: number): LimitWindow | null {
  const ranked = windows.map((w) => ({ w, state: windowView(w, now).pace, usedPercent: w.usedPercent, resetsAt: w.resetsAt }));
  ranked.sort(compareWorst);
  return ranked[0]?.w ?? null;
}

/** The thread id of an app path such as `/projects/<id>/threads/<threadId>`, or null. */
export function threadIdOfPath(pathname: string): string | null {
  const match = /\/threads\/([^/?#]+)/.exec(pathname);
  return match === null ? null : decodeURIComponent(match[1]!);
}
