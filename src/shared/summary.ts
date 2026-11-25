// The summary that stands in for compaction on a provider that cannot
// compact: the plugin asks the agent for a summary that starts with
// SUMMARY_MARKER, clears the context and sends the summary back. This module
// imports nothing, so i18n and the server share it.

/** The first line the agent is asked to write; an answer without it is not a summary. */
export const SUMMARY_MARKER = "[context-summary]";
/** The marker must open the answer; a little leading text (a greeting, a blank line) is tolerated. */
const SUMMARY_MARKER_WITHIN_CHARS = 200;
/** A shorter body is not a usable summary. */
const SUMMARY_MIN_CHARS = 100;
/** A longer body is cut; the full answer stays in the thread history. */
export const SUMMARY_MAX_CHARS = 40_000;
export const SUMMARY_CUT_NOTE = "\n\n[The summary was cut here; the full text is in the thread history above.]";

/**
 * The summary in a `threads.output` answer, or null when the answer is not
 * one: missing, without the marker near its start, or too short.
 */
export function readSummary(answer: unknown): string | null {
  const output = (answer as { output?: unknown } | null)?.output;
  if (typeof output !== "string") return null;
  const text = output.trim();
  const at = text.indexOf(SUMMARY_MARKER);
  if (at < 0 || at > SUMMARY_MARKER_WITHIN_CHARS) return null;
  const body = text.slice(at + SUMMARY_MARKER.length).trim();
  if (body.length < SUMMARY_MIN_CHARS) return null;
  return body.length > SUMMARY_MAX_CHARS ? `${body.slice(0, SUMMARY_MAX_CHARS)}${SUMMARY_CUT_NOTE}` : body;
}
