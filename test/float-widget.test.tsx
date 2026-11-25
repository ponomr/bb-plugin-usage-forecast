// @vitest-environment jsdom
// The floating limits widget: off by default, one line per provider, the fold
// into a badge with two rings, the vertical drag and what it keeps per device.

import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FloatLimits, floatTopPx, parseFloatTop } from "../src/app/float-widget";
import { DAY_MS } from "../src/shared/windows";
import { backend, provider, render, snapshot, T, threadState, win } from "./app-fixtures";

const weekly = (used: number) => win("Weekly limit", used, { durationMs: 7 * DAY_MS, resetsAt: Date.now() + 3 * DAY_MS });
const two = () =>
  snapshot([
    provider("claude-code", [win("Current session", 41), weekly(38)]),
    provider("codex", [win("Current session", 5), weekly(22)]),
  ]);
const on = { showFloat: true };

beforeEach(() => window.history.replaceState(null, "", `/projects/p1/threads/${T}`));
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("float position", () => {
  it("reads a stored share and falls back to mid-height", () => {
    expect(parseFloatTop(null)).toBe(0.5);
    expect(parseFloatTop("x")).toBe(0.5);
    expect(parseFloatTop("0.25")).toBe(0.25);
    expect(parseFloatTop("3")).toBe(1);
  });

  it("keeps the widget inside the window", () => {
    expect(floatTopPx(0.5, 800, 60)).toBe(400);
    expect(floatTopPx(0, 800, 60)).toBe(38);
    expect(floatTopPx(1, 800, 60)).toBe(762);
  });
});

describe("float widget", () => {
  it("is off by default", async () => {
    render(FloatLimits, {}, backend({ snapshot: two() }));
    await act(async () => {});
    expect(screen.queryByTestId("float-limits")).toBeNull();
  });

  it("F4: one line per provider, the thread's own first, percents in their tones", async () => {
    render(FloatLimits, {}, backend({ snapshot: two(), thread: threadState({ providerId: "codex" }) }), { settings: on });
    const widget = await screen.findByTestId("float-limits");
    await waitFor(() => expect(widget.querySelectorAll("[data-provider]")).toHaveLength(2));
    const lines = Array.from(widget.querySelectorAll<HTMLElement>("[data-provider]"));
    expect(lines.map((l) => l.textContent)).toEqual(["Codex5H5%W22%", "Claude5H41%W38%"]);
    expect(within(lines[1]!).getByText("41%").getAttribute("data-tone")).toBeTruthy();
    expect(widget.getAttribute("data-folded")).toBe("false");
    expect(widget.getAttribute("aria-label")).toMatch(/^Codex 5H 5% W 22% · Claude 5H 41% W 38%\./);
    expect(widget.style.top).toBe(`${floatTopPx(0.5, window.innerHeight, 0)}px`);
  });

  it("F2: a press folds it into a badge with two rings and back, kept per device", async () => {
    render(FloatLimits, {}, backend({ snapshot: two() }), { settings: on });
    const widget = await screen.findByTestId("float-limits");
    await waitFor(() => expect(widget.querySelectorAll("[data-provider]").length).toBeGreaterThan(0));
    fireEvent.click(widget);
    expect(widget.getAttribute("data-folded")).toBe("true");
    await waitFor(() => expect(widget.querySelector("[data-ring=outer]")?.getAttribute("data-arc")).toBe("41"));
    expect(widget.querySelector("[data-ring=inner]")?.getAttribute("data-arc")).toBe("38");
    expect(localStorage.getItem("usage-forecast:float-folded")).toBe("1");
    cleanup();
    render(FloatLimits, {}, backend({ snapshot: two() }), { settings: on });
    const again = await screen.findByTestId("float-limits");
    expect(again.getAttribute("data-folded")).toBe("true");
    fireEvent.click(again);
    expect(again.getAttribute("data-folded")).toBe("false");
  });

  it("is dragged up or down without folding, and keeps the place", async () => {
    render(FloatLimits, {}, backend({ snapshot: two() }), { settings: on });
    const widget = await screen.findByTestId("float-limits");
    const start = parseFloat(widget.style.top);
    fireEvent.pointerDown(widget, { pointerId: 1, clientY: start });
    fireEvent.pointerMove(widget, { pointerId: 1, clientY: start - 100 });
    fireEvent.pointerUp(widget, { pointerId: 1, clientY: start - 100 });
    fireEvent.click(widget);
    expect(widget.getAttribute("data-folded")).toBe("false");
    expect(parseFloat(widget.style.top)).toBe(start - 100);
    expect(Number(localStorage.getItem("usage-forecast:float-top"))).toBeCloseTo((start - 100) / window.innerHeight, 2);
  });

  it("a small move is a press", async () => {
    render(FloatLimits, {}, backend({ snapshot: two() }), { settings: on });
    const widget = await screen.findByTestId("float-limits");
    fireEvent.pointerDown(widget, { pointerId: 1, clientY: 300 });
    fireEvent.pointerMove(widget, { pointerId: 1, clientY: 302 });
    fireEvent.pointerUp(widget, { pointerId: 1, clientY: 302 });
    fireEvent.click(widget);
    expect(widget.getAttribute("data-folded")).toBe("true");
  });

  it("moves by the arrow keys", async () => {
    render(FloatLimits, {}, backend({ snapshot: two() }), { settings: on });
    const widget = await screen.findByTestId("float-limits");
    fireEvent.keyDown(widget, { key: "ArrowUp" });
    expect(Number(localStorage.getItem("usage-forecast:float-top"))).toBeCloseTo(0.45, 2);
  });

  it("P4: says so without data", async () => {
    render(FloatLimits, {}, backend({ snapshot: snapshot([], { polledAt: null }) }), { settings: on });
    const widget = await screen.findByTestId("float-limits");
    expect(widget.textContent).toBe("—");
    expect(widget.getAttribute("aria-label")).toMatch(/^Usage limits: No limits data\./);
    fireEvent.click(widget);
    expect(widget.querySelector("svg")?.getAttribute("data-empty")).toBe("true");
  });

  it("is registered as an app overlay", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.appOverlays.map((o) => o.id)).toContain("float-limits");
  });
});
