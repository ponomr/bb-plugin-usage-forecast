// The card the footer ring opens: every provider's windows, grouped by host
// when there is more than one, with shared accounts listed once. Compact: one
// line per window (label, bar, percent, reset); the forecast is the bar's
// colour and tick, its words are the row's tooltip, and only a window that
// runs out before its reset spells them out.

import type { ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
import type { LimitWindow, Tokens } from "../shared/contract";
import { planText } from "../shared/plan";
import { formatTokenCount } from "../shared/tokens";
import { ResetTime, WindowBar, WindowPercent } from "./banner";
import { formatClock, providerName, shortWindowLabel, windowLabel } from "./format";
import { errorText, useHiddenProviders, useLimitsShow, useNow, useResetShow, useSnapshot, useStrings, useTokens } from "./hooks";
import { indicatorView, type IndicatorProvider } from "./indicator";
import { hostStale, paceDetails, windowNote, windowView } from "./model";
import { Toned } from "./ui";

type ProviderTokens = Tokens["providers"][number];

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
      {v.status === "out" ? (
        <Toned tone={v.tone}>
          <span data-testid="window-runs-out">{note}</span>
        </Toned>
      ) : null}
    </li>
  );
}

function ProviderSection({ entry, now, tokens }: { entry: IndicatorProvider; now: number; tokens: ProviderTokens | undefined }) {
  const s = useStrings();
  const { provider, alsoOn } = entry;
  const plan = planText(provider.planLabel, provider.planMultiplier);
  return (
    <section className="flex flex-col gap-1" data-provider={provider.providerId}>
      <span className="flex items-baseline gap-x-2">
        <span className="font-semibold">{providerName(s, provider.providerId)}</span>
        {alsoOn.length === 0 ? null : (
          <span className="min-w-0 truncate text-muted-foreground" data-testid="also-on">
            {s.alsoOn(alsoOn.join(", "))}
          </span>
        )}
        {plan === null ? null : <span className="ml-auto shrink-0 rounded bg-muted px-1.5 text-muted-foreground">{plan}</span>}
      </span>
      <ul className="flex flex-col gap-0.5">
        {provider.windows.map((w) => (
          <WindowRow key={`${w.label}:${w.model ?? ""}`} window={w} now={now} />
        ))}
      </ul>
      {tokens === undefined ? null : (
        <span className="text-muted-foreground" data-testid="provider-tokens">
          {s.tokensTodayMonth(formatTokenCount(tokens.today.work, s.lang), formatTokenCount(tokens.month.work, s.lang))}
        </span>
      )}
    </section>
  );
}

export function SidebarCard(_props: ExperimentalSidebarFooterDisclosureProps) {
  const s = useStrings();
  const now = useNow();
  const hidden = useHiddenProviders();
  const query = useSnapshot();
  const tokens = useTokens(null).data;
  const snapshot = query.data;
  let body: React.ReactNode;
  if (snapshot === undefined) {
    body = query.error ? <Toned tone="amber">{errorText(query.error)}</Toned> : <span className="text-muted-foreground">{s.loading}</span>;
  } else {
    const view = indicatorView(snapshot, now, hidden);
    // UF-12 R9: the sums cover a provider's BB threads on every host, so a
    // provider listed under several hosts carries them once, in its first section.
    const withTokens = new Set<string>();
    const tokensOf = (providerId: string) => {
      if (withTokens.has(providerId)) return undefined;
      withTokens.add(providerId);
      return tokens?.providers.find((p) => p.providerId === providerId);
    };
    const unavailable =
      view.unavailable.length === 0 ? null : (
        <span className="text-muted-foreground" data-testid="hosts-unavailable">
          {s.hostsUnavailable(view.unavailable.join(", "))}
        </span>
      );
    body = (
      <>
        {view.groups.length === 0 ? <span className="text-muted-foreground">{s.noLimitsData}</span> : null}
        {view.groups.map((group) => {
          const host = snapshot.hosts.find((h) => h.hostId === group.hostId);
          const stale = host !== undefined && hostStale(host) && host.polledAt !== null;
          return (
            <section key={group.hostId ?? ""} className="flex flex-col gap-2 border-border border-t pt-2 first:border-t-0 first:pt-0" data-host={group.hostId ?? ""}>
              {view.showHosts ? <h3 className="text-[11px] text-muted-foreground">{group.hostName}</h3> : null}
              {stale ? <Toned tone="amber">{s.hostStale(formatClock(s, host.polledAt!, now))}</Toned> : null}
              <div className="flex flex-col gap-2 [&>section+section]:border-border [&>section+section]:border-t [&>section+section]:pt-2">
                {group.providers.map((entry) => (
                  <ProviderSection key={entry.provider.providerId} entry={entry} now={now} tokens={tokensOf(entry.provider.providerId)} />
                ))}
              </div>
            </section>
          );
        })}
        {unavailable}
      </>
    );
  }
  return (
    <div className="flex max-h-96 flex-col gap-2 overflow-y-auto p-3 text-xs" data-testid="limits-card">
      {body}
    </div>
  );
}
