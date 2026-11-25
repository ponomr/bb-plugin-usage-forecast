// Composer band of a thread, after the band of claude-code-usage-quota-mod
// (see NOTICE). The header has the headline, the auto-compact switch with the
// threshold it acts at and the compact button; the collapsed row has a bar per limit
// window and the context bar; the expanded view has each window with its pace
// note, the context breakdown and the other providers. On a phone the
// expanded part scrolls inside a capped height, so the header with the
// collapse button never leaves the screen.

import { useEffect, useState, type ReactNode } from "react";
import type { ProviderLimits, ThreadState } from "../shared/contract";
import { planText } from "../shared/plan";
import { formatPercent } from "../shared/thresholds";
import { CompactButton, ContextPanel } from "./context-row";
import {
  contextPercent,
  formatClock,
  formatCost,
  limitPercent,
  formatResetAt,
  formatSpan,
  formatTokens,
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
  useHiddenProviders,
  useHideProvider,
  useNow,
  useSetOverride,
  useSnapshot,
  useThreadState,
  useTokens,
  type CompactState,
  useBandShown,
  useStrings,
} from "./hooks";
import {
  bannerView,
  bandAlert,
  contextView,
  headline,
  paceDetails,
  threadHost,
  windowBudget,
  windowNote,
  windowView,
  type BannerView,
  type WindowView,
} from "./model";
import { formatTokenCount, type TokenPair } from "../shared/tokens";
import { RecentCompacts } from "./settings-section";
import { CardActions } from "./card-actions";
import { Bar, Ink, SegmentBar, Switch, Toned } from "./ui";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";

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
      const head = headline(s, primary.windows.map((w) => windowView(w, now)), now);
      const reason = statusText(s, primary.status, primary.message);
      const plan = planText(primary.planLabel, primary.planMultiplier);
      return (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {head === null ? (
            <span className="text-muted-foreground">
              {providerName(s, primary.providerId)}
              {plan === null ? "" : ` · ${plan}`}
            </span>
          ) : (
            <span data-testid="headline">
              <Ink tone={head.tone} className="font-medium">
                {head.text}
              </Ink>
            </span>
          )}
          {reason === null ? null : <Toned tone="amber">{reason}</Toned>}
          {view.staleSince === null ? null : (
            <span data-testid="stale">
              <Toned tone="amber">{s.hostStale(formatClock(s, view.staleSince, now))}</Toned>
            </span>
          )}
        </span>
      );
    }
  }
}

/**
 * The switch acts on this thread's override at the thread's current threshold; turning it on past
 * the threshold asks first. The threshold itself is set in the plugin settings, or for one thread
 * in the context card, so a number typed here cannot silently become a thread override.
 */
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
  // The thread's own limit survives a mode change.
  const keep = state.override.limitTokens === undefined ? {} : { limitTokens: state.override.limitTokens };

  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1.5" title={s.autoCompactHint}>
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
        <span className="text-muted-foreground" data-testid="auto-compact-at">
          {s.autoCompactAt(formatPercent(state.autoCompact.effectiveThresholdPercent))}
        </span>
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

/** A window's bar: the part left or used, the forecast tick and the even-pace tick, mirrored with it. */
export function WindowBar({ view, className }: { view: WindowView; className?: string }) {
  const s = useStrings();
  const at = (p: number | null) => (p === null ? null : limitPercent(s, p));
  return <Bar percent={limitPercent(s, view.window.usedPercent)} tone={view.tone} marker={at(view.marker)} even={at(view.even)} className={className} />;
}

/** A window's percent left or used, in its tone. */
export function WindowPercent({ view, className }: { view: WindowView; className?: string }) {
  const s = useStrings();
  return (
    <Ink tone={view.tone} className={className}>
      {formatPercent(limitPercent(s, view.window.usedPercent))}
    </Ink>
  );
}

/**
 * A window's reset on its own: in a row the time left ("4h 12m"), in a card
 * (`exact`) the local time ("Sat 19:59"); the tooltip has the other form.
 */
export function ResetTime({ resetsAt, now, exact = false, className = NARROW_HIDDEN }: { resetsAt: number; now: number; exact?: boolean; className?: string }) {
  const s = useStrings();
  const span = formatSpan(s, Math.max(0, resetsAt - now));
  // A reset that has passed has no time to name: both forms show the countdown's "<1m".
  const at = resetsAt > now ? formatResetAt(s, resetsAt, now) : span;
  return (
    <span className={cn(className, "text-muted-foreground tabular-nums")} title={exact ? span : at}>
      {exact ? at : span}
    </span>
  );
}

function CollapsedRow({ provider, state, now }: { provider: ProviderLimits | null; state: ThreadState | undefined; now: number }) {
  const s = useStrings();
  const ctx = state?.context ? contextView(state.context) : null;
  return (
    // One line at any width. The free space goes to the items in equal shares and their bars
    // stretch to fill it; when space runs out the bars shrink, the reset times and the
    // context size drop out below 36rem and the bars below 24rem (a phone).
    <div className="flex min-w-0 flex-nowrap items-center gap-x-4 overflow-hidden" data-testid="collapsed-row">
      {provider?.windows.map((w) => {
        const v = windowView(w, now);
        return (
          <span
            key={`${w.label}:${w.model ?? ""}`}
            className={ITEM_CLASS}
            data-window={w.label}
            title={windowLabel(s, w.label, w.model)}
          >
            <span className="shrink-0 font-semibold">{shortWindowLabel(s, w.label, w.model)}</span>
            {w.resetsAt === null ? null : <ResetTime resetsAt={w.resetsAt} now={now} />}
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

/** A note in the window's colour: one with a pace state that is not calm. Others stay muted. */
const paceToned = (v: WindowView) => v.pace !== null && v.tone !== "normal";

function WindowList({ provider, now }: { provider: ProviderLimits; now: number }) {
  const s = useStrings();
  return (
    <ul className="flex flex-col gap-2">
      {provider.windows.map((w) => {
        const v = windowView(w, now);
        const budget = windowBudget(s, v, now);
        const note = windowNote(s, v, now);
        return (
          <li key={`${w.label}:${w.model ?? ""}`} className="flex flex-col gap-0.5" data-window={w.label} title={paceDetails(s, w)}>
            <span className="flex items-center gap-2">
              <span className="w-20 shrink-0 font-semibold">{windowLabel(s, w.label, w.model)}</span>
              <WindowBar view={v} className="flex-1" />
              <WindowPercent view={v} className="w-9 text-right font-medium tabular-nums" />
            </span>
            <span className={paceToned(v) ? "" : "text-muted-foreground"}>
              {paceToned(v) ? <Toned tone={v.tone}>{note}</Toned> : note}
              {w.cost ? <span className="text-muted-foreground"> · {formatCost(s, w.cost)}</span> : null}
            </span>
            {budget === null ? null : (
              <span className="text-muted-foreground" data-testid="window-budget">
                {budget}
              </span>
            )}
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
  const plan = planText(provider.planLabel, provider.planMultiplier);
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-semibold">{providerName(s, provider.providerId)}</span>
      {plan === null ? null : <span className="text-muted-foreground">{plan}</span>}
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
  const s = useStrings();
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-1" {...rest}>
      <button
        type="button"
        className="flex min-w-0 items-baseline gap-1.5 text-left"
        aria-expanded={open}
        title={open ? s.hideDetails : s.showDetails}
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
/** `canHide` is false for the thread's own provider, which the band always shows. */
function OtherProvider({ provider, now, canHide }: { provider: ProviderLimits; now: number; canHide: boolean }) {
  const s = useStrings();
  const summary = (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <ProviderHeader provider={provider} now={now} />
      {provider.windows.map((w) => (
        <span key={`${w.label}:${w.model ?? ""}`} className="tabular-nums">
          <span className="text-muted-foreground">{shortWindowLabel(s, w.label, w.model)} </span>
          <WindowPercent view={windowView(w, now)} />
        </span>
      ))}
    </span>
  );
  const hide = canHide ? <HideButton providerId={provider.providerId} /> : null;
  if (provider.windows.length === 0) {
    // Nothing to open: the button sits on the line, outside any other button.
    return (
      <section data-provider={provider.providerId} className="flex flex-wrap items-baseline gap-x-2 pl-4">
        {summary}
        {hide}
      </section>
    );
  }
  return (
    <Disclosure summary={summary} data-provider={provider.providerId}>
      <WindowList provider={provider} now={now} />
      {hide}
    </Disclosure>
  );
}

/** Hides another provider here, in the sidebar sign and in pushes (the `hiddenProviders` setting). */
function HideButton({ providerId }: { providerId: string }) {
  const s = useStrings();
  const hideProvider = useHideProvider();
  return (
    <button
      type="button"
      className="self-start text-muted-foreground underline-offset-2 hover:underline"
      aria-label={s.hideProviderLabel(providerName(s, providerId))}
      title={s.hideProviderLabel(providerName(s, providerId))}
      data-testid="hide-provider"
      onClick={() => hideProvider(providerId)}
    >
      {s.hideProvider}
    </button>
  );
}

const fullPair = (p: TokenPair) => `${formatTokens(p.work)} (${formatTokens(p.all)})`;

/**
 * UF-12 R8: "Tokens: thread 86k · today 310k · month 4.2M". "today" and
 * "month" are the thread's provider across its BB threads. No line without
 * data, and none while the query loads or after it failed.
 */
function TokensLine({ threadId, providerId }: { threadId: string; providerId: string | null }) {
  const s = useStrings();
  const data = useTokens(threadId).data;
  if (data === undefined) return null;
  const sums = providerId === null ? undefined : data.providers.find((p) => p.providerId === providerId);
  if (data.thread === null && sums === undefined) return null;
  const short = (p: TokenPair | undefined) => (p === undefined ? null : formatTokenCount(p.work, s.lang));
  const full = (p: TokenPair | undefined) => (p === undefined ? null : fullPair(p));
  const thread = data.thread ?? undefined;
  return (
    <span className="text-muted-foreground" data-testid="tokens-line" title={s.tokensTitle(full(thread), full(sums?.today), full(sums?.month))}>
      {s.tokensLine(short(thread), short(sums?.today), short(sums?.month))}
    </span>
  );
}

/** The band, unless the `showBand` setting is off. */
export function Banner() {
  return useBandShown() ? <Band /> : null;
}

function Band() {
  const s = useStrings();
  const threadId = useComposerThreadId();
  const snapshot = useSnapshot();
  const thread = useThreadState(threadId);
  const compact = useCompact(threadId);
  const [expanded, setExpanded] = useExpanded();
  const now = useNow();
  const hidden = useHiddenProviders();
  const [askAt, setAskAt] = useState<number | null>(null);
  if (threadId === null) return null;

  const state = thread.data;
  const view = bannerView(s, snapshot.data, snapshot.error?.message ?? null, state, now, hidden);
  const host = snapshot.data === undefined ? null : threadHost(snapshot.data.hosts, state?.hostId);
  const ownHost = host === null || typeof host === "string" ? null : host;
  const primary = view.kind === "limits" ? view.primary : null;
  const ctx = state?.context ? contextView(state.context) : null;
  const asking = askAt !== null && ctx !== null && Math.round(ctx.percent) >= askAt;
  const data = snapshot.data;
  // C2: while all is calm and the details are closed, the band is the one row of windows.
  const alert = bandAlert(view, ctx?.tone ?? null, now);
  // Stale data (P4) or a provider error (an expired sign-in) keeps the full band, so its note stays in view.
  const calm =
    !expanded &&
    !alert &&
    view.kind === "limits" &&
    view.staleSince === null &&
    statusText(s, view.primary.status, view.primary.message) === null;
  const askRow =
    asking && ctx !== null && askAt !== null ? (
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
    ) : null;
  const toggle = (
    // The vendored Button takes no title: the tooltip sits on a wrapper.
    <span className="order-2 inline-flex shrink-0 @2xl:order-3" title={expanded ? s.hideDetails : s.showDetails}>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 px-0 text-xs"
        aria-label={expanded ? s.hideDetails : s.showDetails}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "▲" : "▼"}
      </Button>
    </span>
  );

  if (calm) {
    return (
      <div className="@container flex flex-col gap-2 px-3 py-1.5 text-xs" data-testid="usage-banner" data-band="calm">
        <div className="flex min-w-0 items-center gap-x-3">
          <div className="min-w-0 flex-1">
            <CollapsedRow provider={primary} state={state} now={now} />
          </div>
          {toggle}
        </div>
        {askRow}
      </div>
    );
  }

  return (
    <div className="@container flex flex-col gap-2 px-3 py-1.5 text-xs" data-testid="usage-banner" data-band={expanded ? "expanded" : alert ? "alert" : "full"}>
      {/* Narrower than 42rem (a phone): the headline and the toggle share the first row; the
          controls take the next one when expanded and are hidden when collapsed, so the
          collapsed band is two lines. Wider: all in one row, the controls wrapping first. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="order-1 min-w-0 flex-1 basis-0 @2xl:basis-[20rem]" data-testid="status">
          <Status view={view} now={now} />
        </span>
        {state === undefined ? null : (
          <div
            // On an alert Compact is in view at any width.
            className={`order-3 w-full @2xl:order-2 @2xl:block @2xl:w-auto ${expanded || alert ? "" : "hidden"}`}
            data-testid="controls"
          >
            <AutoCompactControls state={state} compact={compact} onArm={setAskAt} onDisarm={() => setAskAt(null)} />
          </div>
        )}
        {toggle}
      </div>

      {askRow}

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
                <OtherProvider key={p.providerId} provider={p} now={now} canHide={p.providerId !== (state?.providerId ?? null)} />
              ))}
            </div>
          ) : null}
          <TokensLine threadId={threadId} providerId={state?.providerId ?? null} />
          {ownHost?.pollError && view.kind !== "error" ? <Toned tone="amber">{s.pollFailed(ownHost.pollError)}</Toned> : null}
          {data === undefined || data.recentCompactions.length === 0 ? null : (
            <Disclosure summary={<span className="font-medium">{s.recentCompactsCount(data.recentCompactions.length)}</span>}>
              <RecentCompacts entries={data.recentCompactions} now={now} heading={false} />
            </Disclosure>
          )}
          <CardActions polledAt={ownHost?.polledAt ?? null} now={now}>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setExpanded(false)}>
              ▲ {s.collapse}
            </Button>
          </CardActions>
        </div>
      ) : null}
    </div>
  );
}
