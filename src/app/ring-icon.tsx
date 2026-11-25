// The sidebar-footer icon, by the `sidebarShow` setting: two concentric
// rings (the 5-hour window outside, the weekly one inside) or one ring for
// the worst window with the even-pace tick. Each arc is filled to the used
// percent in the window's tone. It renders outside the plugin slot, so it
// reads the store that `IndicatorFeeder` fills, never SDK hooks.

import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "../../lib/utils";
import type { Tone } from "../shared/thresholds";
import { useIndicatorState } from "./indicator-store";

export const RING_ICON = "usage-forecast/ring";

/** One window as a ring draws it. */
export interface RingWindow {
  usedPercent: number;
  tone: Tone;
}

/** The drawn size in the footer's 28 px button; the host's 16 px wrapper is left by negative margins. */
export const FOOTER_RING_PX = 26;

const VIEW = 26;
const C = VIEW / 2;

/**
 * The tones as colours, light and dark, matching INK_CLASS in ui.tsx. The icon
 * renders outside the plugin's slot, where the plugin's scoped CSS (and so its
 * tone classes) does not reach, so the arcs carry the colour inline.
 */
const TONE_COLOR: Record<Tone, [light: string, dark: string] | null> = {
  muted: null,
  normal: ["#16a34a", "#4ade80"],
  amber: ["#ea8a0c", "#fbbf24"],
  red: ["#ef4444", "#f87171"],
};

function subscribeTheme(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  return () => observer.disconnect();
}

/** True while bb's theme is dark (the `dark` class on the root, as Tailwind's `dark:` reads it). */
function useDark(): boolean {
  return useSyncExternalStore(
    subscribeTheme,
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
    () => false,
  );
}

const clamp = (p: number) => Math.max(0, Math.min(100, p));

/** The faint track; dashed without data (P4), so it does not read as a calm, empty window. */
function Track({ r, width, empty }: { r: number; width: number; empty: boolean }) {
  return (
    <circle
      cx={C}
      cy={C}
      r={r}
      stroke="currentColor"
      strokeWidth={width}
      opacity={empty ? 0.5 : 0.2}
      strokeDasharray={empty ? "2.5 2.5" : undefined}
    />
  );
}

function Arc({ r, width, w, ring }: { r: number; width: number; w: RingWindow; ring?: string }) {
  const percent = clamp(w.usedPercent);
  const dark = useDark();
  const color = TONE_COLOR[w.tone];
  return (
    <circle
      data-arc={Math.round(percent)}
      data-ring={ring}
      data-tone={w.tone}
      style={color === null ? { opacity: 0.6 } : { color: color[dark ? 1 : 0] }}
      cx={C}
      cy={C}
      r={r}
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap={percent > 0 && percent < 100 ? "round" : "butt"}
      pathLength={100}
      strokeDasharray={`${percent} 100`}
      transform={`rotate(-90 ${C} ${C})`}
    />
  );
}

/** C5: one ring for the worst window, with a tick where an even pace would be now. */
export function Ring({
  worst,
  even = null,
  title,
  className,
  style,
  svgRef,
}: {
  worst: RingWindow | null;
  even?: number | null;
  title: string;
  className?: string;
  style?: React.CSSProperties;
  svgRef?: React.Ref<SVGSVGElement>;
}) {
  const r = 10.5;
  const width = 3;
  const angle = even === null ? null : ((clamp(even) / 100) * 360 - 90) * (Math.PI / 180);
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      fill="none"
      className={cn("size-4", className)}
      style={style}
      data-style="ring"
      data-empty={worst === null || undefined}
    >
      <title>{title}</title>
      <Track r={r} width={width} empty={worst === null} />
      {worst === null ? null : <Arc r={r} width={width} w={worst} />}
      {worst === null || angle === null ? null : (
        <line
          data-even={Math.round(clamp(even!))}
          x1={C + (r - width / 2 - 1) * Math.cos(angle)}
          y1={C + (r - width / 2 - 1) * Math.sin(angle)}
          x2={C + (r + width / 2 + 1) * Math.cos(angle)}
          y2={C + (r + width / 2 + 1) * Math.sin(angle)}
          stroke="currentColor"
          strokeWidth={1.2}
          opacity={0.85}
        />
      )}
    </svg>
  );
}

/** C1: the 5-hour window outside, the weekly one inside. */
export function Rings({
  outer,
  inner,
  title,
  className,
  style,
  svgRef,
}: {
  outer: RingWindow | null;
  inner: RingWindow | null;
  title: string;
  className?: string;
  style?: React.CSSProperties;
  svgRef?: React.Ref<SVGSVGElement>;
}) {
  const empty = outer === null && inner === null;
  const width = 2.2;
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      fill="none"
      className={cn("size-4", className)}
      style={style}
      data-style="rings"
      data-empty={empty || undefined}
    >
      <title>{title}</title>
      <Track r={11.5} width={width} empty={empty} />
      {outer === null ? null : <Arc r={11.5} width={width} w={outer} ring="outer" />}
      {empty ? null : <Track r={7.3} width={width} empty={false} />}
      {inner === null ? null : <Arc r={7.3} width={width} w={inner} ring="inner" />}
    </svg>
  );
}

/**
 * The registered icon component. In the footer's 28 px button it draws at
 * FOOTER_RING_PX; anywhere smaller (the More menu, once the user took the
 * button out of the footer) it keeps the size the host gives.
 */
export function RingIcon({ className }: { className?: string }) {
  const state = useIndicatorState();
  const probe = useRef<SVGSVGElement | null>(null);
  const [large, setLarge] = useState(false);
  useLayoutEffect(() => {
    const button = probe.current?.closest("button");
    const box = button?.getBoundingClientRect();
    setLarge(box !== undefined && box.width >= FOOTER_RING_PX + 2 && box.height >= FOOTER_RING_PX + 2);
  });
  const offset = -(FOOTER_RING_PX - 16) / 2;
  const style: React.CSSProperties | undefined = large
    ? { width: FOOTER_RING_PX, height: FOOTER_RING_PX, margin: offset, flex: "none", maxWidth: "none" }
    : undefined;
  if (state.style === "ring") {
    return <Ring svgRef={probe} worst={state.worst} even={state.worst?.even ?? null} title={state.title} className={className} style={style} />;
  }
  return <Rings svgRef={probe} outer={state.outer ?? null} inner={state.inner ?? null} title={state.title} className={className} style={style} />;
}
