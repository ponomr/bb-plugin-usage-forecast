// Push notifications when a limit window nears its end. After every poll each
// window of an `ok` provider is checked against the `limitNotifyPercent`
// setting: crossing it sends one push, reaching 100 % sends a second one.
// A window is identified by (providerId, label) and its period by `resetsAt`;
// a new period, or a fill back below the threshold, re-arms it. What was sent
// is kept in KV so a restart does not repeat a push.
//
// Delivery goes through the `push-notifications` plugin's RPC
// `notifications.send`. A failed send is logged and still counts as sent, so
// a missing plugin or a host with no devices does not retry on every poll.
// The push carries the provider name, the window label and percents only.

import { isNewWindow } from "../shared/forecast";
import { formatPercent } from "../shared/thresholds";
import { windowKey } from "../shared/windows";
import { formatResetIn, providerName, windowLabel } from "../app/format";
import { STRINGS } from "../app/i18n";
import { cleanMessage } from "./messages";
import type { Notified, Storage, StoredProvider } from "./storage";
import type { PluginSettings } from "./threads";

export interface PushMessage {
  title: string;
  body: string;
}

export interface LimitNotifierDeps {
  storage: Storage;
  settings: () => Promise<PluginSettings>;
  /** Sends one push; resolves to the channels that received it. */
  send: (message: PushMessage) => Promise<readonly string[]>;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

type Level = Notified["level"];

function levelOf(usedPercent: number, threshold: number): Level | null {
  if (usedPercent >= 100) return "reached";
  if (usedPercent >= threshold) return "threshold";
  return null;
}

export class LimitNotifier {
  constructor(private readonly deps: LimitNotifierDeps) {}

  /** Checks the windows of one poll. Never throws. */
  async check(providers: readonly StoredProvider[], now: number): Promise<void> {
    try {
      const settings = await this.deps.settings();
      if (!settings.limitNotifyEnabled) return;
      const s = STRINGS[settings.language];
      const sent = await this.deps.storage.notified();
      let changed = false;

      for (const provider of providers) {
        if (provider.status !== "ok") continue;
        for (const w of provider.windows) {
          // A window whose reset has passed shows stale numbers.
          if (w.resetsAt !== null && w.resetsAt <= now) continue;
          const key = windowKey(provider.providerId, w.label);
          const previous = sent[key];
          const level = levelOf(w.usedPercent, settings.limitNotifyPercent);
          if (level === null) {
            if (previous !== undefined) {
              delete sent[key];
              changed = true;
            }
            continue;
          }
          const samePeriod = previous !== undefined && !isNewWindow(previous.resetsAt, w.resetsAt);
          if (samePeriod && (previous.level === "reached" || level === "threshold")) continue;

          const provName = providerName(s, provider.providerId);
          const window = windowLabel(s, w.label, w.model);
          const message: PushMessage = {
            title:
              level === "reached"
                ? s.pushReachedTitle(provName, window)
                : s.pushTitle(provName, window, formatPercent(w.usedPercent)),
            body: s.pushBody(formatResetIn(s, w.resetsAt, now)),
          };
          await this.send(message, `${provider.providerId} ${w.label} ${level}`);
          sent[key] = { resetsAt: w.resetsAt, level, at: now };
          changed = true;
        }
      }
      if (changed) await this.deps.storage.setNotified(sent);
    } catch (cause) {
      this.deps.log.warn(`limit notification check failed: ${cleanMessage(cause)}`);
    }
  }

  private async send(message: PushMessage, what: string): Promise<void> {
    try {
      const channels = await this.deps.send(message);
      if (channels.length === 0) this.deps.log.warn(`limit push not delivered (${what})`);
      else this.deps.log.info(`limit push sent (${what}) to ${channels.join(", ")}`);
    } catch (cause) {
      this.deps.log.warn(`limit push failed (${what}): ${cleanMessage(cause)}`);
    }
  }
}
