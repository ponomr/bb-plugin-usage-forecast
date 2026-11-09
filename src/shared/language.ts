// Plugin UI language. bb gives plugins no locale, so it is a plugin setting.

export const LANGUAGES = ["en", "ru"] as const;
export type Lang = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Lang = "en";

/** A stored setting value, or the default for anything unknown. */
export function parseLang(value: unknown): Lang {
  return (LANGUAGES as readonly unknown[]).includes(value) ? (value as Lang) : DEFAULT_LANGUAGE;
}
