// The poller across hosts: one record per host, shared accounts grouped in
// memory, per-host back-off, departed hosts removed, and the legacy keys kept
// for the host that owned them before 0.4.6.

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { Poller, readHosts, toSnapshot, type HostInfo, type HostRecord } from "../src/server/poller";
import { keys, Storage } from "../src/server/storage";
import { HOUR_MS, windowKey } from "../src/shared/windows";
import { claudeLimits, Clock, iso, MIN, NOW } from "./helpers";

const SERVER = "host_server";
const MAC = "host_mac";

function codex(account: string | null, session: number, weekly: number, plan = "Plus", email = "owner@example.com") {
  return {
    codex: {
      status: "ok",
      ...(account === null ? {} : { accountKey: account, accountEmail: email }),
      planLabel: plan,
      windows: [
        { label: "Current session", usedPercent: session, resetsAt: iso(NOW + 2 * HOUR_MS), kind: "five-hour" },
        { label: "Weekly limit", usedPercent: weekly, resetsAt: iso(NOW + 3 * 24 * HOUR_MS), kind: "weekly" },
      ],
    },
  };
}

const hostInfo = (id: string, name: string, status = "connected", phase = "active"): HostInfo => ({
  id,
  name,
  status,
  lifecycle: { phase },
});

interface Options {
  hosts?: HostInfo[] | (() => HostInfo[]);
  primary?: () => string | null;
  /** By host id; the key "" answers the call without a host. */
  answers: Record<string, () => unknown | Promise<unknown>>;
  /** Without hosts and primaryHostId: the poller as before 0.4.6. */
  legacy?: boolean;
}

function setup(options: Options, kvFrom?: ReturnType<typeof makeKv>) {
  const clock = new Clock();
  const kv = kvFrom ?? makeKv();
  const storage = new Storage(kv);
  const calls: Array<string | undefined> = [];
  const afterPoll: HostRecord[][] = [];
  let hosts = options.hosts ?? [];
  const o = {
    clock,
    kv,
    storage,
    calls,
    afterPoll,
    setHosts: (next: HostInfo[]) => {
      hosts = next;
    },
    poller: new Poller({
      usageLimits: async (args) => {
        calls.push(args.hostId);
        const answer = options.answers[args.hostId ?? ""];
        if (!answer) throw new Error(`no answer for ${args.hostId}`);
        return answer();
      },
      ...(options.legacy
        ? {}
        : {
            hosts: async () => (typeof hosts === "function" ? hosts() : hosts),
            primaryHostId: async () => (options.primary ? options.primary() : SERVER),
          }),
      storage,
      intervalMinutes: async () => 2,
      invalidate: () => {},
      afterPoll: async (records) => {
        afterPoll.push([...records]);
      },
      now: clock.now,
      hostTimeoutMs: 50,
    }),
  };
  return o;
}

function makeKv() {
  return createFakePluginHost({ pluginId: "usage-forecast" }).bb.storage.kv;
}

async function dump(kv: ReturnType<typeof makeKv>): Promise<string> {
  const all: Record<string, unknown> = {};
  for (const key of await kv.list()) all[key] = await kv.get(key);
  return JSON.stringify(all);
}

const twoHosts = [hostInfo(SERVER, "server"), hostInfo(MAC, "MacBook")];

describe("poll every host", () => {
  it("keeps each host's own windows for different accounts (AE1, AE3)", async () => {
    const t = setup({ hosts: twoHosts, answers: { [SERVER]: () => codex("acct-a", 18, 57), [MAC]: () => codex("acct-b", 2, 5, "K12") } });
    const { error } = await t.poller.poll();
    expect(error).toBeNull();
    expect(t.calls.sort()).toEqual([MAC, SERVER]);
    const server = await t.storage.latest(null);
    const mac = await t.storage.latest(MAC);
    expect(server.providers[0]!.windows.map((w) => w.usedPercent)).toEqual([18, 57]);
    expect(mac.providers[0]).toMatchObject({ planLabel: "K12" });
    expect(mac.providers[0]!.windows.map((w) => w.usedPercent)).toEqual([2, 5]);
    expect(server.providers[0]).not.toHaveProperty("sharedWith");
    expect(mac.providers[0]).not.toHaveProperty("sharedWith");
    // Each host keeps its own samples.
    expect((await t.storage.samples("codex", null)).map((s) => s.usedPercent)).toEqual([18, 57]);
    expect((await t.storage.samples("codex", MAC)).map((s) => s.usedPercent)).toEqual([2, 5]);
    expect(await t.storage.hostIndex()).toEqual({
      legacyOwner: SERVER,
      hosts: [
        { hostId: SERVER, name: "server", connected: true, polledAt: NOW, pollError: null },
        { hostId: MAC, name: "MacBook", connected: true, polledAt: NOW, pollError: null },
      ],
    });
  });

  it("groups a shared account by accountKey and stores, logs and serves no account field (AE2)", async () => {
    const both = () => ({ ...claudeLimits(24, 27), ...codex("acct-a", 1, 2) });
    const t = setup({ hosts: twoHosts, answers: { [SERVER]: both, [MAC]: () => ({ ...claudeLimits(24, 27), ...codex("acct-b", 3, 4) }) } });
    await t.poller.poll();
    const server = await t.storage.latest(null);
    const mac = await t.storage.latest(MAC);
    expect(server.providers.find((p) => p.providerId === "claude-code")!.sharedWith).toEqual([MAC]);
    expect(mac.providers.find((p) => p.providerId === "claude-code")!.sharedWith).toEqual([SERVER]);
    expect(server.providers.find((p) => p.providerId === "codex")).not.toHaveProperty("sharedWith");

    const snapshot = toSnapshot(await readHosts(t.storage), [], NOW);
    for (const text of [await dump(t.kv), JSON.stringify(t.afterPoll), JSON.stringify(snapshot)]) {
      for (const secret of ["secret-account-key", "owner@example.com", "acct-a", "acct-b", "accountKey", "accountEmail"]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("never groups providers without an accountKey", async () => {
    const t = setup({ hosts: twoHosts, answers: { [SERVER]: () => codex(null, 1, 2), [MAC]: () => codex(null, 1, 2) } });
    await t.poller.poll();
    expect((await t.storage.latest(null)).providers[0]).not.toHaveProperty("sharedWith");
    expect((await t.storage.latest(MAC)).providers[0]).not.toHaveProperty("sharedWith");
  });

  it("stores the answering host when another throws, and backs off only the failed one (R2)", async () => {
    let macFails = false;
    const t = setup({
      hosts: twoHosts,
      answers: {
        [SERVER]: () => codex("a", 18, 57),
        [MAC]: () => {
          if (macFails) throw new Error("host offline");
          return codex("b", 2, 5);
        },
      },
    });
    await t.poller.tick();
    macFails = true;
    t.clock.advance(2 * MIN);
    await expect(t.poller.tick()).rejects.toThrow("MacBook: host offline");
    const mac = await t.storage.latest(MAC);
    expect(mac).toMatchObject({ polledAt: t.clock.value, pollError: "host offline" });
    expect(mac.providers[0]!.windows.map((w) => w.usedPercent)).toEqual([2, 5]);
    expect((await t.storage.latest(null))).toMatchObject({ polledAt: t.clock.value, pollError: null });
    expect(t.poller.consecutiveFailures).toBe(1);

    // Two minutes on: the server is due, the Mac waits 5 minutes.
    t.calls.length = 0;
    t.clock.advance(2 * MIN);
    await expect(t.poller.tick()).rejects.toThrow(/MacBook: Polling paused until .* after 1 failed polls: host offline/);
    expect(t.calls).toEqual([SERVER]);
    t.clock.advance(3 * MIN);
    t.calls.length = 0;
    macFails = false;
    await t.poller.tick();
    expect(t.calls.sort()).toEqual([MAC, SERVER]);
    expect(t.poller.consecutiveFailures).toBe(0);
  });

  it("does not wait for a host that never answers", async () => {
    const t = setup({ hosts: twoHosts, answers: { [SERVER]: () => codex("a", 18, 57), [MAC]: () => new Promise(() => {}) } });
    const { error } = await t.poller.poll();
    expect(error).toBe("MacBook: No answer within 0 s");
    expect((await t.storage.latest(null)).providers[0]!.windows).toHaveLength(2);
  });

  it("keeps a disconnected host's record, marks it, and drops its forecasts in the snapshot (AE4)", async () => {
    const t = setup({ hosts: twoHosts, answers: { [SERVER]: () => codex("a", 18, 57), [MAC]: () => codex("b", 2, 5) } });
    await t.poller.poll();
    t.setHosts([hostInfo(SERVER, "server"), hostInfo(MAC, "MacBook", "disconnected")]);
    t.clock.advance(2 * MIN);
    t.calls.length = 0;
    await t.poller.tick();
    expect(t.calls).toEqual([SERVER]);
    const index = (await t.storage.hostIndex())!;
    expect(index.hosts.find((h) => h.hostId === MAC)).toMatchObject({ connected: false, polledAt: NOW });
    const snapshot = toSnapshot(await readHosts(t.storage), [], t.clock.value);
    const mac = snapshot.hosts.find((h) => h.hostId === MAC)!;
    expect(mac).toMatchObject({ connected: false, name: "MacBook", polledAt: NOW });
    expect(mac.providers[0]!.windows.map((w) => w.usedPercent)).toEqual([2, 5]);
    expect(mac.providers[0]!.windows.every((w) => w.forecast === null)).toBe(true);
    const server = snapshot.hosts.find((h) => h.hostId === SERVER)!;
    expect(server.primary).toBe(true);
    expect(server.providers[0]!.windows[0]!.forecast).not.toBeNull();
  });

  it("notes a host that disconnects on a tick that polls nothing", async () => {
    const t = setup({ hosts: twoHosts, answers: { [SERVER]: () => codex("a", 1, 2), [MAC]: () => codex("b", 1, 2) } });
    await t.poller.tick();
    t.setHosts([hostInfo(SERVER, "server"), hostInfo(MAC, "MacBook", "disconnected")]);
    t.clock.advance(MIN);
    t.calls.length = 0;
    await t.poller.tick();
    expect(t.calls).toEqual([]);
    expect((await t.storage.hostIndex())!.hosts.find((h) => h.hostId === MAC)!.connected).toBe(false);
  });

  it("removes a host that left bb, or was destroyed, with its keys (R12)", async () => {
    const third = "host_old";
    const t = setup({
      hosts: [...twoHosts, hostInfo(third, "old")],
      answers: { [SERVER]: () => codex("a", 1, 2), [MAC]: () => codex("b", 1, 2), [third]: () => codex("c", 1, 2) },
    });
    await t.poller.poll();
    expect(await t.kv.list(keys.hostLatest(third))).toHaveLength(1);
    t.setHosts([hostInfo(SERVER, "server"), hostInfo(MAC, "MacBook", "disconnected", "destroyed")]);
    t.clock.advance(2 * MIN);
    await t.poller.poll();
    expect((await t.storage.hostIndex())!.hosts.map((h) => h.hostId)).toEqual([SERVER]);
    const left = await t.kv.list("limits:");
    expect(left.filter((k) => k.includes(MAC) || k.includes(third))).toEqual([]);
    expect(left).toContain(keys.latest);
    expect(left).toContain(keys.samples("codex"));
    expect((await readHosts(t.storage)).map((h) => h.hostId)).toEqual([SERVER]);
  });

  it("falls back to the call without a host when hosts.list fails, stored as the default host", async () => {
    let listFails = false;
    const t = setup({
      hosts: () => {
        if (listFails) throw new Error("bb down");
        return twoHosts;
      },
      answers: { "": () => codex("a", 30, 60), [SERVER]: () => codex("a", 18, 57), [MAC]: () => codex("b", 2, 5) },
    });
    await t.poller.poll();
    listFails = true;
    t.clock.advance(2 * MIN);
    t.calls.length = 0;
    await t.poller.poll();
    expect(t.calls).toEqual([undefined]);
    expect((await t.storage.latest(null)).providers[0]!.windows.map((w) => w.usedPercent)).toEqual([30, 60]);
    expect((await t.storage.latest(MAC)).providers[0]!.windows.map((w) => w.usedPercent)).toEqual([2, 5]);
    const index = (await t.storage.hostIndex())!;
    expect(index.hosts.map((h) => [h.hostId, h.polledAt])).toEqual([
      [SERVER, t.clock.value],
      [MAC, NOW],
    ]);
  });
});

describe("one host and the upgrade", () => {
  it("stores the same record for one host as the poller before 0.4.6 (R5)", async () => {
    const before = setup({ legacy: true, answers: { "": () => claudeLimits(40, 20) } });
    await before.poller.poll();
    const after = setup({ hosts: [hostInfo(SERVER, "server")], primary: () => null, answers: { [SERVER]: () => claudeLimits(40, 20) } });
    await after.poller.poll();
    expect(await after.storage.latest(null)).toEqual(await before.storage.latest(null));
    expect(await after.storage.samples("claude-code")).toEqual(await before.storage.samples("claude-code"));
    expect((await after.storage.hostIndex())!.legacyOwner).toBe(SERVER);
    const snapshot = toSnapshot(await readHosts(after.storage), [], NOW);
    expect(snapshot).toMatchObject({ polledAt: NOW, pollError: null });
    expect(snapshot.hosts).toHaveLength(1);
  });

  it("continues the legacy owner's windows and history after the upgrade; another host starts empty (AE5)", async () => {
    let session = 70;
    let resetsAt = NOW + 2 * HOUR_MS;
    const kv = makeKv();
    const old = setup({ legacy: true, answers: { "": () => claudeLimits(session, 10, resetsAt) } }, kv);
    await old.poller.poll();
    const firstSeen = (await old.storage.latest()).providers[0]!.open["Current session"]!.firstSeenAt;

    const t = setup({ hosts: twoHosts, answers: { [SERVER]: () => claudeLimits(session, 10, resetsAt), [MAC]: () => claudeLimits(1, 1) } }, kv);
    t.clock.advance(MIN);
    await t.poller.poll();
    expect((await t.storage.latest(null)).providers[0]!.open["Current session"]!.firstSeenAt).toBe(firstSeen);
    expect(await t.storage.samples("claude-code", MAC)).toHaveLength(2);

    // The window resets: the closed window lands in the legacy history.
    session = 5;
    resetsAt += 5 * HOUR_MS;
    t.clock.advance(3 * HOUR_MS);
    await t.poller.poll();
    expect(await t.storage.closedWindows(windowKey("claude-code", "Current session"))).toEqual([
      { startedAt: NOW + 2 * HOUR_MS - 5 * HOUR_MS, resetAt: NOW + 2 * HOUR_MS, peakUsedPercent: 70 },
    ]);
    expect(await t.storage.closedWindows(windowKey("claude-code", "Current session"), MAC)).toEqual([]);
    expect(await t.storage.samples("claude-code")).toHaveLength(6);
  });

  it("stays on the legacy keys while the default host is unknown, then writes the marker", async () => {
    let primary: () => string | null = () => null;
    const kv = makeKv();
    await kv.set(keys.samples("codex"), [{ at: 1, label: "Weekly limit", usedPercent: 3, resetsAt: null }]);
    const t = setup({ hosts: twoHosts, primary: () => primary(), answers: { "": () => codex("a", 18, 57), [SERVER]: () => codex("a", 18, 57), [MAC]: () => codex("b", 2, 5) } }, kv);

    await t.poller.poll();
    primary = () => {
      throw new Error("config failed");
    };
    t.clock.advance(2 * MIN);
    await t.poller.poll();
    expect(t.calls).toEqual([undefined, undefined]);
    expect(await t.storage.hostIndex()).toBeNull();
    expect(await kv.list("limits:latest:")).toEqual([]);
    expect(await t.storage.samples("codex")).toHaveLength(5);
    expect(toSnapshot(await readHosts(t.storage), [], t.clock.value).hosts).toMatchObject([{ hostId: null, primary: true }]);

    primary = () => SERVER;
    t.clock.advance(2 * MIN);
    t.calls.length = 0;
    await t.poller.poll();
    expect(t.calls.sort()).toEqual([MAC, SERVER]);
    expect((await t.storage.hostIndex())!.legacyOwner).toBe(SERVER);
    expect(await t.storage.samples("codex")).toHaveLength(7);
    // The marker is written once: a later primary host does not move it.
    primary = () => MAC;
    t.clock.advance(2 * MIN);
    await t.poller.poll();
    expect((await t.storage.hostIndex())!.legacyOwner).toBe(SERVER);
  });
});
