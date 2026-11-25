// Colour thresholds shared by the app and the CLI. Values follow
// claude-code-usage-quota-mod: context amber from 50 %, red from 80 %. A
// limit window is coloured by its pace state (`src/shared/pace.ts`); one
// without a current pace is `muted` (P1), red only once the limit is reached.
// The CLI's provider headroom calls a limit tight from LIMIT_AMBER_PERCENT.

/** `muted`: a limit window with no forecast to judge it by (P1); it is not coloured. */
export type Tone = "muted" | "normal" | "amber" | "red";

const CONTEXT_AMBER_PERCENT = 50;
const CONTEXT_RED_PERCENT = 80;
export const LIMIT_AMBER_PERCENT = 75;
const FORECAST_RED_PERCENT = 100;

// Percent values are judged as shown, that is rounded, so 49.6 % reads and
// colours as 50 %.
export function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

function tone(percent: number, amber: number, red: number): Tone {
  const shown = Math.round(percent);
  if (shown >= red) return "red";
  if (shown >= amber) return "amber";
  return "normal";
}

export function contextTone(percent: number): Tone {
  return tone(percent, CONTEXT_AMBER_PERCENT, CONTEXT_RED_PERCENT);
}

/** A projection strictly above 100 % warns; exactly 100 % does not. */
export function forecastWarns(projectedPercent: number): boolean {
  return projectedPercent > FORECAST_RED_PERCENT;
}

