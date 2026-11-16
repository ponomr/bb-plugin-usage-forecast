import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCli } from "../src/server/cli";
import type { Service } from "../src/server/rpc";
import type { LimitsSnapshot, ThreadState } from "../src/shared/contract";
import { windowVerdict } from "../src/shared/headroom";
import { ae1Providers, host, NOW, snap } from "./cli-headroom.fixture";

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
