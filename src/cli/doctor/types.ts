import type { Identity, ToolConfig } from "../../identities/types.ts";

/** "responsive" means the real binary answered within its timeout budget —
 * regardless of whether the answer itself was useful (an auth error, "no
 * rate-limit data", etc. all still count as responsive; the process didn't
 * hang). "hung" is the one status this command exists to catch: the process
 * never answered at all within budget. "unavailable" means the probe was
 * never even attempted (binary not resolvable on PATH, or no doctor probe
 * exists yet for this tool — see collect.ts's PROBES). */
export type DoctorStatus = "responsive" | "hung" | "unavailable";

export type DoctorToolName = ToolConfig["toolName"] | "aws-spend-guard";

export interface DoctorResult {
  /** "aws-spend-guard" is the spend guard's pseudo-tool: one row per AWS
   * account (see spend/doctor.ts), grouped as its own section by the
   * renderer. */
  toolName: DoctorToolName;
  identity: Identity;
  status: DoctorStatus;
  /** Replaces the default status WORD ("responsive"/"hung"/"unavailable")
   * while keeping the status's colour semantics — the spend guard's
   * breached/degraded wording, so doctor reads consistently without
   * inventing a second result shape. */
  statusWord?: string;
  /** Wall-clock time the probe actually took. Set for "responsive" and
   * "hung" (a hang still "takes" the full timeout); unset for "unavailable"
   * since no subprocess was ever spawned. */
  elapsedMs?: number;
  /** Extra context: the real error/exit output for "responsive" (e.g. an
   * auth error) or "unavailable" (e.g. binary missing), or the timeout
   * explanation for "hung". */
  detail?: string;
}
