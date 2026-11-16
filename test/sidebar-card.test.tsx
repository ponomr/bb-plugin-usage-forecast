// @vitest-environment jsdom
// The card the footer ring opens: host headings only with several hosts, a
// shared account once with the hosts it is also on, and the band's rows.

import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "../src/app/i18n";
import { windowNote, windowView } from "../src/app/model";
import { SidebarCard } from "../src/app/sidebar-card";
import { backend, host, provider, render, snapshot, win } from "./app-fixtures";

afterEach(() => cleanup());

const props = { dismiss: () => {} };

const card = () => screen.getByTestId("limits-card");

describe("SidebarCard", () => {
  it("with two hosts heads each group with its host", async () => {
    const b = backend({
      snapshot: snapshot([], {
        hosts: [
          host("server", [provider("codex", [win("Weekly limit", 40)])], { primary: true }),
          host("laptop", [provider("claude-code", [win("Current session", 70)])]),
        ],
      }),
    });
    render(SidebarCard, props, b);
    await waitFor(() => expect(card().querySelectorAll("[data-host]")).toHaveLength(2));
    expect(Array.from(card().querySelectorAll("h3")).map((h) => h.textContent)).toEqual(["server", "laptop"]);
    expect(within(card().querySelector('[data-host="laptop"]')!).getByText("Claude Code")).toBeTruthy();
  });

  it("with one host has no host heading", async () => {
    render(SidebarCard, props, backend());
    await waitFor(() => expect(card().querySelector("[data-provider]")).not.toBeNull());
    expect(card().querySelector("h3")).toBeNull();
  });

  it("lists a shared account once, with the other hosts", async () => {
    const shared = (sharedWith: string) => provider("claude-code", [win("Current session", 30)], { sharedWith: [sharedWith] });
    const b = backend({
      snapshot: snapshot([], { hosts: [host("server", [shared("laptop")], { primary: true }), host("laptop", [shared("server")])] }),
    });
    render(SidebarCard, props, b);
    await waitFor(() => expect(screen.getByTestId("also-on").textContent).toBe("also laptop"));
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

  it("shows the band's note under a window", async () => {
    const w = win("Current session", 40);
    render(SidebarCard, props, backend({ snapshot: snapshot([provider("codex", [w])]) }));
    const now = Date.now();
    await waitFor(() => expect(card().querySelector('[data-window="Current session"]')).not.toBeNull());
    expect(card().querySelector('[data-window="Current session"]')!.textContent).toContain(windowNote(en, windowView(w, now), now));
  });

  it("is registered as the footer disclosure with the ring", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const item = app.experimentalSidebarFooterItems.find((i) => i.id === "limits");
    expect(item).toMatchObject({ kind: "disclosure", label: "Usage limits", icon: "usage-forecast/ring" });
  });
});
