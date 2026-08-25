import type { Identity, ToolConfig } from "../../identities/types.ts";

/** "responsive" means the real binary answered within its timeout budget —
 * regardless of whether the answer itself was useful (an auth error, "no
 * rate-limit data", etc. all still count as responsive; the process didn't
 * hang). "hung" is the one status this command exists to catch: the process
 * never answered at all within budget. "unavailable" means the probe was
 * never even attempted (binary not resolvable on PATH, or no doctor probe
 * exists yet for this tool — see collect.ts's PROBES). */
export type DoctorStatus = "responsive" | "hung" | "unavailable";

export interface DoctorResult {
  toolName: ToolConfig["toolName"];
  identity: Identity;
  status: DoctorStatus;
  /** Wall-clock time the probe actually took. Set for "responsive" and
   * "hung" (a hang still "takes" the full timeout); unset for "unavailable"
   * since no subprocess was ever spawned. */
  elapsedMs?: number;
  /** Extra context: the real error/exit output for "responsive" (e.g. an
   * auth error) or "unavailable" (e.g. binary missing), or the timeout
   * explanation for "hung". */
  detail?: string;
}
