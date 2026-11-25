// Plugin UI language. bb gives plugins no locale, so it is a plugin setting.

export const LANGUAGES = ["en", "ru"] as const;
export type Lang = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Lang = "en";

/** A stored setting value when it is one of `values`, else `fallback`. */
export function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return (values as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/** A stored setting value, or the default for anything unknown. */
export const parseLang = (value: unknown): Lang => oneOf(LANGUAGES, value, DEFAULT_LANGUAGE);
