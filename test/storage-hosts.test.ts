// Per-host storage: the legacy owner keeps the pre-0.4.6 keys, every other
// host has its own keys, and the host index stays bounded.

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  keys,
  MAX_HOSTS,
  scopeOf,
  Storage,
  type HostEntry,
  type StoredLatest,
} from "../src/server/storage";
import { HOUR_MS } from "../src/shared/windows";
import { MIN, NOW } from "./helpers";

function setup() {
  const kv = createFakePluginHost({ pluginId: "usage-forecast" }).bb.storage.kv;
  return { kv, storage: new Storage(kv) };
}


const latestOf = (usedPercent: number): StoredLatest => ({
  polledAt: NOW,
  pollError: null,
  providers: [
    {
      providerId: "codex",
      status: "ok",
      message: null,
      planLabel: "Plus",
      planMultiplier: null,
      checkedAt: NOW,
      measuredAt: NOW,
      windows: [{ label: "Weekly limit", usedPercent, resetsAt: NOW + HOUR_MS, model: null, cost: null, durationMs: null, forecast: null, pace: null }],
      open: {},
    },
  ],
});

const host = (hostId: string, polledAt: number | null): HostEntry => ({ hostId, name: hostId, connected: true, polledAt, pollError: null });

describe("host scope", () => {
  it("maps the legacy owner and an unknown host to the legacy keys", () => {
    expect(scopeOf("h1", "h1")).toBeNull();
    expect(scopeOf(null, "h1")).toBeNull();
    expect(scopeOf("h2", "h1")).toBe("h2");
    expect(scopeOf("h2", null)).toBeNull();
  });

  it("returns data written before the change for the legacy owner, unchanged", async () => {
    const { kv, storage } = setup();
    await kv.set("limits:latest", latestOf(57));
    await kv.set("limits:windows:codex:Weekly%20limit", [{ startedAt: 1, resetAt: 2, peakUsedPercent: 80 }]);
    await storage.setHostIndex({ legacyOwner: "h1", hosts: [host("h1", NOW)] });

    const scope = scopeOf("h1", (await storage.hostIndex())!.legacyOwner);
    expect(await storage.latest(scope)).toEqual(latestOf(57));
    expect(await storage.closedWindows("codex:Weekly%20limit", scope)).toEqual([{ startedAt: 1, resetAt: 2, peakUsedPercent: 80 }]);
    // Another host starts empty.
    expect((await storage.latest("h2")).providers).toEqual([]);
    expect(await storage.closedWindows("codex:Weekly%20limit", "h2")).toEqual([]);
  });

  it("keeps each host's latest and closed windows apart", async () => {
    const { storage } = setup();
    await storage.setLatest(latestOf(57), null);
    await storage.setLatest(latestOf(5), "h2");
    await storage.appendClosedWindow("codex:Weekly%20limit", { startedAt: 1, resetAt: 2, peakUsedPercent: 90 }, "h2");
    expect((await storage.latest()).providers[0]!.windows[0]!.usedPercent).toBe(57);
    expect((await storage.latest("h2")).providers[0]!.windows[0]!.usedPercent).toBe(5);
    expect(await storage.closedWindows("codex:Weekly%20limit")).toEqual([]);
    expect(await storage.closedWindows("codex:Weekly%20limit", "h2")).toHaveLength(1);
  });

  it("reads values in an unexpected shape as empty", async () => {
    const { kv, storage } = setup();
    await kv.set(keys.latest, "junk");
    await kv.set(keys.windows("codex:x"), 5);
    await kv.set(keys.hostIndex, { legacyOwner: 3, hosts: "x" });
    expect(await storage.latest()).toEqual({ polledAt: null, pollError: null, providers: [] });
    expect(await storage.closedWindows("codex:x")).toEqual([]);
    expect(await storage.hostIndex()).toBeNull();
  });
});

describe("removeHost", () => {
  it("deletes one host's keys and leaves the legacy keys and other hosts", async () => {
    const { kv, storage } = setup();
    for (const scope of [null, "h2", "h3"]) {
      await storage.setLatest(latestOf(10), scope);
      await storage.appendClosedWindow("codex:Weekly%20limit", { startedAt: 1, resetAt: 2, peakUsedPercent: 10 }, scope);
    }
    // A host id that starts with another's must survive.
    await storage.setLatest(latestOf(10), "h2x");
    await storage.removeHost("h2");
    const left = (await kv.list("limits:")).sort();
    expect(left.some((k) => k.includes(":h2:") || k.endsWith(":h2"))).toBe(false);
    expect(left).toContain(keys.latest);
    expect(left).toContain(keys.windows("codex:Weekly%20limit"));
    expect(left).toContain(keys.hostLatest("h3"));
    expect(left).toContain(keys.hostLatest("h2x"));
    expect(left).toContain(keys.hostWindows("h3", "codex:Weekly%20limit"));

    // Removing the legacy owner's id leaves the legacy keys alone.
    await storage.removeHost("h1");
    expect(await kv.get(keys.latest)).toEqual(latestOf(10));
    expect(await storage.closedWindows("codex:Weekly%20limit")).toHaveLength(1);
  });
});

describe("host index", () => {
  it("keeps at most MAX_HOSTS hosts, drops the ones polled longest ago and never the legacy owner", async () => {
    const { storage } = setup();
    const hosts = Array.from({ length: MAX_HOSTS + 3 }, (_, i) => host(`h${i}`, NOW + i * MIN));
    // The legacy owner was polled longest ago.
    hosts[0] = host("h0", NOW - HOUR_MS);
    const dropped = await storage.setHostIndex({ legacyOwner: "h0", hosts });
    const index = (await storage.hostIndex())!;
    expect(index.hosts).toHaveLength(MAX_HOSTS);
    expect(index.legacyOwner).toBe("h0");
    expect(index.hosts.map((h) => h.hostId)).toContain("h0");
    expect(dropped.sort()).toEqual(["h1", "h2", "h3"]);
  });

  it("drops a host never polled before one that was", async () => {
    const { storage } = setup();
    const hosts = [host("h0", NOW), ...Array.from({ length: MAX_HOSTS - 1 }, (_, i) => host(`p${i}`, NOW + i)), host("never", null)];
    expect(await storage.setHostIndex({ legacyOwner: "h0", hosts })).toEqual(["never"]);
  });
});

describe("dropSamples", () => {
  it("deletes the samples of every host and nothing else", async () => {
    const { kv, storage } = setup();
    await kv.set("limits:samples:codex", [1]);
    await kv.set("limits:samples:h2:codex", [1]);
    await storage.setLatest(latestOf(10), null);
    await storage.dropSamples();
    expect(await kv.list("limits:")).toEqual([keys.latest]);
  });
});
