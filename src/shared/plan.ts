// A provider's plan as the band, the sidebar card and the CLI show it: the
// host's `planLabel` plus the multiplier of its undocumented
// `plan: {id, multiplier}` ("Max 5×"). On bb 0.49 the host sent
// `multiplier: null` for every provider (AGENTS.md, Host facts), so nothing is
// guessed: only a finite number above 1 is shown. Of `plan` only the
// multiplier is ever kept.
//
// Pure: no SDK.

/** The multiplier of the host's `plan` object, or null for any other shape or a value of 1 or less. */
export function planMultiplier(plan: unknown): number | null {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return null;
  const value = (plan as { multiplier?: unknown }).multiplier;
  return typeof value === "number" && Number.isFinite(value) && value > 1 ? value : null;
}

/** A plan name that already names a multiplier ("Max 20x", "Pro 5×"). */
const HAS_MULTIPLIER = /\d\s*[x×]/i;

/** "Max 5×"; the name alone without a usable multiplier; null without a name. */
export function planText(planLabel: string | null | undefined, multiplier: number | null | undefined): string | null {
  if (!planLabel) return null;
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 1) return planLabel;
  if (HAS_MULTIPLIER.test(planLabel)) return planLabel;
  return `${planLabel} ${Math.round(multiplier * 10) / 10}×`;
}
