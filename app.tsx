// App entry: the composer banner of every thread, a section of the thread
// context card (Mac) and a settings page section.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { Banner } from "./src/app/banner";
import { ContextCardSection } from "./src/app/context-row";
import { SettingsSection } from "./src/app/settings-section";

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
});
