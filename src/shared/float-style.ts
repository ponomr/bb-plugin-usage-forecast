// How the open floating widget draws the limits (big numbers by default): lines (one line per provider
// with its 5-hour and weekly percents) or big numbers (per provider a small
// name over the two percents in large type). The fold into the ring badge is
// the same for both.

import { oneOf } from "./language";

export const FLOAT_STYLE = ["big", "lines"] as const;
export type FloatStyle = (typeof FLOAT_STYLE)[number];
export const DEFAULT_FLOAT_STYLE: FloatStyle = "big";

/** A stored setting value, or the default for anything unknown. */
export const parseFloatStyle = (value: unknown): FloatStyle => oneOf(FLOAT_STYLE, value, DEFAULT_FLOAT_STYLE);
