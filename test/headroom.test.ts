import { describe, expect, it } from "vitest";
import type { HostLimits, LimitsSnapshot, LimitWindow, ProviderLimits } from "../src/shared/contract";
import type { WindowForecast } from "../src/shared/forecast";
import { headroomReport, providerHeadroom, STALE_AFTER_MS, windowVerdict } from "../src/shared/headroom";
import type { PaceState } from "../src/shared/pace";
import { DAY_MS, HOUR_MS, MIN_MS } from "../src/shared/windows";

const NOW = Date.UTC(2026, 10, 16, 12, 0);
const FIVE_H = 5 * HOUR_MS;
const WEEK = 7 * DAY_MS;

function current(projectedPercent: number, runOutAt: number | null = null): WindowForecast {
  return {
    status: "running",
    current: { projectedPercent, runOutAt },
    learned: null,
    main: "current",
    early: false,
    warning: projectedPercent > 100,
  };
}

function early(learnedPercent: number | null = null): WindowForecast {
  return {
    status: "running",
    current: null,
    learned: learnedPercent === null ? null : { projectedPercent: learnedPercent, runOutAt: null, basedOnWindows: 3 },
    main: learnedPercent === null ? null : "learned",
    early: true,
    warning: false,
  };
}

const HIT: WindowForecast = {
  status: "hit",
  current: { projectedPercent: 100, runOutAt: NOW },
  learned: null,
  main: "current",
  early: false,
  warning: true,
};

function win(label: string, usedPercent: number, over: Partial<LimitWindow> = {}): LimitWindow {
  const weekly = label !== "Current session";
  return {
    label,
    usedPercent,
    resetsAt: NOW + (weekly ? 2 * DAY_MS : 2 * HOUR_MS),
    model: null,
    cost: null,
    durationMs: weekly ? WEEK : FIVE_H,
    forecast: null,
    pace: null,
    ...over,
  };
}

/** A window with a current pace and the state the server would hold for it. */
function paced(label: string, usedPercent: number, projected: number, over: Partial<LimitWindow> = {}): LimitWindow {
  const runOutAt = projected > 100 ? NOW + HOUR_MS : null;
  const state: PaceState = projected > 100 ? "short" : Math.round(projected) >= 85 ? "tight" : "calm";
  return win(label, usedPercent, { forecast: current(projected, runOutAt), pace: state, ...over });
}

function provider(providerId: string, windows: LimitWindow[], over: Partial<ProviderLimits> = {}): ProviderLimits {
  return {
    providerId,
    status: "ok",
    message: null,
    planLabel: providerId === "codex" ? "Plus" : "Max",
    planMultiplier: null,
    checkedAt: NOW,
    measuredAt: NOW,
    windows,
    ...over,
  };
}

function host(hostId: string | null, providers: ProviderLimits[], over: Partial<HostLimits> = {}): HostLimits {
  return { hostId, name: hostId, connected: true, primary: hostId === "server", polledAt: NOW, pollError: null, providers, ...over };
}

function snap(hosts: HostLimits[], polledAt: number | null = NOW): LimitsSnapshot {
  return { polledAt, pollError: null, hosts, recentCompactions: [] };
}

describe("windowVerdict", () => {
  it("maps each pace state to lasts", () => {
    expect(windowVerdict(paced("Current session", 20, 50), NOW)).toMatchObject({ state: "calm", lasts: true, runsOutAt: null });
    expect(windowVerdict(paced("Current session", 60, 90), NOW)).toMatchObject({ state: "tight", lasts: true, runsOutAt: null });
    expect(windowVerdict(paced("Current session", 70, 130), NOW)).toMatchObject({
      state: "short",
      lasts: false,
      runsOutAt: NOW + HOUR_MS,
      projectedPercent: 130,
    });
    const critical = win("Current session", 90, { forecast: current(150, NOW + 10 * MIN_MS), pace: "critical" });
    expect(windowVerdict(critical, NOW)).toMatchObject({ state: "critical", lasts: false, runsOutAt: NOW + 10 * MIN_MS });
    expect(windowVerdict(win("Current session", 100, { forecast: HIT, pace: "hit" }), NOW)).toMatchObject({
      state: "hit",
      lasts: false,
      runsOutAt: null,
    });
  });

  it("shows the held state when it is worse than the state read now", () => {
    const held = paced("Current session", 60, 90, { pace: "short" });
    expect(windowVerdict(held, NOW)).toMatchObject({ state: "short", lasts: false });
  });

  it("a held short with a calm current projection has no run-out time", () => {
    const held = paced("Current session", 40, 60, { pace: "short" });
    expect(windowVerdict(held, NOW)).toMatchObject({ state: "short", lasts: false, runsOutAt: null, projectedPercent: 60 });
  });

  it("is early in the first part of a window (AE5)", () => {
    const w = win("Current session", 3, { resetsAt: NOW + FIVE_H - 5 * MIN_MS, forecast: early() });
    expect(windowVerdict(w, NOW)).toEqual({
      state: "early",
      lasts: null,
      runsOutAt: null,
      projectedPercent: null,
      paceDeviationPercent: 1.3,
      resetsInMs: FIVE_H - 5 * MIN_MS,
    });
    expect(windowVerdict({ ...w, forecast: early(40) }, NOW).projectedPercent).toBe(40);
  });

  it("is unknown without a forecast, hit at 100 % without one", () => {
    expect(windowVerdict(win("Weekly limit", 40, { durationMs: null }), NOW)).toMatchObject({
      state: "unknown",
      lasts: null,
      projectedPercent: null,
      paceDeviationPercent: null,
    });
    expect(windowVerdict(win("Weekly limit", 100, { durationMs: null }), NOW)).toMatchObject({ state: "hit", lasts: false });
  });

  it("is unknown once the reset has passed, even at 100 %", () => {
    const w = win("Current session", 100, { resetsAt: NOW - MIN_MS });
    expect(windowVerdict(w, NOW)).toEqual({
      state: "unknown",
      lasts: null,
      runsOutAt: null,
      projectedPercent: null,
      paceDeviationPercent: null,
      resetsInMs: 0,
    });
  });

  it("measures the distance from an even pace (AE4)", () => {
    const w = win("Weekly limit", 60, { resetsAt: NOW + 4 * DAY_MS, forecast: current(140, NOW + DAY_MS), pace: "short" });
    expect(windowVerdict(w, NOW).paceDeviationPercent).toBe(17.1);
    expect(windowVerdict({ ...w, usedPercent: 20 }, NOW).paceDeviationPercent).toBe(-22.9);
    expect(windowVerdict({ ...w, durationMs: null }, NOW).paceDeviationPercent).toBeNull();
    expect(windowVerdict({ ...w, resetsAt: null }, NOW)).toMatchObject({ paceDeviationPercent: null, resetsInMs: null });
  });
});

describe("providerHeadroom", () => {
  it("ranks a calm provider above a tight one and names the tightest window (AE1)", () => {
    const s = snap([
      host("server", [
        provider("claude-code", [paced("Current session", 62, 95), paced("Weekly limit", 40, 64)]),
        provider("codex", [paced("Current session", 10, 21), paced("Weekly limit", 57, 69)]),
      ]),
    ]);
    const entries = providerHeadroom(s, NOW);
    expect(entries.map((e) => [e.providerId, e.verdict, e.worstWindow?.label])).toEqual([
      ["codex", "headroom", "Weekly limit"],
      ["claude-code", "tight", "Current session"],
    ]);
    expect(entries[0]).toMatchObject({
      planLabel: "Plus",
      hosts: [{ hostId: "server", hostName: "server" }],
      availableAt: null,
      status: "ok",
      worstWindow: { label: "Weekly limit", model: null, usedPercent: 57, state: "calm", lasts: true, projectedPercent: 69 },
    });
  });

  it("orders equal verdicts by the lower projection (AE2)", () => {
    const s = snap([host("server", [provider("codex", [paced("Weekly limit", 57, 69)]), provider("claude-code", [paced("Weekly limit", 20, 40)])])]);
    expect(providerHeadroom(s, NOW).map((e) => e.providerId)).toEqual(["claude-code", "codex"]);
  });

  it("keeps the snapshot order on a tie", () => {
    const s = snap([host("server", [provider("codex", [paced("Weekly limit", 20, 40)]), provider("claude-code", [paced("Weekly limit", 20, 40)])])]);
    expect(providerHeadroom(s, NOW).map((e) => e.providerId)).toEqual(["codex", "claude-code"]);
  });

  it("is hit when one window is used up; available again at its reset (AE3)", () => {
    const session = win("Current session", 100, { forecast: HIT, pace: "hit" });
    const s = snap([host("server", [provider("claude-code", [session, paced("Weekly limit", 40, 60)])])]);
    const [e] = providerHeadroom(s, NOW);
    expect(e).toMatchObject({ verdict: "hit", availableAt: session.resetsAt, worstWindow: { label: "Current session", state: "hit" } });
  });

  it("is available again at the latest reset among the used-up windows", () => {
    const session = win("Current session", 100, { forecast: HIT, pace: "hit" });
    const weekly = win("Weekly limit", 100, { forecast: HIT, pace: "hit" });
    const [e] = providerHeadroom(snap([host("server", [provider("claude-code", [session, weekly])])]), NOW);
    expect(e!.availableAt).toBe(weekly.resetsAt);
  });

  it("counts an early window as calm (AE5)", () => {
    const w = win("Current session", 3, { resetsAt: NOW + FIVE_H - 5 * MIN_MS, forecast: early() });
    const [e] = providerHeadroom(snap([host("server", [provider("codex", [w])])]), NOW);
    expect(e).toMatchObject({ verdict: "headroom", worstWindow: { state: "early" } });
  });

  it("counts windows without a pace by their used percent", () => {
    const unknown = (used: number) => win("Weekly limit", used, { durationMs: null });
    const verdict = (used: number) => providerHeadroom(snap([host("server", [provider("codex", [unknown(used)])])]), NOW)[0]!.verdict;
    expect(verdict(95)).toBe("tight");
    expect(verdict(75)).toBe("tight");
    expect(verdict(74)).toBe("headroom");
  });

  it("skips a window whose reset has passed", () => {
    const passed = win("Current session", 100, { resetsAt: NOW - MIN_MS });
    const [e] = providerHeadroom(snap([host("server", [provider("codex", [passed, paced("Weekly limit", 20, 40)])])]), NOW);
    expect(e).toMatchObject({ verdict: "headroom", availableAt: null, worstWindow: { label: "Weekly limit" } });
    const [only] = providerHeadroom(snap([host("server", [provider("codex", [passed])])]), NOW);
    expect(only).toMatchObject({ verdict: "unknown", worstWindow: null });
  });

  it("lists a provider that is not ok last as unknown with its status (AE6)", () => {
    const s = snap([
      host("server", [
        provider("acp-x", [], { status: "error", message: "boom", measuredAt: null }),
        provider("claude-code", [paced("Current session", 100, 100, { forecast: HIT, pace: "hit" })]),
        provider("codex", [paced("Weekly limit", 57, 69)], { status: "expired" }),
      ]),
    ]);
    expect(providerHeadroom(s, NOW).map((e) => [e.providerId, e.verdict, e.status, e.worstWindow])).toEqual([
      ["claude-code", "hit", "ok", expect.objectContaining({ state: "hit" })],
      ["acp-x", "unknown", "error", null],
      ["codex", "unknown", "expired", null],
    ]);
  });

  it("shows a shared account once with all its hosts and the newest member's windows", () => {
    const older = provider("claude-code", [paced("Weekly limit", 30, 50)], { sharedWith: ["laptop"], measuredAt: NOW - HOUR_MS });
    const newer = provider("claude-code", [paced("Weekly limit", 80, 95)], { sharedWith: ["server"] });
    const s = snap([host("server", [older, provider("codex", [paced("Weekly limit", 10, 20)])]), host("laptop", [newer])]);
    const entries = providerHeadroom(s, NOW);
    expect(entries.map((e) => [e.providerId, e.hosts.map((h) => h.hostId), e.verdict])).toEqual([
      ["codex", ["server"], "headroom"],
      ["claude-code", ["server", "laptop"], "tight"],
    ]);
    expect(entries[1]!.worstWindow?.usedPercent).toBe(80);
  });

  it("shows a shared account once when only one host still holds the link", () => {
    // The laptop went offline with its `sharedWith`; the server's next poll dropped its own.
    const s = snap([
      host("server", [provider("claude-code", [paced("Weekly limit", 80, 95)])]),
      host("laptop", [provider("claude-code", [paced("Weekly limit", 30, 50)], { sharedWith: ["server"], measuredAt: NOW - HOUR_MS })]),
    ]);
    const entries = providerHeadroom(s, NOW);
    expect(entries.map((e) => [e.providerId, e.hosts.map((h) => h.hostId)])).toEqual([["claude-code", ["server", "laptop"]]]);
    expect(entries[0]!.worstWindow?.usedPercent).toBe(80);
  });

  it("filters by host and keeps a shared account with all its hosts", () => {
    const shared = (other: string) => provider("claude-code", [paced("Weekly limit", 30, 50)], { sharedWith: [other] });
    const s = snap([
      host("server", [shared("laptop"), provider("codex", [paced("Weekly limit", 10, 20)])]),
      host("laptop", [shared("server")]),
    ]);
    const onLaptop = providerHeadroom(s, NOW, { hostId: "laptop" });
    expect(onLaptop.map((e) => [e.providerId, e.hosts.map((h) => h.hostId)])).toEqual([["claude-code", ["server", "laptop"]]]);
    expect(providerHeadroom(s, NOW, { hostId: "server" })).toHaveLength(2);
  });
});

describe("headroomReport", () => {
  it("marks data older than 30 minutes as stale", () => {
    const s = snap([host("server", [provider("codex", [paced("Weekly limit", 10, 20)])])], NOW - 45 * MIN_MS);
    expect(headroomReport(s, NOW)).toMatchObject({ polledAt: NOW - 45 * MIN_MS, ageMs: 45 * MIN_MS, stale: true });
    expect(headroomReport(snap(s.hosts, NOW - STALE_AFTER_MS), NOW).stale).toBe(false);
    expect(headroomReport(snap([], null), NOW)).toEqual({ polledAt: null, ageMs: null, stale: false, entries: [], hidden: [] });
  });
});

describe("an account measured long ago", () => {
  it("is marked stale on its own while the poll is fresh", () => {
    const old = NOW - 2 * 24 * HOUR_MS;
    const s = snap([
      host("server", [provider("codex", [paced("Weekly limit", 20, 50)])]),
      host("laptop", [provider("claude-code", [paced("Weekly limit", 20, 50)], { checkedAt: old, measuredAt: old })], { connected: false, polledAt: old }),
    ]);
    const report = headroomReport(s, NOW);
    expect(report.stale).toBe(false);
    expect(report.entries.map((e) => [e.providerId, e.stale, e.measuredAt])).toEqual([
      ["codex", false, NOW],
      ["claude-code", true, old],
    ]);
  });
});
