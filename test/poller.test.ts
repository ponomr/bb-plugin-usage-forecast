import { describe, expect, it } from "vitest";
import { cleanMessage } from "../src/server/messages";
import { backoffMinutes, Poller, toSnapshot } from "../src/server/poller";
import { byteLength, keys, MAX_CLOSED_WINDOWS, MAX_VALUE_BYTES, type Sample } from "../src/server/storage";
import { HOUR_MS, windowKey } from "../src/shared/windows";
import { LimitNotifier, type PushMessage } from "../src/server/limit-notifier";
import { snapshotSchema } from "../src/shared/contract";
import { claudeLimits, Clock, iso, makeStorage, MIN, NOW, settingsOf } from "./helpers";

function setup(answer: () => unknown | Promise<unknown>, interval = 2) {
  const clock = new Clock();
  const storage = makeStorage();
  let invalidations = 0;
  let calls = 0;
  const poller = new Poller({
    usageLimits: async () => {
      calls += 1;
      return answer();
    },
    storage,
    intervalMinutes: async () => interval,
    invalidate: () => {
      invalidations += 1;
    },
    now: clock.now,
  });
  return { clock, storage, poller, calls: () => calls, invalidations: () => invalidations };
}

describe("backoff", () => {
  it("uses the interval, then 5 and 15 minutes", () => {
    expect(backoffMinutes(0, 2)).toBe(2);
    expect(backoffMinutes(1, 2)).toBe(5);
    expect(backoffMinutes(2, 2)).toBe(15);
    expect(backoffMinutes(7, 2)).toBe(15);
    // Never more often than a longer interval.
    expect(backoffMinutes(1, 10)).toBe(10);
    expect(backoffMinutes(2, 10)).toBe(15);
  });

  it("skips ticks while backing off, keeps the error visible and resets on success", async () => {
    let fail = true;
    const t = setup(() => {
      if (fail) throw new Error("host down");
      return claudeLimits(10, 20);
    });
    await expect(t.poller.tick()).rejects.toThrow("host down");
    expect(t.poller.consecutiveFailures).toBe(1);

    // One minute later: backing off for 5 minutes, the tick rethrows without polling.
    t.clock.advance(MIN);
    await expect(t.poller.tick()).rejects.toThrow(/Polling paused until .* after 1 failed polls: host down/);
    expect(t.calls()).toBe(1);

    t.clock.advance(4 * MIN);
    await expect(t.poller.tick()).rejects.toThrow("host down");
    expect(t.calls()).toBe(2);
    expect(t.poller.consecutiveFailures).toBe(2);

    // Now 15 minutes.
    t.clock.advance(10 * MIN);
    await expect(t.poller.tick()).rejects.toThrow(/paused/);
    expect(t.calls()).toBe(2);
    t.clock.advance(5 * MIN);
    fail = false;
    await t.poller.tick();
    expect(t.calls()).toBe(3);
    expect(t.poller.consecutiveFailures).toBe(0);

    // Back to the interval: a tick one minute later is skipped quietly.
    t.clock.advance(MIN);
    await t.poller.tick();
    expect(t.calls()).toBe(3);
    t.clock.advance(MIN);
    await t.poller.tick();
    expect(t.calls()).toBe(4);
  });

  it("counts a poll failed when every provider reports an error", async () => {
    const t = setup(() => ({ codex: { status: "error", message: "rate limited for owner@example.com" } }));
    await expect(t.poller.tick()).rejects.toThrow("codex: rate limited for <email>");
    expect(t.poller.consecutiveFailures).toBe(1);
    expect((await t.storage.latest()).pollError).toBe("codex: rate limited for <email>");
  });

  it("does not back off when only one provider reports an error", async () => {
    const t = setup(() => ({ codex: { status: "error", message: "rate limited" }, ...claudeLimits(10, 20) }));
    await t.poller.tick();
    expect(t.poller.consecutiveFailures).toBe(0);
    const codex = (await t.storage.latest()).providers.find((p) => p.providerId === "codex");
    expect(codex).toMatchObject({ status: "error", message: "rate limited" });
  });

  it("counts a storage failure as a failed poll instead of throwing from poll", async () => {
    const t = setup(() => claudeLimits(10, 20));
    t.storage.latest = async () => {
      throw new Error("kv unavailable");
    };
    const { error } = await t.poller.poll();
    expect(error).toBe("kv unavailable");
    expect(t.poller.consecutiveFailures).toBe(1);
  });

  it("shares one request between concurrent polls", async () => {
    const t = setup(() => claudeLimits(10, 20));
    await Promise.all([t.poller.poll(), t.poller.poll(), t.poller.poll()]);
    expect(t.calls()).toBe(1);
  });
});

describe("poll", () => {
  it("stores windows with forecasts and never stores account identifiers", async () => {
    const t = setup(() => claudeLimits(40, 20));
    const { latest, error } = await t.poller.poll();
    expect(error).toBeNull();
    const provider = latest.providers[0]!;
    expect(provider).toMatchObject({ providerId: "claude-code", status: "ok", planLabel: "Max", measuredAt: NOW });
    expect(provider.windows.map((w) => w.label)).toEqual(["Current session", "Weekly limit"]);
    expect(provider.windows[0]!.durationMs).toBe(5 * HOUR_MS);
    expect(provider.windows[0]!.forecast).not.toBeNull();
    const stored = JSON.stringify(await t.storage.latest()) + JSON.stringify(await t.storage.samples("claude-code"));
    expect(stored).not.toContain("owner@example.com");
    expect(stored).not.toContain("secret-account-key");
    expect(t.invalidations()).toBe(1);
  });

  it("keeps the last good data when a provider is unauthenticated, expired or not installed (AE3)", async () => {
    let answer: unknown = claudeLimits(40, 20);
    const t = setup(() => answer);
    await t.poller.poll();
    for (const status of ["unauthenticated", "expired", "not_installed"] as const) {
      t.clock.advance(2 * MIN);
      answer = { "claude-code": { status, message: "ignored" } };
      const { latest, error } = await t.poller.poll();
      expect(error).toBeNull();
      expect(latest.providers[0]).toMatchObject({ status, message: null, measuredAt: NOW, checkedAt: t.clock.value });
      expect(latest.providers[0]!.windows).toHaveLength(2);
    }
    expect(t.poller.consecutiveFailures).toBe(0);
  });

  it("keeps the previous providers when the call throws", async () => {
    let fail = false;
    const t = setup(() => {
      if (fail) throw new Error("boom");
      return claudeLimits(40, 20);
    });
    await t.poller.poll();
    fail = true;
    t.clock.advance(MIN);
    const { latest, error } = await t.poller.poll();
    expect(error).toBe("boom");
    expect(latest).toMatchObject({ polledAt: t.clock.value, pollError: "boom" });
    expect(latest.providers[0]!.windows).toHaveLength(2);
  });

  it("marks a malformed provider answer as an error and drops unknown fields", async () => {
    const t = setup(() => ({ odd: { status: "weird" }, "claude-code": claudeLimits(1, 2)["claude-code"] }));
    const { latest, error } = await t.poller.poll();
    expect(error).toBeNull();
    expect(latest.providers.find((p) => p.providerId === "odd")).toMatchObject({
      status: "error",
      message: "Unexpected answer for this provider",
    });
    expect(latest.providers.find((p) => p.providerId === "claude-code")).not.toHaveProperty("accountEmail");
  });

  it("closes a window when the reset moves and records its peak", async () => {
    let session = 30;
    let resetsAt = NOW + 2 * HOUR_MS;
    const t = setup(() => claudeLimits(session, 10, resetsAt));
    await t.poller.poll();
    session = 70;
    t.clock.advance(MIN);
    await t.poller.poll();
    // The window resets: usage drops and the reset moves 5 hours on.
    session = 5;
    resetsAt += 5 * HOUR_MS;
    t.clock.advance(3 * HOUR_MS);
    await t.poller.poll();
    const closed = await t.storage.closedWindows(windowKey("claude-code", "Current session"));
    expect(closed).toEqual([{ startedAt: NOW + 2 * HOUR_MS - 5 * HOUR_MS, resetAt: NOW + 2 * HOUR_MS, peakUsedPercent: 70 }]);
    const latest = await t.storage.latest();
    expect(latest.providers[0]!.open["Current session"]).toEqual({
      peakUsedPercent: 5,
      firstSeenAt: t.clock.value,
      pace: { state: "calm", calmer: null },
    });
  });

  it("keeps at most MAX_CLOSED_WINDOWS closed windows", async () => {
    const storage = makeStorage();
    for (let i = 0; i < MAX_CLOSED_WINDOWS + 5; i += 1) {
      await storage.appendClosedWindow("k", { startedAt: i, resetAt: i + 1, peakUsedPercent: i });
    }
    const closed = await storage.closedWindows("k");
    expect(closed).toHaveLength(MAX_CLOSED_WINDOWS);
    expect(closed[0]!.peakUsedPercent).toBe(5);
  });
});

describe("storage bounds", () => {
  it("keeps 5000 samples under the byte bound, newest kept", async () => {
    const storage = makeStorage();
    const samples: Sample[] = Array.from({ length: 5000 }, (_, i) => ({
      at: NOW + i * MIN,
      label: i % 2 ? "Current session" : "Weekly limit",
      usedPercent: (i % 1000) / 10,
      resetsAt: NOW + 5 * HOUR_MS,
    }));
    for (let i = 0; i < samples.length; i += 500) await storage.appendSamples("claude-code", samples.slice(i, i + 500));
    const stored = await storage.samples("claude-code");
    expect(byteLength(stored)).toBeLessThanOrEqual(MAX_VALUE_BYTES);
    expect(stored.at(-1)).toEqual(samples.at(-1));
    expect(stored.length).toBeLessThan(5000);
    expect(keys.samples("a/b")).toBe("limits:samples:a%2Fb");
  });
});

describe("snapshot", () => {
  it("drops the forecast of a window whose reset has passed", async () => {
    const t = setup(() => claudeLimits(40, 20));
    const { latest } = await t.poller.poll();
    const later = toSnapshot([{ hostId: null, name: null, primary: true, connected: true, latest }], [], NOW + 3 * HOUR_MS);
    const provider = later.hosts[0]!.providers[0]!;
    expect(provider.windows[0]!.forecast).toBeNull();
    expect(provider.windows[1]!.forecast).not.toBeNull();
    expect(provider).not.toHaveProperty("open");
  });

  it("drops every forecast of a host whose last poll failed (R6)", async () => {
    const t = setup(() => claudeLimits(40, 20));
    const { latest } = await t.poller.poll();
    const failed = { ...latest, pollError: "boom" };
    const s = toSnapshot([{ hostId: null, name: null, primary: true, connected: true, latest: failed }], [], NOW);
    expect(s.pollError).toBe("boom");
    expect(s.hosts[0]!.providers[0]!.windows.map((w) => w.forecast)).toEqual([null, null]);
  });
});

describe("pace state", () => {
  // Session window resets 2 h after NOW: 3 h of 5 h have passed.
  const sessionPace = (latest: { providers: { windows: { label: string; pace: unknown }[] }[] }) =>
    latest.providers[0]!.windows.find((w) => w.label === "Current session")!.pace;

  it("holds a worse state for ten minutes before calming down (AE4)", async () => {
    let session = 70; // 70 % after 3 h: on course for 117 %, runs out in 1 h 17 m.
    const t = setup(() => claudeLimits(session, 10));
    expect(sessionPace((await t.poller.poll()).latest)).toBe("short");
    // Two minutes later the projection is calm, but the state holds.
    session = 40;
    t.clock.advance(2 * MIN);
    expect(sessionPace((await t.poller.poll()).latest)).toBe("short");
    expect((await t.storage.latest()).providers[0]!.open["Current session"]!.pace).toEqual({
      state: "short",
      calmer: { state: "calm", since: t.clock.value },
    });
    const snap = toSnapshot([{ hostId: null, name: null, primary: true, connected: true, latest: await t.storage.latest() }], [], t.clock.value);
    expect(snap.hosts[0]!.providers[0]!.windows[0]!.pace).toBe("short");
    // Ten minutes after the first calm reading.
    t.clock.advance(10 * MIN);
    expect(sessionPace((await t.poller.poll()).latest)).toBe("calm");
  });

  it("starts a new window with its raw state, no hold carried over", async () => {
    let session = 70;
    let resetsAt = NOW + 2 * HOUR_MS;
    const t = setup(() => claudeLimits(session, 10, resetsAt));
    expect(sessionPace((await t.poller.poll()).latest)).toBe("short");
    // The window resets two minutes later; one hour into the new one it is calm.
    session = 5;
    resetsAt = NOW + 2 * MIN + 4 * HOUR_MS;
    t.clock.advance(2 * MIN);
    const { latest } = await t.poller.poll();
    expect(sessionPace(latest)).toBe("calm");
    expect(latest.providers[0]!.open["Current session"]!.pace).toEqual({ state: "calm", calmer: null });
  });

  it("has no state early in a window", async () => {
    const t = setup(() => claudeLimits(3, 10, NOW + 5 * HOUR_MS - 5 * MIN));
    const { latest } = await t.poller.poll();
    expect(sessionPace(latest)).toBeNull();
    expect(latest.providers[0]!.open["Current session"]).not.toHaveProperty("pace");
  });

  it("drops the pace of a window whose reset has passed", async () => {
    const t = setup(() => claudeLimits(90, 20));
    const { latest } = await t.poller.poll();
    const later = toSnapshot([{ hostId: null, name: null, primary: true, connected: true, latest: latest }], [], NOW + 3 * HOUR_MS);
    expect(later.hosts[0]!.providers[0]!.windows[0]!.pace).toBeNull();
    expect(later.hosts[0]!.providers[0]!.windows[1]!.pace).toBe("calm");
  });

  it("reads a latest value stored before the upgrade with a null pace", async () => {
    const t = setup(() => claudeLimits(40, 20));
    const { latest } = await t.poller.poll();
    const old = JSON.parse(JSON.stringify(latest));
    for (const p of old.providers) {
      for (const w of p.windows) delete w.pace;
      for (const o of Object.values(p.open) as { pace?: unknown }[]) delete o.pace;
    }
    await t.storage.setLatest(old);
    const snap = toSnapshot([{ hostId: null, name: null, primary: true, connected: true, latest: await t.storage.latest() }], [], NOW);
    expect(snap.hosts[0]!.providers[0]!.windows.map((w) => w.pace)).toEqual([null, null]);
    expect(snapshotSchema.parse(snap).hosts[0]!.providers[0]!.windows[0]!.pace).toBeNull();
    // The JSON a pre-upgrade server returned parses too.
    const parsed = snapshotSchema.parse({
      polledAt: NOW,
      pollError: null,
      hosts: [{ hostId: null, name: null, connected: true, primary: true, polledAt: NOW, pollError: null, providers: old.providers }],
      recentCompactions: [],
    });
    expect(parsed.hosts[0]!.providers[0]!.windows[0]!.pace).toBeNull();
    // The next poll starts the state without a hold.
    t.clock.advance(2 * MIN);
    expect(sessionPace((await t.poller.poll()).latest)).toBe("calm");
  });

  it("does not change what the limit push sends (AE7)", async () => {
    const sent: PushMessage[] = [];
    const storage = makeStorage();
    const notifier = new LimitNotifier({
      storage,
      settings: settingsOf({ limitNotifyPercent: 60 }),
      send: async (m) => {
        sent.push(m);
        return ["mobile"];
      },
      log: { info: () => {}, warn: () => {} },
    });
    let session = 50;
    let resetsAt = NOW + 4 * HOUR_MS + 30 * MIN; // 30 minutes in.
    const clock = new Clock();
    const poller = new Poller({
      usageLimits: async () => claudeLimits(session, 10, resetsAt),
      storage,
      intervalMinutes: async () => 2,
      invalidate: () => {},
      afterPoll: (hosts, now) => notifier.checkHosts(hosts, now),
      now: clock.now,
    });
    // Critical below the push threshold: 50 % after 30 minutes runs out in 30 minutes.
    expect(sessionPace((await poller.poll()).latest)).toBe("critical");
    expect(sent).toEqual([]);
    // A new window, calm, crossing the threshold ten minutes before its reset.
    session = 61;
    clock.advance(5 * HOUR_MS);
    resetsAt = clock.value + 10 * MIN;
    expect(sessionPace((await poller.poll()).latest)).toBe("calm");
    expect(sent.map((m) => m.title)).toEqual(["Claude Code: 5 Hour limit at 61%"]);
  });
});

describe("cleanMessage", () => {
  it("masks e-mails and bounds the length", () => {
    expect(cleanMessage(new Error("bad token for a.b+c@mail.example.org"))).toBe("bad token for <email>");
    expect(cleanMessage("x".repeat(600))).toHaveLength(500);
    expect(cleanMessage({})).toBe("Unknown error");
    expect(iso(0)).toBe("1970-01-01T00:00:00.000Z");
  });
});
