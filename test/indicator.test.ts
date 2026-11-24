import { describe, expect, it } from "vitest";
import { en, ru } from "../src/app/i18n";
import { compareWorst, indicatorTitle, indicatorView } from "../src/app/indicator";
import type { HostLimits, LimitsSnapshot, LimitWindow, ProviderLimits } from "../src/shared/contract";
import type { PaceState } from "../src/shared/pace";
import { DAY_MS, HOUR_MS, MIN_MS } from "../src/shared/windows";

const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const FIVE_HOURS = 5 * HOUR_MS;

/** A window whose forecast reads `state` at NOW; `null` gives a window without a forecast. */
function win(label: string, usedPercent: number, state: PaceState | null, over: Partial<LimitWindow> = {}): LimitWindow {
  const projection: Record<PaceState, { projectedPercent: number; runOutAt: number | null }> = {
    calm: { projectedPercent: usedPercent, runOutAt: null },
    tight: { projectedPercent: 90, runOutAt: null },
    short: { projectedPercent: 120, runOutAt: NOW + 2 * HOUR_MS },
    critical: { projectedPercent: 150, runOutAt: NOW + 10 * MIN_MS },
    hit: { projectedPercent: 100, runOutAt: NOW },
  };
  return {
    label,
    usedPercent,
    resetsAt: NOW + 3 * HOUR_MS,
    model: null,
    cost: null,
    durationMs: FIVE_HOURS,
    forecast:
      state === null
        ? null
        : { status: state === "hit" ? "hit" : "running", current: projection[state], learned: null, main: "current", early: false, warning: false },
    pace: null,
    ...over,
  };
}

function prov(providerId: string, windows: LimitWindow[], over: Partial<ProviderLimits> = {}): ProviderLimits {
  return { providerId, status: "ok", message: null, planLabel: null, planMultiplier: null, checkedAt: NOW, measuredAt: NOW, windows, ...over };
}

function host(hostId: string, providers: ProviderLimits[], over: Partial<HostLimits> = {}): HostLimits {
  return { hostId, name: hostId, connected: true, primary: false, polledAt: NOW, pollError: null, providers, ...over };
}

function snap(hosts: HostLimits[]): LimitsSnapshot {
  return { polledAt: NOW, pollError: null, hosts, recentCompactions: [] };
}

describe("indicatorView: the worst window", () => {
  it("AE1: ranks every window of every host; a critical window beats a short one", () => {
    const view = indicatorView(
      snap([
        host("server", [prov("codex", [win("Weekly limit", 60, "short")])], {
          primary: true,
        }),
        host("laptop", [prov("claude-code", [win("Current session", 92, "critical")])]),
      ]),
      NOW,
    );
    expect(view.worst).toMatchObject({
      hostName: "laptop",
      providerId: "claude-code",
      label: "Current session",
      usedPercent: 92,
      state: "critical",
      tone: "red",
    });
    expect(indicatorTitle(en, view.worst, NOW)).toBe("laptop · Claude Code · 5 Hour: 92%, critical");
  });

  it("AE2: all calm, the highest percent leads in the normal tone", () => {
    const view = indicatorView(
      snap([host("server", [prov("claude-code", [win("Current session", 20, "calm"), win("Weekly limit", 34, "calm")])])]),
      NOW,
    );
    expect(view.worst).toMatchObject({ label: "Weekly limit", usedPercent: 34, state: "calm", tone: "normal" });
  });

  it("AE3: on a tie of state the higher percent wins", () => {
    const view = indicatorView(
      snap([host("server", [prov("codex", [win("Current session", 60, "short"), win("Weekly limit", 71, "short")])])]),
      NOW,
    );
    expect(view.worst).toMatchObject({ label: "Weekly limit", usedPercent: 71, state: "short", tone: "amber" });
  });

  it("P1: a window without a pace ranks as calm and is not coloured", () => {
    const view = indicatorView(
      snap([host("server", [prov("codex", [win("Current session", 40, "calm"), win("Weekly limit", 90, null)])])]),
      NOW,
    );
    expect(view.worst).toMatchObject({ label: "Weekly limit", usedPercent: 90, state: null, tone: "muted" });
    expect(indicatorTitle(en, view.worst, NOW)).toBe("Codex · Weekly: 90%");
  });

  it("on a tie of state and percent the nearer reset wins", () => {
    const view = indicatorView(
      snap([
        host("server", [
          prov("codex", [
            win("Weekly limit", 50, "calm", { resetsAt: NOW + 2 * DAY_MS }),
            win("Current session", 50, "calm", { resetsAt: NOW + HOUR_MS }),
          ]),
        ]),
      ]),
      NOW,
    );
    expect(view.worst?.label).toBe("Current session");
  });

  it("compareWorst orders state, then percent, then reset", () => {
    const a = { state: "short" as const, usedPercent: 10, resetsAt: NOW + DAY_MS };
    const b = { state: "tight" as const, usedPercent: 99, resetsAt: NOW };
    expect(compareWorst(a, b)).toBeLessThan(0);
    expect(compareWorst({ ...b, state: null }, { ...b, state: "calm" })).toBe(0);
    expect(compareWorst({ ...a, resetsAt: null }, a)).toBeGreaterThan(0);
  });

  it("AE7: the pace read now wins over a calmer state the server holds", () => {
    const view = indicatorView(
      snap([host("server", [prov("claude-code", [win("Current session", 70, "critical", { pace: "calm" })])])]),
      NOW,
    );
    expect(view.worst).toMatchObject({ state: "critical", tone: "red" });
  });

  it("a held state worse than the reading stays shown", () => {
    const view = indicatorView(
      snap([host("server", [prov("claude-code", [win("Current session", 40, "calm", { pace: "short" })])])]),
      NOW,
    );
    expect(view.worst).toMatchObject({ state: "short", tone: "amber" });
  });

  it("a provider in error contributes no windows, even kept ones", () => {
    const view = indicatorView(
      snap([
        host("server", [
          prov("claude-code", [win("Current session", 99, "critical")], { status: "error", message: "boom" }),
          prov("codex", [win("Current session", 30, "calm")]),
        ]),
      ]),
      NOW,
    );
    expect(view.worst).toMatchObject({ providerId: "codex", usedPercent: 30 });
    expect(view.groups.flatMap((g) => g.providers.map((p) => p.provider.providerId))).toEqual(["codex"]);
  });

  it("P1: a stale host shows no pace and is not coloured", () => {
    const view = indicatorView(
      snap([host("laptop", [prov("claude-code", [win("Current session", 50, "critical")])], { connected: false })]),
      NOW,
    );
    expect(view.worst).toMatchObject({ usedPercent: 50, state: null, tone: "muted", staleAt: NOW });
    // P4: the title says the data is not current and when it was measured.
    expect(indicatorTitle(en, view.worst, NOW)).toMatch(/^Claude Code · 5 Hour: 50%\. Host unavailable, data from \d/);
  });

  it("P4: a fresh window has no stale time", () => {
    const view = indicatorView(snap([host("server", [prov("codex", [win("Current session", 10, "calm")])])]), NOW);
    expect(view.worst?.staleAt).toBeNull();
  });

  it("the title follows the language", () => {
    const view = indicatorView(snap([host("server", [prov("claude-code", [win("Current session", 92, "critical")])])]), NOW);
    expect(indicatorTitle(ru, view.worst, NOW)).toBe("Claude Code · 5 часов: 92%, критично");
    expect(indicatorTitle(en, view.worst, NOW)).toBe("Claude Code · 5 Hour: 92%, critical");
  });
});

describe("indicatorView: groups", () => {
  it("one host: no host heading, no host in the title", () => {
    const view = indicatorView(snap([host("server", [prov("codex", [win("Current session", 10, "calm")])])]), NOW);
    expect(view.showHosts).toBe(false);
    expect(view.worst?.hostName).toBeNull();
    expect(view.groups).toHaveLength(1);
  });

  it("two hosts: groups in snapshot order with host names", () => {
    const view = indicatorView(
      snap([
        host("server", [prov("codex", [win("Current session", 10, "calm")])], { primary: true }),
        host("laptop", [prov("claude-code", [win("Current session", 20, "calm")])]),
      ]),
      NOW,
    );
    expect(view.showHosts).toBe(true);
    expect(view.groups.map((g) => [g.hostName, g.providers.map((p) => p.provider.providerId)])).toEqual([
      ["server", ["codex"]],
      ["laptop", ["claude-code"]],
    ]);
  });

  it("AE4: a shared account is listed under each of its hosts, with the others in alsoOn", () => {
    const view = indicatorView(
      snap([
        host("server", [
          prov("claude-code", [win("Current session", 30, "calm")], { sharedWith: ["laptop"], measuredAt: NOW - MIN_MS }),
          prov("codex", [win("Current session", 10, "calm")]),
        ]),
        host("laptop", [prov("claude-code", [win("Current session", 45, "calm")], { sharedWith: ["server"] })]),
      ]),
      NOW,
    );
    expect(view.groups.map((g) => g.hostName)).toEqual(["server", "laptop"]);
    const claude = view.groups[0]!.providers.find((p) => p.provider.providerId === "claude-code")!;
    expect(claude.alsoOn).toEqual(["laptop"]);
    // The newest answer of the account speaks for it on both hosts.
    expect(claude.provider.windows[0]!.usedPercent).toBe(45);
    expect(view.groups[1]!.providers).toEqual([{ provider: claude.provider, alsoOn: ["server"] }]);
    expect(view.worst).toMatchObject({ hostName: "server", providerId: "claude-code", usedPercent: 45 });
  });

  it("a link kept by one host only still makes one account", () => {
    // The laptop went offline with its `sharedWith`; the server's next poll dropped its own.
    const view = indicatorView(
      snap([
        host("server", [prov("claude-code", [win("Current session", 45, "calm")])]),
        host("laptop", [prov("claude-code", [win("Current session", 30, "calm")], { sharedWith: ["server"], measuredAt: NOW - MIN_MS })]),
      ]),
      NOW,
    );
    expect(view.groups.map((g) => g.providers.length)).toEqual([1, 1]);
    expect(view.groups[0]!.providers[0]!.alsoOn).toEqual(["laptop"]);
    expect(view.groups[1]!.providers[0]!.provider.windows[0]!.usedPercent).toBe(45);
  });

  it("AE5: no ok provider anywhere gives no worst window and no groups", () => {
    const view = indicatorView(
      snap([
        host("server", [prov("claude-code", [], { status: "not_installed" })]),
        host("laptop", [prov("codex", [win("Current session", 80, "short")], { status: "expired" })]),
      ]),
      NOW,
    );
    expect(view.worst).toBeNull();
    expect(view.groups).toEqual([]);
    expect(indicatorTitle(en, view.worst, NOW)).toBe("Usage limits: No limits data");
  });

  it("no snapshot yet, or one never polled, gives no data", () => {
    expect(indicatorView(undefined, NOW)).toEqual({ worst: null, groups: [], showHosts: false, unavailable: [] });
    expect(indicatorView({ ...snap([]), polledAt: null }, NOW).worst).toBeNull();
  });
});

describe("indicatorView: review fixes", () => {
  it("a window whose reset has passed is not the worst window", () => {
    const view = indicatorView(
      snap([
        host("server", [
          prov("codex", [win("Current session", 100, null, { resetsAt: NOW - HOUR_MS }), win("Weekly limit", 40, "calm")]),
        ]),
      ]),
      NOW,
    );
    expect(view.worst).toMatchObject({ label: "Weekly limit", usedPercent: 40 });
  });

  it("names a host that cannot be read and has nothing listed", () => {
    const view = indicatorView(
      snap([
        host("server", [prov("codex", [win("Weekly limit", 40, "calm")])]),
        host("laptop", [prov("codex", [], { status: "error", measuredAt: null })], { connected: false }),
      ]),
      NOW,
    );
    expect(view.groups.map((g) => g.hostName)).toEqual(["server"]);
    expect(view.unavailable).toEqual(["laptop"]);
  });
});

describe("indicatorView: hidden providers (UF-11)", () => {
  const s = () =>
    snap([
      host("server", [
        prov("claude-code", [win("Current session", 60, "tight"), win("Weekly limit", 30, "calm")]),
        prov("codex", [win("Weekly limit", 98, "critical")]),
      ]),
    ]);

  it("ranks the worst window without hidden providers and leaves them out of the card (AE4)", () => {
    expect(indicatorView(s(), NOW).worst?.providerId).toBe("codex");
    const view = indicatorView(s(), NOW, ["codex"]);
    expect(view.worst).toMatchObject({ providerId: "claude-code", label: "Current session", usedPercent: 60 });
    expect(view.groups.flatMap((g) => g.providers.map((p) => p.provider.providerId))).toEqual(["claude-code"]);
  });

  it("with every provider hidden is the empty state", () => {
    const view = indicatorView(s(), NOW, ["codex", "claude-code"]);
    expect(view.worst).toBeNull();
    expect(view.groups).toEqual([]);
    expect(indicatorTitle(en, view.worst, NOW)).toBe(`${en.indicatorLabel}: ${en.noLimitsData}`);
  });
});
