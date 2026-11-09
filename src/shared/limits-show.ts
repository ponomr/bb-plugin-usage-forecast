// Whether the band shows each limit window as the percent used or the percent
// left. A plugin setting; the context bar always shows what is used.

export const LIMITS_SHOW = ["used", "remaining"] as const;
export type LimitsShow = (typeof LIMITS_SHOW)[number];
export const DEFAULT_LIMITS_SHOW: LimitsShow = "used";

/** A stored setting value, or the default for anything unknown. */
export function parseLimitsShow(value: unknown): LimitsShow {
  return (LIMITS_SHOW as readonly unknown[]).includes(value) ? (value as LimitsShow) : DEFAULT_LIMITS_SHOW;
}

/** A used percent as the setting shows it: as is, or what is left (never below 0). */
export function shownPercent(show: LimitsShow, usedPercent: number): number {
  return show === "used" ? usedPercent : Math.max(0, 100 - usedPercent);
}
