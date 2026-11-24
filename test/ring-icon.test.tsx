// @vitest-environment jsdom
// The footer ring: arc length, tone, the empty ring, and the store the
// overlay feeds for the icon, which renders outside the plugin slot.

import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, render as rtl, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IndicatorFeeder, getIndicatorState, setIndicatorState } from "../src/app/indicator-store";
import { RING_ICON, Ring, RingIcon } from "../src/app/ring-icon";
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
    const { container } = rtl(<Ring worst={{ usedPercent: used, tone: "normal" }} title="t" />);
    expect(arc(container)?.getAttribute("data-arc")).toBe(drawn);
    expect(arc(container)?.getAttribute("stroke-dasharray")).toBe(`${drawn} 100`);
  });

  it.each([
    ["normal", "text-[#16a34a]"],
    ["amber", "text-[#ea8a0c]"],
    ["red", "text-[#ef4444]"],
  ] as const)("colours the arc for the %s tone", (tone, cls) => {
    const { container } = rtl(<Ring worst={{ usedPercent: 50, tone }} title="t" />);
    expect(arc(container)?.getAttribute("data-tone")).toBe(tone);
    expect(arc(container)?.getAttribute("class")).toContain(cls);
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

  it("RingIcon follows the store", () => {
    const { container } = rtl(<RingIcon />);
    expect(arc(container)).toBeNull();
    act(() => setIndicatorState({ worst: worstOf(92, "red"), title: "Claude Code · 5 Hour: 92%, critical" }));
    expect(arc(container)?.getAttribute("data-arc")).toBe("92");
    expect(container.querySelector("title")?.textContent).toBe("Claude Code · 5 Hour: 92%, critical");
  });
});

function worstOf(usedPercent: number, tone: "normal" | "amber" | "red") {
  return { hostName: null, providerId: "claude-code", label: "Current session", model: null, usedPercent, resetsAt: null, state: null, tone, staleAt: null };
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
    await waitFor(() => expect(getIndicatorState().worst?.usedPercent).toBe(92));
    expect(getIndicatorState().worst?.tone).toBe("red");
    expect(getIndicatorState().title).toMatch(/^laptop · Claude Code · 5 Hour: 92%, critical$/);
  });

  it("writes a Russian title when the settings say so", async () => {
    render(IndicatorFeeder, {}, backend({ snapshot: critical() }), { settings: { language: "ru" } });
    await waitFor(() => expect(getIndicatorState().title).toMatch(/^laptop · Claude Code · 5 часов: 92%, критично$/));
  });

  it("is registered with the icon", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.icons.map((i) => i.name)).toContain(RING_ICON);
    expect(app.appOverlays.map((o) => o.id)).toContain("indicator-feeder");
  });
});
