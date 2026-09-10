import {
  fetchAccountBudgetWires,
  type BudgetsApi,
  type BudgetWire,
} from "../cli/limits/aws-bedrock-limits.ts";
import { defaultCostExplorerApi, sumCostExplorerBuckets, type CostExplorerApi } from "../cli/usage/aws-bedrock-usage.ts";
import type { AwsProfileDeps } from "../identities/aws-profile.ts";
import { periodStartForTimeUnit, chooseBudget, computeAccountState, type AccountSpendState, type BudgetSnapshot } from "./state.ts";
import { resolveGuardAccounts, type GuardAccount } from "./accounts.ts";
import { estimateIdentityLocalSpend } from "./local-estimate.ts";

/**
 * One full spend-guard cycle: per AWS account, fetch THIS cycle's real
 * signals (budget limit + budget actual from AWS Budgets, Bedrock spend
 * from Cost Explorer), sum every mapped identity's local token-based
 * estimate over the budget's current period, and reduce to the pure
 * AccountSpendState. Consumers: the console daemon's periodic guard (which
 * additionally acts on breach transitions), the internal `ais
 * __spend_refresh` command the launch gate spawns detached, and `ais
 * doctor`'s spend section (read-only live view).
 *
 * Every fetch failure is degraded-and-reasoned, never thrown: SSO expiry,
 * API downtime, or a missing budget leave the account unenforced but loud.
 */

export interface SpendGuardCycleResult {
  states: Record<string, AccountSpendState>;
  errors: string[];
  computedAt: string;
}

export interface SpendCycleDeps {
  /** Pre-resolved accounts (tests / callers that already enumerated).
   * Default: walk every tool registry. */
  accounts?: GuardAccount[];
  budgets?: BudgetsApi;
  costExplorer?: CostExplorerApi;
  now?: () => Date;
  awsProfileDeps?: AwsProfileDeps;
  localEstimate?: typeof estimateIdentityLocalSpend;
}

/** Pure mapping from the wire budgets to the snapshots the state core
 * consumes: COST budgets only (a USAGE budget's "limit" is not dollars),
 * skip unparseable limits, actual spend defaults to 0 (AWS leaves
 * CalculatedSpend absent until it has computed something). Exported for
 * tests. */
export function budgetSnapshotsFromWires(budgets: BudgetWire[]): BudgetSnapshot[] {
  const snapshots: BudgetSnapshot[] = [];
  for (const budget of budgets) {
    if (budget.BudgetType !== "COST") continue;
    const name = budget.BudgetName;
    const limit = budget.BudgetLimit?.Amount !== undefined ? Number(budget.BudgetLimit.Amount) : undefined;
    if (!name || limit === undefined || !Number.isFinite(limit)) continue;
    const actualRaw = budget.CalculatedSpend?.ActualSpend?.Amount;
    const actual = actualRaw !== undefined ? Number(actualRaw) : 0;
    snapshots.push({
      name,
      limitUsd: limit,
      actualUsd: Number.isFinite(actual) ? actual : 0,
      ...(budget.TimeUnit ? { timeUnit: budget.TimeUnit } : {}),
    });
  }
  return snapshots;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function runSpendGuardCycle(deps: SpendCycleDeps = {}): Promise<SpendGuardCycleResult> {
  const now = deps.now?.() ?? new Date();
  const computedAt = now.toISOString();
  const errors: string[] = [];
  const { accounts, errors: mappingErrors } = deps.accounts
    ? { accounts: deps.accounts, errors: [] as string[] }
    : await resolveGuardAccounts(undefined, deps.awsProfileDeps);
  errors.push(...mappingErrors);

  const states: Record<string, AccountSpendState> = {};
  await Promise.all(
    accounts.map(async (account) => {
      const budgetFetch = await fetchAccountBudgetWires(
        {
          profile: account.profile,
          ...(account.region ? { region: account.region } : {}),
          accountId: account.accountId,
        },
        deps.budgets,
      );
      if (budgetFetch.error !== undefined) errors.push(`account ...${account.accountId.slice(-4)}: ${budgetFetch.error}`);

      const snapshots = budgetSnapshotsFromWires(budgetFetch.budgets);
      const budget = chooseBudget(snapshots);
      const periodStart = periodStartForTimeUnit(budget?.timeUnit, now);

      const localEstimate = deps.localEstimate ?? estimateIdentityLocalSpend;
      let localUsd = 0;
      for (const { toolName, identity } of account.identities) {
        localUsd += localEstimate(toolName, identity.configDir, periodStart).usd;
      }

      let realReportedUsd: number | undefined;
      if (budgetFetch.error === undefined) {
        try {
          const api = deps.costExplorer ?? defaultCostExplorerApi(account.profile);
          const start = isoDay(periodStart);
          const end = isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
          const wire = await api.getCostAndUsage("DAILY", start, end);
          realReportedUsd = sumCostExplorerBuckets(wire);
        } catch (err) {
          errors.push(
            `account ...${account.accountId.slice(-4)}: Cost Explorer query failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      states[account.accountId] = computeAccountState(
        {
          accountId: account.accountId,
          profile: account.profile,
          ...(account.region ? { region: account.region } : {}),
          budgets: snapshots,
          ...(budgetFetch.error !== undefined ? { budgetError: budgetFetch.error } : {}),
          localEstimateUsd: localUsd,
          ...(realReportedUsd !== undefined ? { realReportedUsd } : {}),
          identities: account.identities.map(({ identity }) => identity.name),
          now,
        },
        now,
      );
    }),
  );

  return { states, errors, computedAt };
}
