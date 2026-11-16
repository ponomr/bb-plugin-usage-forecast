// The `hiddenProviders` setting: provider ids the band, the sidebar sign,
// limit pushes and `headroom` leave out. Polling and storage ignore it.

/**
 * The ids of the setting, split on commas and whitespace, trimmed,
 * lower-cased and without duplicates. Anything but a string is no ids. An id
 * that matches no provider is kept: it simply matches nothing.
 */
export function parseHiddenProviders(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const ids = raw
    .split(/[\s,]+/)
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id !== "");
  return [...new Set(ids)];
}

/** True when the provider is in the parsed list. */
export function isHidden(hidden: readonly string[], providerId: string): boolean {
  return hidden.length > 0 && hidden.includes(providerId.trim().toLowerCase());
}

/** The setting's text for a list of ids. */
export function joinHiddenProviders(hidden: readonly string[]): string {
  return hidden.join(", ");
}
