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
// The push carries the provider name, the window label and percents only,
// plus the host names when more than one host is known. A provider in the
// `hiddenProviders` setting is checked and remembered as usual but not sent.
//
// With several hosts the check walks account groups: a provider on hosts that
// share its account (`sharedWith`) is one group and gets one push. What was
// sent is remembered under every member host's key, and a group counts as
// sent for a period when any member's key holds it, so a member going offline
// does not repeat the push. The legacy owner's key is the bare window key, as
// before per-host polling, so pushes remembered then are not repeated.

import { isNewWindow } from "../shared/forecast";
import { isHidden } from "../shared/hidden-providers";
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

/** One host's answer, as the poller hands it over after a poll. */
export interface NotifyHost {
  hostId: string | null;
  name: string | null;
  /** The owner of the legacy keys; its pushes keep the bare window key. */
  primary: boolean;
  /** False for a host that did not answer this poll: its values are not checked. */
  answered: boolean;
  latest: { providers: readonly StoredProvider[] };
}

/** The KV key of one host's window. */
export function notifyKey(host: Pick<NotifyHost, "hostId" | "primary">, key: string): string {
  return host.primary || host.hostId === null ? key : `${encodeURIComponent(host.hostId)}|${key}`;
}

const LEVEL_RANK: Record<Level, number> = { threshold: 1, reached: 2 };

interface Group {
  /** The member whose answer is checked: the newest measurement, the primary host on a tie. */
  provider: StoredProvider;
  members: NotifyHost[];
}

/** Account groups of the answering hosts, primary host first. */
function groupsOf(hosts: readonly NotifyHost[]): Group[] {
  const answered = hosts.filter((h) => h.answered);
  const byId = new Map(answered.map((h) => [h.hostId, h]));
  const done = new Set<string>();
  const groups: Group[] = [];
  for (const host of [...answered].sort((a, b) => Number(b.primary) - Number(a.primary))) {
    for (const provider of host.latest.providers) {
      const seen = `${host.hostId ?? ""}\n${provider.providerId}`;
      if (done.has(seen)) continue;
      const members = [host, ...(provider.sharedWith ?? []).flatMap((id) => byId.get(id) ?? [])];
      let best = { host, provider };
      for (const member of members) {
        done.add(`${member.hostId ?? ""}\n${provider.providerId}`);
        const p = member.latest.providers.find((x) => x.providerId === provider.providerId);
        if (p !== undefined && (p.measuredAt ?? -Infinity) > (best.provider.measuredAt ?? -Infinity)) best = { host: member, provider: p };
      }
      groups.push({ provider: best.provider, members });
    }
  }
  return groups;
}

function levelOf(usedPercent: number, threshold: number): Level | null {
  if (usedPercent >= 100) return "reached";
  if (usedPercent >= threshold) return "threshold";
  return null;
}

export class LimitNotifier {
  constructor(private readonly deps: LimitNotifierDeps) {}

  /** Checks the windows of one host's poll. Never throws. */
  async check(providers: readonly StoredProvider[], now: number): Promise<void> {
    await this.checkHosts([{ hostId: null, name: null, primary: true, answered: true, latest: { providers } }], now);
  }

  /** Checks the windows of one poll across hosts, once per account group. Never throws. */
  async checkHosts(hosts: readonly NotifyHost[], now: number): Promise<void> {
    try {
      const settings = await this.deps.settings();
      if (!settings.limitNotifyEnabled) return;
      const s = STRINGS[settings.language];
      const sent = await this.deps.storage.notified();
      const named = hosts.length > 1;
      let changed = false;

      for (const { provider, members } of groupsOf(hosts)) {
        if (provider.status !== "ok") continue;
        for (const w of provider.windows) {
          // A window whose reset has passed shows stale numbers.
          if (w.resetsAt !== null && w.resetsAt <= now) continue;
          const key = windowKey(provider.providerId, w.label);
          const memberKeys = members.map((m) => notifyKey(m, key));
          const level = levelOf(w.usedPercent, settings.limitNotifyPercent);
          if (level === null) {
            for (const k of memberKeys) {
              if (sent[k] !== undefined) {
                delete sent[k];
                changed = true;
              }
            }
            continue;
          }
          // The highest level any member already sent for this period.
          let previous: Notified | undefined;
          for (const k of memberKeys) {
            const entry = sent[k];
            if (entry === undefined || isNewWindow(entry.resetsAt, w.resetsAt)) continue;
            if (previous === undefined || LEVEL_RANK[entry.level] > LEVEL_RANK[previous.level]) previous = entry;
          }
          if (previous !== undefined && (previous.level === "reached" || level === "threshold")) continue;

          const provName = providerName(s, provider.providerId);
          const window = windowLabel(s, w.label, w.model);
          const title =
            level === "reached" ? s.pushReachedTitle(provName, window) : s.pushTitle(provName, window, formatPercent(w.usedPercent));
          const message: PushMessage = {
            title: named ? s.pushOnHosts(title, members.map((m) => m.name ?? m.hostId ?? "").join(", ")) : title,
            body: s.pushBody(formatResetIn(s, w.resetsAt, now)),
          };
          const what = `${provider.providerId} ${w.label} ${level}`;
          // A hidden provider passes its steps as usual and only stays silent,
          // so un-hiding it sends nothing for steps already passed.
          if (isHidden(settings.hiddenProviders, provider.providerId)) this.deps.log.info(`limit push skipped, provider hidden (${what})`);
          else await this.send(message, what);
          for (const k of memberKeys) sent[k] = { resetsAt: w.resetsAt, level, at: now };
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
