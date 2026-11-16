// @vitest-environment jsdom
// Press to switch: a press on a reset time switches every row between the
// countdown and the exact time, a press on a percent between used and left.

import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { formatResetAt, formatResetIn } from "../src/app/format";
import { clearDisplayOverrides } from "../src/app/hooks";
import { en, ru } from "../src/app/i18n";
import { DAY_MS, HOUR_MS } from "../src/shared/windows";
import { backend, callsTo, forecastOf, provider, render, snapshot, threadState, win } from "./app-fixtures";

let Banner: React.ComponentType<object>;

beforeAll(async () => {
  const app = await loadPluginApp(() => import("../app"));
  Banner = app.composerCustomizations[0]!.banners![0]!.component as React.ComponentType<object>;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  clearDisplayOverrides();
});

const SESSION_IN = 2 * HOUR_MS;
const WEEKLY_IN = 3 * DAY_MS + HOUR_MS / 2;

function limits() {
  const now = Date.now();
  return snapshot([
    provider("claude-code", [
      win("Current session", 40, { resetsAt: now + SESSION_IN }),
      win("Weekly limit", 92, { resetsAt: now + WEEKLY_IN, durationMs: 7 * DAY_MS }),
    ]),
    provider("codex", [win("Current session", 10, { forecast: forecastOf(20) })]),
  ]);
}

const resetOf = (b: ReturnType<typeof backend>, providerId: string, label: string) =>
  b.snapshot.hosts[0]!.providers.find((p) => p.providerId === providerId)!.windows.find((w) => w.label === label)!.resetsAt!;

async function collapsed(label: string): Promise<HTMLElement> {
  const row = await screen.findByTestId("collapsed-row");
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = row.querySelector<HTMLElement>(`[data-window="${label}"]`);
    expect(found).not.toBeNull();
  });
  return found!;
}

async function expanded(providerId: string, label: string): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = document.querySelector<HTMLElement>(`section[data-provider="${providerId}"] li[data-window="${label}"]`);
    expect(found).not.toBeNull();
  });
  return found!;
}

const expand = async (name = "Show details") => fireEvent.click(await screen.findByRole("button", { name }));

describe("press on a reset time", () => {
  it("AE1: switches every row of the collapsed band to the exact time and back", async () => {
    const b = backend({ snapshot: limits() });
    render(Banner, {}, b);
    const weekly = await collapsed("Weekly limit");
    const session = await collapsed("Current session");
    expect(weekly.textContent).toBe("W3d92%");
    fireEvent.click(within(weekly).getByRole("button", { name: /Show reset time$/ }));
    const now = Date.now();
    expect(weekly.textContent).toBe(`W${formatResetAt(en, resetOf(b, "claude-code", "Weekly limit"), now)}92%`);
    expect(session.textContent).toBe(`5H${formatResetAt(en, resetOf(b, "claude-code", "Current session"), now)}40%`);
    await waitFor(() => expect(callsTo(b, "setDisplay").map((c) => c.input)).toEqual([{ resetShow: "time" }]));
    fireEvent.click(within(session).getByRole("button", { name: /Show countdown$/ }));
    expect(weekly.textContent).toBe("W3d92%");
    await waitFor(() => expect(callsTo(b, "setDisplay").map((c) => c.input)).toEqual([{ resetShow: "time" }, { resetShow: "countdown" }]));
  });

  it("AE2: a press on the expanded note switches it to the exact time", async () => {
    const b = backend({ snapshot: limits() });
    render(Banner, {}, b);
    await expand();
    const weekly = await expanded("claude-code", "Weekly limit");
    const note = within(weekly).getByRole("button", { name: /resets in 3d – Show reset time$/ });
    expect(note.textContent).toBe("Tight – at this pace about 92% used, resets in 3d");
    fireEvent.click(note);
    const at = formatResetAt(en, resetOf(b, "claude-code", "Weekly limit"), Date.now());
    expect(note.textContent).toBe(`Tight – at this pace about 92% used, resets ${at}`);
    await waitFor(() => expect(callsTo(b, "setDisplay").map((c) => c.input)).toEqual([{ resetShow: "time" }]));
  });

  it("a press in the collapsed row carries over to the expanded list", async () => {
    const b = backend({ snapshot: limits() });
    render(Banner, {}, b);
    fireEvent.click(within(await collapsed("Weekly limit")).getByRole("button", { name: /Show reset time$/ }));
    await expand();
    const session = await expanded("claude-code", "Current session");
    expect(session.textContent).toContain(formatResetIn(en, resetOf(b, "claude-code", "Current session"), Date.now(), "time")!);
    expect(within(session).getByRole("button", { name: /Show countdown$/ })).toBeTruthy();
  });

  it("AE5: a failed save shows the previous form again", async () => {
    const b = backend({
      snapshot: limits(),
      setDisplay: async () => {
        throw new Error("settings unavailable");
      },
    });
    render(Banner, {}, b);
    const weekly = await collapsed("Weekly limit");
    fireEvent.click(within(weekly).getByRole("button", { name: /Show reset time$/ }));
    await waitFor(() => expect(weekly.textContent).toBe("W3d92%"));
    expect(callsTo(b, "setDisplay")).toHaveLength(1);
    expect(screen.queryByText(/settings unavailable/)).toBeNull();
  });

  it("AE7: a window without a reset time has no reset target in either mode", async () => {
    const s = snapshot([provider("claude-code", [win("Current session", 40, { resetsAt: null, forecast: null, durationMs: null })])]);
    for (const resetShow of ["countdown", "time"]) {
      render(Banner, {}, backend({ snapshot: s }), { settings: { resetShow } });
      const session = await collapsed("Current session");
      expect(session.textContent).toBe("5H40%");
      expect(within(session).queryByRole("button", { name: /reset time|countdown/ })).toBeNull();
      await expand();
      const row = await expanded("claude-code", "Current session");
      expect(row.textContent).toContain("No reset time");
      expect(within(row).queryByRole("button", { name: /reset time|countdown/ })).toBeNull();
      cleanup();
      localStorage.clear();
    }
  });

  it("the run-out note has no reset time and is not a target", async () => {
    const runsOut = { ...forecastOf(150)!, current: { projectedPercent: 150, runOutAt: Date.now() + HOUR_MS } };
    const s = snapshot([provider("claude-code", [win("Current session", 60, { forecast: runsOut })])]);
    render(Banner, {}, backend({ snapshot: s }), { settings: { resetShow: "time" } });
    await expand();
    const row = await expanded("claude-code", "Current session");
    expect(row.textContent).toMatch(/At this pace runs out at .+ – 1h before reset/);
    expect(within(row).queryByRole("button", { name: /reset time|countdown/ })).toBeNull();
    expect(within(row).getAllByRole("button")).toHaveLength(1);
  });

  it("follows the setting, and a later settings change replaces a press", async () => {
    const settings: Record<string, string> = { resetShow: "time" };
    const b = backend({ snapshot: limits() });
    const r = render(Banner, {}, b, { settings });
    const weekly = await collapsed("Weekly limit");
    const at = formatResetAt(en, resetOf(b, "claude-code", "Weekly limit"), Date.now());
    expect(weekly.textContent).toBe(`W${at}92%`);
    fireEvent.click(within(weekly).getByRole("button", { name: /Show countdown$/ }));
    expect(weekly.textContent).toBe("W3d92%");
    // The save lands: the settings now say countdown.
    settings.resetShow = "countdown";
    r.rerender(<Banner />);
    expect((await collapsed("Weekly limit")).textContent).toBe("W3d92%");
    // Then the settings page (or another device) switches back to the time.
    settings.resetShow = "time";
    r.rerender(<Banner />);
    await waitFor(async () => expect((await collapsed("Weekly limit")).textContent).toBe(`W${at}92%`));
  });
});

describe("press on a percent", () => {
  const fillWidth = (el: HTMLElement) => el.querySelector<HTMLElement>("[aria-hidden] > span")!.style.width;

  it("AE3: switches every window between used and left, bars included", async () => {
    const b = backend({ snapshot: limits() });
    render(Banner, {}, b);
    const weekly = await collapsed("Weekly limit");
    const session = await collapsed("Current session");
    fireEvent.click(within(weekly).getByRole("button", { name: "92% – Show percent left" }));
    expect(weekly.textContent).toBe("W3d8%");
    expect(fillWidth(weekly)).toBe("8%");
    expect(session.textContent).toBe("5H2h60%");
    await waitFor(() => expect(callsTo(b, "setDisplay").map((c) => c.input)).toEqual([{ limitsShow: "remaining" }]));
    await expand();
    const list = await expanded("claude-code", "Weekly limit");
    expect(list.textContent).toContain("Tight – at this pace about 8% left");
    fireEvent.click(within(list).getByRole("button", { name: "8% – Show percent used" }));
    expect(list.textContent).toContain("Tight – at this pace about 92% used");
    await waitFor(() => expect(callsTo(b, "setDisplay").map((c) => c.input)).toEqual([{ limitsShow: "remaining" }, { limitsShow: "used" }]));
  });

  it("AE5: a failed save shows the previous percent again", async () => {
    const b = backend({
      snapshot: limits(),
      setDisplay: async () => {
        throw new Error("settings unavailable");
      },
    });
    render(Banner, {}, b);
    const weekly = await collapsed("Weekly limit");
    fireEvent.click(within(weekly).getByRole("button", { name: /Show percent left$/ }));
    await waitFor(() => expect(weekly.textContent).toBe("W3d92%"));
  });

  it("the context percent and another provider's summary are not targets", async () => {
    render(Banner, {}, backend({ snapshot: limits(), thread: threadState() }));
    expect(within(await collapsed("context")).queryAllByRole("button")).toHaveLength(0);
    await expand();
    const codex = document.querySelector<HTMLElement>('section[data-provider="codex"]')!;
    // Closed: the disclosure is the only button, its percents are plain text inside it.
    expect(within(codex).getAllByRole("button")).toHaveLength(1);
    expect(within(codex).getByRole("button").textContent).toBe("▸Codex5H 10%");
  });
});

describe("press targets, labels", () => {
  it("are labelled in Russian", async () => {
    render(Banner, {}, backend({ snapshot: limits() }), { settings: { language: "ru" } });
    const weekly = await collapsed("Weekly limit");
    expect(within(weekly).getByRole("button", { name: "3д – Показать время сброса" })).toBeTruthy();
    fireEvent.click(within(weekly).getByRole("button", { name: "92% – Показать остаток" }));
    fireEvent.click(within(weekly).getByRole("button", { name: /Показать время сброса$/ }));
    const at = formatResetAt(ru, Date.now() + WEEKLY_IN, Date.now());
    expect(within(weekly).getByRole("button", { name: `${at} – Показать обратный отсчёт` })).toBeTruthy();
    expect(within(weekly).getByRole("button", { name: "8% – Показать расход" })).toBeTruthy();
  });

  it("are real buttons that do not submit", async () => {
    render(Banner, {}, backend({ snapshot: limits() }));
    const weekly = await collapsed("Weekly limit");
    for (const button of within(weekly).getAllByRole("button")) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.className).toContain("cursor-pointer");
    }
  });
});
