// Composer band of a thread, after the band of claude-code-usage-quota-mod
// (see NOTICE). The header has the headline, the auto-compact switch with its
// threshold and the compact button; the collapsed row has a bar per limit
// window and the context bar; the expanded view has each window with its pace
// note, the context breakdown and the other providers. On a phone the
// expanded part scrolls inside a capped height, so the header with the
// collapse button never leaves the screen.

import { useEffect, useState, type ReactNode } from "react";
import {
  THRESHOLD_MAX_PERCENT,
  THRESHOLD_MIN_PERCENT,
  type ProviderLimits,
  type ThreadState,
} from "../shared/contract";
import { formatPercent } from "../shared/thresholds";
import { CompactButton, ContextPanel, parseThreshold } from "./context-row";
import {
  contextPercent,
  formatAgo,
  formatClock,
  formatCost,
  formatSpan,
  providerName,
  shortWindowLabel,
  statusText,
  usedOfLimit,
  windowLabel,
} from "./format";
import {
  useCompact,
  useComposerThreadId,
  useExpanded,
  useLimitsShow,
  useNow,
  useSetOverride,
  useSnapshot,
  useThreadState,
  type CompactState,
} from "./hooks";
import { useStrings } from "./i18n";
import { bannerView, contextView, headline, paceDetails, windowNote, windowView, type BannerView, type WindowView } from "./model";
import { shownPercent } from "../shared/limits-show";
import { RecentCompacts } from "./settings-section";
import { Bar, Ink, SegmentBar, Switch, Toned } from "./ui";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

function Status({ view, now }: { view: BannerView; now: number }) {
  const s = useStrings();
  switch (view.kind) {
    case "loading":
      return <span className="inline-block h-3 w-40 animate-pulse rounded bg-muted" aria-label={s.loading} />;
    case "error":
      return <Toned tone="red">{s.unavailable(view.message)}</Toned>;
    case "empty":
      return <span className="text-muted-foreground">{s.noDataYet}</span>;
    case "reasons":
      return <span className="text-muted-foreground">{view.text}</span>;
    case "limits": {
      const { primary } = view;
      const head = headline(s, primary.windows.map(windowView), now);
      const reason = statusText(s, primary.status, primary.message);
      return (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {head === null ? (
            <span className="text-muted-foreground">
              {providerName(s, primary.providerId)}
              {primary.planLabel ? ` · ${primary.planLabel}` : ""}
            </span>
          ) : (
            <span data-testid="headline">
              <Ink tone={head.tone} className="font-medium">
                {head.text}
              </Ink>
            </span>
          )}
          {reason === null ? null : <Toned tone="amber">{reason}</Toned>}
        </span>
      );
    }
  }
}

/** The switch and threshold act on this thread's override; turning it on past the threshold asks first. */
function AutoCompactControls({
  state,
  compact,
  onArm,
  onDisarm,
}: {
  state: ThreadState;
  compact: CompactState;
  onArm: (threshold: number) => void;
  onDisarm: () => void;
}) {
  const s = useStrings();
  const { set, pending, error } = useSetOverride(state.threadId);
  const mode = state.override.autoCompact;
  const enabled = mode === "inherit" ? state.autoCompact.enabled : mode === "on";
  const current = state.override.thresholdPercent ?? state.autoCompact.thresholdPercent;
  const [draft, setDraft] = useState(String(current));
  useEffect(() => setDraft(String(current)), [current]);
  // The thread's own limit survives a mode change.
  const keep = state.override.limitTokens === undefined ? {} : { limitTokens: state.override.limitTokens };

  const commit = () => {
    const parsed = parseThreshold(draft);
    if (parsed === null) return setDraft(String(current));
    if (parsed === current && mode === "on") return;
    set({ ...keep, autoCompact: "on", thresholdPercent: parsed });
    onArm(parsed);
  };

  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1.5">
        <Switch
          checked={enabled}
          label={s.autoCompact}
          disabled={pending}
          onChange={(on) => {
            if (on) {
              set({ ...keep, autoCompact: "on", thresholdPercent: current });
              onArm(current);
            } else {
              set({ ...keep, autoCompact: "off" });
              onDisarm();
            }
          }}
        />
        <span className="text-muted-foreground">{s.autoCompact}</span>
      </span>
      <span className="flex items-center gap-0.5">
        <Input
          aria-label={s.thresholdLabel}
          title={s.thresholdRange(THRESHOLD_MIN_PERCENT, THRESHOLD_MAX_PERCENT)}
          inputMode="numeric"
          className="h-6 w-10 px-1 text-center text-xs tabular-nums"
          value={draft}
          disabled={!enabled || pending}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        <span className="text-muted-foreground">%</span>
      </span>
      <CompactButton state={state} compact={compact} />
      {error === null ? null : <Toned tone="red">{error}</Toned>}
    </span>
  );
}

/** Hidden in a band narrower than 36rem. */
const NARROW_HIDDEN = "hidden shrink-0 @xl:inline";
/** A collapsed-row item: its content plus an equal share of the free space, so the bars grow alike. */
const ITEM_CLASS = "flex min-w-0 flex-auto items-center gap-1.5";
/** A collapsed-row bar: fills its item, hidden in a band narrower than 24rem. */
const BAR_FIT = "hidden min-w-3 flex-1 @sm:flex";

/** A window's bar as the `limitsShow` setting says: the used part, or the part left with the pace tick mirrored. */
function WindowBar({ view, className }: { view: WindowView; className?: string }) {
  const show = useLimitsShow();
  return (
    <Bar
      percent={shownPercent(show, view.window.usedPercent)}
      tone={view.tone}
      marker={view.marker === null ? null : shownPercent(show, view.marker)}
      className={className}
    />
  );
}

/** A window's percent, used or left as the setting says. */
function WindowPercent({ view, className }: { view: WindowView; className?: string }) {
  const show = useLimitsShow();
  return (
    <Ink tone={view.tone} className={className}>
      {formatPercent(shownPercent(show, view.window.usedPercent))}
    </Ink>
  );
}

function CollapsedRow({ provider, state, now }: { provider: ProviderLimits | null; state: ThreadState | undefined; now: number }) {
  const s = useStrings();
  const show = useLimitsShow();
  const ctx = state?.context ? contextView(state.context) : null;
  return (
    // One line at any width. The free space goes to the items in equal shares and their bars
    // stretch to fill it; when space runs out the bars shrink, the reset times and the
    // context size drop out below 36rem and the bars below 24rem (a phone).
    <div className="flex min-w-0 flex-nowrap items-center gap-x-4 overflow-hidden" data-testid="collapsed-row">
      {provider?.windows.map((w) => {
        const v = windowView(w);
        return (
          <span
            key={`${w.label}:${w.model ?? ""}`}
            className={ITEM_CLASS}
            data-window={w.label}
            title={
              show === "used"
                ? windowLabel(s, w.label, w.model)
                : `${windowLabel(s, w.label, w.model)} – ${s.percentLeft(formatPercent(shownPercent(show, w.usedPercent)))}`
            }
          >
            <span className="shrink-0 font-semibold">{shortWindowLabel(s, w.label, w.model)}</span>
            {w.resetsAt === null ? null : (
              <span className={`${NARROW_HIDDEN} text-muted-foreground tabular-nums`}>{formatSpan(s, Math.max(0, w.resetsAt - now))}</span>
            )}
            <WindowBar view={v} className={BAR_FIT} />
            <WindowPercent view={v} className="shrink-0 font-medium tabular-nums" />
          </span>
        );
      })}
      {ctx === null ? null : (
        <span className={ITEM_CLASS} data-window="context" title={s.contextTitle(ctx.limitTokens, ctx.windowTokens)}>
          <span className="shrink-0 font-semibold">{s.contextShort}</span>
          <span className={`${NARROW_HIDDEN} text-muted-foreground tabular-nums`}>
            {usedOfLimit(ctx.usedTokens, ctx.limitTokens, ctx.estimated)}
          </span>
          <SegmentBar view={ctx} className={BAR_FIT} />
          <Ink tone={ctx.tone} className="shrink-0 font-medium tabular-nums">
            {contextPercent(ctx.percent, ctx.estimated)}
          </Ink>
        </span>
      )}
    </div>
  );
}

function WindowList({ provider, now }: { provider: ProviderLimits; now: number }) {
  const s = useStrings();
  const show = useLimitsShow();
  return (
    <ul className="flex flex-col gap-2">
      {provider.windows.map((w) => {
        const v = windowView(w);
        return (
          <li key={`${w.label}:${w.model ?? ""}`} className="flex flex-col gap-0.5" data-window={w.label} title={paceDetails(s, w, show)}>
            <span className="flex items-center gap-2">
              <span className="w-20 shrink-0 font-semibold">{windowLabel(s, w.label, w.model)}</span>
              <WindowBar view={v} className="flex-1" />
              <WindowPercent view={v} className="w-9 text-right font-medium tabular-nums" />
            </span>
            <span className={v.status === "out" || v.status === "hit" ? "" : "text-muted-foreground"}>
              {v.status === "out" || v.status === "hit" ? (
                <Toned tone={v.tone}>{windowNote(s, v, now, show)}</Toned>
              ) : (
                windowNote(s, v, now, show)
              )}
              {w.cost ? <span className="text-muted-foreground"> · {formatCost(s, w.cost)}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ProviderHeader({ provider, now }: { provider: ProviderLimits; now: number }) {
  const s = useStrings();
  const reason = statusText(s, provider.status, provider.message);
  // Windows kept from an earlier answer while the latest poll failed.
  const keptFrom = provider.status === "ok" || provider.windows.length === 0 ? null : provider.measuredAt;
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-semibold">{providerName(s, provider.providerId)}</span>
      {provider.planLabel ? <span className="text-muted-foreground">{provider.planLabel}</span> : null}
      {reason === null ? null : <Toned tone="amber">{reason}</Toned>}
      {keptFrom === null ? null : <span className="text-muted-foreground">{s.dataFrom(formatClock(s, keptFrom, now))}</span>}
    </span>
  );
}

function ProviderBlock({ provider, now }: { provider: ProviderLimits; now: number }) {
  return (
    <section className="flex flex-col gap-1" data-provider={provider.providerId}>
      <ProviderHeader provider={provider} now={now} />
      {provider.windows.length === 0 ? null : <WindowList provider={provider} now={now} />}
    </section>
  );
}

/** A one-line row that opens its content on tap; closed by default. */
function Disclosure({ summary, children, ...rest }: { summary: ReactNode; children: ReactNode; "data-provider"?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-1" {...rest}>
      <button
        type="button"
        className="flex min-w-0 items-baseline gap-1.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden className="w-3 shrink-0 text-muted-foreground">
          {open ? "▾" : "▸"}
        </span>
        <span className="min-w-0">{summary}</span>
      </button>
      {open ? <div className="pl-4">{children}</div> : null}
    </section>
  );
}

/** Another provider: its name and each window's percent on one line, the full windows on tap. */
function OtherProvider({ provider, now }: { provider: ProviderLimits; now: number }) {
  const s = useStrings();
  const summary = (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <ProviderHeader provider={provider} now={now} />
      {provider.windows.map((w) => (
        <span key={`${w.label}:${w.model ?? ""}`} className="tabular-nums">
          <span className="text-muted-foreground">{shortWindowLabel(s, w.label, w.model)} </span>
          <WindowPercent view={windowView(w)} />
        </span>
      ))}
    </span>
  );
  if (provider.windows.length === 0) {
    return (
      <section data-provider={provider.providerId} className="pl-4">
        {summary}
      </section>
    );
  }
  return (
    <Disclosure summary={summary} data-provider={provider.providerId}>
      <WindowList provider={provider} now={now} />
    </Disclosure>
  );
}

export function Banner() {
  const s = useStrings();
  const threadId = useComposerThreadId();
  const snapshot = useSnapshot();
  const thread = useThreadState(threadId);
  const compact = useCompact(threadId);
  const [expanded, setExpanded] = useExpanded();
  const now = useNow();
  const [askAt, setAskAt] = useState<number | null>(null);
  if (threadId === null) return null;

  const state = thread.data;
  const view = bannerView(s, snapshot.data, snapshot.error?.message ?? null, state?.providerId ?? null);
  const primary = view.kind === "limits" ? view.primary : null;
  const ctx = state?.context ? contextView(state.context) : null;
  const asking = askAt !== null && ctx !== null && Math.round(ctx.percent) >= askAt;
  const data = snapshot.data;

  return (
    <div className="@container flex flex-col gap-2 px-3 py-1.5 text-xs" data-testid="usage-banner">
      {/* Narrower than 42rem (a phone): the headline and the toggle share the first row; the
          controls take the next one when expanded and are hidden when collapsed, so the
          collapsed band is two lines. Wider: all in one row, the controls wrapping first. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="order-1 min-w-0 flex-1 basis-0 @2xl:basis-[20rem]" data-testid="status">
          <Status view={view} now={now} />
        </span>
        {state === undefined ? null : (
          <div
            className={`order-3 w-full @2xl:order-2 @2xl:block @2xl:w-auto ${expanded ? "" : "hidden"}`}
            data-testid="controls"
          >
            <AutoCompactControls state={state} compact={compact} onArm={setAskAt} onDisarm={() => setAskAt(null)} />
          </div>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="order-2 h-6 w-6 shrink-0 px-0 text-xs @2xl:order-3"
          aria-label={expanded ? s.hideDetails : s.showDetails}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "▲" : "▼"}
        </Button>
      </div>

      {asking && ctx !== null && askAt !== null ? (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <Toned tone="amber">{s.askPast(contextPercent(ctx.percent, ctx.estimated), formatPercent(askAt))}</Toned>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            disabled={state?.active || compact.pending}
            onClick={() => {
              compact.compact();
              setAskAt(null);
            }}
          >
            {s.now}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setAskAt(null)}>
            {s.afterNextReply}
          </Button>
        </div>
      ) : null}

      {expanded ? null : <CollapsedRow provider={primary} state={state} now={now} />}

      {expanded ? (
        <div
          className="flex max-h-[45dvh] flex-col gap-3 overflow-y-auto overscroll-contain border-t pt-2"
          data-testid="banner-details"
        >
          <div className="flex flex-wrap gap-4">
            {primary === null ? null : (
              <div className="min-w-[14rem] flex-1">
                <ProviderBlock provider={primary} now={now} />
              </div>
            )}
            {state === undefined ? null : (
              <div className="min-w-[14rem] flex-1">
                <ContextPanel state={state} />
              </div>
            )}
          </div>
          {view.kind === "limits" && view.others.length > 0 ? (
            <div className="flex flex-col gap-1">
              {view.others.map((p) => (
                <OtherProvider key={p.providerId} provider={p} now={now} />
              ))}
            </div>
          ) : null}
          {data?.pollError && view.kind !== "error" ? <Toned tone="amber">{s.pollFailed(data.pollError)}</Toned> : null}
          {data === undefined || data.recentCompactions.length === 0 ? null : (
            <Disclosure summary={<span className="font-medium">{s.recentCompactsCount(data.recentCompactions.length)}</span>}>
              <RecentCompacts entries={data.recentCompactions} now={now} heading={false} />
            </Disclosure>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">
              {data?.polledAt == null ? null : s.updated(formatAgo(s, data.polledAt, now))}
            </span>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setExpanded(false)}>
              ▲ {s.collapse}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
