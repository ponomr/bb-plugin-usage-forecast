// How the page header shows the limits on a desktop: coloured percents with
// the 5-hour reset (`numbers`), the same with horizontal bars (`bars`), the
// window that runs out first leading with its forecast (`forecast`), every
// provider's worst window by its icon (`providers`), or nothing. Narrower than
// 40rem (a phone) every mode but `off` shows a dot and the worst percent.
// Values from 0.4.22 builds before this one ("rings") read as the default.

import { oneOf } from "./language";

export const HEADER_SHOW = ["numbers", "bars", "forecast", "providers", "off"] as const;
export type HeaderShow = (typeof HEADER_SHOW)[number];
export const DEFAULT_HEADER_SHOW: HeaderShow = "numbers";

/** A stored setting value, or the default for anything unknown. */
export const parseHeaderShow = (value: unknown): HeaderShow => oneOf(HEADER_SHOW, value, DEFAULT_HEADER_SHOW);
