import type { DoctorResult } from "../cli/doctor/types.ts";
import { runSpendGuardCycle, type SpendCycleDeps, type SpendGuardCycleResult } from "./compute.ts";
import { loadSpendGuardConfig, type SpendGuardMode } from "./config.ts";

/**
 * `ais doctor`'s spend-guard section: one row per AWS account with a
 * budget, saying plainly whether it is in budget, BREACHED, or DEGRADED
 * (unenforced, with the reason). A breach is qualified by the machine-local
 * mode: "BREACHED (enforced)" is the original hard stop (launches blocked,
 * sessions terminated); "BREACHED (warning)" means the same breach with the
 * default warn response, where nothing is refused or killed and the detail
 * says how to switch. Implemented standalone on this branch (no other
 * degraded pattern to reuse): it runs a REAL read-only cycle — the same
 * budgets/Cost Explorer/local-estimate pipeline the daemon runs — so
 * doctor's answer is live truth, not a cached maybe. Accounts appear only
 * when the machine has an identity->AWS mapping; everyone else sees no
 * section at all.
 */

export function spendGuardDoctorRows(result: SpendGuardCycleResult, mode: SpendGuardMode = "warn"): DoctorResult[] {
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
      const warned = mode !== "enforce";
      rows.push({
        toolName: "aws-spend-guard",
        identity: { name: `account ...${suffix}`, label: `profile ${state.profile}`, configDir: "" },
        status: "hung",
        statusWord: warned ? "BREACHED (warning)" : "BREACHED (enforced)",
        detail: warned
          ? `${cap} · enforcing on ${money(state.effectiveUsd)} (${signals}) · warning only: launches and sessions untouched; set mode=enforce in ~/.ais/config/spend-guard.json to block${who}`
          : `${cap} · enforcing on ${money(state.effectiveUsd)} (${signals}) — new launches blocked, active sessions terminated${who}`,
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
  const [cycle, config] = await Promise.all([runSpendGuardCycle(deps), loadSpendGuardConfig()]);
  return spendGuardDoctorRows(cycle, config.mode);
}
