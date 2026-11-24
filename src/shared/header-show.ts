// How the page header shows the 5-hour and weekly limits: coloured percents
// with the 5-hour reset, the same with horizontal bars, or nothing. Values
// from 0.4.22 builds before this one ("rings") read as the default.

export const HEADER_SHOW = ["numbers", "bars", "off"] as const;
export type HeaderShow = (typeof HEADER_SHOW)[number];
export const DEFAULT_HEADER_SHOW: HeaderShow = "numbers";

/** A stored setting value, or the default for anything unknown. */
export function parseHeaderShow(value: unknown): HeaderShow {
  return (HEADER_SHOW as readonly unknown[]).includes(value) ? (value as HeaderShow) : DEFAULT_HEADER_SHOW;
}
