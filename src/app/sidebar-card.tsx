// The card the footer ring and the header limits open: every provider's windows. With more than
// one host the hosts are tabs and the card shows one of them, first the host
// of the ring's worst window. Compact (к1): one line per window (label, bar,
// percent, time to reset); the forecast is the bar's colour, its words are the
// row's tooltip, and only a window that runs out before its reset names the
// time. Big numbers (`cardStyle`): each window's percent in large type over
// its short label, the note and pace in its tooltip. The plan and the other hosts of an account are the name's tooltip;
// token sums live in the band and the CLI.

import { useState } from "react";
import type { ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
import type { LimitWindow } from "../shared/contract";
import { planText } from "../shared/plan";
import { ResetTime, WindowBar, WindowPercent } from "./banner";
import { formatClock, formatRunOut, limitPercent, providerName, shortWindowLabel, windowLabel } from "./format";
import { errorText, useCardStyle, useHiddenProviders, useNow, useSnapshot, useStrings } from "./hooks";
import type { Strings } from "./i18n";
import { indicatorView, type IndicatorProvider } from "./indicator";
import { hostStale, paceDetails, windowNote, windowView } from "./model";
import { cn } from "../../lib/utils";
import { CardActions } from "./card-actions";
import { Ink, Toned } from "./ui";

function runOutParts(s: Strings, at: number, now: number): [string, string | null] {
  const { time, weekday } = formatRunOut(s, at, now);
  return [time, weekday];
}

function WindowRow({ window: w, now }: { window: LimitWindow; now: number }) {
  const s = useStrings();
  const v = windowView(w, now);
  const note = windowNote(s, v, now);
  const details = paceDetails(s, w);
  // A label with no short form ("Fable") stays whole: its first letter says nothing here.
  // A window nobody has used since its last reset has no reset yet: a dash, not 100% left or 0% used.
  const notStarted = w.resetsAt === null && w.usedPercent === 0;
  const label = Object.hasOwn(s.shortWindow, w.label) ? shortWindowLabel(s, w.label, w.model) : windowLabel(s, w.label, w.model);
  return (
    <li className="flex flex-col" data-window={w.label} title={details === undefined ? note : `${note}\n${details}`}>
      <span className="flex items-center gap-2">
        <span className="w-12 shrink-0 truncate text-muted-foreground">{label}</span>
        <WindowBar view={v} ticks={false} className="min-w-0 flex-1" />
        {notStarted ? (
          <span className="w-9 shrink-0 text-right text-muted-foreground" data-testid="window-not-started">
            —
          </span>
        ) : (
          <WindowPercent view={v} className="w-9 shrink-0 text-right font-medium tabular-nums" />
        )}
        {/* The time left to the reset ("4d 17h"); its tooltip has the local time. */}
        <span className="w-14 shrink-0 whitespace-nowrap text-right" data-testid="window-reset">
          {w.resetsAt === null ? null : <ResetTime resetsAt={w.resetsAt} now={now} className="" />}
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

/** Big numbers: the window's percent in large type over its short label. */
function WindowBig({ window: w, now }: { window: LimitWindow; now: number }) {
  const s = useStrings();
  const v = windowView(w, now);
  const note = windowNote(s, v, now);
  const details = paceDetails(s, w);
  const notStarted = w.resetsAt === null && w.usedPercent === 0;
  const label = Object.hasOwn(s.shortWindow, w.label) ? shortWindowLabel(s, w.label, w.model) : windowLabel(s, w.label, w.model);
  return (
    <li className="flex flex-col items-start" data-window={w.label} title={details === undefined ? note : `${note}\n${details}`}>
      {notStarted ? (
        <span className="text-[30px] font-bold leading-8 text-muted-foreground" data-testid="window-not-started">
          —
        </span>
      ) : (
        <Ink tone={v.tone} className="text-[30px] font-bold leading-8 tabular-nums">
          {Math.round(limitPercent(s, w.usedPercent))}
          <span className="ml-px text-base font-semibold opacity-80">%</span>
        </Ink>
      )}
      <span className="max-w-16 truncate text-[10px] leading-3 text-muted-foreground">{label}</span>
    </li>
  );
}

function ProviderSection({ entry, now }: { entry: IndicatorProvider; now: number }) {
  const s = useStrings();
  const { provider, alsoOn } = entry;
  const plan = planText(provider.planLabel, provider.planMultiplier);
  const name = providerName(s, provider.providerId);
  const also = alsoOn.length === 0 ? undefined : s.alsoOn(alsoOn.join(", "));
  const extra = [plan, also].filter((x) => x != null).join(" · ") || undefined;
  const big = useCardStyle() === "big";
  return (
    <section className="flex flex-col gap-0.5" data-provider={provider.providerId}>
      <span
        className="self-start font-semibold"
        data-testid="provider-name"
        title={extra}
        aria-label={extra === undefined ? undefined : `${name}, ${extra}`}
      >
        {name}
      </span>
      <ul className={big ? "flex flex-wrap gap-x-4 gap-y-1" : "flex flex-col"} data-style={big ? "big" : "rows"}>
        {provider.windows.map((w) =>
          big ? (
            <WindowBig key={`${w.label}:${w.model ?? ""}`} window={w} now={now} />
          ) : (
            <WindowRow key={`${w.label}:${w.model ?? ""}`} window={w} now={now} />
          ),
        )}
      </ul>
    </section>
  );
}

export function SidebarCard(_props: ExperimentalSidebarFooterDisclosureProps) {
  return <LimitsCard />;
}

/**
 * The limits card of the sidebar ring and of the header limits. `onNavigate`
 * runs before the settings button leaves the page (the header closes its
 * popover); `className` replaces the size and scroll of the sidebar card.
 */
export function LimitsCard({ onNavigate, className }: { onNavigate?: () => void; className?: string }) {
  const s = useStrings();
  const now = useNow();
  const hidden = useHiddenProviders();
  const query = useSnapshot();
  // The tab the user picked; until then, and when its host is gone, the worst window's host.
  const [picked, setPicked] = useState<string | null>(null);
  const snapshot = query.data;
  let body: React.ReactNode;
  let polledAt: number | null = null;
  if (snapshot === undefined) {
    body = query.error ? <Toned tone="amber">{errorText(query.error)}</Toned> : <span className="text-muted-foreground">{s.loading}</span>;
  } else {
    const view = indicatorView(snapshot, now, hidden);
    const shown =
      view.groups.find((g) => g.hostId === picked) ?? view.groups.find((g) => g.hostName === view.worst?.hostName) ?? view.groups[0];
    const host = shown === undefined ? undefined : snapshot.hosts.find((h) => h.hostId === shown.hostId);
    polledAt = host?.polledAt ?? snapshot.polledAt;
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
                <ProviderSection key={entry.provider.providerId} entry={entry} now={now} />
              ))}
            </div>
          </section>
        )}
        {unavailable}
      </>
    );
  }
  return (
    <div className={cn("flex flex-col gap-1.5 px-3 py-2 text-xs leading-4", className ?? "max-h-[19rem] overflow-y-auto")} data-testid="limits-card">
      {body}
      <CardActions polledAt={polledAt} now={now} onNavigate={onNavigate} short />
    </div>
  );
}
