// The card the footer ring opens: every provider's windows, grouped by host
// when there is more than one, with shared accounts listed once.

import type { ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
import type { Tokens } from "../shared/contract";
import { planText } from "../shared/plan";
import { formatTokenCount } from "../shared/tokens";
import { WindowList } from "./banner";
import { formatClock, providerName } from "./format";
import { errorText, useHiddenProviders, useNow, useSnapshot, useStrings, useTokens } from "./hooks";
import { indicatorView, type IndicatorProvider } from "./indicator";
import { hostStale } from "./model";
import { Toned } from "./ui";

type ProviderTokens = Tokens["providers"][number];

function ProviderSection({ entry, now, tokens }: { entry: IndicatorProvider; now: number; tokens: ProviderTokens | undefined }) {
  const s = useStrings();
  const { provider, alsoOn } = entry;
  const plan = planText(provider.planLabel, provider.planMultiplier);
  return (
    <section className="flex flex-col gap-1" data-provider={provider.providerId}>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">{providerName(s, provider.providerId)}</span>
        {plan === null ? null : <span className="text-muted-foreground">{plan}</span>}
        {alsoOn.length === 0 ? null : (
          <span className="text-muted-foreground" data-testid="also-on">
            {s.alsoOn(alsoOn.join(", "))}
          </span>
        )}
      </span>
      <WindowList provider={provider} now={now} />
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
            <section key={group.hostId ?? ""} className="flex flex-col gap-2" data-host={group.hostId ?? ""}>
              {view.showHosts ? <h3 className="font-semibold text-muted-foreground">{group.hostName}</h3> : null}
              {stale ? <Toned tone="amber">{s.hostStale(formatClock(s, host.polledAt!, now))}</Toned> : null}
              {group.providers.map((entry) => (
                <ProviderSection key={entry.provider.providerId} entry={entry} now={now} tokens={tokensOf(entry.provider.providerId)} />
              ))}
            </section>
          );
        })}
        {unavailable}
      </>
    );
  }
  return (
    <div className="flex max-h-96 flex-col gap-3 overflow-y-auto p-3 text-xs" data-testid="limits-card">
      {body}
    </div>
  );
}
