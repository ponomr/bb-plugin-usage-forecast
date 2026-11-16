import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCli } from "../src/server/cli";
import type { Service } from "../src/server/rpc";
import type { LimitsSnapshot, ThreadState } from "../src/shared/contract";
import { windowVerdict } from "../src/shared/headroom";
import { ae1Providers, HIT, host, NOW, paced, provider, snap, win } from "./cli-headroom.fixture";
import { DAY_MS, HOUR_MS, MIN_MS } from "../src/shared/windows";

/** The CLI over a fixed snapshot; `threadHosts` answers `thread()` with a host id. */
function cli(snapshot: LimitsSnapshot, threadHosts: Record<string, string | null> = {}) {
  const calls = { refresh: 0 };
  const service = {
    snapshot: async () => snapshot,
    refresh: async () => {
      calls.refresh += 1;
      return snapshot;
    },
    thread: async (threadId: string) => ({ threadId, hostId: threadHosts[threadId] ?? null }) as ThreadState,
  } as unknown as Service;
  const { bb, harness } = createFakePluginHost({ pluginId: "usage-forecast" });
  bb.cli.register(createCli(service, () => NOW));
  return { calls, run: (...argv: string[]) => harness.runCli(argv) };
}

/** Every key of a JSON value, at any depth. */
function keys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keys);
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)]);
  return [];
}

describe("status --json verdict", () => {
  const s = snap([host("host_server", "server", ae1Providers())]);

  it("adds a verdict to every window and keeps every former field", async () => {
    const out = JSON.parse((await cli(s).run("status", "--json")).stdout) as LimitsSnapshot;
    const windows = out.hosts.flatMap((h) => h.providers.flatMap((p) => p.windows)) as (LimitsSnapshot["hosts"][0]["providers"][0]["windows"][0] & {
      verdict: unknown;
    })[];
    expect(windows).toHaveLength(4);
    for (const w of windows) expect(w.verdict).toEqual(windowVerdict(w, NOW));
    expect(windows[0]!.verdict).toEqual({
      state: "tight",
      lasts: true,
      runsOutAt: null,
      projectedPercent: 95,
      paceDeviationPercent: -4.7,
      resetsInMs: 100 * 60_000,
    });
    const stripped = { ...out, hosts: out.hosts.map((h) => ({ ...h, providers: h.providers.map((p) => ({ ...p, windows: p.windows.map(({ verdict: _v, ...w }: any) => w) })) })) };
    expect(stripped).toEqual(s);
    expect(keys(out).filter((k) => /account|email/i.test(k))).toEqual([]);
  });

  it("leaves the text of status as it was", async () => {
    expect((await cli(s).run("status")).stdout).toBe(
      [
        "Limits, polled 2026-11-16 00:09 UTC (1m ago)",
        "  claude-code (Max): ok",
        "    Current session: 62% [tight], resets in 1h 40m, at this pace lasts to reset (95% at reset)",
        "    Weekly limit: 40% [calm], resets in 1d 6h, at this pace lasts to reset (64% at reset)",
        "  codex (Plus): ok",
        "    Current session: 10% [calm], resets in 1h 40m, at this pace lasts to reset (21% at reset)",
        "    Weekly limit: 57% [calm], resets in 1d 6h, at this pace lasts to reset (69% at reset)",
        "  acp-x: not installed",
        "Recent compacts: none",
      ].join("\n"),
    );
  });
});

describe("headroom", () => {
  const one = snap([host("host_server", "server", ae1Providers())]);
  const two = snap([
    host("host_server", "server", [provider("codex", [paced("Weekly limit", 57, 69)], { planLabel: "Plus" })]),
    host("host_laptop", "Laptop", [provider("claude-code", [paced("Current session", 62, 95)], { planLabel: "Max" })]),
  ]);

  it("ranks providers from the freest with their tightest window (AE1)", async () => {
    const out = await cli(one).run("headroom");
    expect(out).toMatchObject({ exitCode: 0 });
    expect(out.stdout).toBe(
      [
        "Headroom, polled 2026-11-16 00:09 UTC (1m ago)",
        "  1. codex (Plus): headroom – Weekly limit 57%, on pace for 69% at reset in 1d 6h",
        "  2. claude-code (Max): tight – Current session 62%, on pace for 95% at reset in 1h 40m",
        "  3. acp-x: unknown – not installed",
      ].join("\n"),
    );
  });

  it("names the hosts when there are several", async () => {
    const out = await cli(two).run("headroom");
    expect(out.stdout.split("\n").slice(1)).toEqual([
      "  1. codex on server (Plus): headroom – Weekly limit 57%, on pace for 69% at reset in 1d 6h",
      "  2. claude-code on Laptop (Max): tight – Current session 62%, on pace for 95% at reset in 1h 40m",
    ]);
  });

  it("says when a used-up provider is available again (AE3)", async () => {
    const session = win("Current session", 100, { forecast: HIT, pace: "hit" });
    const out = await cli(snap([host("host_server", "server", [provider("claude-code", [session, paced("Weekly limit", 40, 60)])])])).run(
      "headroom",
    );
    expect(out.stdout.split("\n")[1]).toBe("  1. claude-code: hit – Current session 100%, limit reached, available again in 1h 40m");
  });

  it("words a short window with and without a run-out time", async () => {
    const running = paced("Current session", 70, 130);
    const held = paced("Weekly limit", 40, 60, { pace: "short" });
    const out = await cli(snap([host("host_server", "server", [provider("codex", [running]), provider("claude-code", [held])])])).run("headroom");
    expect(out.stdout.split("\n").slice(1)).toEqual([
      "  1. claude-code: short – Weekly limit 40%, will not last to the reset, resets in 1d 6h",
      "  2. codex: short – Current session 70%, runs out in 1h 0m, resets in 1h 40m",
    ]);
  });

  it("prints JSON with the age and the entries", async () => {
    const out = JSON.parse((await cli(two).run("headroom", "--json")).stdout);
    expect(out).toMatchObject({ polledAt: NOW - MIN_MS, ageMs: MIN_MS, stale: false });
    expect(out.entries[0]).toEqual({
      providerId: "codex",
      planLabel: "Plus",
      planMultiplier: null,
      hosts: [{ hostId: "host_server", hostName: "server" }],
      verdict: "headroom",
      availableAt: null,
      worstWindow: {
        label: "Weekly limit",
        model: null,
        usedPercent: 57,
        resetsAt: NOW + DAY_MS + 6 * HOUR_MS,
        state: "calm",
        lasts: true,
        runsOutAt: null,
        projectedPercent: 69,
        paceDeviationPercent: -25.1,
        resetsInMs: DAY_MS + 6 * HOUR_MS,
      },
      status: "ok",
      measuredAt: NOW,
      stale: false,
      message: null,
    });
    expect(keys(out).filter((k) => /account|email/i.test(k))).toEqual([]);
  });

  it("limits the answer to a host by id or by name", async () => {
    const ids = async (...argv: string[]) => JSON.parse((await cli(two).run("headroom", "--json", ...argv)).stdout).entries.map((e: any) => e.providerId);
    expect(await ids("--host", "host_laptop")).toEqual(["claude-code"]);
    expect(await ids("--host", "laptop")).toEqual(["claude-code"]);
    expect(await ids("--host", "SERVER")).toEqual(["codex"]);
    const unknown = await cli(two).run("headroom", "--host", "nowhere");
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain('Unknown host "nowhere"');
  });

  it("limits the answer to a thread's host (AE7)", async () => {
    const t = cli(two, { thr_x: "host_laptop", thr_gone: "host_other" });
    expect(JSON.parse((await t.run("headroom", "--json", "--thread", "thr_x")).stdout).entries.map((e: any) => e.providerId)).toEqual([
      "claude-code",
    ]);
    const unresolved = await t.run("headroom", "--thread", "thr_y");
    expect(unresolved.exitCode).not.toBe(0);
    expect(unresolved.stderr).toContain("host of thread thr_y");
    const missing = await t.run("headroom", "--thread", "thr_gone");
    expect(missing.exitCode).not.toBe(0);
    // With one host an unresolved thread gets that host's answer.
    const single = await cli(one).run("headroom", "--thread", "thr_y");
    expect(single.exitCode).toBe(0);
    expect(single.stdout.split("\n")).toHaveLength(4);
  });

  it("refuses --host with --thread", async () => {
    const out = await cli(two).run("headroom", "--host", "server", "--thread", "thr_x");
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("either --host or --thread");
  });

  it("polls first with --refresh", async () => {
    const t = cli(one);
    await t.run("headroom");
    expect(t.calls.refresh).toBe(0);
    await t.run("headroom", "--refresh");
    expect(t.calls.refresh).toBe(1);
  });

  it("marks data older than 30 minutes (AE8)", async () => {
    const old = snap(one.hosts, NOW - 45 * MIN_MS);
    const text = (await cli(old).run("headroom")).stdout.split("\n");
    expect(text[1]).toBe("Stale: data is 45m old; run with --refresh to poll now.");
    expect(text).toHaveLength(5);
    expect(JSON.parse((await cli(old).run("headroom", "--json")).stdout).stale).toBe(true);
  });

  it("says when nothing was polled yet", async () => {
    const never = snap([], null);
    expect((await cli(never).run("headroom")).stdout).toBe("Headroom: not polled yet.");
    expect(JSON.parse((await cli(never).run("headroom", "--json")).stdout)).toEqual({ polledAt: null, ageMs: null, stale: false, entries: [] });
  });
});

describe("plan multiplier (UF-11)", () => {
  const s = snap([
    host("host_server", "server", [
      provider("claude-code", [paced("Weekly limit", 20, 40)], { planLabel: "Max", planMultiplier: 5 }),
      provider("codex", [paced("Weekly limit", 57, 69)], { planLabel: "Plus" }),
    ]),
  ]);

  it("prints it after the plan name in status and headroom (AE1, AE2)", async () => {
    const status = (await cli(s).run("status")).stdout;
    expect(status).toContain("  claude-code (Max 5×): ok");
    expect(status).toContain("  codex (Plus): ok");
    const headroom = (await cli(s).run("headroom")).stdout;
    expect(headroom).toContain("claude-code (Max 5×): headroom");
    expect(headroom).toContain("codex (Plus): headroom");
  });

  it("adds planMultiplier to the JSON of status and headroom (R4)", async () => {
    const status = JSON.parse((await cli(s).run("status", "--json")).stdout) as LimitsSnapshot;
    expect(status.hosts[0]!.providers.map((p) => [p.providerId, p.planMultiplier])).toEqual([
      ["claude-code", 5],
      ["codex", null],
    ]);
    const headroom = JSON.parse((await cli(s).run("headroom", "--json")).stdout);
    expect(headroom.entries.map((e: { providerId: string; planMultiplier: number | null }) => [e.providerId, e.planMultiplier])).toEqual([
      ["claude-code", 5],
      ["codex", null],
    ]);
  });
});
