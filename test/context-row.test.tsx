// @vitest-environment jsdom
// The thread context card section: context panel, compact button, override.

import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CARD_SECTION_GROUP } from "../app";
import { parseLimit, parseThreshold } from "../src/app/context-row";
import { contextView } from "../src/app/model";
import { backend, callsTo, render, T, threadState } from "./app-fixtures";

type Props = { threadId: string; projectId: string; environment: null };
let Section: React.ComponentType<Props>;
const props: Props = { threadId: T, projectId: "prj_a", environment: null };

beforeAll(async () => {
  const app = await loadPluginApp(() => import("../app"));
  expect(app.threadContextCardSections).toHaveLength(1);
  const reg = app.threadContextCardSections[0]!;
  expect(reg).toMatchObject({ id: "context", title: "Context & auto compact", group: CARD_SECTION_GROUP });
  Section = reg.component as React.ComponentType<Props>;
});

afterEach(cleanup);

const select = () => screen.findByRole("combobox", { name: "Thread auto compact" }) as Promise<HTMLSelectElement>;
const thresholdInput = () => screen.findByRole("textbox", { name: "Auto compact threshold, %" }) as Promise<HTMLInputElement>;
const limitInput = () => screen.findByRole("textbox", { name: "Thread limit, k tokens" }) as Promise<HTMLInputElement>;

describe("context card section", () => {
  it("shows the fill, free space, breakdown, the provider's own compact point and the effective threshold", async () => {
    const autoCompact = { enabled: true, thresholdPercent: 80, effectiveThresholdPercent: 76, effectiveThresholdTokens: 114_000, source: "settings" as const };
    render(Section, props, backend({ thread: threadState({ autoCompact }) }));
    const details = await screen.findByTestId("context-details");
    expect(details.textContent).toContain("Context 60% used");
    expect(details.textContent).toContain("60k free of 150k");
    expect(within(screen.getByRole("list", { name: "Context breakdown" })).getByRole("listitem").textContent).toBe("Messages90k");
    expect(details.textContent).toContain("The provider compacts on its own at 117k (78% of the window)");
    expect(details.textContent).toContain("Auto compact: on at 80%, acts at 76% (114k)");
    expect(screen.getByTestId("context-limit").textContent).toBe("Limit 150k (Claude Code setting)");
    expect(screen.getByRole("button", { name: "Compact" })).toBeTruthy();
  });

  it("names the provider's own compaction point as the limit, without repeating it", async () => {
    const context = {
      usedTokens: 100_200,
      windowTokens: 200_000,
      limitTokens: 167_000,
      limitSource: "reported" as const,
      percent: 60,
      estimated: true,
      autoCompactAtTokens: 167_000,
      categories: [],
    };
    const autoCompact = { enabled: true, thresholdPercent: 80, effectiveThresholdPercent: 80, effectiveThresholdTokens: 133_600, source: "settings" as const };
    render(Section, props, backend({ thread: threadState({ context, autoCompact }) }));
    expect((await screen.findByTestId("context-limit")).textContent).toBe("Limit 167k: where Claude Code compacts on its own, window 200k");
    expect(screen.getByTestId("context-details").textContent).not.toContain("The provider compacts on its own");
  });

  it("names the limit source in Russian", async () => {
    const context = { usedTokens: 50_000, windowTokens: 475_000, limitTokens: 150_000, limitSource: "settings" as const, percent: 33, estimated: false, autoCompactAtTokens: null, categories: [] };
    render(Section, props, backend({ thread: threadState({ providerId: "codex", context }) }), { settings: { language: "ru" } });
    expect((await screen.findByTestId("context-limit")).textContent).toBe("Лимит 150k (общая настройка), окно 475k");
  });

  it("renders nothing until the thread state loads", () => {
    const { container } = render(Section, props, backend());
    expect(container.textContent).toBe("");
  });

  it("says when the provider cannot compact and hides the button", async () => {
    render(Section, props, backend({ thread: threadState({ compactSupported: false, context: null }) }));
    expect(await screen.findByText("The provider does not support compacting")).toBeTruthy();
    expect(screen.getByText("Context: not measured yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
  });

  it("speaks Russian when the setting says so", async () => {
    render(Section, props, backend(), { settings: { language: "ru" } });
    expect((await screen.findByTestId("context-details")).textContent).toContain("Контекст занято 60%");
    expect(screen.getByRole("button", { name: "Сжать" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Авто-компакт треда" })).toBeTruthy();
  });
});

describe("AE6: per-thread override", () => {
  it("on with 70 sends the threshold", async () => {
    const b = backend();
    render(Section, props, b, { settings: { autoCompactThresholdPercent: 85 } });
    fireEvent.change(await select(), { target: { value: "on" } });
    await waitFor(() => expect(b.overrides).toEqual([{ autoCompact: "on" }]));
    const input = await thresholdInput();
    expect(input.value).toBe("85");
    fireEvent.change(input, { target: { value: "70" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(b.overrides.at(-1)).toEqual({ autoCompact: "on", thresholdPercent: 70 }));
    expect(callsTo(b, "setThreadOverride").at(-1)!.input).toEqual({ threadId: T, override: { autoCompact: "on", thresholdPercent: 70 } });
  });

  it("40 shows the range and sends nothing", async () => {
    const b = backend({ thread: threadState({ override: { autoCompact: "on" } }) });
    render(Section, props, b);
    fireEvent.change(await thresholdInput(), { target: { value: "40" } });
    expect(screen.getByText("Threshold 50–95%")).toBeTruthy();
    const apply = screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.submit(apply.closest("form")!);
    expect(b.overrides).toEqual([]);
  });

  it("inherit and off send at once without a threshold", async () => {
    const b = backend({ thread: threadState({ override: { autoCompact: "on", thresholdPercent: 70 } }) });
    render(Section, props, b);
    fireEvent.change(await select(), { target: { value: "inherit" } });
    await waitFor(() => expect(b.overrides).toEqual([{ autoCompact: "inherit" }]));
    fireEvent.change(await select(), { target: { value: "off" } });
    await waitFor(() => expect(b.overrides.at(-1)).toEqual({ autoCompact: "off" }));
  });
});

describe("helpers", () => {
  it("parses thresholds", () => {
    expect(parseThreshold("70")).toBe(70);
    expect(parseThreshold(" 95 ")).toBe(95);
    expect(parseThreshold("40")).toBeNull();
    expect(parseThreshold("96")).toBeNull();
    expect(parseThreshold("7.5")).toBeNull();
    expect(parseThreshold("")).toBeNull();
  });

  it("groups the context into messages, tools and other, with the reserved buffer apart", () => {
    const view = contextView({
      usedTokens: 120_000,
      windowTokens: 200_000,
      limitTokens: 200_000,
      limitSource: "settings",
      percent: 60,
      estimated: false,
      autoCompactAtTokens: null,
      categories: [
        { id: "m", label: "Messages", tokens: 70_000, kind: "used" },
        { id: "s", label: "System tools", tokens: 15_000, kind: "used" },
        { id: "p", label: "MCP tools", tokens: 5_000, kind: "used" },
        { id: "sp", label: "System prompt", tokens: 30_000, kind: "used" },
        { id: "e", label: "Empty", tokens: 0, kind: "used" },
        { id: "b", label: "Autocompact buffer", tokens: 33_000, kind: "reserved" },
        { id: "f", label: "Free space", tokens: 47_000, kind: "free" },
      ],
    });
    expect(view.segments).toEqual([
      { key: "messages", tokens: 70_000 },
      { key: "tools", tokens: 20_000 },
      { key: "other", tokens: 30_000 },
    ]);
    expect(view.bufferTokens).toBe(33_000);
    expect(view.freeTokens).toBe(47_000);
    expect(view.tone).toBe("amber");
  });

  it("draws one used part and derives free space when the provider gives no breakdown", () => {
    const view = contextView({ usedTokens: 90_000, windowTokens: 100_000, limitTokens: 100_000, limitSource: "window", percent: 90, estimated: true, autoCompactAtTokens: null, categories: [] });
    expect(view.segments).toEqual([{ key: "used", tokens: 90_000 }]);
    expect(view.freeTokens).toBe(10_000);
    expect(view.tone).toBe("red");
  });

  it("measures the bar against the limit and shows only the buffer part inside it", () => {
    const view = contextView({
      usedTokens: 90_000,
      windowTokens: 200_000,
      limitTokens: 150_000,
      limitSource: "settings",
      percent: 60,
      estimated: false,
      autoCompactAtTokens: 156_000,
      categories: [
        { id: "m", label: "Messages", tokens: 90_000, kind: "used" },
        { id: "b", label: "Autocompact buffer", tokens: 44_000, kind: "reserved" },
        { id: "f", label: "Free space", tokens: 66_000, kind: "free" },
      ],
    });
    expect(view.limitTokens).toBe(150_000);
    expect(view.bufferTokens).toBe(0);
    expect(view.freeTokens).toBe(60_000);
  });

  it("shows the limit line with ~ for an estimated fill and a per-thread limit", async () => {
    const context = { usedTokens: 50_000, windowTokens: 258_400, limitTokens: 100_000, limitSource: "thread" as const, percent: 50, estimated: true, autoCompactAtTokens: null, categories: [] };
    render(Section, props, backend({ thread: threadState({ providerId: "codex", context, override: { autoCompact: "inherit", limitTokens: 100_000 } }) }));
    const details = await screen.findByTestId("context-details");
    expect(details.textContent).toContain("Context ~50% used");
    expect(details.textContent).toContain("50k free of 100k");
    expect((await screen.findByTestId("context-limit")).textContent).toBe("Limit 100k (this thread), window 258k");
    expect((await limitInput()).value).toBe("100");
  });

  it("keeps the thread's limit when the mode changes", async () => {
    const b = backend({ thread: threadState({ override: { autoCompact: "inherit", limitTokens: 100_000 } }) });
    render(Section, props, b);
    fireEvent.change(await select(), { target: { value: "off" } });
    await waitFor(() => expect(b.overrides.at(-1)).toEqual({ autoCompact: "off", limitTokens: 100_000 }));
  });

  it("sets and clears the per-thread limit in thousands of tokens", async () => {
    const b = backend({ thread: threadState({ override: { autoCompact: "on", thresholdPercent: 70 } }) });
    render(Section, props, b);
    const input = await limitInput();
    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(b.overrides.at(-1)).toEqual({ autoCompact: "on", thresholdPercent: 70, limitTokens: 120_000 }));
    await waitFor(() => expect(input.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "5" } });
    expect(screen.getByText("Limit 10–2000k tokens, blank for the provider's or global limit")).toBeTruthy();
    fireEvent.blur(input);
    expect(b.overrides).toHaveLength(1);
    expect(input.value).toBe("120");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    await waitFor(() => expect(b.overrides).toHaveLength(2));
    expect(b.overrides.at(-1)).toEqual({ autoCompact: "on", thresholdPercent: 70 });
    fireEvent.change(await select(), { target: { value: "off" } });
    await waitFor(() => expect(b.overrides.at(-1)).toEqual({ autoCompact: "off" }));
    expect(parseLimit("10")).toBe(10_000);
    expect(parseLimit("2000")).toBe(2_000_000);
    expect(parseLimit("9")).toBeNull();
    expect(parseLimit("2001")).toBeNull();
    expect(parseLimit("1.5")).toBeNull();
    expect(parseLimit(" ")).toBeUndefined();
  });
});
