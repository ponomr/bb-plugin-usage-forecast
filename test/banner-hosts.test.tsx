// @vitest-environment jsdom
// The band of a thread shows only the limits of the host the thread runs on,
// marks them stale when that host is unavailable, and says when the host is
// unknown instead of showing another host's windows.

import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { backend, forecastOf, host, provider, render, snapshot, threadState, win } from "./app-fixtures";

let Banner: React.ComponentType<object>;
let Section: React.ComponentType<object>;

beforeAll(async () => {
  const app = await loadPluginApp(() => import("../app"));
  Banner = app.composerCustomizations[0]!.banners![0]!.component as React.ComponentType<object>;
  Section = app.settingsSections[0]!.component as React.ComponentType<object>;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const codex = (session: number, weekly: number, plan: string) =>
  provider("codex", [win("Current session", session, { forecast: forecastOf(session + 10) }), win("Weekly limit", weekly, { forecast: forecastOf(weekly + 10) })], {
    planLabel: plan,
  });

/** The server host with Codex at week 57 % and a Mac on another Codex account at week 5 %. */
const twoHosts = (mac: Partial<Parameters<typeof host>[2]> = {}) =>
  snapshot([], {
    hosts: [
      host("host_server", [codex(20, 57, "Pro")], { name: "clovis", primary: true }),
      host("host_mac", [codex(3, 5, "Plus")], { name: "MacBook", ...mac }),
    ],
  });

const codexThread = (hostId: string | null) => threadState({ providerId: "codex", hostId });

async function bandText() {
  const band = await screen.findByTestId("usage-banner");
  await waitFor(() => expect(screen.queryByLabelText("Loading")).toBeNull());
  return band;
}

describe("band per host", () => {
  it("AE1: a Mac thread shows the Mac's week 5% and nothing of the server's 57%", async () => {
    render(Banner, {}, backend({ snapshot: twoHosts(), thread: codexThread("host_mac") }));
    await waitFor(() => expect(document.querySelector('[data-window="Weekly limit"]')?.textContent).toContain("5%"));
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    const band = await bandText();
    await waitFor(() => expect(band.textContent).toContain("Plus"));
    expect(band.textContent).not.toContain("57%");
    expect(band.textContent).not.toContain("Pro");
    expect(band.textContent).not.toContain("clovis");
    expect(band.textContent).not.toContain("MacBook");
  });

  it("AE6: one host shows its windows with no host name, whatever the thread's host", async () => {
    const s = snapshot([], { hosts: [host("host_server", [codex(20, 57, "Pro")], { name: "clovis", primary: true })] });
    render(Banner, {}, backend({ snapshot: s, thread: codexThread(null) }));
    await waitFor(() => expect(document.querySelector('[data-window="Weekly limit"]')?.textContent).toContain("57%"));
    const band = await bandText();
    expect(band.textContent).not.toContain("clovis");
    expect(screen.queryByTestId("stale")).toBeNull();
  });

  it("AE4: a disconnected host keeps its values, marked stale with their time, and no forecast", async () => {
    const at = Date.now() - 40 * 60_000;
    const s = twoHosts({ connected: false, polledAt: at });
    s.hosts[1]!.providers = s.hosts[1]!.providers.map((p) => ({ ...p, measuredAt: at }));
    render(Banner, {}, backend({ snapshot: s, thread: codexThread("host_mac") }));
    const stale = await screen.findByTestId("stale");
    expect(stale.textContent).toMatch(/^Host unavailable, data from .+/);
    expect(document.querySelector('[data-window="Weekly limit"]')?.textContent).toContain("5%");
    expect(screen.queryByTestId("headline")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    const band = await bandText();
    expect(band.textContent).not.toMatch(/On pace|Limit will hit|will be left/);
  });

  it("marks a host whose last poll failed as stale and shows its error", async () => {
    render(Banner, {}, backend({ snapshot: twoHosts({ pollError: "No answer within 30 s" }), thread: codexThread("host_mac") }));
    expect((await screen.findByTestId("stale")).textContent).toMatch(/^Host unavailable/);
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect((await bandText()).textContent).toContain("Last poll failed: No answer within 30 s");
  });

  it("does not show the other host's poll error", async () => {
    const s = twoHosts();
    s.hosts[0]!.pollError = "boom";
    s.pollError = "clovis: boom";
    render(Banner, {}, backend({ snapshot: s, thread: codexThread("host_mac") }));
    fireEvent.click(await screen.findByRole("button", { name: "Show details" }));
    const band = await bandText();
    await waitFor(() => expect(band.textContent).toContain("Plus"));
    expect(band.textContent).not.toContain("boom");
    expect(screen.queryByTestId("stale")).toBeNull();
  });

  it("an unresolved host with two hosts known shows the host-unknown state and no windows", async () => {
    render(Banner, {}, backend({ snapshot: twoHosts(), thread: codexThread(null) }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("Limits unknown: this thread's host has no data"));
    expect(document.querySelector('[data-window="Weekly limit"]')).toBeNull();
  });

  it("an unresolved host with one host known shows that host's windows", async () => {
    const s = snapshot([], { hosts: [host("host_server", [codex(20, 57, "Pro")], { primary: true })] });
    render(Banner, {}, backend({ snapshot: s, thread: codexThread(null) }));
    await waitFor(() => expect(document.querySelector('[data-window="Weekly limit"]')?.textContent).toContain("57%"));
  });

  it("a resolved host absent from the snapshot shows the host-unknown state, even with one other host", async () => {
    const s = snapshot([], { hosts: [host("host_server", [codex(20, 57, "Pro")], { primary: true })] });
    render(Banner, {}, backend({ snapshot: s, thread: codexThread("host_mac") }));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("Limits unknown: this thread's host has no data"));
    expect(document.querySelector('[data-window="Weekly limit"]')).toBeNull();
    expect(screen.getByTestId("usage-banner").textContent).not.toContain("57%");
  });

  it("speaks Russian for the stale and unknown states", async () => {
    render(Banner, {}, backend({ snapshot: twoHosts({ connected: false }), thread: codexThread("host_mac") }), { settings: { language: "ru" } });
    expect((await screen.findByTestId("stale")).textContent).toMatch(/^Хост недоступен, данные от .+/);
    cleanup();
    render(Banner, {}, backend({ snapshot: twoHosts(), thread: codexThread(null) }), { settings: { language: "ru" } });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("Лимиты неизвестны: нет данных хоста этого треда"));
  });
});

describe("settings per host", () => {
  it("lists a provider that two hosts report once", async () => {
    render(Section, {}, backend({ snapshot: twoHosts() }), { settings: {} });
    const root = await screen.findByTestId("usage-settings");
    await waitFor(() => expect(root.textContent).toContain("Codex: ok"));
    expect(root.textContent!.match(/Codex: ok/g)).toHaveLength(1);
  });
});
