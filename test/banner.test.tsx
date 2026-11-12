// @vitest-environment jsdom
// The composer band: headline, window bars with the pace marker, context bar,
// auto-compact switch with the threshold it acts at, compact button, expanded view, Russian.

import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CompactResult } from "../src/shared/contract";
import { HOUR_MS } from "../src/shared/windows";
import { worstProvider } from "../src/app/model";
import { backend, callsTo, entry, forecastOf, provider, render, snapshot, T, threadState, win } from "./app-fixtures";

let Banner: React.ComponentType<object>;

beforeAll(async () => {
  const app = await loadPluginApp(() => import("../app"));
  expect(app.composerCustomizations).toHaveLength(1);
  expect(app.composerCustomizations[0]!.scopes).toEqual(["thread"]);
  Banner = app.composerCustomizations[0]!.banners![0]!.component as React.ComponentType<object>;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const twoProviders = () =>
  snapshot([
    provider("claude-code", [win("Current session", 40), win("Weekly limit", 92, { resetsAt: Date.now() + 3 * 24 * HOUR_MS + HOUR_MS / 2 })], {
      planLabel: "Max",
    }),
    provider("codex", [
      win("Current session", 10, { forecast: forecastOf(20, 130), cost: { usedUsdCents: 125, limitUsdCents: 2000 } }),
    ]),
  ]);

/** The element of one window (or "context") inside `root`, once it is drawn. */
async function findWindow(label: string, root: () => HTMLElement | null = () => screen.queryByTestId("collapsed-row")) {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = root()?.querySelector<HTMLElement>(`[data-window="${label}"]`) ?? null;
    expect(found).not.toBeNull();
  });
  return found!;
}

const providerBlock = (id: string) => () => document.querySelector<HTMLElement>(`[data-provider="${id}"]`);

describe("band, collapsed", () => {
  it("AE1: shows the thread's provider as 5H and W bars, the weekly one red at 92%", async () => {
    render(Banner, {}, backend({ snapshot: twoProviders() }));
    const weekly = await findWindow("Weekly limit");
    expect(weekly.textContent).toBe("W3d92%");
    expect(within(weekly).getByText("92%").getAttribute("data-tone")).toBe("red");
    expect(weekly.querySelector("[data-marker]")).toBeNull();
    expect((await findWindow("Current session")).textContent).toBe("5H2h40%");
    expect((await screen.findByTestId("headline")).textContent).toMatch(/^On track\. You should reach \w+'s reset with room to spare\.$/);
  });

  it("without a thread provider shows the worst one: 60% heading for 110% beats 70% heading for 75%", async () => {
    const s = snapshot([
      provider("claude-code", [win("Current session", 70, { forecast: forecastOf(75) })]),
      provider("codex", [win("Weekly limit", 60, { forecast: forecastOf(110), resetsAt: Date.now() + 5 * HOUR_MS })]),
    ]);
    expect(worstProvider(s.providers)?.providerId).toBe("codex");
    render(Banner, {}, backend({ snapshot: s, thread: threadState({ providerId: null }) }));
    const weekly = await findWindow("Weekly limit");
    expect(weekly.querySelector("[data-marker]")!.getAttribute("data-marker")).toBe("100");
    const head = await screen.findByTestId("headline");
    expect(head.textContent).toMatch(/^At this pace you'll run out before the .+ reset\.$/);
    expect(head.firstElementChild!.getAttribute("data-tone")).toBe("amber");
  });

  it("prefers the thread's provider over a worse one", async () => {
    render(Banner, {}, backend({ snapshot: twoProviders(), thread: threadState({ providerId: "codex" }) }));
    const session = await findWindow("Current session");
    expect(session.textContent).toBe("5H2h10%");
    expect(screen.queryByText("92%")).toBeNull();
  });

  it("breaks a tie by the later reset", () => {
    const s = snapshot([
      provider("claude-code", [win("Current session", 50, { resetsAt: Date.now() + HOUR_MS })]),
      provider("codex", [win("Weekly limit", 50, { resetsAt: Date.now() + 5 * 24 * HOUR_MS })]),
    ]);
    expect(worstProvider(s.providers)?.providerId).toBe("codex");
  });

  it("says the limit is reached, in red", async () => {
    const hit = { status: "hit" as const, current: null, learned: null, warning: true };
    render(Banner, {}, backend({ snapshot: snapshot([provider("claude-code", [win("Current session", 100, { forecast: hit })])]) }));
    const head = await screen.findByTestId("headline");
    expect(head.textContent).toMatch(/^Limit reached\. Usage resumes at .+\.$/);
    expect(head.firstElementChild!.getAttribute("data-tone")).toBe("red");
  });

  it("names the provider and plan when no window has a forecast", async () => {
    const s = snapshot([provider("claude-code", [win("Current session", 30, { forecast: null })], { planLabel: "Max" })]);
    render(Banner, {}, backend({ snapshot: s }));
    expect(await screen.findByText("Claude Code · Max")).toBeTruthy();
    expect(screen.queryByTestId("headline")).toBeNull();
  });

  it("says when no data has arrived yet", async () => {
    render(Banner, {}, backend({ snapshot: snapshot([], { polledAt: null }) }));
    expect(await screen.findByText("No limit data yet")).toBeTruthy();
  });

  it("AE3: gives one line of reasons when no provider has windows", async () => {
    const s = snapshot([
      provider("claude-code", [], { status: "unauthenticated" }),
      provider("codex", [], { status: "error", message: "timeout" }),
    ]);
    render(Banner, {}, backend({ snapshot: s }));
    expect(await screen.findByText("Claude Code: not signed in · Codex: error: timeout")).toBeTruthy();
  });

  it("draws the context bar and colours its fill: 85% red, 60% amber", async () => {
    render(Banner, {}, backend({ thread: threadState({ context: { ...threadState().context!, percent: 85 } }) }));
    const ctx = await findWindow("context");
    expect(ctx.textContent).toBe("Ctx90k / 150k85%");
    expect(within(ctx).getByText("85%").getAttribute("data-tone")).toBe("red");
    expect(ctx.querySelector('[data-segment="messages"]')).toBeTruthy();
    cleanup();
    render(Banner, {}, backend());
    expect(within(await findWindow("context")).getByText("60%").getAttribute("data-tone")).toBe("amber");
  });
});

describe("band, auto compact", () => {
  const toggle = () => screen.findByRole("switch", { name: "Auto compact" });
  const actsAt = async () => (await screen.findByTestId("auto-compact-at")).textContent;

  it("has no threshold field: the threshold lives in the settings and the context card", async () => {
    render(Banner, {}, backend());
    await toggle();
    expect(screen.queryByRole("textbox", { name: "Auto compact threshold, %" })).toBeNull();
    expect((await screen.findByTestId("auto-compact-at")).parentElement!.title).toContain("plugin settings");
  });

  it("follows the settings, turns the thread on at the current threshold and off again", async () => {
    const b = backend();
    render(Banner, {}, b);
    const sw = await toggle();
    expect(sw.getAttribute("aria-checked")).toBe("false");
    // The fixture's 80 % lands at 76 % below the provider's own point; the band names where it acts.
    expect(await actsAt()).toBe("Auto compact at 76%");
    fireEvent.click(sw);
    await waitFor(() => expect(b.overrides).toEqual([{ autoCompact: "on", thresholdPercent: 80 }]));
    await waitFor(async () => expect((await toggle()).getAttribute("aria-checked")).toBe("true"));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(await toggle());
    await waitFor(() => expect(b.overrides.at(-1)).toEqual({ autoCompact: "off" }));
  });

  it("turns on at the thread's own threshold when it has one", async () => {
    const b = backend({ thread: threadState({ override: { autoCompact: "off", thresholdPercent: 65 } }) });
    render(Banner, {}, b);
    fireEvent.click(await toggle());
    await waitFor(() => expect(b.overrides.at(-1)).toEqual({ autoCompact: "on", thresholdPercent: 65 }));
  });

  it("keeps the thread's limit when the switch changes the mode", async () => {
    const b = backend({ thread: threadState({ override: { autoCompact: "on", thresholdPercent: 80, limitTokens: 100_000 } }) });
    render(Banner, {}, b);
    fireEvent.click(await toggle());
    await waitFor(() => expect(b.overrides.at(-1)).toEqual({ autoCompact: "off", limitTokens: 100_000 }));
  });

  it("shows on when the settings turn it on for every thread", async () => {
    const autoCompact = { enabled: true, thresholdPercent: 70, effectiveThresholdPercent: 70, effectiveThresholdTokens: 105_000, source: "settings" as const };
    render(Banner, {}, backend({ thread: threadState({ autoCompact }) }));
    expect((await toggle()).getAttribute("aria-checked")).toBe("true");
    expect(await actsAt()).toBe("Auto compact at 70%");
  });

  it("asks before compacting when turned on past the threshold; Now compacts once", async () => {
    const autoCompact = { enabled: false, thresholdPercent: 50, effectiveThresholdPercent: 50, effectiveThresholdTokens: 75_000, source: "settings" as const };
    const b = backend({ thread: threadState({ autoCompact }) });
    render(Banner, {}, b);
    fireEvent.click(await toggle());
    await waitFor(() => expect(b.overrides).toEqual([{ autoCompact: "on", thresholdPercent: 50 }]));
    const ask = await screen.findByRole("alert");
    expect(ask.textContent).toContain("Context is already at 60%, past 50%. Auto compact:");
    fireEvent.click(within(ask).getByRole("button", { name: "Now" }));
    await waitFor(() => expect(callsTo(b, "compact")).toEqual([{ method: "compact", input: { threadId: T } }]));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("After the next reply leaves the compact to the idle check", async () => {
    const autoCompact = { enabled: false, thresholdPercent: 55, effectiveThresholdPercent: 55, effectiveThresholdTokens: 82_500, source: "settings" as const };
    const b = backend({ thread: threadState({ autoCompact }) });
    render(Banner, {}, b);
    fireEvent.click(await toggle());
    fireEvent.click(await screen.findByRole("button", { name: "After the next reply" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(callsTo(b, "compact")).toEqual([]);
  });
});

describe("band, compact button", () => {
  it("is disabled while the agent answers", async () => {
    render(Banner, {}, backend({ thread: threadState({ active: true }) }));
    expect(((await screen.findByRole("button", { name: "Compact" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is hidden when the provider cannot compact", async () => {
    render(Banner, {}, backend({ thread: threadState({ compactSupported: false }) }));
    await screen.findByRole("switch", { name: "Auto compact" });
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
  });

  it("AE4: one click calls compact once and stays disabled until the answer", async () => {
    let resolve!: (r: CompactResult) => void;
    const b = backend({ compact: () => new Promise<CompactResult>((r) => (resolve = r)) });
    render(Banner, {}, b);
    const button = (await screen.findByRole("button", { name: "Compact" })) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    const pending = (await screen.findByRole("button", { name: "Compacting…" })) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    expect(callsTo(b, "compact")).toEqual([{ method: "compact", input: { threadId: T } }]);
    await act(async () => resolve({ ok: true, message: null, entry: entry(0) }));
    expect(((await screen.findByRole("button", { name: "Compact" })) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows why a compact did not start and lets the user retry", async () => {
    render(Banner, {}, backend({ compact: async () => ({ ok: false, message: "The agent is answering", entry: null }) }));
    fireEvent.click(await screen.findByRole("button", { name: "Compact" }));
    expect(await screen.findByText("The agent is answering")).toBeTruthy();
    expect(((await screen.findByRole("button", { name: "Compact" })) as HTMLButtonElement).disabled).toBe(false);
  });

  it("falls back to a generic reason when the server gives none", async () => {
    render(Banner, {}, backend({ compact: async () => ({ ok: false, message: null, entry: null }) }));
    fireEvent.click(await screen.findByRole("button", { name: "Compact" }));
    expect(await screen.findByText("Compact did not start")).toBeTruthy();
  });
});

describe("band, expanded", () => {
  const expand = async () => fireEvent.click(await screen.findByRole("button", { name: "Show details" }));

  it("AE1: lists both providers with their pace notes, cost and the last 5 compacts", async () => {
    const s = twoProviders();
    s.recentCompactions = [0, 1, 2, 3, 4].map((i) => entry(i));
    render(Banner, {}, backend({ snapshot: s }));
    await expand();
    const claude = providerBlock("claude-code");
    expect(claude()!.textContent).toContain("Max");
    expect((await findWindow("Current session", claude)).textContent).toContain("5 Hour40%");
    expect((await findWindow("Weekly limit", claude)).textContent).toContain("On pace for about 92% by reset – resets in 3d");
    const codex = providerBlock("codex");
    fireEvent.click(within(codex()!).getByRole("button"));
    const session = await findWindow("Current session", codex);
    expect(session.textContent).toContain("On pace for about 20% by reset – resets in 2h");
    expect(session.textContent).toContain("$1.25 of $20.00");
    expect(session.title).toBe("Current pace: 20% by reset\nUsual pace (3 past windows): 130%");
    fireEvent.click(screen.getByRole("button", { name: "Recent compacts (5)" }));
    expect(within(screen.getByRole("list", { name: "Recent compacts" })).getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getAllByText(/\(Codex\), auto: 85% → 30%, compacted/)).toHaveLength(5);
    expect(screen.queryByTestId("collapsed-row")).toBeNull();
  });

  it("says when a window will hit its limit before the reset", async () => {
    const forecast = { status: "running" as const, current: { projectedPercent: 160, runOutAt: Date.now() + HOUR_MS }, learned: null, warning: true };
    render(Banner, {}, backend({ snapshot: snapshot([provider("claude-code", [win("Current session", 70, { forecast })])]) }));
    await expand();
    const session = await findWindow("Current session", providerBlock("claude-code"));
    expect(session.textContent).toContain("Limit will hit in 1h – resets in 2h");
    expect(within(session).getByText(/Limit will hit/).getAttribute("data-tone")).toBe("red");
  });

  it("marks windows kept from an earlier answer", async () => {
    const s = twoProviders();
    s.providers[1] = { ...s.providers[1]!, status: "error", message: "timeout", measuredAt: Date.now() - 30 * 60_000 };
    render(Banner, {}, backend({ snapshot: s }));
    await expand();
    await waitFor(() => expect(providerBlock("codex")()?.textContent).toMatch(/error: timeout.*data from .+/));
  });

  it("shows the context panel with free space and breakdown", async () => {
    render(Banner, {}, backend());
    await expand();
    const details = await screen.findByTestId("context-details");
    expect(details.textContent).toContain("Context 60% used");
    expect(details.textContent).toContain("60k free of 150k");
    expect(within(screen.getByRole("list", { name: "Context breakdown" })).getByRole("listitem").textContent).toBe("Messages90k");
    expect(details.textContent).toContain("The provider compacts on its own at 117k (78% of the window)");
  });

  it("shows another provider on one line and its windows on tap", async () => {
    render(Banner, {}, backend({ snapshot: twoProviders() }));
    await expand();
    const codex = providerBlock("codex");
    await waitFor(() => expect(codex()).not.toBeNull());
    const row = within(codex()!).getByRole("button");
    expect(row.textContent).toBe("▸Codex5H 10%");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(codex()!.querySelector("[data-window]")).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(codex()!.querySelector('[data-window="Current session"]')).not.toBeNull();
  });

  it("hides the recent compacts behind a row and has none when there are none", async () => {
    const s = twoProviders();
    s.recentCompactions = [entry(1)];
    render(Banner, {}, backend({ snapshot: s }));
    await expand();
    const row = await screen.findByRole("button", { name: "Recent compacts (1)" });
    expect(screen.queryByRole("list", { name: "Recent compacts" })).toBeNull();
    fireEvent.click(row);
    expect(within(screen.getByRole("list", { name: "Recent compacts" })).getAllByRole("listitem")).toHaveLength(1);
    cleanup();
    render(Banner, {}, backend({ snapshot: twoProviders() })); // still expanded: the state is kept per device
    await screen.findByTestId("banner-details");
    expect(screen.queryByRole("button", { name: /Recent compacts/ })).toBeNull();
  });

  it("scrolls the details inside a capped height and collapses from the bottom", async () => {
    render(Banner, {}, backend({ snapshot: twoProviders() }));
    await expand();
    const details = await screen.findByTestId("banner-details");
    expect(details.className).toContain("max-h-[45dvh]");
    expect(details.className).toContain("overflow-y-auto");
    fireEvent.click(within(details).getByRole("button", { name: "▲ Collapse" }));
    expect(screen.queryByTestId("banner-details")).toBeNull();
    expect(await screen.findByTestId("collapsed-row")).toBeTruthy();
    expect(localStorage.getItem("usage-forecast:banner-expanded")).toBe("0");
  });

  it("keeps the collapsed band to two lines: one metrics row, the controls hidden on a phone", async () => {
    render(Banner, {}, backend({ snapshot: twoProviders() }));
    const row = await screen.findByTestId("collapsed-row");
    expect(row.className).toContain("flex-nowrap");
    const controls = (await screen.findByTestId("controls")).className.split(" ");
    expect(controls).toEqual(expect.arrayContaining(["hidden", "@2xl:block"]));
    await expand();
    expect((await screen.findByTestId("controls")).className.split(" ")).not.toContain("hidden");
  });

  it("keeps the expanded state per device", async () => {
    render(Banner, {}, backend());
    await expand();
    expect(localStorage.getItem("usage-forecast:banner-expanded")).toBe("1");
    cleanup();
    render(Banner, {}, backend());
    expect((await screen.findByRole("button", { name: "Hide details" })).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("band, limits shown as left", () => {
  const remaining = { settings: { limitsShow: "remaining" } };
  const fillWidth = (el: HTMLElement) => el.querySelector<HTMLElement>("[aria-hidden] > span")!.style.width;

  it("shows what is left of each window and keeps the risk colours and the used context", async () => {
    render(Banner, {}, backend({ snapshot: twoProviders() }), remaining);
    const weekly = await findWindow("Weekly limit");
    expect(weekly.textContent).toBe("W3d8%");
    expect(within(weekly).getByText("8%").getAttribute("data-tone")).toBe("red");
    expect(fillWidth(weekly)).toBe("8%");
    expect(weekly.title).toBe("Weekly – 8% left");
    expect((await findWindow("Current session")).textContent).toBe("5H2h60%");
    expect((await findWindow("context")).textContent).toBe("Ctx90k / 150k60%");
  });

  it("mirrors the pace tick: 60% used heading for 110% leaves 40% now and nothing at reset", async () => {
    const s = snapshot([provider("codex", [win("Weekly limit", 60, { forecast: forecastOf(110), resetsAt: Date.now() + 5 * HOUR_MS })])]);
    render(Banner, {}, backend({ snapshot: s, thread: threadState({ providerId: "codex" }) }), remaining);
    const weekly = await findWindow("Weekly limit");
    expect(fillWidth(weekly)).toBe("40%");
    expect(weekly.querySelector("[data-marker]")!.getAttribute("data-marker")).toBe("0");
  });

  it("says in the details how much will be left at reset", async () => {
    render(Banner, {}, backend({ snapshot: twoProviders() }), remaining);
    fireEvent.click(await screen.findByRole("button", { name: "Show details" }));
    const claude = providerBlock("claude-code");
    expect((await findWindow("Current session", claude)).textContent).toContain("5 Hour60%");
    expect((await findWindow("Weekly limit", claude)).textContent).toContain("About 8% left at reset – resets in 3d");
    const codex = providerBlock("codex");
    expect(within(codex()!).getByRole("button").textContent).toBe("▸Codex5H 90%");
    fireEvent.click(within(codex()!).getByRole("button"));
    expect((await findWindow("Current session", codex)).title).toBe("Current pace: 80% left by reset\nUsual pace (3 past windows): 0% left");
  });

  it("speaks Russian", async () => {
    render(Banner, {}, backend({ snapshot: twoProviders() }), { settings: { limitsShow: "remaining", language: "ru" } });
    fireEvent.click(await screen.findByRole("button", { name: "Подробнее" }));
    expect((await findWindow("Weekly limit", providerBlock("claude-code"))).textContent).toContain("К сбросу останется примерно 8%");
  });
});

describe("band, Russian", () => {
  it("follows the language setting", async () => {
    render(Banner, {}, backend({ snapshot: twoProviders() }), { settings: { language: "ru" } });
    expect((await findWindow("Weekly limit")).textContent).toBe("Нед3д92%");
    expect((await screen.findByTestId("headline")).textContent).toMatch(/^Всё в порядке\. Лимита с запасом хватит до сброса .+\.$/);
    expect(await screen.findByRole("button", { name: "Сжать" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Авто-компакт" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Подробнее" }));
    expect((await screen.findByTestId("context-details")).textContent).toContain("Контекст занято 60%");
  });
});
