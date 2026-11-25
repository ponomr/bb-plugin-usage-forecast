// @vitest-environment jsdom
// The header limits: the 5-hour and weekly windows of one provider moved into
// the page header row, coloured percents with the 5-hour reset (and bars by the setting), and the limits card with
// its refresh and settings buttons on a press.

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardActions } from "../src/app/card-actions";
import { headerProviders, headerView, headerWindows, threadIdOfPath, worstWindowOf } from "../src/app/header-model";
import { HeaderLimits } from "../src/app/header-widget";
import { pluginSettingsPath } from "../src/app/hooks";
import { en } from "../src/app/i18n";
import { DAY_MS } from "../src/shared/windows";
import { backend, callsTo, forecastOf, host, provider, render, snapshot, T, threadState, win } from "./app-fixtures";

const desktop = (pill: HTMLElement) => within(pill).getByTestId("header-limits-desktop");
const phone = (pill: HTMLElement) => within(pill).getByTestId("header-limits-phone");
/** A window on course to run out: `inMin` minutes from now, before its reset. */
const runsOut = (label: string, used: number, inMin: number, over: Parameters<typeof win>[2] = {}) =>
  win(label, used, { forecast: { ...forecastOf(150)!, current: { projectedPercent: 150, runOutAt: Date.now() + inMin * 60_000 } }, ...over });

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

  it("lists the thread's provider first for the providers mode, and only providers with windows", () => {
    const s = snapshot([provider("claude-code", [win("Current session", 10)]), provider("codex", [win("Current session", 95)]), provider("acp-x", [])]);
    expect(headerProviders(en, s, { providerId: "codex", hostId: null }, Date.now()).map((p) => p.providerId)).toEqual(["codex", "claude-code"]);
    expect(headerProviders(en, s, undefined, Date.now()).map((p) => p.providerId)).toEqual(["claude-code", "codex"]);
  });

  it("takes the worst window by pace state before the used percent", () => {
    const calm = win("Weekly limit", 80);
    const out = runsOut("Current session", 40, 30);
    expect(worstWindowOf([calm, out], Date.now())).toBe(out);
    expect(worstWindowOf([win("Current session", 20), calm], Date.now())).toBe(calm);
    expect(worstWindowOf([], Date.now())).toBeNull();
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
    expect(desktop(pill).textContent).toMatch(/^5H(2h|1h 59m)42%W7%$/);
    expect(pill.querySelector("[data-gauge] [aria-hidden]")).toBeNull();
    expect(pill.getAttribute("aria-label")).toContain("Claude Code");
  });

  it("draws horizontal bars with the even-pace tick by the setting, counts down the reset, and goes away when off", async () => {
    headerRow();
    const b = backend({ snapshot: snapshot([provider("codex", [win("Current session", 42), weekly(7)])]) });
    const view = render(HeaderLimits, {}, b, { settings: { headerShow: "bars" } });
    const pill = await screen.findByTestId("header-limits");
    expect(pill.dataset.style).toBe("bars");
    await waitFor(() => expect(pill.querySelectorAll("[data-gauge] [aria-hidden]")).toHaveLength(2));
    expect(desktop(pill).textContent).toMatch(/^5H(2h|1h 59m)42%W7%$/);
    expect(pill.querySelectorAll("[data-even]").length).toBeGreaterThan(0);
    view.unmount();
    render(HeaderLimits, {}, b, { settings: { headerShow: "off" } });
    await act(async () => {});
    expect(screen.queryByTestId("header-limits")).toBeNull();
  });

  it("P4: without data shows a dash and says so", async () => {
    headerRow();
    render(HeaderLimits, {}, backend({ snapshot: snapshot([]) }));
    const pill = await screen.findByTestId("header-limits");
    await waitFor(() => expect(pill.dataset.data).toBe("none"));
    expect(desktop(pill).textContent).toBe("—");
    expect(phone(pill).textContent).toBe("—");
    expect(pill.title).toBe("Usage limits: No limits data");
  });

  it("B5: on a phone shows a dot and the worst window's percent in its tone, whatever the desktop mode", async () => {
    headerRow();
    const s = snapshot([provider("codex", [runsOut("Current session", 30, 20), weekly(61)])]);
    for (const headerShow of ["numbers", "bars", "forecast", "providers"]) {
      const view = render(HeaderLimits, {}, backend({ snapshot: s }), { settings: { headerShow } });
      const pill = await screen.findByTestId("header-limits");
      await waitFor(() => expect(phone(pill).textContent).toBe("●30%"));
      expect(phone(pill).className).toContain("sm:hidden");
      expect(desktop(pill).className).toContain("hidden");
      expect(phone(pill).querySelector("[data-phone]")?.getAttribute("data-tone")).not.toBe("muted");
      view.unmount();
    }
  });

  it("B3: while every window lasts, forecast shows the numbers", async () => {
    headerRow();
    render(HeaderLimits, {}, backend({ snapshot: snapshot([provider("codex", [win("Current session", 42), weekly(7)])]) }), { settings: { headerShow: "forecast" } });
    const pill = await screen.findByTestId("header-limits");
    await waitFor(() => expect(pill.querySelectorAll("[data-gauge]")).toHaveLength(2));
    expect(desktop(pill).textContent).toMatch(/^5H(2h|1h 59m)42%W7%$/);
    expect(pill.querySelector("[data-forecast]")).toBeNull();
  });

  it("B3: a window that runs out goes first with its run-out; a later day says how long it falls short", async () => {
    headerRow();
    const soon = Date.now() + 20 * 60_000;
    const sameDay = new Date(soon).toDateString() === new Date().toDateString();
    const late = runsOut("Weekly limit", 74, 2 * 24 * 60, { durationMs: 7 * DAY_MS, resetsAt: Date.now() + 3 * DAY_MS });
    const s = snapshot([provider("codex", [runsOut("Current session", 41, 20), late])]);
    render(HeaderLimits, {}, backend({ snapshot: s }), { settings: { headerShow: "forecast" } });
    const pill = await screen.findByTestId("header-limits");
    await waitFor(() => expect(pill.querySelectorAll("[data-forecast]")).toHaveLength(2));
    const gauges = Array.from(pill.querySelectorAll<HTMLElement>("[data-gauge]"));
    expect(gauges.map((g) => g.dataset.gauge)).toEqual(["Current session", "Weekly limit"]);
    if (sameDay) expect(gauges[0]!.textContent).toMatch(/^5H41%· out \S+/);
    expect(gauges[1]!.textContent).toBe("W74%· short by 1d");
  });

  it("B3: the window that runs out leads even when it is the weekly one; the other loses its reset", async () => {
    headerRow();
    const late = runsOut("Weekly limit", 74, 2 * 24 * 60, { durationMs: 7 * DAY_MS, resetsAt: Date.now() + 3 * DAY_MS });
    render(HeaderLimits, {}, backend({ snapshot: snapshot([provider("codex", [win("Current session", 41), late])]) }), {
      settings: { headerShow: "forecast" },
    });
    const pill = await screen.findByTestId("header-limits");
    await waitFor(() => expect(pill.querySelector("[data-gauge]")?.getAttribute("data-gauge")).toBe("Weekly limit"));
    expect(desktop(pill).textContent).toBe("W74%· short by 1d5H41%");
  });

  it("B4: every provider by bb's icon with its worst percent; a provider without artwork by its short label", async () => {
    headerRow();
    const s = snapshot([provider("claude-code", [win("Current session", 97), weekly(40)]), provider("codex", [win("Current session", 10), weekly(30)])]);
    const providers = { status: "ready" as const, providers: [{ id: "claude-code", logoUrl: "/api/v1/system/providers/claude-code/logo" }] };
    render(HeaderLimits, {}, backend({ snapshot: s }), { settings: { headerShow: "providers" }, providers: providers as never });
    const pill = await screen.findByTestId("header-limits");
    await waitFor(() => expect(pill.querySelectorAll("[data-provider]")).toHaveLength(2));
    const [cc, cx] = Array.from(pill.querySelectorAll<HTMLElement>("[data-provider]"));
    expect(cc!.querySelector("[data-provider-id=claude-code]")?.getAttribute("data-provider-logo")).toContain("claude-code");
    expect(cc!.textContent).toMatch(/^97%(2h|1h 59m)$/);
    expect(cx!.querySelector("[data-provider-label]")?.textContent).toBe("CX");
    expect(cx!.textContent).toMatch(/^CX30%/);
    expect(pill.getAttribute("aria-label")).toMatch(/^Claude Code · 5 Hour: 97%.* · Codex · Weekly: 30%/);
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

describe("percent mode: left (the default)", () => {
  it("shows the share left, mirrors the bar and keeps the tones of the share used", async () => {
    headerRow();
    const b = backend({ snapshot: snapshot([provider("codex", [win("Current session", 42), weekly(7)])]) });
    render(HeaderLimits, {}, b, { settings: { headerShow: "bars", percentMode: "left" } });
    const pill = await screen.findByTestId("header-limits");
    await waitFor(() => expect(pill.querySelectorAll("[data-gauge]")).toHaveLength(2));
    expect(desktop(pill).textContent).toMatch(/^5H(2h|1h 59m)58%W93%$/);
    expect(pill.querySelector<HTMLElement>("[data-gauge] [aria-hidden] > span")!.style.width).toBe("58%");
    expect(pill.querySelector("[data-gauge]")!.getAttribute("title")).toMatch(/^5 Hour: 58% left/);
    expect(phone(pill).textContent).toBe("●58%");
  });

  it("a nearly used-up window shows little left in red", async () => {
    headerRow();
    const b = backend({ snapshot: snapshot([provider("codex", [runsOut("Current session", 95, 10), weekly(7)])]) });
    render(HeaderLimits, {}, b, { settings: { percentMode: "left" } });
    const pill = await screen.findByTestId("header-limits");
    await waitFor(() => expect(pill.querySelectorAll("[data-gauge]")).toHaveLength(2));
    const gauge = pill.querySelector<HTMLElement>("[data-gauge='Current session']")!;
    expect(gauge.textContent).toContain("5%");
    expect(gauge.dataset.tone).toBe("red");
  });
});
