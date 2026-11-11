// @vitest-environment jsdom
// The settings page section and the formatters in both languages.

import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { en, ru } from "../src/app/i18n";
import {
  formatAgo,
  formatResetIn,
  formatSpan,
  formatTokens,
  providerName,
  shortTokens,
  shortWindowLabel,
  windowLabel,
} from "../src/app/format";
import { parseLang } from "../src/shared/language";
import { parseLimitsShow, shownPercent } from "../src/shared/limits-show";
import { HOUR_MS } from "../src/shared/windows";
import { backend, callsTo, entry, provider, render, snapshot } from "./app-fixtures";

let Section: React.ComponentType<object>;

beforeAll(async () => {
  const app = await loadPluginApp(() => import("../app"));
  expect(app.settingsSections).toHaveLength(1);
  Section = app.settingsSections[0]!.component as React.ComponentType<object>;
});

afterEach(cleanup);

describe("settings section", () => {
  it("summarises the settings, the providers and the recent compacts, and refreshes", async () => {
    const s = snapshot([provider("claude-code", []), provider("acp-cursor", [], { status: "not_installed" })], {
      pollError: "codex: boom",
      recentCompactions: [entry(1)],
    });
    const b = backend({ snapshot: s });
    render(Section, {}, b, { settings: { autoCompactEnabled: true, autoCompactThresholdPercent: 70, pollIntervalMinutes: 5, contextLimitTokens: 120_000 } });
    const root = await screen.findByTestId("usage-settings");
    await waitFor(() => expect(root.textContent).toContain("Last poll: just now"));
    expect(root.textContent).toContain("Context limit 120k tokens. Auto compact: on, threshold 70% of the limit. Limits polled every 5 min.");
    expect(root.textContent).toContain("Poll error: codex: boom");
    expect(root.textContent).toContain("Claude Code: ok");
    expect(root.textContent).toContain("acp-cursor: not installed");
    expect(root.textContent).toContain("bb--provider-usage");
    expect(screen.getAllByRole("listitem").some((li) => li.textContent?.includes("(Codex), auto: 85% → 30%"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Refresh now" }));
    await waitFor(() => expect(callsTo(b, "refresh")).toHaveLength(1));
  });

  it("shows auto compact off by default", async () => {
    render(Section, {}, backend({ snapshot: snapshot([], { polledAt: null }) }), { settings: {} });
    const root = await screen.findByTestId("usage-settings");
    expect(root.textContent).toContain("Auto compact: off. Limits polled every 2 min.");
    await waitFor(() => expect(root.textContent).toContain("Limits not polled yet"));
  });

  it("speaks Russian when the setting says so", async () => {
    render(Section, {}, backend(), { settings: { language: "ru" } });
    const root = await screen.findByTestId("usage-settings");
    expect(root.textContent).toContain("Авто-компакт: выкл. Опрос лимитов каждые 2 мин.");
    await waitFor(() => expect(root.textContent).toContain("Последний опрос: только что"));
    expect(screen.getByRole("button", { name: "Обновить сейчас" })).toBeTruthy();
  });
});

describe("formatters", () => {
  const now = Date.UTC(2026, 10, 8, 12);

  it("formats spans, resets and ages", () => {
    expect(formatSpan(en, 20_000)).toBe("<1m");
    expect(formatSpan(en, 5 * 60_000)).toBe("5m");
    expect(formatSpan(en, 2 * HOUR_MS + 5 * 60_000)).toBe("2h 5m");
    expect(formatSpan(en, 4 * HOUR_MS)).toBe("4h");
    expect(formatSpan(en, 3 * 24 * HOUR_MS + 4 * HOUR_MS)).toBe("3d 4h");
    expect(formatSpan(en, 24 * HOUR_MS)).toBe("1d");
    expect(formatSpan(ru, 2 * 24 * HOUR_MS + 20 * HOUR_MS)).toBe("2д 20ч");
    expect(formatResetIn(en, null, now)).toBeNull();
    expect(formatResetIn(en, now - 1, now)).toBe("resets now");
    expect(formatResetIn(en, now + HOUR_MS, now)).toBe("resets in 1h");
    expect(formatAgo(en, now - 2 * 60_000, now)).toBe("2m ago");
    expect(formatAgo(ru, now - 2 * 60_000, now)).toBe("2м назад");
    expect(formatAgo(en, now - 10_000, now)).toBe("just now");
  });

  it("formats token counts", () => {
    expect(formatTokens(258_400)).toBe("258 400");
    expect(formatTokens(999)).toBe("999");
    expect(shortTokens(999)).toBe("999");
    expect(shortTokens(190_000)).toBe("190k");
    expect(shortTokens(1_000_000)).toBe("1M");
    expect(shortTokens(1_500_000)).toBe("1.5M");
  });

  it("names providers and windows", () => {
    expect(providerName(en, "codex")).toBe("Codex");
    expect(providerName(en, "toString")).toBe("toString");
    expect(windowLabel(en, "Fable", "fable")).toBe("Fable");
    expect(windowLabel(en, "Weekly limit", "opus")).toBe("Weekly [opus]");
    expect(windowLabel(ru, "Weekly limit")).toBe("Неделя");
    expect(shortWindowLabel(en, "Current session")).toBe("5H");
    expect(shortWindowLabel(en, "Weekly limit", "opus")).toBe("W [opus]");
    expect(shortWindowLabel(ru, "Current session")).toBe("5ч");
    expect(shortWindowLabel(en, "Fable")).toBe("F");
    expect(shortWindowLabel(en, "Fable", "fable")).toBe("F");
  });

  it("shows limits as used by default and as left when asked", () => {
    expect(parseLimitsShow("remaining")).toBe("remaining");
    expect(parseLimitsShow("left")).toBe("used");
    expect(parseLimitsShow(undefined)).toBe("used");
    expect(shownPercent("used", 92)).toBe(92);
    expect(shownPercent("remaining", 92)).toBe(8);
    expect(shownPercent("remaining", 130)).toBe(0);
  });

  it("falls back to English for an unknown language", () => {
    expect(parseLang("ru")).toBe("ru");
    expect(parseLang("de")).toBe("en");
    expect(parseLang(undefined)).toBe("en");
  });
});
