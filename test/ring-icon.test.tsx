// @vitest-environment jsdom
// The footer ring: arc length, tone, the empty ring, and the store the
// overlay feeds for the icon, which renders outside the plugin slot.

import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, render as rtl, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IndicatorFeeder, getIndicatorState, setIndicatorState } from "../src/app/indicator-store";
import { RING_ICON, Ring, RingIcon, Rings } from "../src/app/ring-icon";
import { backend, forecastOf, host, provider, render, snapshot, win } from "./app-fixtures";

afterEach(() => {
  cleanup();
  setIndicatorState({ worst: null, title: "Usage limits" });
});

const arc = (container: HTMLElement) => container.querySelector("[data-arc]");

describe("Ring", () => {
  it.each([
    [0, "0"],
    [34, "34"],
    [100, "100"],
    [130, "100"],
  ])("draws %i %% as an arc of %s", (used, drawn) => {
    const { container } = rtl(<Ring worst={{ percent: used, tone: "normal" }} title="t" />);
    expect(arc(container)?.getAttribute("data-arc")).toBe(drawn);
    expect(arc(container)?.getAttribute("stroke-dasharray")).toBe(`${drawn} 100`);
  });

  it.each([
    ["normal", "rgb(22, 163, 74)", "rgb(74, 222, 128)"],
    ["amber", "rgb(234, 138, 12)", "rgb(251, 191, 36)"],
    ["red", "rgb(239, 68, 68)", "rgb(248, 113, 113)"],
  ] as const)("colours the arc for the %s tone inline, in light and dark", async (tone, light, dark) => {
    // Inline: the icon renders outside the plugin slot, where the scoped tone classes do not apply.
    const { container } = rtl(<Ring worst={{ percent: 50, tone }} title="t" />);
    expect(arc(container)?.getAttribute("data-tone")).toBe(tone);
    expect((arc(container) as SVGElement).style.color).toBe(light);
    document.documentElement.classList.add("dark");
    await waitFor(() => expect((arc(container) as SVGElement).style.color).toBe(dark));
    document.documentElement.classList.remove("dark");
  });

  it("P4: without data draws only a dashed neutral track", () => {
    const { container } = rtl(<Ring worst={null} title="Usage limits: No limits data" />);
    expect(arc(container)).toBeNull();
    expect(container.querySelector("svg")?.getAttribute("data-empty")).toBe("true");
    expect(container.querySelector("circle")?.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(container.querySelector("title")?.textContent).toBe("Usage limits: No limits data");
  });

  it("passes className to the root", () => {
    const { container } = rtl(<Ring worst={null} title="t" className="size-5 text-muted" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("size-5 text-muted");
  });

  it("RingIcon draws one ring with the even tick when the store says ring", () => {
    const { container } = rtl(<RingIcon />);
    act(() => setIndicatorState({ worst: worstOf(92, "red"), even: 40, title: "Claude Code · 5 Hour: 92%, critical", style: "ring" }));
    expect(container.querySelector("svg")?.getAttribute("data-style")).toBe("ring");
    expect(arc(container)?.getAttribute("data-arc")).toBe("92");
    expect(container.querySelector("[data-even]")?.getAttribute("data-even")).toBe("40");
    expect(container.querySelector("title")?.textContent).toBe("Claude Code · 5 Hour: 92%, critical");
  });

  it("RingIcon draws two rings by default: 5-hour outside, weekly inside", () => {
    const { container } = rtl(<RingIcon />);
    act(() =>
      setIndicatorState({ worst: worstOf(92, "red"), title: "t", outer: { percent: 92, tone: "red" }, inner: { percent: 41, tone: "normal" } }),
    );
    expect(container.querySelector("svg")?.getAttribute("data-style")).toBe("rings");
    expect(container.querySelector("[data-ring=outer]")?.getAttribute("data-arc")).toBe("92");
    expect(container.querySelector("[data-ring=inner]")?.getAttribute("data-arc")).toBe("41");
    expect(container.querySelector("[data-ring=inner]")?.getAttribute("data-tone")).toBe("normal");
  });

  it("P4: two rings without data are one dashed track", () => {
    const { container } = rtl(<Rings outer={null} inner={null} title="t" />);
    expect(container.querySelector("svg")?.getAttribute("data-empty")).toBe("true");
    expect(container.querySelectorAll("circle")).toHaveLength(1);
    expect(container.querySelector("circle")?.getAttribute("stroke-dasharray")).toBeTruthy();
  });
});

function worstOf(percent: number, tone: "normal" | "amber" | "red") {
  return { percent, tone };
}

describe("IndicatorFeeder", () => {
  const critical = () =>
    snapshot([], {
      hosts: [
        host("server", [provider("codex", [win("Weekly limit", 40)])], { primary: true }),
        host("laptop", [provider("claude-code", [win("Current session", 92, { forecast: { ...forecastOf(150)!, current: { projectedPercent: 150, runOutAt: Date.now() + 10 * 60_000 } } })])]),
      ],
    });

  it("writes the worst window and an English title by default", async () => {
    render(IndicatorFeeder, {}, backend({ snapshot: critical() }));
    await waitFor(() => expect(getIndicatorState().worst?.percent).toBe(92));
    expect(getIndicatorState().worst?.tone).toBe("red");
    expect(getIndicatorState().title).toMatch(/^laptop · Claude Code · 5 Hour: 92%, critical$/);
  });

  it("draws the share left by the percent mode, in the same tones", async () => {
    render(IndicatorFeeder, {}, backend({ snapshot: critical() }), { settings: { percentMode: "left", sidebarShow: "ring" } });
    await waitFor(() => expect(getIndicatorState().worst?.percent).toBe(8));
    expect(getIndicatorState().worst?.tone).toBe("red");
    expect(getIndicatorState().title).toMatch(/^laptop · Claude Code · 5 Hour: 8% left, critical$/);
  });

  it("writes a Russian title when the settings say so", async () => {
    render(IndicatorFeeder, {}, backend({ snapshot: critical() }), { settings: { language: "ru" } });
    await waitFor(() => expect(getIndicatorState().title).toMatch(/^laptop · Claude Code · 5 часов: 92%, критично$/));
  });

  it("writes the 5-hour and weekly rings of the worst window's provider", async () => {
    const s = snapshot([provider("codex", [win("Current session", 30), win("Weekly limit", 60)])]);
    render(IndicatorFeeder, {}, backend({ snapshot: s }));
    await waitFor(() => expect(getIndicatorState().outer?.percent).toBe(30));
    expect(getIndicatorState().style).toBe("rings");
    expect(getIndicatorState().inner?.percent).toBe(60);
    expect(getIndicatorState().title).toMatch(/^Codex · 5 Hour: 30%.* · Weekly: 60%/);
  });

  it("writes one ring by the sidebarShow setting", async () => {
    const s = snapshot([provider("codex", [win("Current session", 30), win("Weekly limit", 60)])]);
    render(IndicatorFeeder, {}, backend({ snapshot: s }), { settings: { sidebarShow: "ring" } });
    await waitFor(() => expect(getIndicatorState().style).toBe("ring"));
    expect(getIndicatorState().outer).toBeNull();
    expect(getIndicatorState().title).not.toContain(" · Weekly");
  });

  it("is registered with the icon", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.icons.map((i) => i.name)).toContain(RING_ICON);
    expect(app.appOverlays.map((o) => o.id)).toContain("indicator-feeder");
  });
});
