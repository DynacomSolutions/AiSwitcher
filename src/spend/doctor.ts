import type { DoctorResult } from "../cli/doctor/types.ts";
import { runSpendGuardCycle, type SpendCycleDeps, type SpendGuardCycleResult } from "./compute.ts";

/**
 * `ais doctor`'s spend-guard section: one row per AWS account with a
 * budget, saying plainly whether it is in budget, BREACHED (launches
 * blocked, active sessions terminated), or DEGRADED (unenforced, with the
 * reason). Implemented standalone on this branch (no other degraded pattern
 * to reuse): it runs a REAL read-only cycle — the same budgets/Cost
 * Explorer/local-estimate pipeline the daemon runs — so doctor's answer is
 * live truth, not a cached maybe. Accounts appear only when the machine has
 * an identity->AWS mapping; everyone else sees no section at all.
 */

export function spendGuardDoctorRows(result: SpendGuardCycleResult): DoctorResult[] {
  const rows: DoctorResult[] = [];
  for (const state of Object.values(result.states)) {
    const suffix = state.accountId.slice(-4);
    const money = (n: number | undefined): string => (n === undefined ? "n/a" : `$${n.toFixed(2)}`);
    const signals =
      `local ${money(state.localEstimateUsd)}` +
      (state.realReportedUsd !== undefined ? `, Cost Explorer ${money(state.realReportedUsd)}` : "") +
      (state.budgetActualUsd !== undefined ? `, budget actual ${money(state.budgetActualUsd)}` : "");
    const cap =
      state.budgetName !== undefined && state.budgetLimitUsd !== undefined
        ? `budget ${state.budgetName} cap ${money(state.budgetLimitUsd)}`
        : "no usable budget";
    const who = state.identities.length > 0 ? ` · identities: ${state.identities.join(", ")}` : "";
    if (state.degraded) {
      rows.push({
        toolName: "aws-spend-guard",
        identity: { name: `account ...${suffix}`, label: `profile ${state.profile}`, configDir: "" },
        status: "unavailable",
        statusWord: "DEGRADED (unenforced)",
        detail: `${cap} · ${signals} · ${state.reason}${who}`,
      });
      continue;
    }
    if (state.breached) {
      rows.push({
        toolName: "aws-spend-guard",
        identity: { name: `account ...${suffix}`, label: `profile ${state.profile}`, configDir: "" },
        status: "hung",
        statusWord: "BREACHED",
        detail: `${cap} · enforcing on ${money(state.effectiveUsd)} (${signals}) — new launches blocked, active sessions terminated${who}`,
      });
      continue;
    }
    rows.push({
      toolName: "aws-spend-guard",
      identity: { name: `account ...${suffix}`, label: `profile ${state.profile}`, configDir: "" },
      status: "responsive",
      statusWord: "in budget",
      detail: `${cap} · enforcing on ${money(state.effectiveUsd)} (${signals})${who}`,
    });
  }
  return rows;
}

export async function collectSpendGuardDoctor(deps: SpendCycleDeps = {}): Promise<DoctorResult[]> {
  const cycle = await runSpendGuardCycle(deps);
  return spendGuardDoctorRows(cycle);
}
