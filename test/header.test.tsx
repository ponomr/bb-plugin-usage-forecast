// @vitest-environment jsdom
// The header limits: the 5-hour and weekly windows of one provider moved into
// the page header row, coloured percents with the 5-hour reset (and bars by the setting), and the limits card with
// its refresh and settings buttons on a press.

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardActions } from "../src/app/card-actions";
import { headerView, headerWindows, threadIdOfPath } from "../src/app/header-model";
import { HeaderLimits } from "../src/app/header-widget";
import { pluginSettingsPath } from "../src/app/hooks";
import { en } from "../src/app/i18n";
import { DAY_MS } from "../src/shared/windows";
import { backend, callsTo, host, provider, render, snapshot, T, threadState, win } from "./app-fixtures";

const weekly = (used: number) => win("Weekly limit", used, { durationMs: 7 * DAY_MS, resetsAt: Date.now() + 3 * DAY_MS });

function headerRow(): HTMLElement {
  const row = document.createElement("div");
  row.dataset.testid = "app-page-header-content-row";
  row.innerHTML = '<div data-title></div><div data-actions></div>';
  // jsdom lays nothing out: the row counts as visible once it has a client rect.
  row.getClientRects = () => [{}] as unknown as DOMRectList;
  document.body.append(row);
  return row;
}

beforeEach(() => window.history.replaceState(null, "", `/projects/p1/threads/${T}`));
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("header model", () => {
  it("reads the thread id from the app path", () => {
    expect(threadIdOfPath("/projects/p1/threads/thr_abc")).toBe("thr_abc");
    expect(threadIdOfPath("/projects/p1/threads/thr_abc/files")).toBe("thr_abc");
    expect(threadIdOfPath("/")).toBeNull();
  });

  it("takes the 5-hour window and the weekly window of all models", () => {
    const fable = win("Fable", 90, { model: "fable", durationMs: 7 * DAY_MS });
    const w = headerWindows(provider("claude-code", [fable, weekly(20), win("Current session", 40)]));
    expect(w.session?.label).toBe("Current session");
    expect(w.weekly?.label).toBe("Weekly limit");
  });

  it("shows the thread's provider, else the worst one", () => {
    const s = snapshot([provider("claude-code", [win("Current session", 10)]), provider("codex", [win("Current session", 95), weekly(50)])]);
    expect(headerView(en, s, { providerId: "claude-code", hostId: null }, Date.now())?.provider.providerId).toBe("claude-code");
    expect(headerView(en, s, undefined, Date.now())?.provider.providerId).toBe("codex");
    expect(headerView(en, snapshot([provider("codex", [])]), undefined, Date.now())).toBeNull();
  });
});

describe("HeaderLimits", () => {
  it("sits in the header row before its actions: coloured percents and the 5-hour reset", async () => {
    const row = headerRow();
    const b = backend({ snapshot: snapshot([provider("claude-code", [win("Current session", 42), weekly(7)])]), thread: threadState() });
    render(HeaderLimits, {}, b);
    const pill = await screen.findByTestId("header-limits");
    expect(pill.closest("[data-bb-plugin=usage-forecast]")!.nextElementSibling).toBe(row.querySelector("[data-actions]"));
    expect(pill.dataset.style).toBe("numbers");
    await waitFor(() => expect(pill.querySelectorAll("[data-gauge]")).toHaveLength(2));
    expect(pill.textContent).toMatch(/^5H(2h|1h 59m)42%W7%$/);
    expect(pill.querySelector("[data-gauge] [aria-hidden]")).toBeNull();
    expect(pill.getAttribute("aria-label")).toContain("Claude Code");
  });

  it("draws horizontal bars by the setting, shows the reset as a time by resetShow, and goes away when off", async () => {
    headerRow();
    const b = backend({ snapshot: snapshot([provider("codex", [win("Current session", 42), weekly(7)])]) });
    const view = render(HeaderLimits, {}, b, { settings: { headerShow: "bars", resetShow: "time", limitsShow: "remaining" } });
    const pill = await screen.findByTestId("header-limits");
    expect(pill.dataset.style).toBe("bars");
    await waitFor(() => expect(pill.querySelectorAll("[data-gauge] [aria-hidden]")).toHaveLength(2));
    expect(pill.textContent).toMatch(/^5H(\S+ )?\d{1,2}:\d{2}( [AP]M)?58%W93%$/);
    view.unmount();
    render(HeaderLimits, {}, b, { settings: { headerShow: "off" } });
    await act(async () => {});
    expect(screen.queryByTestId("header-limits")).toBeNull();
  });

  it("without a header row uses the shared fixed dock", async () => {
    render(HeaderLimits, {}, backend());
    const pill = await screen.findByTestId("header-limits");
    expect(pill.closest("[data-bb-header-addons]")).not.toBeNull();
  });

  it("opens the limits card on a press; Escape closes it", async () => {
    headerRow();
    const b = backend({ snapshot: snapshot([], { hosts: [host(null, [provider("claude-code", [win("Current session", 42), weekly(7)])])] }) });
    render(HeaderLimits, {}, b);
    const pill = await screen.findByTestId("header-limits");
    fireEvent.click(pill);
    const card = await screen.findByTestId("header-limits-card");
    expect(card.dataset.bbPlugin).toBe("usage-forecast");
    expect(within(card).getByText("Claude Code")).toBeTruthy();
    expect(within(card).getByRole("button", { name: en.refreshLimits })).toBeTruthy();
    expect(within(card).getByRole("button", { name: en.openSettings })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("header-limits-card")).toBeNull());
  });
});

describe("CardActions", () => {
  it("refreshes the limits and opens the plugin settings", async () => {
    const b = backend();
    let navigated = 0;
    render(CardActions, { polledAt: Date.now(), now: Date.now(), onNavigate: () => navigated++ }, b);
    expect((await screen.findByTestId("card-actions")).textContent).toContain("Updated just now");
    // Icon-only buttons: a tooltip and an accessible name, the settings one a cog.
    const settings = screen.getByRole("button", { name: en.openSettings });
    expect(settings.title).toBe(en.openSettings);
    expect(screen.getByRole("button", { name: en.refreshLimits }).title).toBe(en.refreshLimits);
    expect(settings.querySelector("[data-icon=gear]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: en.refreshLimits }));
    await waitFor(() => expect(callsTo(b, "refresh")).toHaveLength(1));
    const popped: string[] = [];
    window.addEventListener("popstate", () => popped.push(window.location.pathname), { once: true });
    fireEvent.click(screen.getByRole("button", { name: en.openSettings }));
    expect(navigated).toBe(1);
    expect(window.location.pathname).toBe(pluginSettingsPath("usage-forecast"));
    expect(popped).toEqual(["/settings/plugins/usage-forecast"]);
  });
});
