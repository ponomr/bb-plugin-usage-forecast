// How the limits card (from the sidebar ring and from the header limits)
// draws a provider: rows (к1: one line per window with bar, percent and the
// time to reset) or big numbers (each window's percent in large type over its
// short label). Host tabs, provider names and the action row are the same.

import { oneOf } from "./language";

export const CARD_STYLE = ["rows", "big"] as const;
export type CardStyle = (typeof CARD_STYLE)[number];
export const DEFAULT_CARD_STYLE: CardStyle = "rows";

/** A stored setting value, or the default for anything unknown. */
export const parseCardStyle = (value: unknown): CardStyle => oneOf(CARD_STYLE, value, DEFAULT_CARD_STYLE);
