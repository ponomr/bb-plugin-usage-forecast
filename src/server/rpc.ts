// The server functions behind RPC `usage-forecast.v1.*` and the CLI. Both call
// the same service, so a change made from the CLI invalidates open pages too.

import { isInheritOverride, normalizeOverride, type LimitsSnapshot, type ThreadOverride, type ThreadState, type CompactResult } from "../shared/contract";
import type { Display, DisplayInput, HiddenProviders, HideProviderInput } from "../shared/contract";
import { joinHiddenProviders, parseHiddenProviders } from "../shared/hidden-providers";
import { parseLimitsShow } from "../shared/limits-show";
import { parseResetShow } from "../shared/reset-show";
import type { AutoCompactor } from "./auto-compact";
import { readHosts, toSnapshot, type Poller } from "./poller";
import type { Storage } from "./storage";
import { readThreadState, type ThreadReaderDeps } from "./threads";

export interface ServiceDeps extends ThreadReaderDeps {
  storage: Storage;
  poller: Poller;
  compactor: AutoCompactor;
  invalidateThread: (threadId: string) => void;
}

export interface Service {
  snapshot(): Promise<LimitsSnapshot>;
  thread(threadId: string): Promise<ThreadState>;
  refresh(): Promise<LimitsSnapshot>;
  compact(threadId: string): Promise<CompactResult>;
  setThreadOverride(threadId: string, override: ThreadOverride): Promise<{ override: ThreadOverride }>;
}

export function createService(deps: ServiceDeps): Service {
  const now = deps.now ?? Date.now;
  const snapshot = async () => {
    const [hosts, log] = await Promise.all([readHosts(deps.storage), deps.storage.log()]);
    return toSnapshot(hosts, log, now());
  };
  return {
    snapshot,
    thread: (threadId) => readThreadState(deps, threadId),
    async refresh() {
      await deps.poller.poll();
      return snapshot();
    },
    compact: (threadId) => deps.compactor.manual(threadId),
    async setThreadOverride(threadId, input) {
      const override = normalizeOverride(input);
      if (isInheritOverride(override)) {
        await deps.threads.updatePluginMetadata({ threadId, remove: ["override"] });
      } else {
        await deps.threads.updatePluginMetadata({ threadId, set: { override } });
      }
      deps.invalidateThread(threadId);
      return { override };
    },
  };
}

/** Writes the display settings a press in the band changes, through the plugin's settings handle. */
export type DisplayWriter = (values: Partial<Display>) => Promise<Record<string, unknown>>;

/**
 * RPC `setDisplay`: writes only the given keys and answers with both
 * effective values. The settings' onChange invalidates the open pages.
 */
export async function setDisplay(write: DisplayWriter, input: DisplayInput): Promise<Display> {
  const values: Partial<Display> = {};
  if (input.limitsShow !== undefined) values.limitsShow = input.limitsShow;
  if (input.resetShow !== undefined) values.resetShow = input.resetShow;
  const next = await write(values);
  return { limitsShow: parseLimitsShow(next.limitsShow), resetShow: parseResetShow(next.resetShow) };
}

/** Reads the plugin's settings and writes the `hiddenProviders` setting, through the settings handle. */
export interface HiddenWriter {
  read: () => Promise<Record<string, unknown>>;
  write: (values: { hiddenProviders: string }) => Promise<Record<string, unknown>>;
}

/**
 * RPC `hideProvider`: appends the id to the `hiddenProviders` setting unless
 * it is there already, and answers with the parsed list after the write. The
 * settings' onChange invalidates the open pages.
 */
export async function hideProvider(settings: HiddenWriter, input: HideProviderInput): Promise<HiddenProviders> {
  const [id] = parseHiddenProviders(input.providerId);
  const current = parseHiddenProviders((await settings.read()).hiddenProviders);
  if (id === undefined || current.includes(id)) return { hiddenProviders: current };
  const next = await settings.write({ hiddenProviders: joinHiddenProviders([...current, id]) });
  return { hiddenProviders: parseHiddenProviders(next.hiddenProviders) };
}
