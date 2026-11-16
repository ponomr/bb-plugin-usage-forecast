// Colour thresholds shared by the app and the CLI. Values follow
// claude-code-usage-quota-mod: context amber from 50 %, red from 80 %; limits
// amber from 75 %, red from 90 %. A limit window with a current pace is
// coloured by its pace state instead (`src/shared/pace.ts`); the limit
// thresholds apply only early in a window and to windows without a forecast.

export type Tone = "normal" | "amber" | "red";

export const CONTEXT_AMBER_PERCENT = 50;
export const CONTEXT_RED_PERCENT = 80;
export const LIMIT_AMBER_PERCENT = 75;
export const LIMIT_RED_PERCENT = 90;
export const FORECAST_RED_PERCENT = 100;

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

export function limitTone(percent: number): Tone {
  return tone(percent, LIMIT_AMBER_PERCENT, LIMIT_RED_PERCENT);
}

/** A projection strictly above 100 % warns; exactly 100 % does not. */
export function forecastWarns(projectedPercent: number): boolean {
  return projectedPercent > FORECAST_RED_PERCENT;
}

