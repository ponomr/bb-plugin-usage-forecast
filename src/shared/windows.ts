// Window durations. A window is identified by (providerId, label); the host
// gives no duration, so it comes from the label table below. The host's
// undocumented `kind` is only a fallback hint for labels outside the table.
// Labels seen on bb 0.49.0 are listed in AGENTS.md «Host facts».

export const MIN_MS = 60_000;
export const HOUR_MS = 60 * MIN_MS;
export const DAY_MS = 24 * HOUR_MS;

const LABEL_DURATIONS: Readonly<Record<string, number>> = {
  "Current session": 5 * HOUR_MS,
  "Weekly limit": 7 * DAY_MS,
  Fable: 7 * DAY_MS,
};

const KIND_DURATIONS: Readonly<Record<string, number>> = {
  "five-hour": 5 * HOUR_MS,
  weekly: 7 * DAY_MS,
};

/** Duration of a window in ms, or null when neither its label nor its kind is known. */
export function windowDurationMs(label: string, kind?: unknown): number | null {
  if (Object.hasOwn(LABEL_DURATIONS, label)) return LABEL_DURATIONS[label]!;
  if (typeof kind === "string" && Object.hasOwn(KIND_DURATIONS, kind)) return KIND_DURATIONS[kind]!;
  return null;
}

/** Storage key part for a window: provider and label, both URI-encoded. */
export function windowKey(providerId: string, label: string): string {
  return `${encodeURIComponent(providerId)}:${encodeURIComponent(label)}`;
}

/** Whether a window's model tag adds anything to its label ("Fable" [fable] does not). */
export function showsModelTag(label: string, model: string | null): model is string {
  return model !== null && model !== "" && model.toLowerCase() !== label.toLowerCase();
}
