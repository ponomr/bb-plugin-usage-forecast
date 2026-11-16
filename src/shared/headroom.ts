// What an agent asks before a long job: does each window last to its reset,
// and which provider has headroom. Used by `status --json` (a `verdict` per
// window) and `headroom` (providers from the freest to the tightest).
//
// A window's state is the pace state shown (`src/shared/pace.ts`: the worse of
// the state read now and the held one), `early` in the first part of a window,
// or `unknown` without a forecast or once its reset has passed.
//
// A provider's verdict is the state of its tightest window: `headroom` when
// every window is calm. A window without a pace state counts by its used
// percent; a window whose reset has passed does not count, since its percent
// belongs to the finished window.
//
// Pure: no SDK, no clock. Callers pass `now`.

import { accountBlocks } from "./accounts";
import { isHidden } from "./hidden-providers";
import type { LimitsSnapshot, LimitWindow, ProviderStatus } from "./contract";
import { mainProjection } from "./forecast";
import { paceRank, rawPaceState, worsePace, type PaceState } from "./pace";
import { LIMIT_AMBER_PERCENT } from "./thresholds";

/** Data polled longer ago than this is marked stale. */
export const STALE_AFTER_MS = 30 * 60_000;

export type WindowState = PaceState | "early" | "unknown";

export interface WindowVerdict {
  state: WindowState;
  /** True for calm and tight, false for short, critical and hit, null for early and unknown. */
  lasts: boolean | null;
  /** When the current pace runs out before the reset; null when it does not, or for hit. */
  runsOutAt: number | null;
  /** The main projection at the reset, or null. */
  projectedPercent: number | null;
  /** Used percent minus the percent an even spend would have reached by now, one decimal. */
  paceDeviationPercent: number | null;
  resetsInMs: number | null;
}

const LASTS: Record<PaceState, boolean> = { calm: true, tight: true, short: false, critical: false, hit: false };

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function paceDeviation(w: LimitWindow, now: number): number | null {
  if (w.durationMs === null || w.durationMs <= 0 || w.resetsAt === null) return null;
  const elapsed = Math.min(w.durationMs, Math.max(0, w.durationMs - (w.resetsAt - now)));
  return round1(w.usedPercent - (100 * elapsed) / w.durationMs);
}

export function windowVerdict(w: LimitWindow, now: number): WindowVerdict {
  if (w.resetsAt !== null && w.resetsAt <= now) {
    return { state: "unknown", lasts: null, runsOutAt: null, projectedPercent: null, paceDeviationPercent: null, resetsInMs: 0 };
  }
  const resetsInMs = w.resetsAt === null ? null : w.resetsAt - now;
  const paceDeviationPercent = paceDeviation(w, now);
  const main = w.forecast ? mainProjection(w.forecast) : null;
  const projectedPercent = main === null ? null : round1(main.projectedPercent);
  const raw = rawPaceState(w, now);
  if (raw === null) {
    const state = w.forecast?.early ? "early" : "unknown";
    return { state, lasts: null, runsOutAt: null, projectedPercent, paceDeviationPercent, resetsInMs };
  }
  const state = worsePace(raw, w.pace);
  // Only the pace read now runs out; a held state keeps `lasts: false` without a time.
  const runsOut = raw === "short" || raw === "critical";
  return {
    state,
    lasts: LASTS[state],
    runsOutAt: runsOut && main?.runOutAt != null ? Math.round(main.runOutAt) : null,
    projectedPercent,
    paceDeviationPercent,
    resetsInMs,
  };
}

// --- Providers ---------------------------------------------------------------

export const PROVIDER_VERDICTS = ["headroom", "tight", "short", "critical", "hit", "unknown"] as const;
export type ProviderVerdict = (typeof PROVIDER_VERDICTS)[number];

export type WorstWindow = Pick<LimitWindow, "label" | "model" | "usedPercent" | "resetsAt"> & WindowVerdict;

export interface HeadroomEntry {
  providerId: string;
  planLabel: string | null;
  /** The plan's multiplier, or null (see `src/shared/plan.ts`). */
  planMultiplier: number | null;
  /** Every host signed in to this account, primary first. */
  hosts: { hostId: string | null; hostName: string | null }[];
  verdict: ProviderVerdict;
  /** For `hit`: the latest reset among the used-up windows, null when one has no reset time. */
  availableAt: number | null;
  /** The tightest window that counts, or null for `unknown`. */
  worstWindow: WorstWindow | null;
  status: ProviderStatus;
  /** When the windows were measured: the latest `ok` answer of the account. */
  measuredAt: number | null;
  /** The windows were measured more than 30 minutes ago, for example on a host that is not connected. */
  stale: boolean;
  /** Error text when `status` is `error`. */
  message: string | null;
}

export interface HeadroomReport {
  polledAt: number | null;
  ageMs: number | null;
  stale: boolean;
  entries: HeadroomEntry[];
  /** Provider ids left out of the ranking by the `hiddenProviders` setting. */
  hidden: string[];
}

export interface HeadroomOptions {
  /** Only accounts on this host. */
  hostId?: string;
  /** Provider ids to leave out (parsed `hiddenProviders`). */
  hidden?: readonly string[];
  /** A provider kept even when hidden: the thread's own, for `--thread`. */
  keep?: string | null;
}

/** The account blocks the ranking considers, before hidden providers drop out. */
function blocksOf(snapshot: LimitsSnapshot, options: HeadroomOptions) {
  return accountBlocks(snapshot.hosts).filter(
    (block) => options.hostId === undefined || block.members.some((m) => m.host.hostId === options.hostId),
  );
}

function leftOut(providerId: string, options: HeadroomOptions): boolean {
  return providerId !== (options.keep ?? null) && isHidden(options.hidden ?? [], providerId);
}

/** The pace state a window counts as for its provider; early and unknown count by used percent. */
function countedState(v: WindowVerdict, usedPercent: number): PaceState {
  if (v.state !== "early" && v.state !== "unknown") return v.state;
  if (usedPercent >= 100) return "hit";
  return Math.round(usedPercent) >= LIMIT_AMBER_PERCENT ? "tight" : "calm";
}

const VERDICT_ORDER: Record<ProviderVerdict, number> = { headroom: 0, tight: 1, short: 2, critical: 3, hit: 4, unknown: 5 };

/** The projection the order compares: the tightest window's at reset, else its used percent. */
function sortScore(e: HeadroomEntry): number {
  return e.worstWindow === null ? 0 : (e.worstWindow.projectedPercent ?? e.worstWindow.usedPercent);
}

/**
 * Providers from the freest to the tightest; `hostId` keeps only accounts on
 * that host, `hidden` leaves providers out except `keep`.
 */
export function providerHeadroom(snapshot: LimitsSnapshot, now: number, options: HeadroomOptions = {}): HeadroomEntry[] {
  const entries: HeadroomEntry[] = [];
  for (const block of blocksOf(snapshot, options)) {
    if (leftOut(block.provider.providerId, options)) continue;
    const p = block.provider;
    const base = {
      providerId: p.providerId,
      planLabel: p.planLabel,
      planMultiplier: p.planMultiplier ?? null,
      hosts: block.members.map((m) => ({ hostId: m.host.hostId, hostName: m.host.name })),
      status: p.status,
      measuredAt: p.measuredAt,
      stale: p.status === "ok" && p.measuredAt !== null && now - p.measuredAt > STALE_AFTER_MS,
      message: p.message,
    };
    const counted = (p.status === "ok" ? p.windows : [])
      .filter((w) => w.resetsAt === null || w.resetsAt > now)
      .map((w) => {
        const verdict = windowVerdict(w, now);
        const worst: WorstWindow = { label: w.label, model: w.model, usedPercent: w.usedPercent, resetsAt: w.resetsAt, ...verdict };
        const score = verdict.projectedPercent ?? w.usedPercent;
        return { worst, state: countedState(verdict, w.usedPercent), score };
      });
    if (counted.length === 0) {
      entries.push({ ...base, verdict: "unknown", availableAt: null, worstWindow: null });
      continue;
    }
    const tightest = counted.reduce((a, b) =>
      paceRank(b.state) > paceRank(a.state) || (paceRank(b.state) === paceRank(a.state) && b.score > a.score) ? b : a,
    );
    const verdict: ProviderVerdict = tightest.state === "calm" ? "headroom" : tightest.state;
    let availableAt: number | null = null;
    if (verdict === "hit") {
      const resets = counted.filter((c) => c.state === "hit").map((c) => c.worst.resetsAt);
      availableAt = resets.includes(null) ? null : Math.max(...(resets as number[]));
    }
    entries.push({ ...base, verdict, availableAt, worstWindow: tightest.worst });
  }
  // A stable sort: a tie keeps the snapshot order.
  return entries.sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || sortScore(a) - sortScore(b));
}

export function headroomReport(snapshot: LimitsSnapshot, now: number, options: HeadroomOptions = {}): HeadroomReport {
  const ageMs = snapshot.polledAt === null ? null : Math.max(0, now - snapshot.polledAt);
  const polled = snapshot.polledAt !== null;
  const hidden = polled ? blocksOf(snapshot, options).map((b) => b.provider.providerId).filter((id) => leftOut(id, options)) : [];
  return {
    polledAt: snapshot.polledAt,
    ageMs,
    stale: ageMs !== null && ageMs > STALE_AFTER_MS,
    entries: polled ? providerHeadroom(snapshot, now, options) : [],
    hidden: [...new Set(hidden)],
  };
}
