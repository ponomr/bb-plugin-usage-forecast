// The thread's context: the segmented bar with its breakdown, the compact
// button and the per-thread auto-compact override. The band shows the panel in
// its expanded view; the thread context card (Mac) adds the full override.

import { useEffect, useState } from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";
import {
  THRESHOLD_DEFAULT_PERCENT,
  THRESHOLD_MAX_PERCENT,
  THRESHOLD_MIN_PERCENT,
  type ThreadOverride,
  type ThreadState,
} from "../shared/contract";
import { formatPercent } from "../shared/thresholds";
import { formatSpan, formatTokens, shortTokens } from "./format";
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

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2">
        <span>{s.threadAutoCompact}</span>
        <select
          aria-label={s.threadAutoCompact}
          className="rounded border border-input bg-transparent px-1 py-0.5"
          value={mode}
          disabled={pending}
          onChange={(e) => set({ autoCompact: e.target.value as ThreadOverride["autoCompact"] })}
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
            if (parsed !== null) set({ autoCompact: "on", thresholdPercent: parsed });
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
  const paused = state.cooldownUntil !== null && state.cooldownUntil > now ? formatSpan(s, state.cooldownUntil - now) : null;
  return s.autoOn(formatPercent(a.thresholdPercent), actsAt, forThread, paused);
}

/** The context bar, fill, free space and breakdown, then the compact notes. */
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
                {s.contextUsed(formatPercent(view.percent))}
              </Ink>
            </span>
            <span
              className="text-muted-foreground tabular-nums"
              title={`${ctx.estimated ? "≈" : ""}${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.windowTokens)}`}
            >
              {s.freeOf(shortTokens(view.freeTokens), shortTokens(view.windowTokens))}
            </span>
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
          {ctx.autoCompactAtTokens ? (
            <div className="text-muted-foreground">
              {s.providerCompactsAt(formatPercent((ctx.autoCompactAtTokens / ctx.windowTokens) * 100))}
            </div>
          ) : null}
        </>
      )}
      {state.compactSupported ? null : <div className="text-muted-foreground">{s.compactUnsupported}</div>}
      <div className="text-muted-foreground">{autoCompactLine(s, state, now)}</div>
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
