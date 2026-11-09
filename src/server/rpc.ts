// The server functions behind RPC `usage-forecast.v1.*` and the CLI. Both call
// the same service, so a change made from the CLI invalidates open pages too.

import { normalizeOverride, type LimitsSnapshot, type ThreadOverride, type ThreadState, type CompactResult } from "../shared/contract";
import type { AutoCompactor } from "./auto-compact";
import { toSnapshot, type Poller } from "./poller";
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
    const [latest, log] = await Promise.all([deps.storage.latest(), deps.storage.log()]);
    return toSnapshot(latest, log, now());
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
      if (override.autoCompact === "inherit") {
        await deps.threads.updatePluginMetadata({ threadId, remove: ["override"] });
      } else {
        await deps.threads.updatePluginMetadata({ threadId, set: { override } });
      }
      deps.invalidateThread(threadId);
      return { override };
    },
  };
}
