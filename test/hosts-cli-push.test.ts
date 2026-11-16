// The CLI status and the limit pushes across hosts: one block and one push
// per account, host names only when more than one host is known.

import { describe, expect, it } from "vitest";
import { formatStatus } from "../src/server/cli";
import { LimitNotifier, notifyKey, type NotifyHost, type PushMessage } from "../src/server/limit-notifier";
import type { StoredProvider } from "../src/server/storage";
import type { PluginSettings } from "../src/server/threads";
import type { HostLimits, LimitsSnapshot, ProviderLimits } from "../src/shared/contract";
import { HOUR_MS, windowKey } from "../src/shared/windows";
import { makeStorage, MIN, NOW, settingsOf } from "./helpers";

const SERVER = "host_server";
const MAC = "host_mac";
const RESET = NOW + 3 * 24 * HOUR_MS;

function prov(providerId: string, weekly: number, plan: string, sharedWith?: string[], measuredAt = NOW): StoredProvider {
  return {
    providerId,
    status: "ok",
    message: null,
    planLabel: plan,
    planMultiplier: null,
    checkedAt: measuredAt,
    measuredAt,
    windows: [{ label: "Weekly limit", usedPercent: weekly, resetsAt: RESET, model: null, cost: null, durationMs: 7 * 24 * HOUR_MS, forecast: null, pace: null }],
    open: {},
    ...(sharedWith ? { sharedWith } : {}),
  };
}

const notifyHost = (hostId: string, name: string, providers: StoredProvider[], over: Partial<NotifyHost> = {}): NotifyHost => ({
  hostId,
  name,
  primary: hostId === SERVER,
  answered: true,
  latest: { providers },
  ...over,
});

function setup(over: Partial<PluginSettings> = {}) {
  const sent: PushMessage[] = [];
  const storage = makeStorage();
  const notifier = new LimitNotifier({
    storage,
    settings: settingsOf(over),
    send: async (m) => {
      sent.push(m);
      return ["mobile"];
    },
    log: { info: () => {}, warn: () => {} },
  });
  return { notifier, sent, storage };
}

/** Claude Code on one account on both hosts. */
const shared = (serverWeekly: number, macWeekly: number) => [
  notifyHost(SERVER, "server", [prov("claude-code", serverWeekly, "Max", [MAC])]),
  notifyHost(MAC, "MacBook", [prov("claude-code", macWeekly, "Max", [SERVER])]),
];

describe("limit pushes across hosts", () => {
  it("AE2: a shared account crossing the threshold sends one push naming both hosts, the next poll none", async () => {
    const { notifier, sent } = setup();
    await notifier.checkHosts(shared(91, 91), NOW);
    expect(sent).toEqual([{ title: "Claude Code: Weekly limit at 91% on server, MacBook", body: "The limit resets in 3d." }]);
    await notifier.checkHosts(shared(92, 92), NOW + 2 * MIN);
    expect(sent).toHaveLength(1);
  });

  it("different accounts on two hosts get a push each, naming their own host", async () => {
    const { notifier, sent } = setup();
    await notifier.checkHosts(
      [notifyHost(SERVER, "server", [prov("codex", 95, "Pro")]), notifyHost(MAC, "MacBook", [prov("codex", 93, "Plus")])],
      NOW,
    );
    expect(sent.map((m) => m.title)).toEqual(["Codex: Weekly limit at 95% on server", "Codex: Weekly limit at 93% on MacBook"]);
  });

  it("does not repeat a push remembered before the upgrade under the legacy key", async () => {
    const { notifier, sent, storage } = setup();
    await storage.setNotified({ [windowKey("claude-code", "Weekly limit")]: { resetsAt: RESET, level: "threshold", at: NOW - HOUR_MS } });
    await notifier.checkHosts(shared(91, 91), NOW);
    expect(sent).toEqual([]);
    // The primary host keeps the bare key; another host's key carries its id.
    expect(notifyKey({ hostId: SERVER, primary: true }, "k")).toBe("k");
    expect(notifyKey({ hostId: MAC, primary: false }, "k")).toBe("host_mac|k");
  });

  it("sends no second push for the period when the group's first host goes offline", async () => {
    const { notifier, sent } = setup();
    await notifier.checkHosts(shared(91, 91), NOW);
    // The server does not answer: the Mac alone, with no group this poll.
    await notifier.checkHosts(
      [
        notifyHost(SERVER, "server", [prov("claude-code", 91, "Max", [MAC])], { answered: false }),
        notifyHost(MAC, "MacBook", [prov("claude-code", 93, "Max")]),
      ],
      NOW + 2 * MIN,
    );
    expect(sent).toHaveLength(1);
    // Reaching 100 % is a new level and still sends.
    await notifier.checkHosts([notifyHost(MAC, "MacBook", [prov("claude-code", 100, "Max")]), notifyHost(SERVER, "server", [], { answered: false })], NOW + 4 * MIN);
    expect(sent.map((m) => m.title).at(-1)).toBe("Claude Code: Weekly limit reached on MacBook");
  });

  it("does not check a host that did not answer this poll", async () => {
    const { notifier, sent } = setup();
    await notifier.checkHosts(
      [notifyHost(SERVER, "server", [prov("codex", 10, "Pro")]), notifyHost(MAC, "MacBook", [prov("codex", 99, "Plus")], { answered: false })],
      NOW,
    );
    expect(sent).toEqual([]);
  });

  it("names the hosts in Russian with two hosts and no host with one", async () => {
    const ru = setup({ language: "ru" });
    await ru.notifier.checkHosts(shared(91, 91), NOW);
    expect(ru.sent[0]!.title).toBe("Claude Code: лимит «Неделя» — 91% на server, MacBook");
    const one = setup({ language: "ru" });
    await one.notifier.checkHosts([notifyHost(SERVER, "server", [prov("claude-code", 91, "Max")])], NOW);
    expect(one.sent[0]!.title).toBe("Claude Code: лимит «Неделя» — 91%");
    const en = setup();
    await en.notifier.checkHosts([notifyHost(SERVER, "server", [prov("claude-code", 91, "Max")])], NOW);
    expect(en.sent[0]!.title).toBe("Claude Code: Weekly limit at 91%");
  });
});

// --- CLI ---------------------------------------------------------------------

function cliProvider(p: StoredProvider): ProviderLimits {
  const { open: _open, ...rest } = p;
  return rest;
}

const cliHost = (hostId: string, name: string, providers: StoredProvider[], over: Partial<HostLimits> = {}): HostLimits => ({
  hostId,
  name,
  connected: true,
  primary: hostId === SERVER,
  polledAt: NOW,
  pollError: null,
  providers: providers.map(cliProvider),
  ...over,
});

const status = (hosts: HostLimits[]): LimitsSnapshot => ({ polledAt: NOW, pollError: null, hosts, recentCompactions: [] });

describe("CLI status across hosts", () => {
  it("AE2: a shared account is one block naming both hosts, with the newest answer", async () => {
    const out = formatStatus(
      status([
        cliHost(SERVER, "server", [prov("claude-code", 40, "Max", [MAC], NOW - MIN)]),
        cliHost(MAC, "MacBook", [prov("claude-code", 41, "Max", [SERVER], NOW)]),
      ]),
      NOW + MIN,
    );
    expect(out).toBe(
      [
        "Limits, polled 2026-11-08 12:00 UTC (1m ago)",
        "  claude-code (Max) on server, MacBook: ok",
        "    Weekly limit: 41%, resets in 2d 23h",
        "Recent compacts: none",
      ].join("\n"),
    );
  });

  it("AE3: different accounts are two blocks, each with its host and plan", () => {
    const out = formatStatus(
      status([cliHost(SERVER, "server", [prov("codex", 57, "Pro")]), cliHost(MAC, "MacBook", [prov("codex", 5, "Plus")])]),
      NOW,
    );
    expect(out).toContain("  codex (Pro) on server: ok\n    Weekly limit: 57%");
    expect(out).toContain("  codex (Plus) on MacBook: ok\n    Weekly limit: 5%");
  });

  it("says when a host is not connected and from when its data is", () => {
    const out = formatStatus(
      status([
        cliHost(SERVER, "server", [prov("claude-code", 40, "Max", [MAC])]),
        cliHost(MAC, "MacBook", [prov("claude-code", 30, "Max", [SERVER], NOW - HOUR_MS)], { connected: false, polledAt: NOW - HOUR_MS }),
      ]),
      NOW,
    );
    expect(out).toContain("  claude-code (Max) on server, MacBook: ok\n    Weekly limit: 40%");
    expect(out).toContain("    MacBook: not connected, data from 2026-11-08 11:00 UTC");
  });

  it("joins hosts that share an account through a third", () => {
    const out = formatStatus(
      status([
        cliHost(SERVER, "server", [prov("codex", 1, "Pro", ["h3"])]),
        cliHost(MAC, "MacBook", [prov("codex", 1, "Pro", ["h3"])]),
        cliHost("h3", "mini", [prov("codex", 1, "Pro", [SERVER, MAC])]),
      ]),
      NOW,
    );
    expect(out.match(/codex/g)).toHaveLength(1);
    expect(out).toContain("codex (Pro) on server, MacBook, mini: ok");
  });
});
