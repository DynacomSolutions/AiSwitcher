import { resetDateForTimeUnit } from "../cli/limits/aws-bedrock-limits.ts";

/**
 * Pure per-account spend state for the spend guard — the unit-testable core
 * of the enforcement decision. One AWS account maps to exactly one state;
 * every identity resolved to that account (via identities/aws-profile.ts's
 * machine-local mapping) contributes its local estimate to the sum.
 *
 * The staleness contract (decided, see the AGENTS.md case study):
 *   - The LOCAL token-based estimate is always computable offline and is the
 *     PRIMARY breach signal (AWS billing data lags by hours).
 *   - Real spend is blended as max(local, real) and only from sources whose
 *     fetch SUCCEEDED this cycle. Two real sources exist: Cost Explorer's
 *     Bedrock spend, and the budget's own CalculatedSpend.ActualSpend (free
 *     with the same DescribeBudget call that yields the limit). A source
 *     that failed this cycle contributes nothing to the max — it never
 *     poisons the blend with a stale zero.
 *   - A budget LIMIT that cannot be fetched (SSO expired, API down) leaves
 *     the account UNENFORCED (nothing to enforce against) but flagged
 *     degraded with the reason. Never block on missing data; never silently
 *     skip either — the reason surfaces in the daemon status, doctor, and
 *     the WebUI.
 *   - No override exists: enforcement is a property of the state, not of
 *     flags. Editing the budget (or the machine-local mapping) is the only
 *     escape.
 */

/** The subset of a fetched COST budget the guard needs. Amounts are parsed
 * dollars, not wire strings. */
export interface BudgetSnapshot {
  name: string;
  limitUsd: number;
  /** The budget's own AWS-side spend for the current period (CalculatedSpend.
   * ActualSpend; 0 when AWS has not computed one yet). Lags by hours. */
  actualUsd: number;
  timeUnit?: string;
}

export interface AccountSpendInput {
  accountId: string;
  profile: string;
  region?: string;
  /** COST budgets with a parseable limit, as fetched THIS cycle. Empty when
   * the fetch failed or the account defines none. */
  budgets: BudgetSnapshot[];
  /** Why the budget list is empty/unusable, when it is. A transport or auth
   * failure — distinct from "the account genuinely defines no COST budget". */
  budgetError?: string;
  /** Sum of the account's identities' local token-based estimates over the
   * budget's current period (month-to-date for a MONTHLY budget, etc.). */
  localEstimateUsd: number;
  /** Cost Explorer's Bedrock spend over the same period. Present ONLY when
   * the fetch succeeded this cycle. */
  realReportedUsd?: number;
  /** Identity names contributing to this account's sums (display only). */
  identities: string[];
  now: Date;
}

export interface AccountSpendState {
  accountId: string;
  profile: string;
  region?: string;
  budgetName?: string;
  budgetLimitUsd?: number;
  budgetActualUsd?: number;
  budgetTimeUnit?: string;
  /** Inclusive period start the estimates cover (ISO, local midnight). */
  periodStart?: string;
  /** Next AWS-side reset derived from the budget's TimeUnit (ISO). */
  periodEnd?: string;
  localEstimateUsd: number;
  realReportedUsd?: number;
  /** max(local, every real source that succeeded this cycle). */
  effectiveUsd: number;
  breached: boolean;
  /** false exactly when degraded: no cap, nothing to enforce against. */
  enforced: boolean;
  degraded: boolean;
  /** Present when degraded, and on breach as a human-readable summary. */
  reason?: string;
  identities: string[];
  computedAt: string;
}

/** The start of the budget period CONTAINING `now`, per the budget's own
 * TimeUnit — the window the local estimate must sum over to be comparable
 * with the limit. WEEKLY is Sunday-based (AWS Budgets' recurring week).
 * Exported pure for tests. */
export function periodStartForTimeUnit(timeUnit: string | undefined, now: Date): Date {
  const year = now.getFullYear();
  const month = now.getMonth();
  switch (timeUnit) {
    case "DAILY":
      return new Date(year, month, now.getDate());
    case "WEEKLY":
      return new Date(year, month, now.getDate() - now.getDay());
    case "MONTHLY":
      return new Date(year, month, 1);
    case "QUARTERLY":
      return new Date(year, month - (month % 3), 1);
    case "ANNUALLY":
      return new Date(year, 0, 1);
    default:
      return new Date(year, month, 1);
  }
}

/** Deterministic cap choice when an account defines several COST budgets:
 * the largest limit wins (the loosest ceiling is the one that governs "when
 * is the account actually out of allowance"); ties fall to the
 * lexicographically first name so the choice is stable across cycles.
 * Exported pure for tests. */
export function chooseBudget(budgets: BudgetSnapshot[]): BudgetSnapshot | undefined {
  if (budgets.length === 0) return undefined;
  return [...budgets].sort((a, b) => b.limitUsd - a.limitUsd || a.name.localeCompare(b.name))[0];
}

/** Pure mapping from this cycle's inputs to the enforceable state. See the
 * module doc for the contract. Exported for tests. */
export function computeAccountState(input: AccountSpendInput, now: Date = input.now): AccountSpendState {
  const computedAt = now.toISOString();
  const budget = chooseBudget(input.budgets);

  if (!budget) {
    const reason =
      input.budgetError ??
      `no AWS COST budget with a parseable limit in account ...${input.accountId.slice(-4)} — nothing to enforce against`;
    return {
      accountId: input.accountId,
      profile: input.profile,
      ...(input.region ? { region: input.region } : {}),
      localEstimateUsd: input.localEstimateUsd,
      effectiveUsd: input.localEstimateUsd,
      breached: false,
      enforced: false,
      degraded: true,
      reason,
      identities: input.identities,
      computedAt,
    };
  }

  const periodStart = periodStartForTimeUnit(budget.timeUnit, now);
  const periodEnd = resetDateForTimeUnit(budget.timeUnit, now);
  const realSources: number[] = [input.localEstimateUsd, budget.actualUsd];
  if (input.realReportedUsd !== undefined) realSources.push(input.realReportedUsd);
  const effectiveUsd = Math.max(...realSources);
  // "Hit" is >=: the moment spend reaches the cap the account is done for
  // the period — an over-cap request already billed by definition.
  const breached = effectiveUsd >= budget.limitUsd;

  return {
    accountId: input.accountId,
    profile: input.profile,
    ...(input.region ? { region: input.region } : {}),
    budgetName: budget.name,
    budgetLimitUsd: budget.limitUsd,
    budgetActualUsd: budget.actualUsd,
    ...(budget.timeUnit ? { budgetTimeUnit: budget.timeUnit } : {}),
    periodStart: periodStart.toISOString(),
    ...(periodEnd ? { periodEnd: periodEnd.toISOString() } : {}),
    localEstimateUsd: input.localEstimateUsd,
    ...(input.realReportedUsd !== undefined ? { realReportedUsd: input.realReportedUsd } : {}),
    effectiveUsd,
    breached,
    enforced: true,
    degraded: false,
    ...(breached ? { reason: `spend ${effectiveUsd.toFixed(2)} reached cap ${budget.limitUsd.toFixed(2)} (${budget.name})` } : {}),
    identities: input.identities,
    computedAt,
  };
}

/**
 * The killer's transition rule: act when the account ENTERS breach from the
 * guard's point of view — including the first observation ever seen by this
 * guard (a fresh daemon starting against an already-blown account kills;
 * sessions launched after that moment are blocked at the launch gate, so
 * anything still alive predates the cap being hit). An account that STAYED
 * breached across cycles is not re-killed: its sessions were already
 * terminated at the transition, and everything newer never launched.
 */
export function enteredBreach(previous: AccountSpendState | undefined, current: AccountSpendState): boolean {
  return current.breached && current.enforced && previous?.breached !== true;
}
