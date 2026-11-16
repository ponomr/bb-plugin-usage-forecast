// The sidebar-footer icon: a ring filled to the used percent of the worst
// window, in its tone. It renders outside the plugin slot, so it reads the
// store that `IndicatorFeeder` fills, never SDK hooks.

import { cn } from "../../lib/utils";
import { useIndicatorState } from "./indicator-store";
import type { WorstWindow } from "./indicator";
import { INK_CLASS } from "./ui";

export const RING_ICON = "usage-forecast/ring";

export function Ring({
  worst,
  title,
  className,
}: {
  worst: Pick<WorstWindow, "usedPercent" | "tone"> | null;
  title: string;
  className?: string;
}) {
  const percent = worst === null ? 0 : Math.max(0, Math.min(100, worst.usedPercent));
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-4", className)} data-empty={worst === null || undefined}>
      <title>{title}</title>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      {worst === null ? null : (
        <circle
          data-arc={percent}
          data-tone={worst.tone}
          className={INK_CLASS[worst.tone]}
          cx="8"
          cy="8"
          r="6"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap={percent > 0 && percent < 100 ? "round" : "butt"}
          pathLength={100}
          strokeDasharray={`${percent} 100`}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  );
}

/** The registered icon component. */
export function RingIcon({ className }: { className?: string }) {
  const { worst, title, hidden } = useIndicatorState();
  if (hidden) return null;
  return <Ring worst={worst} title={title} className={className} />;
}
