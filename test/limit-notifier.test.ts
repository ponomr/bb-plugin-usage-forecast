import { describe, expect, it } from "vitest";
import { LimitNotifier, type PushMessage } from "../src/server/limit-notifier";
import type { StoredProvider } from "../src/server/storage";
import type { PluginSettings } from "../src/server/threads";
import { HOUR_MS } from "../src/shared/windows";
import { makeStorage, NOW, settingsOf } from "./helpers";

function provider(windows: { label: string; usedPercent: number; resetsAt: number | null }[], status: StoredProvider["status"] = "ok"): StoredProvider {
  return {
    providerId: "claude-code",
    status,
    message: null,
    planLabel: null,
    checkedAt: NOW,
    measuredAt: NOW,
    windows: windows.map((w) => ({ ...w, model: null, cost: null, durationMs: 5 * HOUR_MS, forecast: null, pace: null })),
    open: {},
  };
}

const session = (usedPercent: number, resetsAt: number | null = NOW + 2 * HOUR_MS) =>
  provider([{ label: "Current session", usedPercent, resetsAt }]);

function setup(over: Partial<PluginSettings> = {}, send?: (m: PushMessage) => Promise<readonly string[]>) {
  const sent: PushMessage[] = [];
  const logs: string[] = [];
  const storage = makeStorage();
  const notifier = new LimitNotifier({
    storage,
    settings: settingsOf(over),
    send:
      send ??
      (async (m) => {
        sent.push(m);
        return ["mobile"];
      }),
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(`warn: ${m}`) },
  });
  return { notifier, sent, logs, storage };
}

describe("limit push notifications", () => {
  it("pushes once when a window crosses the threshold", async () => {
    const { notifier, sent } = setup();
    await notifier.check([session(85)], NOW);
    expect(sent).toEqual([]);
    await notifier.check([session(91)], NOW);
    await notifier.check([session(95)], NOW + 60_000);
    expect(sent).toEqual([{ title: "Claude Code: 5 Hour limit at 91%", body: "The limit resets in 2h." }]);
  });

  it("pushes again when the window runs out, then stays quiet", async () => {
    const { notifier, sent } = setup();
    await notifier.check([session(92)], NOW);
    await notifier.check([session(100)], NOW);
    await notifier.check([session(100)], NOW);
    expect(sent.map((m) => m.title)).toEqual(["Claude Code: 5 Hour limit at 92%", "Claude Code: 5 Hour limit reached"]);
  });

  it("re-arms in a new window period", async () => {
    const { notifier, sent } = setup();
    await notifier.check([session(95)], NOW);
    // The next period starts with a high reading (no low poll in between).
    await notifier.check([session(93, NOW + 7 * HOUR_MS)], NOW + 3 * HOUR_MS);
    expect(sent).toHaveLength(2);
  });

  it("re-arms when the fill drops below the threshold", async () => {
    const { notifier, sent } = setup();
    await notifier.check([session(95, null)], NOW);
    await notifier.check([session(10, null)], NOW);
    await notifier.check([session(95, null)], NOW);
    expect(sent).toHaveLength(2);
  });

  it("remembers what was sent across restarts", async () => {
    const first = setup();
    await first.notifier.check([session(95)], NOW);
    const again = new LimitNotifier({
      storage: first.storage,
      settings: settingsOf(),
      send: async () => {
        throw new Error("must not send");
      },
      log: { info: () => {}, warn: () => {} },
    });
    await again.check([session(96)], NOW);
    expect(first.sent).toHaveLength(1);
  });

  it("respects the switch, the threshold, the language and skips stale or failing providers", async () => {
    const off = setup({ limitNotifyEnabled: false });
    await off.notifier.check([session(99)], NOW);
    expect(off.sent).toEqual([]);

    const ru = setup({ limitNotifyPercent: 60, language: "ru" });
    await ru.notifier.check([session(61)], NOW);
    expect(ru.sent).toEqual([{ title: "Claude Code: лимит «5 часов» — 61%", body: "Лимит: сброс через 2ч." }]);

    const skip = setup();
    await skip.notifier.check([session(99, NOW - 1), provider([{ label: "Weekly limit", usedPercent: 99, resetsAt: null }], "error")], NOW);
    expect(skip.sent).toEqual([]);
  });

  it("logs a failed or undelivered push and does not retry it", async () => {
    let calls = 0;
    const failing = setup({}, async () => {
      calls += 1;
      throw new Error("plugin push-notifications is not running");
    });
    await failing.notifier.check([session(95)], NOW);
    await failing.notifier.check([session(96)], NOW);
    expect(calls).toBe(1);
    expect(failing.logs).toEqual([expect.stringContaining("warn: limit push failed (claude-code Current session threshold)")]);

    const empty = setup({}, async () => []);
    await empty.notifier.check([session(95)], NOW);
    expect(empty.logs).toEqual(["warn: limit push not delivered (claude-code Current session threshold)"]);
  });
});
