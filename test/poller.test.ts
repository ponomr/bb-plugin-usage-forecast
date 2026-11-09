import { describe, expect, it } from "vitest";
import { cleanMessage } from "../src/server/messages";
import { backoffMinutes, Poller, toSnapshot } from "../src/server/poller";
import { byteLength, keys, MAX_CLOSED_WINDOWS, MAX_VALUE_BYTES, type Sample } from "../src/server/storage";
import { HOUR_MS, windowKey } from "../src/shared/windows";
import { claudeLimits, Clock, iso, makeStorage, MIN, NOW } from "./helpers";

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
    expect(latest.providers[0]!.open["Current session"]).toEqual({ peakUsedPercent: 5, firstSeenAt: t.clock.value });
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
    const later = toSnapshot(latest, [], NOW + 3 * HOUR_MS);
    expect(later.providers[0]!.windows[0]!.forecast).toBeNull();
    expect(later.providers[0]!.windows[1]!.forecast).not.toBeNull();
    expect(later.providers[0]).not.toHaveProperty("open");
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
