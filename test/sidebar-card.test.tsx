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
    await waitFor(() => expect(screen.getByTestId("also-on").getAttribute("title")).toBe("also laptop"));
    expect(card().querySelectorAll('[data-provider="claude-code"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: "laptop" }));
    expect(screen.getByTestId("also-on").getAttribute("title")).toBe("also server");
    expect(card().querySelectorAll('[data-provider="claude-code"]')).toHaveLength(1);
  });

  it("shows the plan with its multiplier", async () => {
    const b = backend({ snapshot: snapshot([provider("claude-code", [win("Current session", 30)], { planLabel: "Max", planMultiplier: 20 })]) });
    render(SidebarCard, props, b);
    await waitFor(() => expect(within(card()).getByText("Max 20×")).toBeTruthy());
  });

  it("without any ok provider says there is no data", async () => {
    render(SidebarCard, props, backend({ snapshot: snapshot([provider("codex", [], { status: "not_installed" })]) }));
    await waitFor(() => expect(card().textContent).toBe(en.noLimitsData));
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

  it("keeps a reset shown as a time on the window's line", async () => {
    render(SidebarCard, props, backend({ snapshot: snapshot([provider("codex", [win("Weekly limit", 40)])]) }), { settings: { resetShow: "time" } });
    await waitFor(() => expect(screen.getByTestId("window-reset").className).toContain("whitespace-nowrap"));
    expect(screen.getByTestId("window-reset").className).toContain("w-24");
  });

  it("spells out a window that runs out before its reset", async () => {
    const w = win("Current session", 80, {
      forecast: { status: "running", current: { projectedPercent: 140, runOutAt: Date.now() + HOUR_MS }, learned: null, main: "current", early: false, warning: true },
    });
    render(SidebarCard, props, backend({ snapshot: snapshot([provider("codex", [w])]) }));
    await waitFor(() => expect(screen.getByTestId("window-runs-out").textContent).toMatch(/^runs out at \d/));
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

describe("SidebarCard, tokens (UF-12 R9)", () => {
  const pair = (work: number) => ({ work, all: work * 10 });
  const tokens = async () => ({
    thread: null,
    providers: [{ providerId: "codex", today: pair(310_000), month: pair(4_200_000) }],
    backfillDone: true,
  });

  it("gives a provider with sums today and month, and a provider without none", async () => {
    const b = backend({
      snapshot: snapshot([provider("codex", [win("Weekly limit", 40)]), provider("claude-code", [win("Current session", 70)])]),
      tokens,
    });
    render(SidebarCard, props, b);
    await waitFor(() => expect(screen.getByTestId("provider-tokens").textContent).toBe("310k · 4.2M"));
    expect(screen.getByTestId("provider-tokens").getAttribute("title")).toBe("today 310k · month 4.2M");
    expect(card().querySelector('[data-provider="codex"] [data-testid="provider-tokens"]')).not.toBeNull();
    expect(card().querySelector('[data-provider="claude-code"] [data-testid="provider-tokens"]')).toBeNull();
    expect(callsTo(b, "tokens")[0]!.input).toMatchObject({ threadId: null });
  });

  it("speaks Russian", async () => {
    render(SidebarCard, props, backend({ snapshot: snapshot([provider("codex", [win("Weekly limit", 40)])]), tokens }), { settings: { language: "ru" } });
    await waitFor(() => expect(screen.getByTestId("provider-tokens").getAttribute("title")).toBe("сегодня 310 тыс. · месяц 4,2 млн"));
  });

  it("shows a provider listed under two hosts with its sums in each tab", async () => {
    const b = backend({
      snapshot: snapshot([], {
        hosts: [
          host("server", [provider("codex", [win("Weekly limit", 40)])], { primary: true }),
          host("laptop", [provider("codex", [win("Weekly limit", 60)])]),
        ],
      }),
      tokens,
    });
    render(SidebarCard, props, b);
    await waitFor(() => expect(screen.getAllByTestId("provider-tokens")).toHaveLength(1));
    fireEvent.click(screen.getByRole("tab", { name: "server" }));
    expect(card().querySelector('[data-host="server"] [data-testid="provider-tokens"]')).not.toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "laptop" }));
    expect(card().querySelector('[data-host="laptop"] [data-testid="provider-tokens"]')).not.toBeNull();
  });

  it("leaves a hidden provider out with its sums", async () => {
    const b = backend({
      snapshot: snapshot([provider("codex", [win("Weekly limit", 40)]), provider("claude-code", [win("Current session", 70)])]),
      tokens,
    });
    render(SidebarCard, props, b, { settings: { hiddenProviders: "codex" } });
    await waitFor(() => expect(callsTo(b, "tokens").length).toBeGreaterThan(0));
    await waitFor(() => expect(card().querySelector('[data-provider="claude-code"]')).not.toBeNull());
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(card().querySelector('[data-provider="codex"]')).toBeNull();
    expect(screen.queryByTestId("provider-tokens")).toBeNull();
  });

  it("a failed query adds nothing and no error", async () => {
    const b = backend({ snapshot: snapshot([provider("codex", [win("Weekly limit", 40)])]), tokens: async () => Promise.reject(new Error("tokens failed")) });
    render(SidebarCard, props, b);
    await waitFor(() => expect(callsTo(b, "tokens").length).toBeGreaterThan(0));
    await waitFor(() => expect(card().querySelector('[data-provider="codex"]')).not.toBeNull());
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByTestId("provider-tokens")).toBeNull();
    expect(card().textContent).not.toContain("tokens failed");
  });
});
