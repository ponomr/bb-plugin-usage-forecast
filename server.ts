// Server entry: settings, the limits poller, storage, auto-compact, RPC
// `usage-forecast.v1` and the `bb usage-forecast` CLI.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  LIMITS_TAG,
  pollIntervalSchema,
  POLL_DEFAULT_MINUTES,
  POLL_MAX_MINUTES,
  POLL_MIN_MINUTES,
  thresholdSchema,
  threadTag,
  THRESHOLD_DEFAULT_PERCENT,
  THRESHOLD_MAX_PERCENT,
  THRESHOLD_MIN_PERCENT,
  usageForecastContract,
} from "./src/shared/contract";
import { AutoCompactor } from "./src/server/auto-compact";
import { createCli } from "./src/server/cli";
import { Poller, TICK_CRON } from "./src/server/poller";
import { createService } from "./src/server/rpc";
import { Storage } from "./src/server/storage";
import { parseSettings, type ThreadsSdk } from "./src/server/threads";
import { DEFAULT_LANGUAGE, LANGUAGES } from "./src/shared/language";
import { DEFAULT_LIMITS_SHOW, LIMITS_SHOW } from "./src/shared/limits-show";

export const POLL_SCHEDULE = "poll-limits";

export default async function plugin(bb: BbPluginApi) {
  const settingsHandle = bb.settings.define({
    autoCompactEnabled: {
      type: "boolean",
      label: "Auto-compact",
      description: "Compact a thread when it goes idle with its context at or above the threshold.",
      default: false,
    },
    autoCompactThresholdPercent: {
      type: "number",
      label: "Auto-compact threshold, %",
      description: `Context fill that triggers auto-compact, ${THRESHOLD_MIN_PERCENT}-${THRESHOLD_MAX_PERCENT}. Claude Code compacts on its own at 78 %, so for it the plugin acts a little below that.`,
      default: THRESHOLD_DEFAULT_PERCENT,
      experimental_schema: thresholdSchema,
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
      description: "Show each limit window as the percent used or the percent left. The context bar always shows what is used.",
      options: [...LIMITS_SHOW],
      experimental_optionLabels: { used: "Used", remaining: "Remaining" },
      default: DEFAULT_LIMITS_SHOW,
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
  };

  const poller = new Poller({
    usageLimits: (args) => bb.sdk.system.usageLimits(args),
    storage,
    intervalMinutes: async () => (await settings()).pollIntervalMinutes,
    invalidate: invalidateLimits,
  });

  const compactor = new AutoCompactor({ threads, storage, settings, invalidate: invalidateThread, log: bb.log });
  bb.onDispose(() => compactor.dispose());

  const service = createService({ threads, storage, settings, poller, compactor, invalidateThread });

  bb.background.schedule(POLL_SCHEDULE, TICK_CRON, () => poller.tick());

  bb.events.on("thread.active", ({ thread }) => compactor.onActive(thread.id));
  // Not awaited: a check reads the thread several times and must not hold up
  // other listeners. `onIdle` never throws.
  bb.events.on("thread.idle", ({ thread }) => {
    void compactor.onIdle(thread.id);
  });

  bb.rpc.register(usageForecastContract, {
    snapshot: () => service.snapshot(),
    thread: ({ threadId }) => service.thread(threadId),
    refresh: () => service.refresh(),
    compact: ({ threadId }) => service.compact(threadId),
    setThreadOverride: ({ threadId, override }) => service.setThreadOverride(threadId, override),
  });

  bb.cli.register(createCli(service));

  bb.log.info("usage-forecast loaded");
}
