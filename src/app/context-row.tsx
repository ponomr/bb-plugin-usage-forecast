// The thread's context: the segmented bar with its breakdown, the compact
// button and the per-thread auto-compact override. The band shows the panel in
// its expanded view; the thread context card (Mac) adds the full override.

import { useEffect, useState } from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";
import {
  CONTEXT_LIMIT_MAX_TOKENS,
  CONTEXT_LIMIT_MIN_TOKENS,
  THRESHOLD_DEFAULT_PERCENT,
  THRESHOLD_MAX_PERCENT,
  THRESHOLD_MIN_PERCENT,
  normalizeOverride,
  type ThreadOverride,
  type ThreadState,
} from "../shared/contract";
import { formatPercent } from "../shared/thresholds";
import { contextPercent, formatSpan, formatTokens, providerName, shortTokens } from "./format";
import { useCompact, useNow, useSetOverride, useThreadState, type CompactState } from "./hooks";
import { useStrings, type Strings } from "./i18n";
import { contextView } from "./model";
import { Ink, SegmentBar, Swatch, Toned } from "./ui";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

/** Hidden until the thread state is known and when the provider cannot compact. */
export function CompactButton({ state, compact }: { state: ThreadState | undefined; compact: CompactState }) {
  const s = useStrings();
  if (state === undefined || !state.compactSupported) return null;
  return (
    <span className="inline-flex items-center gap-2" title={state.active ? s.compactBusyTitle : s.compactTitle}>
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-xs"
        disabled={state.active || compact.pending}
        onClick={compact.compact}
      >
        {compact.pending ? s.compacting : s.compact}
      </Button>
      {compact.error === null ? null : (
        <Toned tone="red" className="text-xs">
          {compact.error}
        </Toned>
      )}
    </span>
  );
}

export function parseThreshold(text: string): number | null {
  if (!/^\d{1,3}$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= THRESHOLD_MIN_PERCENT && n <= THRESHOLD_MAX_PERCENT ? n : null;
}

/**
 * A per-thread limit typed in thousands of tokens: "" means the settings'
 * limit (undefined), a number in range means that many thousand tokens, and
 * anything else is invalid (null).
 */
export function parseLimit(text: string): number | undefined | null {
  const t = text.trim();
  if (t === "") return undefined;
  if (!/^\d{1,4}$/.test(t)) return null;
  const tokens = Number(t) * 1000;
  return tokens >= CONTEXT_LIMIT_MIN_TOKENS && tokens <= CONTEXT_LIMIT_MAX_TOKENS ? tokens : null;
}

/** The thread's working limit in thousands of tokens; blank returns to the settings. */
function LimitControl({ state }: { state: ThreadState }) {
  const s = useStrings();
  const { set, pending, error } = useSetOverride(state.threadId);
  const current = state.override.limitTokens === undefined ? "" : String(Math.round(state.override.limitTokens / 1000));
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const parsed = parseLimit(draft);
  const commit = () => {
    if (parsed === null) return setDraft(current);
    if (draft.trim() === current) return;
    const { limitTokens: _dropped, ...rest } = state.override;
    set(normalizeOverride(parsed === undefined ? rest : { ...rest, limitTokens: parsed }));
  };
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground">{s.limitLabel}</span>
      <Input
        aria-label={s.limitLabel}
        title={s.limitRange(CONTEXT_LIMIT_MIN_TOKENS / 1000, CONTEXT_LIMIT_MAX_TOKENS / 1000)}
        placeholder={s.mode.inherit}
        inputMode="numeric"
        className="h-6 w-20 px-1 text-xs tabular-nums"
        value={draft}
        disabled={pending}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <span className="text-muted-foreground">k</span>
      {parsed === null ? (
        <Toned tone="amber">{s.limitRange(CONTEXT_LIMIT_MIN_TOKENS / 1000, CONTEXT_LIMIT_MAX_TOKENS / 1000)}</Toned>
      ) : null}
      {error === null ? null : <Toned tone="red">{error}</Toned>}
    </span>
  );
}

const MODES: readonly ThreadOverride["autoCompact"][] = ["inherit", "off", "on"];

function OverrideControl({ state }: { state: ThreadState }) {
  const s = useStrings();
  const settings = useSettings();
  const { set, pending, error } = useSetOverride(state.threadId);
  const globalThreshold = Number(settings.values?.autoCompactThresholdPercent ?? THRESHOLD_DEFAULT_PERCENT);
  const current = state.override.thresholdPercent ?? globalThreshold;
  const [draft, setDraft] = useState(String(current));
  useEffect(() => setDraft(String(current)), [current]);
  const parsed = parseThreshold(draft);
  const mode = state.override.autoCompact;
  // The thread's own limit survives a mode change.
  const keep = state.override.limitTokens === undefined ? {} : { limitTokens: state.override.limitTokens };

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2">
        <span>{s.threadAutoCompact}</span>
        <select
          aria-label={s.threadAutoCompact}
          className="rounded border border-input bg-transparent px-1 py-0.5"
          value={mode}
          disabled={pending}
          onChange={(e) => set({ ...keep, autoCompact: e.target.value as ThreadOverride["autoCompact"] })}
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {s.mode[m]}
            </option>
          ))}
        </select>
      </label>
      {mode === "on" ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (parsed !== null) set({ ...keep, autoCompact: "on", thresholdPercent: parsed });
          }}
        >
          <span>{s.thresholdShort}</span>
          <Input
            aria-label={s.thresholdLabel}
            inputMode="numeric"
            className="h-6 w-16 px-1 text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={parsed === null || pending}>
            {s.apply}
          </Button>
        </form>
      ) : null}
      {mode === "on" && parsed === null ? (
        <Toned tone="amber">{s.thresholdRange(THRESHOLD_MIN_PERCENT, THRESHOLD_MAX_PERCENT)}</Toned>
      ) : null}
      {error === null ? null : <Toned tone="red">{error}</Toned>}
    </div>
  );
}

export function autoCompactLine(s: Strings, state: ThreadState, now: number): string {
  const a = state.autoCompact;
  const forThread = a.source === "thread";
  if (!a.enabled) return s.autoOff(forThread);
  const actsAt = a.effectiveThresholdPercent === a.thresholdPercent ? null : formatPercent(a.effectiveThresholdPercent);
  const atTokens = a.effectiveThresholdTokens === null ? null : shortTokens(a.effectiveThresholdTokens);
  const paused = state.cooldownUntil !== null && state.cooldownUntil > now ? formatSpan(s, state.cooldownUntil - now) : null;
  return s.autoOn(formatPercent(a.thresholdPercent), actsAt, atTokens, forThread, paused);
}

/** The context bar, fill, free space and breakdown, the limit, then the compact notes. */
export function ContextPanel({ state }: { state: ThreadState }) {
  const s = useStrings();
  const now = useNow();
  const ctx = state.context;
  const view = ctx === null ? null : contextView(ctx);
  return (
    <div className="flex flex-col gap-1.5" data-testid="context-details">
      {ctx === null || view === null ? (
        <span className="text-muted-foreground">
          {s.context}: {s.notMeasured}
        </span>
      ) : (
        <>
          <SegmentBar view={view} />
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span>
              <span className="font-medium">{s.context}</span>{" "}
              <Ink tone={view.tone} className="font-medium tabular-nums">
                {s.contextUsed(contextPercent(view.percent, view.estimated))}
              </Ink>
            </span>
            <span
              className="text-muted-foreground tabular-nums"
              title={`${ctx.estimated ? "~" : ""}${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.limitTokens)}`}
            >
              {s.freeOf(shortTokens(view.freeTokens), shortTokens(view.limitTokens))}
            </span>
          </div>
          <div className="text-muted-foreground" data-testid="context-limit">
            {s.limitLine(
              shortTokens(ctx.limitTokens),
              ctx.limitSource,
              providerName(s, state.providerId),
              ctx.limitTokens < ctx.windowTokens ? shortTokens(ctx.windowTokens) : null,
            )}
          </div>
          {view.segments[0]?.key === "used" ? null : (
            <ul className="flex flex-col gap-0.5" aria-label={s.contextBreakdown}>
              {view.segments.map((seg) =>
                seg.key === "used" ? null : (
                  <li key={seg.key} className="flex items-center gap-1.5">
                    <Swatch segment={seg.key} />
                    <span className="flex-1">{s.categories[seg.key]}</span>
                    <span className="text-muted-foreground tabular-nums">{shortTokens(seg.tokens)}</span>
                  </li>
                ),
              )}
            </ul>
          )}
          {ctx.autoCompactAtTokens && ctx.limitSource !== "reported" ? (
            <div className="text-muted-foreground">
              {s.providerCompactsAt(shortTokens(ctx.autoCompactAtTokens), formatPercent((ctx.autoCompactAtTokens / ctx.windowTokens) * 100))}
            </div>
          ) : null}
        </>
      )}
      {state.compactSupported ? null : <div className="text-muted-foreground">{s.compactUnsupported}</div>}
      <div className="text-muted-foreground">{autoCompactLine(s, state, now)}</div>
      <LimitControl state={state} />
    </div>
  );
}

/** The thread context card section (Mac). Renders nothing until the state loads. */
export function ContextCardSection({ threadId }: { threadId: string }) {
  const thread = useThreadState(threadId);
  const compact = useCompact(threadId);
  if (thread.data === undefined) {
    return thread.error === null ? null : (
      <Toned tone="red" className="text-xs">
        {thread.error.message}
      </Toned>
    );
  }
  return (
    <div className="flex flex-col gap-2 text-xs">
      <ContextPanel state={thread.data} />
      <div>
        <CompactButton state={thread.data} compact={compact} />
      </div>
      <OverrideControl state={thread.data} />
    </div>
  );
}
