// @vitest-environment jsdom
// The card the footer ring opens: host headings only with several hosts, a
// shared account once with the hosts it is also on, and the band's rows.

import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "../src/app/i18n";
import { windowNote, windowView } from "../src/app/model";
import { SidebarCard } from "../src/app/sidebar-card";
import { HOUR_MS } from "../src/shared/windows";
import { backend, callsTo, host, provider, render, snapshot, win } from "./app-fixtures";

afterEach(() => cleanup());

const props = { dismiss: () => {} };

const card = () => screen.getByTestId("limits-card");

describe("SidebarCard", () => {
  it("with two hosts shows one host at a time, picked by tabs", async () => {
    const b = backend({
      snapshot: snapshot([], {
        hosts: [
          host("server", [provider("codex", [win("Weekly limit", 40)])], { primary: true }),
          host("laptop", [provider("claude-code", [win("Current session", 70)])]),
        ],
      }),
    });
    render(SidebarCard, props, b);
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["server", "laptop"]);
    // It opens on the host of the ring's worst window.
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("laptop");
    expect(card().querySelectorAll("[data-host]")).toHaveLength(1);
    expect(within(card().querySelector('[data-host="laptop"]')!).getByText("Claude Code")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "server" }));
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("server");
    expect(card().querySelector('[data-host="laptop"]')).toBeNull();
    expect(within(card().querySelector('[data-host="server"]')!).getByText("Codex")).toBeTruthy();
  });

  it("big numbers: percents only, tabs and actions stay, left or used", async () => {
    const b = () =>
      backend({
        snapshot: snapshot([], {
          hosts: [
            host("server", [provider("codex", [win("Current session", 30), win("Weekly limit", 40)])], { primary: true }),
            host("laptop", [provider("claude-code", [win("Current session", 70), win("Weekly limit", 0, { resetsAt: null })])]),
          ],
        }),
      });
    render(SidebarCard, props, b(), { settings: { cardStyle: "big", percentMode: "left" } });
    await waitFor(() => expect(card().querySelector("[data-style=big]")).not.toBeNull());
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    const claude = card().querySelector<HTMLElement>("[data-provider=claude-code] ul")!;
    expect(Array.from(claude.querySelectorAll("[data-window]")).map((w) => w.textContent)).toEqual(["30%5H", "—W"]);
    expect(card().querySelector("[data-testid=window-reset]")).toBeNull();
    expect(card().querySelector("[data-provider] [aria-hidden]")).toBeNull();
    expect(screen.getByTestId("card-age")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "server" }));
    expect(Array.from(card().querySelectorAll("[data-provider=codex] [data-window]")).map((w) => w.textContent)).toEqual(["70%5H", "60%W"]);
    cleanup();
    render(SidebarCard, props, b(), { settings: { cardStyle: "big", percentMode: "used" } });
    await waitFor(() => expect(card().querySelector("[data-style=big]")).not.toBeNull());
    expect(card().querySelector("[data-provider=claude-code] [data-window]")!.textContent).toBe("70%5H");
  });

  it("rows by default", async () => {
    render(SidebarCard, props, backend());
    await waitFor(() => expect(card().querySelector("[data-style=rows]")).not.toBeNull());
  });

  it("with one host has no tabs", async () => {
    render(SidebarCard, props, backend());
    await waitFor(() => expect(card().querySelector("[data-provider]")).not.toBeNull());
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("lists a shared account in each host's tab, with the other hosts", async () => {
    const shared = (sharedWith: string) => provider("claude-code", [win("Current session", 30)], { sharedWith: [sharedWith] });
    const b = backend({
      snapshot: snapshot([], { hosts: [host("server", [shared("laptop")], { primary: true }), host("laptop", [shared("server")])] }),
    });
    render(SidebarCard, props, b);
    await waitFor(() => expect(screen.getByTestId("provider-name").getAttribute("title")).toBe("also laptop"));
    expect(card().querySelectorAll('[data-provider="claude-code"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: "laptop" }));
    expect(screen.getByTestId("provider-name").getAttribute("title")).toBe("also server");
    expect(card().querySelectorAll('[data-provider="claude-code"]')).toHaveLength(1);
  });

  it("puts the plan with its multiplier into the name's tooltip, not on the card", async () => {
    const b = backend({ snapshot: snapshot([provider("claude-code", [win("Current session", 30)], { planLabel: "Max", planMultiplier: 20 })]) });
    render(SidebarCard, props, b);
    await waitFor(() => expect(screen.getByTestId("provider-name").getAttribute("title")).toBe("Max 20×"));
    expect(card().textContent).not.toContain("Max 20×");
  });

  it("without any ok provider says there is no data", async () => {
    render(SidebarCard, props, backend({ snapshot: snapshot([provider("codex", [], { status: "not_installed" })]) }));
    await waitFor(() => expect(card().textContent).toContain(en.noLimitsData));
  });

  it("puts a window on one line and keeps the band's note in its tooltip", async () => {
    const w = win("Current session", 40);
    render(SidebarCard, props, backend({ snapshot: snapshot([provider("codex", [w])]) }));
    const now = Date.now();
    await waitFor(() => expect(card().querySelector('[data-window="Current session"]')).not.toBeNull());
    const row = card().querySelector('[data-window="Current session"]')!;
    const note = windowNote(en, windowView(w, now), now);
    expect(row.getAttribute("title")).toContain(note);
    expect(row.textContent).not.toContain(note);
    expect(row.textContent).toContain("5H");
    expect(row.textContent).toContain("40%");
    expect(screen.queryByTestId("window-runs-out")).toBeNull();
  });

  it("counts down to the reset on the window's line, the local time in its tooltip", async () => {
    render(SidebarCard, props, backend({ snapshot: snapshot([provider("codex", [win("Weekly limit", 40)])]) }));
    await waitFor(() => expect(screen.getByTestId("window-reset").className).toContain("whitespace-nowrap"));
    const reset = screen.getByTestId("window-reset");
    expect(reset.textContent).toMatch(/^(\d+d)?\s?(\d+h)?\s?(\d+m)?$/);
    expect(reset.textContent).not.toMatch(/:/);
    expect(reset.firstElementChild!.getAttribute("title")).toMatch(/\d{1,2}:\d{2}/);
  });

  it("draws no pace ticks on the bars", async () => {
    render(SidebarCard, props, backend({ snapshot: snapshot([provider("codex", [win("Current session", 40)])]) }));
    await waitFor(() => expect(card().querySelector('[data-window="Current session"]')).not.toBeNull());
    expect(card().querySelector("[data-even], [data-marker]")).toBeNull();
  });

  it("shows a dash for a window that has not started, in both modes", async () => {
    const idle = win("Current session", 0, { resetsAt: null });
    for (const percentMode of ["left", "used"]) {
      render(SidebarCard, props, backend({ snapshot: snapshot([provider("claude-code", [idle])]) }), { settings: { percentMode } });
      await waitFor(() => expect(screen.getByTestId("window-not-started").textContent).toBe("—"));
      expect(card().querySelector('[data-window="Current session"]')!.textContent).not.toContain("%");
      expect(screen.getByTestId("window-reset").textContent).toBe("");
      cleanup();
    }
  });

  it("shows only the data's age before the buttons, the sentence in its tooltip", async () => {
    render(SidebarCard, props, backend());
    await waitFor(() => expect(screen.getByTestId("card-age").getAttribute("title")).toMatch(/^Updated /));
    expect(screen.getByTestId("card-age").textContent).not.toContain("Updated");
  });

  it("shows the share left in left mode", async () => {
    render(SidebarCard, props, backend({ snapshot: snapshot([provider("codex", [win("Current session", 15)])]) }), { settings: { percentMode: "left" } });
    await waitFor(() => expect(card().querySelector('[data-window="Current session"]')!.textContent).toContain("85%"));
  });

  it("spells out a window that runs out before its reset", async () => {
    const w = win("Current session", 80, {
      forecast: { status: "running", current: { projectedPercent: 140, runOutAt: Date.now() + HOUR_MS }, learned: null, main: "current", early: false, warning: true },
    });
    render(SidebarCard, props, backend({ snapshot: snapshot([provider("codex", [w])]) }));
    await waitFor(() => expect(screen.getByTestId("window-runs-out").textContent).toMatch(/^runs out (at )?\S/));
  });

  it("keeps a label with no short form whole", async () => {
    render(SidebarCard, props, backend({ snapshot: snapshot([provider("claude-code", [win("Fable", 34)])]) }));
    await waitFor(() => expect(card().querySelector('[data-window="Fable"]')).not.toBeNull());
    expect(card().querySelector('[data-window="Fable"]')!.textContent).toContain("Fable");
  });

  it("is registered as the footer disclosure with the ring", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const item = app.experimentalSidebarFooterItems.find((i) => i.id === "limits");
    expect(item).toMatchObject({ kind: "disclosure", label: "Usage limits", icon: "usage-forecast/ring" });
  });
});

describe("hidden providers (UF-11)", () => {
  it("leaves hidden providers out of the card; all hidden is the empty state (AE4)", async () => {
    const s = snapshot([provider("claude-code", [win("Current session", 30)]), provider("codex", [win("Weekly limit", 97)])]);
    render(SidebarCard, props, backend({ snapshot: s }), { settings: { hiddenProviders: "codex" } });
    await waitFor(() => expect(card().querySelector('[data-provider="claude-code"]')).not.toBeNull());
    expect(card().querySelector('[data-provider="codex"]')).toBeNull();
    cleanup();
    render(SidebarCard, props, backend({ snapshot: s }), { settings: { hiddenProviders: "codex, claude-code" } });
    await waitFor(() => expect(within(card()).getByText(en.noLimitsData)).toBeTruthy());
    expect(card().querySelector("[data-provider]")).toBeNull();
  });
});

describe("SidebarCard, tokens", () => {
  it("are not on the card (к1); the band and the CLI keep them", async () => {
    const b = backend({
      snapshot: snapshot([provider("codex", [win("Weekly limit", 40)])]),
      tokens: async () => ({ thread: null, providers: [{ providerId: "codex", today: { work: 310_000, all: 0 }, month: { work: 4_200_000, all: 0 } }], backfillDone: true }),
    });
    render(SidebarCard, props, b);
    await waitFor(() => expect(card().querySelector('[data-provider="codex"]')).not.toBeNull());
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(card().textContent).not.toContain("4.2M");
    expect(callsTo(b, "tokens")).toHaveLength(0);
  });
});
