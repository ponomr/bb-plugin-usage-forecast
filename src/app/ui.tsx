// Small pieces of the band: toned text, the limit bar with its pace marker,
// the segmented context bar and the auto-compact switch. Colours follow the
// band of claude-code-usage-quota-mod, in light and dark themes.

import type { Tone } from "../shared/thresholds";
import type { ContextView, SegmentKey } from "./model";
import { cn } from "../../lib/utils";

/** Warnings and errors: plain text in normal tone. */
const TONE_CLASS: Record<Tone, string> = {
  normal: "",
  amber: "text-[#ea8a0c] dark:text-[#fbbf24]",
  red: "text-[#ef4444] dark:text-[#f87171]",
};

/** Percent figures and the headline: green in normal tone. */
const INK_CLASS: Record<Tone, string> = {
  normal: "text-[#16a34a] dark:text-[#4ade80]",
  amber: TONE_CLASS.amber,
  red: TONE_CLASS.red,
};

const FILL_CLASS: Record<Tone, string> = {
  normal: "bg-[#22b856] dark:bg-[#4ade80]",
  amber: "bg-[#ea8a0c] dark:bg-[#fbbf24]",
  red: "bg-[#ef4444] dark:bg-[#f87171]",
};

const SEGMENT_CLASS: Record<Exclude<SegmentKey, "used">, string> = {
  messages: "bg-[#0ea5e9] dark:bg-[#22d3ee]",
  tools: "bg-[#8b5cf6] dark:bg-[#a78bfa]",
  other: "bg-muted-foreground/60",
};

const BUFFER_CLASS = "bg-[#b9bec9] dark:bg-[#4b5163]";

const TRACK_CLASS = "relative flex h-[7px] overflow-hidden rounded-full bg-foreground/10";

type Children = { tone: Tone; className?: string; children: React.ReactNode };

export function Toned({ tone, className, children }: Children) {
  return (
    <span data-tone={tone} className={cn(TONE_CLASS[tone], className)}>
      {children}
    </span>
  );
}

export function Ink({ tone, className, children }: Children) {
  return (
    <span data-tone={tone} className={cn(INK_CLASS[tone], className)}>
      {children}
    </span>
  );
}

const clampPercent = (p: number) => Math.max(0, Math.min(100, p));

/** A limit bar; the grey tick marks where the window is on pace to be at the reset. */
export function Bar({
  percent,
  tone,
  marker = null,
  className,
}: {
  percent: number;
  tone: Tone;
  marker?: number | null;
  className?: string;
}) {
  return (
    <span className={cn(TRACK_CLASS, className)} aria-hidden>
      <span className={cn("h-full rounded-full", FILL_CLASS[tone])} style={{ width: `${clampPercent(percent)}%` }} />
      {marker === null ? null : (
        <span
          data-marker={Math.round(marker)}
          className="absolute inset-y-0 w-[3px] bg-muted-foreground"
          style={{ left: `clamp(0px, calc(${clampPercent(marker)}% - 1.5px), calc(100% - 3px))` }}
        />
      )}
    </span>
  );
}

/** The context bar: used parts from the left, Claude Code's reserved buffer at the right end. */
export function SegmentBar({ view, className }: { view: ContextView; className?: string }) {
  const width = (tokens: number) => `${clampPercent((tokens / Math.max(1, view.windowTokens)) * 100)}%`;
  return (
    <span className={cn(TRACK_CLASS, "gap-px", className)} aria-hidden>
      {view.segments.map((seg) => (
        <span
          key={seg.key}
          data-segment={seg.key}
          className={cn("h-full", seg.key === "used" ? FILL_CLASS[view.tone] : SEGMENT_CLASS[seg.key])}
          style={{ width: width(seg.tokens) }}
        />
      ))}
      <span className="flex-1" />
      {view.bufferTokens > 0 ? (
        <span data-segment="buffer" className={cn("h-full", BUFFER_CLASS)} style={{ width: width(view.bufferTokens) }} />
      ) : null}
    </span>
  );
}

/** The colour swatch of a context category in the breakdown list. */
export function Swatch({ segment }: { segment: Exclude<SegmentKey, "used"> }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-sm", SEGMENT_CLASS[segment])} aria-hidden />;
}

export function Switch({
  checked,
  label,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
        checked ? "bg-[#22c55e] dark:bg-[#4ade80]" : "bg-[#b4b9c4] dark:bg-[#4b5163]",
      )}
    >
      <span
        className={cn(
          "inline-block size-3 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-3.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}
