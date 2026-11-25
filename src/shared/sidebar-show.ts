// How the sidebar-footer button draws the limits: two concentric rings (the
// 5-hour window outside, the weekly one inside) or one ring for the worst
// window with the even-pace tick. There is no "off": bb's own More →
// Customize footer takes the button out of the footer.

export const SIDEBAR_SHOW = ["rings", "ring"] as const;
export type SidebarShow = (typeof SIDEBAR_SHOW)[number];
export const DEFAULT_SIDEBAR_SHOW: SidebarShow = "rings";

/** A stored setting value, or the default for anything unknown. */
export function parseSidebarShow(value: unknown): SidebarShow {
  return (SIDEBAR_SHOW as readonly unknown[]).includes(value) ? (value as SidebarShow) : DEFAULT_SIDEBAR_SHOW;
}
