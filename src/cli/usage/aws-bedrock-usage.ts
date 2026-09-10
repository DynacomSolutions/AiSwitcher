import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { fromIni } from "@aws-sdk/credential-providers";
import type { Identity, ToolConfig } from "../../identities/types.ts";
import { resolveAwsProfileForIdentity, type AwsProfileDeps } from "../../identities/aws-profile.ts";
import { fetchAccountBudgetWires, isSsoAuthError, withAwsTransientRetry, type BudgetsApi } from "../limits/aws-bedrock-limits.ts";
import { readIdentityLocalSpend, type LocalEstimateDeps, type LocalSpendRead } from "../../shared/local-spend.ts";
import { budgetSnapshotsFromWires, chooseBudget } from "../../spend/state.ts";
import type { TokscaleEntry, TokscaleReport } from "./tokscale.ts";

/**
 * AWS Bedrock usage for one identity, in two strictly separated layers:
 *
 *   - LOCAL TRACKING (the report's normal columns): messages, input/output/
 *     cache tokens and the EST. COST column all come from this identity's
 *     own session logs (codex rollout / claude projects JSONL) via
 *     shared/local-spend.ts: the exact same reader, period filter and
 *     Bedrock-rate valuation the spend guard uses, over the same
 *     month-to-date window. A Bedrock row's local figures therefore
 *     reconcile with the guard's per-identity estimate by construction, and
 *     render exactly like every other provider's rows.
 *
 *   - REAL AWS SPEND (separate realCost info, rendered as a dimmed sub-row
 *     under the provider row): Cost Explorer GetCostAndUsage UnblendedCost
 *     with Service == "Amazon Bedrock": actual billed amounts, NEVER a
 *     token-count estimate (see AGENTS.md's AWS Bedrock case study for why
 *     tokscale can never speak for this provider), plus the enforced COST
 *     budget's limit and ActualSpend from AWS Budgets when available. Real
 *     figures never land in the EST. COST column, and estimates never land
 *     in realCost; the two layers never swap places again (that conflation
 *     was the 2026-09 display regression).
 *
 * Cost Explorer only serves its API from us-east-1, regardless of the
 * profile's own region, so the client's region is forced here (credentials
 * are account-global; only the endpoint location matters). The queried
 * window stays the trailing three calendar months: DAILY buckets are the
 * source for both the month-to-date real figure and dailyCostUsd (a
 * dollars-by-day breakdown, JSON-visible; deliberately NOT dailyUsage,
 * which is a TOKEN-typed dimension shared with the token-count contribution
 * graph), MONTHLY buckets sum to windowUsd. Like the Budgets fetcher, auth
 * is the AWS CLI's own SSO profile chain via identities/aws-profile.ts.
 *
 * A failed Cost Explorer query does NOT sink the row: local tracking is
 * fully offline and still renders; the failure rides in realCost.error so
 * the real sub-row can say "unavailable" honestly. Budget context is
 * best-effort on top of that (its absence shows fewer parenthesised
 * figures, never a wrong one).
 */

/** Thrown when the identity has no AWS profile mapping: "nothing to report"
 * for an unscoped report, one honest row when the user asked explicitly.
 * Distinct from a query failure, which no longer costs the row its local
 * figures (see realCost.error). */
export class AwsNoProfileMappedError extends Error {}

/** The subset of a GetCostAndUsage response this module reads. */
export interface CostAndUsageBucket {
  TimePeriod?: { Start?: string; End?: string };
  Total?: { UnblendedCost?: { Amount?: string; Unit?: string } };
}

export interface CostExplorerWire {
  ResultsByTime?: CostAndUsageBucket[];
}

export interface CostExplorerApi {
  getCostAndUsage(granularity: "DAILY" | "MONTHLY", start: string, end: string): Promise<CostExplorerWire>;
}

/** Cost Explorer serves ONLY from us-east-1 — forced regardless of profile
 * region (confirmed behaviour of the service, not a per-account quirk). */
export const COST_EXPLORER_REGION = "us-east-1";

/** Exported (not just for fetchAwsBedrockUsage) so the spend guard's
 * per-account cycle can reuse the exact same endpoint/pagination/filter
 * behaviour with its own window. */
export function defaultCostExplorerApi(profile: string): CostExplorerApi {
  const client = new CostExplorerClient({
    region: COST_EXPLORER_REGION,
    credentials: fromIni({ profile, ignoreCache: false }),
  });
  return {
    async getCostAndUsage(granularity, start, end) {
      const pages: CostExplorerWire[] = [];
      let nextToken: string | undefined;
      do {
        const page = (await client.send(
          new GetCostAndUsageCommand({
            TimePeriod: { Start: start, End: end },
            Granularity: granularity,
            Metrics: ["UnblendedCost"],
            Filter: { Dimensions: { Key: "SERVICE", Values: ["Amazon Bedrock"] } },
            ...(nextToken ? { NextToken: nextToken } : {}),
          }),
        )) as CostExplorerWire & { NextToken?: string };
        pages.push(page);
        nextToken = page.NextToken;
      } while (nextToken);
      return { ResultsByTime: pages.flatMap((page) => page.ResultsByTime ?? []) };
    },
  };
}

/** REAL AWS-reported spend for one Bedrock row: every dollar figure in here
 * comes from AWS's own billing plane, never from a token estimate. The
 * label is fixed so consumers never have to guess which figure is which. */
export interface RealCostInfo {
  label: string;
  /** Cost Explorer UnblendedCost month-to-date (sum of the month's UTC-day
   * buckets, the same slice the spend guard blends as realReportedUsd).
   * Absent exactly when the query failed this run (see error). */
  monthToDateUsd?: number;
  /** UnblendedCost over the full trailing window (three calendar months),
   * the figure the pre-regression display used to carry in its cost
   * column. Context for "how much of the window predates this month". */
  windowUsd?: number;
  /** The enforced COST budget's ActualSpend (AWS Budgets), when the budget
   * fetch succeeded (AWS's other real figure, free with the limit). */
  budgetActualUsd?: number;
  /** The enforced COST budget's limit, when available. */
  budgetLimitUsd?: number;
  /** Human note such as "reported lag" when AWS's real figure trails the
   * local estimate (billing data lands hours behind usage). */
  note?: string;
  /** Present when the Cost Explorer query failed: the real figure is
   * UNAVAILABLE (SSO expiry, API down), which is not the same as zero. */
  error?: string;
}

/** The fixed real-cost label, shared by the CLI sub-row, the JSON payload
 * and the TUI mapping: "real" is a provenance claim, never a guess. */
export const REAL_COST_LABEL = "real AWS month-to-date";

export interface AwsBedrockUsageDeps {
  costExplorer?: CostExplorerApi;
  budgets?: BudgetsApi;
  now?: () => Date;
  awsProfileDeps?: AwsProfileDeps;
  /** Which wrapper's session logs to read locally (the identity kinds that
   * can be Bedrock-backed). Defaults to "codex" (today's only routing into
   * this fetcher) and is threaded from the caller so a future claude route
   * reads claude project logs without changes here. */
  localTool?: ToolConfig["toolName"];
  /** Injectable fs layer for the local readers (tests). */
  localSpendDeps?: LocalEstimateDeps;
  /** Injectable local reader itself (tests). */
  localSpend?: typeof readIdentityLocalSpend;
}

export interface AwsBedrockUsageResult {
  /** LOCAL month-to-date tracking: token totals, per-model entries and the
   * token-based EST. COST: the row's normal columns. */
  report: TokscaleReport;
  dateSpan?: { firstMs: number; lastMs: number };
  /** Local tokens (input+output) per LOCAL day, feeding the shared
   * contribution graph like every other provider. */
  dailyUsage?: Record<string, number>;
  /** REAL AWS-reported spend + budget context, rendered separately from
   * the estimate columns. */
  realCost?: RealCostInfo;
  /** Local-independent "YYYY-MM-DD" (UTC, Cost Explorer's own bucket keys) ->
   * real dollars billed that day. Only days with a nonzero bucket. */
  dailyCostUsd?: Record<string, number>;
}

const WINDOW_MONTHS = 3;

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The GetCostAndUsage window: the trailing WINDOW_MONTHS calendar months
 * (UTC), end exclusive as the API requires. Exported pure for tests. */
export function costExplorerWindow(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (WINDOW_MONTHS - 1), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return { start: isoDay(start), end: isoDay(end) };
}

function bucketAmount(time: CostAndUsageBucket): number | undefined {
  const raw = time.Total?.UnblendedCost?.Amount;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Pure sum of a GetCostAndUsage response's UnblendedCost buckets — the one
 * figure the spend guard needs from Cost Explorer (period Bedrock spend).
 * Buckets without a parsable amount contribute 0. Exported for the guard
 * and for tests. */
export function sumCostExplorerBuckets(wire: CostExplorerWire): number {
  let total = 0;
  for (const bucket of wire.ResultsByTime ?? []) {
    const amount = bucketAmount(bucket);
    if (amount !== undefined) total += amount;
  }
  return total;
}

/** Pure mapping from the two wire responses to the REAL figures the report
 * carries separately from the estimate: month-to-date (sum of the UTC-day
 * buckets on/after `mtdStartDay`, in wire order: the same slice, order and
 * metric the spend guard blends), the full-window total (the monthly
 * buckets), and the JSON-only dollars-by-day breakdown. Zero buckets are
 * skipped (a day with no Bedrock traffic contributes nothing, matching how
 * every other source omits empty buckets). Exported for tests. */
export function realCostFromCostExplorer(
  monthly: CostExplorerWire,
  daily: CostExplorerWire,
  mtdStartDay: string,
): { monthToDateUsd: number; windowUsd: number; dailyCostUsd: Record<string, number> } {
  let monthToDateUsd = 0;
  const dailyCostUsd: Record<string, number> = {};
  for (const bucket of daily.ResultsByTime ?? []) {
    const day = bucket.TimePeriod?.Start?.slice(0, 10);
    const cost = bucketAmount(bucket);
    if (!day || cost === undefined || cost === 0) continue;
    dailyCostUsd[day] = cost;
    if (day >= mtdStartDay) monthToDateUsd += cost;
  }
  return { monthToDateUsd, windowUsd: sumCostExplorerBuckets(monthly), dailyCostUsd };
}

/** Pure mapping from the local read to the report shape every other
 * provider renders: per-model entries plus the totals, with totalCost =
 * the local token-based estimate (Bedrock on-demand rates, unknown models
 * at the table's conservative fallback, the same valuation as the guard).
 * Exported for tests. */
export function reportFromLocalRead(read: LocalSpendRead): TokscaleReport {
  const entries: TokscaleEntry[] = read.models.map((model) => ({
    client: "aws",
    model: model.model,
    provider: "aws-bedrock",
    input: model.input,
    output: model.output,
    cacheRead: model.cacheRead,
    cacheWrite: model.cacheWrite,
    reasoning: 0,
    messageCount: model.messageCount,
    cost: model.usd,
  }));
  return {
    entries,
    totalInput: read.input,
    totalOutput: read.output,
    totalCacheRead: read.cacheRead,
    totalCacheWrite: read.cacheWrite,
    totalMessages: read.messages,
    totalCost: read.usd,
  };
}

/** The REAL half of the result: Cost Explorer figures plus best-effort
 * budget context. A CE failure is degraded (realCost.error), never thrown:
 * the local half of the row stays intact. */
async function fetchRealCost(
  target: { profile: string; accountId?: string; region?: string },
  read: LocalSpendRead,
  deps: AwsBedrockUsageDeps,
  now: Date,
): Promise<{ realCost: RealCostInfo; dailyCostUsd?: Record<string, number> }> {
  const { start, end } = costExplorerWindow(now);
  let monthToDateUsd: number | undefined;
  let windowUsd: number | undefined;
  let dailyCostUsd: Record<string, number> | undefined;
  let error: string | undefined;
  try {
    const api = deps.costExplorer ?? defaultCostExplorerApi(target.profile);
    const [monthly, daily] = await withAwsTransientRetry(() =>
      Promise.all([api.getCostAndUsage("MONTHLY", start, end), api.getCostAndUsage("DAILY", start, end)]),
    );
    const mapped = realCostFromCostExplorer(monthly, daily, isoDay(new Date(now.getFullYear(), now.getMonth(), 1)));
    monthToDateUsd = mapped.monthToDateUsd;
    windowUsd = mapped.windowUsd;
    dailyCostUsd = mapped.dailyCostUsd;
  } catch (err) {
    // Same taxonomy as before, just non-fatal for the row: SSO expiry
    // carries the exact fix, everything else reports the raw failure.
    error = isSsoAuthError(err)
      ? `AWS SSO credentials expired or unavailable for profile "${target.profile}" — run \`aws sso login --profile ${target.profile}\`, then retry`
      : err instanceof Error
        ? err.message
        : String(err);
  }

  // Budget context is the second real figure (limit + ActualSpend from AWS
  // Budgets). Best-effort: a Budgets failure just means fewer parenthesised
  // figures in the sub-row, never a fabricated one.
  let budgetActualUsd: number | undefined;
  let budgetLimitUsd: number | undefined;
  if (target.accountId) {
    const budgetFetch = await fetchAccountBudgetWires(
      { profile: target.profile, ...(target.region ? { region: target.region } : {}), accountId: target.accountId },
      deps.budgets,
    );
    const budget = chooseBudget(budgetSnapshotsFromWires(budgetFetch.budgets));
    if (budget) {
      budgetLimitUsd = budget.limitUsd;
      budgetActualUsd = budget.actualUsd;
    }
  }

  const realCost: RealCostInfo = {
    label: REAL_COST_LABEL,
    ...(monthToDateUsd !== undefined ? { monthToDateUsd } : {}),
    ...(windowUsd !== undefined ? { windowUsd } : {}),
    ...(budgetLimitUsd !== undefined ? { budgetLimitUsd } : {}),
    ...(budgetActualUsd !== undefined ? { budgetActualUsd } : {}),
    ...(monthToDateUsd !== undefined && monthToDateUsd < read.usd ? { note: "reported lag" } : {}),
    ...(error ? { error } : {}),
  };
  return { realCost, ...(dailyCostUsd && Object.keys(dailyCostUsd).length > 0 ? { dailyCostUsd } : {}) };
}

/**
 * Fetches one Bedrock-backed identity's usage: the local month-to-date
 * report (normal columns) plus the real AWS figures (separate realCost).
 * Throws AwsNoProfileMappedError when the identity has no profile mapping
 * (callers treat that as nothing-to-report); everything else degrades into
 * the result so one billing-plane failure cannot blank the local tracking
 * again (the 2026-09 display regression).
 */
export async function fetchAwsBedrockUsage(identity: Identity, deps: AwsBedrockUsageDeps = {}): Promise<AwsBedrockUsageResult> {
  const target = resolveAwsProfileForIdentity(identity, deps.awsProfileDeps);
  if (!target) {
    throw new AwsNoProfileMappedError(
      `no AWS profile mapping for this identity — set AWS_PROFILE in the identity's registry env, or add one to ~/.ais/config/aws-profiles.json`,
    );
  }

  const now = deps.now?.() ?? new Date();
  // Month-to-date, local calendar: the same frame the guard's MONTHLY
  // budget period uses (periodStartForTimeUnit), so an identity's local
  // totals here reconcile with the guard's per-identity estimate.
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const read = (deps.localSpend ?? readIdentityLocalSpend)(deps.localTool ?? "codex", identity.configDir, periodStart, deps.localSpendDeps ?? {});

  const { realCost, dailyCostUsd } = await fetchRealCost(target, read, deps, now);

  return {
    report: reportFromLocalRead(read),
    ...(read.firstMs !== undefined && read.lastMs !== undefined ? { dateSpan: { firstMs: read.firstMs, lastMs: read.lastMs } } : {}),
    ...(Object.keys(read.dailyTokens).length > 0 ? { dailyUsage: read.dailyTokens } : {}),
    realCost,
    ...(dailyCostUsd ? { dailyCostUsd } : {}),
  };
}
