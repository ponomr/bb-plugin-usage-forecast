// Whether the band shows a window's reset as the time left until it ("4h 12m")
// or as the local time of the reset ("Sat 19:59"). A plugin setting.

export const RESET_SHOW = ["countdown", "time"] as const;
export type ResetShow = (typeof RESET_SHOW)[number];
export const DEFAULT_RESET_SHOW: ResetShow = "countdown";

/** A stored setting value, or the default for anything unknown. */
export function parseResetShow(value: unknown): ResetShow {
  return (RESET_SHOW as readonly unknown[]).includes(value) ? (value as ResetShow) : DEFAULT_RESET_SHOW;
}
