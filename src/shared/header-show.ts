// How the thread header shows the 5-hour and weekly limits: rings with the
// percent inside, a vertical bar beside a larger percent, or nothing.

export const HEADER_SHOW = ["rings", "bars", "off"] as const;
export type HeaderShow = (typeof HEADER_SHOW)[number];
export const DEFAULT_HEADER_SHOW: HeaderShow = "rings";

/** A stored setting value, or the default for anything unknown. */
export function parseHeaderShow(value: unknown): HeaderShow {
  return (HEADER_SHOW as readonly unknown[]).includes(value) ? (value as HeaderShow) : DEFAULT_HEADER_SHOW;
}
