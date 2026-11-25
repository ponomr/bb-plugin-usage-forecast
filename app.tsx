// App entry: the composer banner of every thread, a section of the thread
// context card (Mac), a settings page section and the limits ring in the
// sidebar footer, the 5-hour and weekly limits in the page header and an
// optional floating widget.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { Banner } from "./src/app/banner";
import { ContextCardSection } from "./src/app/context-row";
import { FloatLimits } from "./src/app/float-widget";
import { HeaderLimits } from "./src/app/header-widget";
import { IndicatorFeeder } from "./src/app/indicator-store";
import { RING_ICON, RingIcon } from "./src/app/ring-icon";
import { SettingsSection } from "./src/app/settings-section";
import { SidebarCard } from "./src/app/sidebar-card";

/** After bb's own card sections (`1_related` … `3_storage`). */
export const CARD_SECTION_GROUP = "6_usage";

export default definePluginApp((app) => {
  app.composer.customize({
    id: "usage-forecast",
    scopes: ["thread"],
    banners: [{ id: "limits", chrome: "card", component: Banner }],
  });
  app.slots.experimental_threadContextCardSection({
    id: "context",
    title: "Context & auto compact",
    group: CARD_SECTION_GROUP,
    component: ContextCardSection,
  });
  app.slots.settingsSection({
    id: "status",
    title: "Status",
    description: "Limits polling, providers and recent compacts.",
    component: SettingsSection,
  });
  // The footer icon renders outside the plugin slot; this overlay feeds it.
  app.experimental_icons.register({ name: RING_ICON, component: RingIcon });
  app.slots.experimental_appOverlay({ id: "indicator-feeder", component: IndicatorFeeder });
  // bb has no header slot: this overlay moves its own element into the page header.
  app.slots.experimental_appOverlay({ id: "header-limits", component: HeaderLimits });
  // The floating widget at the window's right edge, by the `showFloat` setting.
  app.slots.experimental_appOverlay({ id: "float-limits", component: FloatLimits });
  // Setup has no settings, so the item cannot follow one: the host's More →
  // Customize footer hides it (AGENTS.md, Host facts, Sidebar footer).
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "limits",
    label: "Usage limits",
    icon: RING_ICON,
    component: SidebarCard,
  });
});
