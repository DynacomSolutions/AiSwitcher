import type { ExtraUsageInfo } from "../types/api";

/**
 * The short note for a codex account's credits. The gateway never routes a member at or over 100%, so credits are
 * shown for information and are never spent. Returns undefined when the reading carries no credits block.
 */
export function creditsNote(extra: ExtraUsageInfo | undefined): string | undefined {
  if (!extra) return undefined;
  if (!extra.enabled) return "Credits: none";
  if (!extra.available) return "Credits: none left";
  return "Credits: available (not used: the gateway stops at 100%)";
}
