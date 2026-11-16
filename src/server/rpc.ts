// The server functions behind RPC `usage-forecast.v1.*` and the CLI. Both call
// the same service, so a change made from the CLI invalidates open pages too.

import { isInheritOverride, normalizeOverride, type LimitsSnapshot, type ThreadOverride, type ThreadState, type CompactResult } from "../shared/contract";
import type { Display, DisplayInput } from "../shared/contract";
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
