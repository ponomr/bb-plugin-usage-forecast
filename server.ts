// Server entry: settings, the limits poller, storage, auto-compact, RPC
// `usage-forecast.v1` and the `bb usage-forecast` CLI.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CONTEXT_LIMIT_DEFAULT_TOKENS,
  CONTEXT_LIMIT_MAX_TOKENS,
  CONTEXT_LIMIT_MIN_TOKENS,
  contextLimitSchema,
  LIMIT_NOTIFY_DEFAULT_PERCENT,
  LIMIT_NOTIFY_MAX_PERCENT,
  LIMIT_NOTIFY_MIN_PERCENT,
  limitNotifySchema,
  LIMITS_TAG,
  PROVIDER_LIMIT_AUTO,
  PROVIDER_LIMIT_SETTINGS,
  providerLimitSchema,
  pollIntervalSchema,
  POLL_DEFAULT_MINUTES,
  POLL_MAX_MINUTES,
  POLL_MIN_MINUTES,
  thresholdSchema,
  threadTag,
  TOKENS_TAG,
  THRESHOLD_DEFAULT_PERCENT,
  THRESHOLD_MAX_PERCENT,
  THRESHOLD_MIN_PERCENT,
  usageForecastContract,
} from "./src/shared/contract";
import { AutoCompactor } from "./src/server/auto-compact";
import { createCli } from "./src/server/cli";
import { LimitNotifier } from "./src/server/limit-notifier";
import { Poller, TICK_CRON } from "./src/server/poller";
import { createService, hideProvider } from "./src/server/rpc";
import { Storage } from "./src/server/storage";
import { TokenCounter } from "./src/server/token-counter";
import { parseSettings, type ThreadsSdk } from "./src/server/threads";
import { DEFAULT_LANGUAGE, LANGUAGES } from "./src/shared/language";
import { DEFAULT_PERCENT_MODE, PERCENT_MODES } from "./src/shared/percent-mode";
import { DEFAULT_HEADER_SHOW, HEADER_SHOW } from "./src/shared/header-show";
import { DEFAULT_SIDEBAR_SHOW, SIDEBAR_SHOW } from "./src/shared/sidebar-show";
import { DEFAULT_FLOAT_STYLE, FLOAT_STYLE } from "./src/shared/float-style";

export const POLL_SCHEDULE = "poll-limits";

/** The bb plugin that delivers pushes, and the answer of its `notifications.send`. */
export const PUSH_PLUGIN_ID = "push-notifications";
const pushSendOutput = z.object({
  ok: z.literal(true),
  channels: z.array(z.enum(["web", "desktop", "mobile"])),
});

/** Thread events after which the context fill is re-read. */
export const CONTEXT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "thread/contextWindowUsage/updated",
  "thread/tokenUsage/updated",
  "thread/compacted",
  "thread/context/cleared",
]);

/** Shortest gap between two invalidations of one thread from context events. */
export const CONTEXT_INVALIDATE_MIN_MS = 2_000;

/** 10000 → "10k", 2000000 → "2M". */
const tokensShort = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1_000}k`);

export default async function plugin(bb: BbPluginApi) {
  // bb draws the form in this order and has no groups, so the label's prefix
  // names the group: Display, Limits, Context. Labels stay English (bb shows
  // them as given, whatever the plugin's language).
  const settingsHandle = bb.settings.define({
    language: {
      type: "select",
      label: "Display: Language",
      description: "Plugin text language.",
      options: [...LANGUAGES],
      experimental_optionLabels: { en: "English", ru: "Русский" },
      default: DEFAULT_LANGUAGE,
    },
    percentMode: {
      type: "select",
      label: "Display: Percents",
      description: "Limits as the share left or used. Colours stay; context and the CLI always show used.",
      options: [...PERCENT_MODES],
      experimental_optionLabels: { left: "Left", used: "Used" },
      default: DEFAULT_PERCENT_MODE,
    },
    headerShow: {
      type: "select",
      label: "Display: Header",
      description:
        "Limits at the top right; press for details. Forecast first: a window that runs out leads. All providers: each one's worst window. Phone: a dot and the worst percent.",
      options: [...HEADER_SHOW],
      experimental_optionLabels: { numbers: "Numbers", bars: "Numbers and bars", forecast: "Forecast first", providers: "All providers", off: "Off" },
      default: DEFAULT_HEADER_SHOW,
    },
    sidebarShow: {
      type: "select",
      label: "Display: Sidebar icon",
      description: "Two rings: 5-hour outside, weekly inside. One ring: the worst window. To remove: More (…) → Customize footer.",
      options: [...SIDEBAR_SHOW],
      experimental_optionLabels: { rings: "Two rings", ring: "One ring" },
      default: DEFAULT_SIDEBAR_SHOW,
    },
    showBand: {
      type: "boolean",
      label: "Display: Band above the composer",
      description: "Limits and context over the message field; opens by itself when a limit runs short or context passes 80%.",
      default: true,
    },
    showFloat: {
      type: "boolean",
      label: "Display: Floating widget",
      description: "A panel at the right edge. Press to fold it into a badge; drag to move.",
      default: false,
    },
    floatStyle: {
      type: "select",
      label: "Display: Floating widget style",
      description: "Lines: name and both percents per provider. Big numbers: the two percents in large type.",
      options: [...FLOAT_STYLE],
      experimental_optionLabels: { lines: "Lines", big: "Big numbers" },
      default: DEFAULT_FLOAT_STYLE,
    },
    limitNotifyEnabled: {
      type: "boolean",
      label: "Limits: Push notifications",
      description: "A push when a window reaches the threshold and when it runs out; once per window until its reset.",
      default: true,
    },
    limitNotifyPercent: {
      type: "number",
      label: "Limits: Push at, % used",
      description: `${LIMIT_NOTIFY_MIN_PERCENT}–${LIMIT_NOTIFY_MAX_PERCENT}. Counted as used in both percent modes.`,
      default: LIMIT_NOTIFY_DEFAULT_PERCENT,
      experimental_schema: limitNotifySchema,
    },
    pollIntervalMinutes: {
      type: "number",
      label: "Limits: Check every, min",
      description: `${POLL_MIN_MINUTES}–${POLL_MAX_MINUTES}.`,
      default: POLL_DEFAULT_MINUTES,
      experimental_schema: pollIntervalSchema,
    },
    hiddenProviders: {
      type: "string",
      label: "Limits: Hidden providers",
      description: "Ids to hide everywhere, pushes included, e.g. acp-opencode. A thread's own provider stays. Ids: bb usage-forecast status.",
      default: "",
    },
    contextLimitTokens: {
      type: "number",
      label: "Context: Limit, tokens",
      description: `Working size for the bar and auto-compact, ${tokensShort(CONTEXT_LIMIT_MIN_TOKENS)}–${tokensShort(CONTEXT_LIMIT_MAX_TOKENS)}, when no provider limit applies.`,
      default: CONTEXT_LIMIT_DEFAULT_TOKENS,
      experimental_schema: contextLimitSchema,
    },
    [PROVIDER_LIMIT_SETTINGS["claude-code"]]: {
      type: "number",
      label: "Context: Claude Code limit",
      description: "0 = where Claude Code compacts itself.",
      default: PROVIDER_LIMIT_AUTO,
      experimental_schema: providerLimitSchema,
    },
    [PROVIDER_LIMIT_SETTINGS.codex]: {
      type: "number",
      label: "Context: Codex limit",
      description: "0 = the limit above. Best: your model_auto_compact_token_limit.",
      default: PROVIDER_LIMIT_AUTO,
      experimental_schema: providerLimitSchema,
    },
    autoCompactEnabled: {
      type: "boolean",
      label: "Context: Auto-compact",
      description: "Compact an idle thread at the threshold.",
      default: false,
    },
    autoCompactThresholdPercent: {
      type: "number",
      label: "Context: Auto-compact at, %",
      description: `${THRESHOLD_MIN_PERCENT}–${THRESHOLD_MAX_PERCENT}. Never above the provider's own compaction point.`,
      default: THRESHOLD_DEFAULT_PERCENT,
      experimental_schema: thresholdSchema,
    },
    summaryClearEnabled: {
      type: "boolean",
      label: "Context: Summary and clear",
      description: "For agents that can't compact: summarise, clear, send the summary back. History stays.",
      default: false,
    },
  });
  const settings = async () => parseSettings(await settingsHandle.get());

  const invalidateLimits = () => bb.rpc.experimental_invalidate([LIMITS_TAG]);
  const invalidateThread = (threadId: string) => bb.rpc.experimental_invalidate([LIMITS_TAG, threadTag(threadId)]);
  // A new threshold or switch changes every thread's effective policy.
  settingsHandle.onChange(() => bb.rpc.experimental_invalidateAll());

  const storage = new Storage(bb.storage.kv);
  // `bb.sdk` is bind-gated, so it is read inside each call.
  const threads: ThreadsSdk = {
    get: (args) => bb.sdk.threads.get(args),
    context: (args) => bb.sdk.threads.context(args),
    getPluginMetadata: (args) => bb.sdk.threads.getPluginMetadata(args),
    updatePluginMetadata: (args) =>
      bb.sdk.threads.updatePluginMetadata(args as Parameters<typeof bb.sdk.threads.updatePluginMetadata>[0]),
    compact: (args) => bb.sdk.threads.compact(args),
    send: ({ input, ...rest }) => bb.sdk.threads.send({ ...rest, input: input.map((item) => ({ ...item, mentions: [] })) }),
    output: (args) => bb.sdk.threads.output(args),
    clearContext: (args) => bb.sdk.threads.clearContext(args),
    environment: (args) => bb.sdk.environments.get(args),
    list: (args) => bb.sdk.threads.list(args),
    events: (args) => bb.sdk.threads.events.list(args),
  };

  const notifier = new LimitNotifier({
    storage,
    settings,
    send: async ({ title, body }) =>
      (
        await bb.sdk.plugins.callRpc({
          pluginId: PUSH_PLUGIN_ID,
          method: "notifications.send",
          input: { title, body },
          outputSchema: pushSendOutput,
        })
      ).channels,
    log: bb.log,
  });

  const poller = new Poller({
    usageLimits: (args) => bb.sdk.system.usageLimits(args),
    hosts: () => bb.sdk.hosts.list(),
    primaryHostId: async () => (await bb.sdk.system.config()).primaryHostId,
    storage,
    intervalMinutes: async () => (await settings()).pollIntervalMinutes,
    invalidate: invalidateLimits,
    afterPoll: (hosts, now) => notifier.checkHosts(hosts, now),
    log: bb.log,
  });

  const compactor = new AutoCompactor({ threads, storage, settings, invalidate: invalidateThread, log: bb.log });
  bb.onDispose(() => compactor.dispose());

  const counter = new TokenCounter({
    threads,
    storage,
    invalidate: () => bb.rpc.experimental_invalidate([TOKENS_TAG]),
    log: bb.log,
  });
  bb.onDispose(() => counter.dispose());

  const service = createService({ threads, storage, settings, poller, compactor, invalidateThread });

  bb.background.schedule(POLL_SCHEDULE, TICK_CRON, () => poller.tick());

  bb.events.on("thread.active", ({ thread }) => compactor.onActive(thread.id));
  // A turn that moved the context number, or a compaction, invalidates the
  // thread's RPC cache so an open app re-reads at once instead of on its
  // backstop poll (after bb-plugin-context-meter). The host reports a usage
  // event on every tool call of a turn, so invalidations of one thread are
  // coalesced to one per CONTEXT_INVALIDATE_MIN_MS.
  const contextTimers = new Map<string, { timer: ReturnType<typeof setTimeout> | null; lastAt: number }>();
  const invalidateThreadSoon = (threadId: string) => {
    const now = Date.now();
    const entry = contextTimers.get(threadId) ?? { timer: null, lastAt: 0 };
    if (entry.timer !== null) return;
    entry.timer = setTimeout(
      () => {
        entry.timer = null;
        entry.lastAt = Date.now();
        invalidateThread(threadId);
      },
      Math.max(0, entry.lastAt + CONTEXT_INVALIDATE_MIN_MS - now),
    );
    contextTimers.set(threadId, entry);
    for (const [id, e] of contextTimers) if (e.timer === null && e.lastAt + CONTEXT_INVALIDATE_MIN_MS <= now) contextTimers.delete(id);
  };
  const unsubscribe = bb.sdk.subscribe({
    event: "thread:changed",
    callback: (event) => {
      if (typeof event.id !== "string" || event.id === "") return;
      const types = event.metadata?.eventTypes;
      if (!Array.isArray(types) || !types.some((t) => CONTEXT_EVENT_TYPES.has(t))) return;
      invalidateThreadSoon(event.id);
    },
  });
  bb.onDispose(() => {
    unsubscribe();
    for (const e of contextTimers.values()) if (e.timer !== null) clearTimeout(e.timer);
    contextTimers.clear();
  });
  // Not awaited: a check reads the thread several times and must not hold up
  // other listeners. `onIdle` never throws.
  bb.events.on("thread.idle", ({ thread }) => {
    void compactor.onIdle(thread.id);
  });
  // A separate listener, so a failing count never touches auto-compact.
  bb.events.on("thread.idle", ({ thread }) => {
    void counter.onIdle(thread.id);
  });

  bb.rpc.register(usageForecastContract, {
    snapshot: () => service.snapshot(),
    thread: ({ threadId }) => service.thread(threadId),
    refresh: () => service.refresh(),
    compact: ({ threadId }) => service.compact(threadId),
    setThreadOverride: ({ threadId, override }) => service.setThreadOverride(threadId, override),
    hideProvider: (input) =>
      hideProvider({ read: () => settingsHandle.get(), write: (values) => settingsHandle.experimental_set(values) }, input),
    tokens: ({ threadId, dayStart, monthStart }) => counter.view(threadId ?? null, dayStart, monthStart),
  });

  bb.cli.register(createCli(service, Date.now, async () => (await settings()).hiddenProviders, { counter }));

  bb.log.info("usage-forecast loaded");
  // The first token collection runs once, in the background; it returns at
  // once when storage says it is done.
  void counter.backfill();
  // Samples written before 0.4.16 were never read; free their storage.
  void storage.dropSamples().catch(() => {});
}
