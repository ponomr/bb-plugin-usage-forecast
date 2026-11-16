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
import { createService, hideProvider, setDisplay } from "./src/server/rpc";
import { Storage } from "./src/server/storage";
import { TokenCounter } from "./src/server/token-counter";
import { parseSettings, type ThreadsSdk } from "./src/server/threads";
import { DEFAULT_LANGUAGE, LANGUAGES } from "./src/shared/language";
import { DEFAULT_LIMITS_SHOW, LIMITS_SHOW } from "./src/shared/limits-show";
import { DEFAULT_RESET_SHOW, RESET_SHOW } from "./src/shared/reset-show";

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

export default async function plugin(bb: BbPluginApi) {
  const settingsHandle = bb.settings.define({
    autoCompactEnabled: {
      type: "boolean",
      label: "Auto-compact",
      description: "Compact a thread when it goes idle with its context at or above the threshold.",
      default: false,
    },
    summaryClearEnabled: {
      type: "boolean",
      label: "Summarise and clear when a provider cannot compact",
      description:
        "For a provider without compaction (such as custom ACP agents), Compact and auto-compact ask the agent for a summary, clear the thread's context and send the summary back as the next message. The thread history stays visible. Off: such threads are skipped.",
      default: false,
    },
    contextLimitTokens: {
      type: "number",
      label: "Context limit, tokens",
      description: `The working context size the bar and the auto-compact threshold are measured against when neither a provider limit below nor the provider's own compaction point applies, ${CONTEXT_LIMIT_MIN_TOKENS.toLocaleString("en-US")}-${CONTEXT_LIMIT_MAX_TOKENS.toLocaleString("en-US")}. A smaller model window caps it.`,
      default: CONTEXT_LIMIT_DEFAULT_TOKENS,
      experimental_schema: contextLimitSchema,
    },
    [PROVIDER_LIMIT_SETTINGS["claude-code"]]: {
      type: "number",
      label: "Claude Code context limit, tokens",
      description: `Working limit for Claude Code threads, ${CONTEXT_LIMIT_MIN_TOKENS.toLocaleString("en-US")}-${CONTEXT_LIMIT_MAX_TOKENS.toLocaleString("en-US")}. 0 (auto) uses the point where Claude Code compacts on its own, as bb reports it, else the context limit above.`,
      default: PROVIDER_LIMIT_AUTO,
      experimental_schema: providerLimitSchema,
    },
    [PROVIDER_LIMIT_SETTINGS.codex]: {
      type: "number",
      label: "Codex context limit, tokens",
      description: `Working limit for Codex threads, ${CONTEXT_LIMIT_MIN_TOKENS.toLocaleString("en-US")}-${CONTEXT_LIMIT_MAX_TOKENS.toLocaleString("en-US")}. bb does not report where Codex compacts on its own, so 0 (auto) uses the context limit above; set your model_auto_compact_token_limit here to measure against it.`,
      default: PROVIDER_LIMIT_AUTO,
      experimental_schema: providerLimitSchema,
    },
    autoCompactThresholdPercent: {
      type: "number",
      label: "Auto-compact threshold, %",
      description: `Fill of the thread's context limit that triggers auto-compact, ${THRESHOLD_MIN_PERCENT}-${THRESHOLD_MAX_PERCENT}. When a limit lies above the point where the provider compacts on its own, the plugin acts a little below that point.`,
      default: THRESHOLD_DEFAULT_PERCENT,
      experimental_schema: thresholdSchema,
    },
    limitNotifyEnabled: {
      type: "boolean",
      label: "Limit push notifications",
      description: "Send a push through the push-notifications plugin when a limit window reaches the percent below, and again when it runs out. One push per window and step until the window resets.",
      default: true,
    },
    limitNotifyPercent: {
      type: "number",
      label: "Limit push threshold, %",
      description: `Usage of a limit window that sends a push, ${LIMIT_NOTIFY_MIN_PERCENT}-${LIMIT_NOTIFY_MAX_PERCENT}.`,
      default: LIMIT_NOTIFY_DEFAULT_PERCENT,
      experimental_schema: limitNotifySchema,
    },
    pollIntervalMinutes: {
      type: "number",
      label: "Limits poll interval, minutes",
      description: `How often the server asks bb for the provider limits, ${POLL_MIN_MINUTES}-${POLL_MAX_MINUTES}.`,
      default: POLL_DEFAULT_MINUTES,
      experimental_schema: pollIntervalSchema,
    },
    language: {
      type: "select",
      label: "Language",
      description: "Language of the plugin UI.",
      options: [...LANGUAGES],
      experimental_optionLabels: { en: "English", ru: "Русский" },
      default: DEFAULT_LANGUAGE,
    },
    limitsShow: {
      type: "select",
      label: "Limits show",
      description: "Show each limit window as the percent used or the percent left. A press on a percent in the band switches it too. The context bar always shows what is used.",
      options: [...LIMITS_SHOW],
      experimental_optionLabels: { used: "Used", remaining: "Remaining" },
      default: DEFAULT_LIMITS_SHOW,
    },
    resetShow: {
      type: "select",
      label: "Reset shows",
      description: "Show when a limit window resets as the time left until it or as the local time of the reset. A press on a reset time in the band switches it too.",
      options: [...RESET_SHOW],
      experimental_optionLabels: { countdown: "Countdown", time: "Exact time" },
      default: DEFAULT_RESET_SHOW,
    },
    showBand: {
      type: "boolean",
      label: "Band above the composer",
      description: "Show the limits and context band above the message field of every thread. Off: the band and its Compact button are gone; the thread context card, the sidebar ring, pushes and auto-compact work as before.",
      default: true,
    },
    showSidebar: {
      type: "boolean",
      label: "Sidebar ring and card",
      description: "Show the limits ring in the sidebar footer and the card it opens. Off: the ring is not drawn and the card is empty; bb keeps the item's empty button in the footer, More → Customize footer removes it.",
      default: true,
    },
    hiddenProviders: {
      type: "string",
      label: "Hidden providers",
      description:
        "Provider ids to leave out of the band's other providers, the sidebar sign, limit pushes and `bb usage-forecast headroom`, separated by commas or spaces (for example: acp-opencode, codex). A thread's own provider is always shown. `bb usage-forecast status` prints the ids. Limits are still polled.",
      default: "",
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
    setDisplay: (input) => setDisplay((values) => settingsHandle.experimental_set(values), input),
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
