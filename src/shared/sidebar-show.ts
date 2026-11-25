// How the sidebar-footer button draws the limits: two concentric rings (the
// 5-hour window outside, the weekly one inside) or one ring for the worst
// window with the even-pace tick. There is no "off": bb's own More →
// Customize footer takes the button out of the footer.

import { oneOf } from "./language";

export const SIDEBAR_SHOW = ["rings", "ring"] as const;
export type SidebarShow = (typeof SIDEBAR_SHOW)[number];
export const DEFAULT_SIDEBAR_SHOW: SidebarShow = "rings";

/** A stored setting value, or the default for anything unknown. */
export const parseSidebarShow = (value: unknown): SidebarShow => oneOf(SIDEBAR_SHOW, value, DEFAULT_SIDEBAR_SHOW);
