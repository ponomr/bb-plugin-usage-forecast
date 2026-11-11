// Settings page section. bb draws the form for the settings above it (and
// rejects out-of-range values); this section shows what the plugin is doing
// with them.

import { useState } from "react";
import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import {
  CONTEXT_LIMIT_DEFAULT_TOKENS,
  POLL_DEFAULT_MINUTES,
  THRESHOLD_DEFAULT_PERCENT,
  type CompactLogEntry,
  type UsageForecastContract,
} from "../shared/contract";
import { compactEntryText, formatAgo, providerName, shortTokens, statusText } from "./format";
import { errorText, useNow, useSnapshot } from "./hooks";
import { useStrings } from "./i18n";
import { Toned } from "./ui";
import { Button } from "../../components/ui/button";

/** The latest compacts of all threads, newest first. Nothing when there are none. */
export function RecentCompacts({
  entries,
  now,
  heading = true,
}: {
  entries: readonly CompactLogEntry[];
  now: number;
  heading?: boolean;
}) {
  const s = useStrings();
  if (entries.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      {heading ? <span className="font-medium">{s.recentCompacts}</span> : null}
      <ul className="flex flex-col gap-0.5" aria-label={s.recentCompacts}>
        {entries.map((e) => (
          <li key={`${e.threadId}:${e.at}`} className="text-muted-foreground" title={e.message ?? undefined}>
            {formatAgo(s, e.at, now)} — {compactEntryText(s, e)}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function SettingsSection() {
  const s = useStrings();
  const settings = useSettings();
  const snapshot = useSnapshot();
  const rpc = useRpc<UsageForecastContract>();
  const now = useNow();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const values = settings.values ?? {};
  const enabled = values.autoCompactEnabled === true;
  const threshold = Number(values.autoCompactThresholdPercent ?? THRESHOLD_DEFAULT_PERCENT);
  const interval = Number(values.pollIntervalMinutes ?? POLL_DEFAULT_MINUTES);
  const limit = Number(values.contextLimitTokens ?? CONTEXT_LIMIT_DEFAULT_TOKENS);
  const data = snapshot.data;

  const refresh = () => {
    setRefreshing(true);
    setRefreshError(null);
    rpc
      .call("refresh", null)
      .then(() => snapshot.refetch())
      .catch((e: unknown) => setRefreshError(errorText(e)))
      .finally(() => setRefreshing(false));
  };

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="usage-settings">
      <div className="flex flex-col gap-1">
        <div>{s.settingsSummary(enabled, threshold, interval, shortTokens(limit))}</div>
        <div className="text-muted-foreground">{s.settingsHint}</div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span>{data?.polledAt == null ? s.notPolledYet : s.lastPoll(formatAgo(s, data.polledAt, now))}</span>
          <Button size="sm" variant="outline" disabled={refreshing} onClick={refresh}>
            {refreshing ? s.refreshing : s.refresh}
          </Button>
        </div>
        {data?.pollError ? <Toned tone="amber">{s.pollError(data.pollError)}</Toned> : null}
        {refreshError === null ? null : <Toned tone="red">{refreshError}</Toned>}
        {data?.providers.length ? (
          <ul className="flex flex-col">
            {data.providers.map((p) => (
              <li key={p.providerId}>
                {providerName(s, p.providerId)}: {statusText(s, p.status, p.message) ?? "ok"}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {data === undefined ? null : <RecentCompacts entries={data.recentCompactions} now={now} />}

      <div className="text-muted-foreground">{s.providerUsageNote}</div>
    </div>
  );
}
