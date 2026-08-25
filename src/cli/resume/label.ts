const MAX_LENGTH = 72;

/** Collapses whitespace (session transcripts routinely embed multi-line
 * prompts) and truncates to one display-friendly line. Shared across all
 * three per-tool readers so labels are sized consistently in the report. */
export function truncateLabel(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_LENGTH ? `${collapsed.slice(0, MAX_LENGTH - 1)}…` : collapsed;
}
