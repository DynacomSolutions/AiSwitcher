import type { Identity } from "../../identities/types.ts";
import { ESCALATION_THRESHOLD, lastRefreshFailure } from "../../server/auth-refresh.ts";
import type { DoctorResult } from "./types.ts";

/** ali has no real binary to spawn (it is a crush-backed fake proxy), so its
 * doctor probe instead reads the persisted auth-refresh state, the health
 * record of exactly the pipeline (console-cookie auto-refresh) that keeps
 * ali's quota checks and, indirectly, its Token plan session usable.
 *
 * - No failure on record (or no state file at all): "responsive". A missing
 *   state file simply means no daemon/timer has ever run here, which is not
 *   a degraded pipeline; `ais limits --tool=ali` remains the honest reporter
 *   of a missing/expired cookie itself.
 * - Last refresh attempt failed: "degraded" with the consecutive-failure
 *   count, the attempt timestamp and the precise error (which, since the
 *   2026-09-10 hardening, carries its own remediation hint). Past
 *   ESCALATION_THRESHOLD consecutive failures this is the "the harvester has
 *   been dead for a while" flag that used to be nowhere at all. */
export async function probeAliDoctor(identity: Identity, home?: string): Promise<DoctorResult> {
  const failure = await lastRefreshFailure("ali", identity.name, home);
  if (!failure) {
    return {
      toolName: "ali",
      identity,
      status: "responsive",
      detail: "console-cookie auto-refresh healthy (no failed refresh on record)",
    };
  }
  const escalated = failure.consecutiveFailures >= ESCALATION_THRESHOLD;
  return {
    toolName: "ali",
    identity,
    status: "degraded",
    detail:
      `console cookie auto-refresh failing (${failure.consecutiveFailures} consecutive` +
      `${escalated ? ", escalated" : ""}; last attempt ${failure.lastAttemptAt}): ${failure.lastError}`,
  };
}
