// The card the footer ring opens: every provider's windows. With more than
// one host the hosts are tabs and the card shows one of them, first the host
// of the ring's worst window. Compact: one
// line per window (label, bar, percent, reset); the forecast is the bar's
// colour and tick, its words are the row's tooltip, and only a window that
// runs out before its reset names the time. A provider's token sums and the
// other hosts of its account share its heading line.

import { useState } from "react";
import type { ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
import type { LimitWindow, Tokens } from "../shared/contract";
import { planText } from "../shared/plan";
import { formatTokenCount } from "../shared/tokens";
import { ResetTime, WindowBar, WindowPercent } from "./banner";
import { formatClock, formatRunOut, providerName, shortWindowLabel, windowLabel } from "./format";
import { errorText, useHiddenProviders, useLimitsShow, useNow, useResetShow, useSnapshot, useStrings, useTokens } from "./hooks";
import type { Strings } from "./i18n";
import { indicatorView, type IndicatorProvider } from "./indicator";
import { hostStale, paceDetails, windowNote, windowView } from "./model";
import { cn } from "../../lib/utils";
import { Toned } from "./ui";

type ProviderTokens = Tokens["providers"][number];

function runOutParts(s: Strings, at: number, now: number): [string, string | null] {
  const { time, weekday } = formatRunOut(s, at, now);
  return [time, weekday];
}

function WindowRow({ window: w, now }: { window: LimitWindow; now: number }) {
  const s = useStrings();
  const show = useLimitsShow();
  const resetShow = useResetShow();
  const v = windowView(w, now);
  const note = windowNote(s, v, now, show, resetShow);
  const details = paceDetails(s, w, show);
  // A label with no short form ("Fable") stays whole: its first letter says nothing here.
  const label = Object.hasOwn(s.shortWindow, w.label) ? shortWindowLabel(s, w.label, w.model) : windowLabel(s, w.label, w.model);
  return (
    <li className="flex flex-col" data-window={w.label} title={details === undefined ? note : `${note}\n${details}`}>
      <span className="flex items-center gap-2">
        <span className="w-12 shrink-0 truncate text-muted-foreground">{label}</span>
        <WindowBar view={v} className="min-w-0 flex-1" />
        <WindowPercent view={v} className="w-9 shrink-0 text-right font-medium tabular-nums" pressable />
        <span className="w-16 shrink-0 text-right">
          {w.resetsAt === null ? <span className="text-muted-foreground">–</span> : <ResetTime resetsAt={w.resetsAt} now={now} className="" />}
        </span>
      </span>
      {v.status === "out" && v.runOutAt !== null ? (
        <Toned tone={v.tone}>
          <span data-testid="window-runs-out">{s.runsOutShort(...runOutParts(s, v.runOutAt, now))}</span>
        </Toned>
      ) : null}
    </li>
  );
}

function ProviderSection({ entry, now, tokens }: { entry: IndicatorProvider; now: number; tokens: ProviderTokens | undefined }) {
  const s = useStrings();
  const { provider, alsoOn } = entry;
  const plan = planText(provider.planLabel, provider.planMultiplier);
  const name = providerName(s, provider.providerId);
  const also = alsoOn.length === 0 ? undefined : s.alsoOn(alsoOn.join(", "));
  const today = tokens === undefined ? "" : formatTokenCount(tokens.today.work, s.lang);
  const month = tokens === undefined ? "" : formatTokenCount(tokens.month.work, s.lang);
  const tokensFull = s.tokensTodayMonth(today, month);
  return (
    <section className="flex flex-col gap-0.5" data-provider={provider.providerId}>
      <span className="flex items-baseline gap-x-2">
        <span
          className="shrink-0 font-semibold"
          data-testid={also === undefined ? undefined : "also-on"}
          title={also}
          aria-label={also === undefined ? undefined : `${name}, ${also}`}
        >
          {name}
        </span>
        {plan === null ? null : <span className="shrink-0 rounded bg-muted px-1.5 text-muted-foreground">{plan}</span>}
        {tokens === undefined ? null : (
          <span className="ml-auto min-w-0 truncate text-muted-foreground tabular-nums" data-testid="provider-tokens" title={tokensFull}>
            {today} · {month}
          </span>
        )}
      </span>
      <ul className="flex flex-col">
        {provider.windows.map((w) => (
          <WindowRow key={`${w.label}:${w.model ?? ""}`} window={w} now={now} />
        ))}
      </ul>
    </section>
  );
}

export function SidebarCard(_props: ExperimentalSidebarFooterDisclosureProps) {
  const s = useStrings();
  const now = useNow();
  const hidden = useHiddenProviders();
  const query = useSnapshot();
  const tokens = useTokens(null).data;
  // The tab the user picked; until then, and when its host is gone, the worst window's host.
  const [picked, setPicked] = useState<string | null>(null);
  const snapshot = query.data;
  let body: React.ReactNode;
  if (snapshot === undefined) {
    body = query.error ? <Toned tone="amber">{errorText(query.error)}</Toned> : <span className="text-muted-foreground">{s.loading}</span>;
  } else {
    const view = indicatorView(snapshot, now, hidden);
    const shown =
      view.groups.find((g) => g.hostId === picked) ?? view.groups.find((g) => g.hostName === view.worst?.hostName) ?? view.groups[0];
    const tokensOf = (providerId: string) => tokens?.providers.find((p) => p.providerId === providerId);
    const host = shown === undefined ? undefined : snapshot.hosts.find((h) => h.hostId === shown.hostId);
    const stale = host !== undefined && hostStale(host) && host.polledAt !== null;
    const unavailable =
      view.unavailable.length === 0 ? null : (
        <span className="text-muted-foreground" data-testid="hosts-unavailable">
          {s.hostsUnavailable(view.unavailable.join(", "))}
        </span>
      );
    body = (
      <>
        {view.groups.length === 0 ? <span className="text-muted-foreground">{s.noLimitsData}</span> : null}
        {view.showHosts && shown !== undefined ? (
          <div role="tablist" className="flex flex-wrap gap-1">
            {view.groups.map((group) => {
              const selected = group === shown;
              return (
                <button
                  key={group.hostId ?? ""}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={cn(
                    "cursor-pointer rounded-md px-2 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                    selected ? "bg-muted font-semibold" : "text-muted-foreground",
                  )}
                  onClick={() => setPicked(group.hostId)}
                >
                  {group.hostName}
                </button>
              );
            })}
          </div>
        ) : null}
        {shown === undefined ? null : (
          <section className="flex flex-col gap-1.5" data-host={shown.hostId ?? ""}>
            {stale ? <Toned tone="amber">{s.hostStale(formatClock(s, host!.polledAt!, now))}</Toned> : null}
            <div className="flex flex-col gap-1.5 [&>section+section]:border-border [&>section+section]:border-t [&>section+section]:pt-1.5">
              {shown.providers.map((entry) => (
                <ProviderSection key={entry.provider.providerId} entry={entry} now={now} tokens={tokensOf(entry.provider.providerId)} />
              ))}
            </div>
          </section>
        )}
        {unavailable}
      </>
    );
  }
  return (
    <div className="flex max-h-[19rem] flex-col gap-1.5 overflow-y-auto px-3 py-2 text-xs leading-4" data-testid="limits-card">
      {body}
    </div>
  );
}
