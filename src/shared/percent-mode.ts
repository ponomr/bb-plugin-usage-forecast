// What the limit indicators show: the share of a window left (the default) or
// the share used. The tones do not change with it: little left is red either
// way. Context fill, thresholds and the CLI always speak of the share used.

import { oneOf } from "./language";

export const PERCENT_MODES = ["left", "used"] as const;
export type PercentMode = (typeof PERCENT_MODES)[number];
export const DEFAULT_PERCENT_MODE: PercentMode = "left";

/** A stored setting value, or the default for anything unknown. */
export const parsePercentMode = (value: unknown): PercentMode => oneOf(PERCENT_MODES, value, DEFAULT_PERCENT_MODE);
