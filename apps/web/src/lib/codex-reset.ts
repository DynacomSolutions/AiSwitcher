import { relTime } from "@/lib/format";
import type { ToolLimitResult } from "@/types/api";

/** After a Codex reset is spent, the use button stays hidden this long. A second click cannot then spend another credit before the count updates. */
export const SPEND_LOCK_MS = 120_000;

/**
 * Whether a Codex card offers the use-reset button. The button stays while the usage read is cached, unavailable or rate-limited,
 * and while the credit list is the last known one: OpenAI decides on the spend itself. It hides when no credit is available, for a
 * retired or pooled identity, while a recheck after a spend runs, and for a short time after a spend.
 */
export function canSpendCodexReset(row: ToolLimitResult, now = Date.now()): boolean {
  const reset = row.manualReset;
  if (row.toolName !== "codex" || row.gatewayManaged !== true || !reset || reset.grants) return false;
  if (reset.availableCount <= 0 || row.identity.retired || row.identity.swapPool) return false;
  if (reset.spentAt !== undefined && now - reset.spentAt < SPEND_LOCK_MS) return false;
  if (row.resetPendingUntil !== undefined && row.resetPendingUntil > now) return false;
  return true;
}

/**
 * The first sentence of the spend dialog. A live card knows the credit count. A cached card or a stale credit list shows the
 * last known count and its age, because OpenAI decides on the spend itself and the count may have changed.
 */
export function spendCreditSentence(availableCount: number, lastKnown: boolean, readAt: string | undefined, nowMs = Date.now()): string {
  if (!lastKnown) return `This spends one of ${availableCount} available reset credits on this Codex account.`;
  const age = readAt && Number.isFinite(Date.parse(readAt)) ? `, read ${relTime(readAt, nowMs)}` : "";
  return `This spends one reset credit on this Codex account. The last known count is ${availableCount}${age}, so it may be out of date.`;
}

/** When the gateway read the credit list from OpenAI. The usage reading time is another read and never stands in for it. */
export function creditReadAt(row: ToolLimitResult): string | undefined {
  return row.manualReset?.readAt;
}

/** Whether the credit count on a Codex card is the last known one and not a fresh read. */
export function creditsAreLastKnown(row: ToolLimitResult): boolean {
  return row.status !== "live" || row.manualReset?.stale === true;
}
