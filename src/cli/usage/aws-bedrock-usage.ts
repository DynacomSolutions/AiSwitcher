import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import { fromIni } from "@aws-sdk/credential-providers";
import type { Identity } from "../../identities/types.ts";
import { resolveAwsProfileForIdentity, type AwsProfileDeps } from "../../identities/aws-profile.ts";
import { isSsoAuthError, withAwsTransientRetry } from "../limits/aws-bedrock-limits.ts";
import type { TokscaleEntry, TokscaleReport } from "./tokscale.ts";

/**
 * AWS Bedrock usage in REAL dollars, sourced from AWS Cost Explorer
 * GetCostAndUsage with Service == "Amazon Bedrock" and metric UnblendedCost
 * — actual billed amounts, NOT a token-count estimate (see AGENTS.md's AWS
 * Bedrock case study for why tokscale can never speak for this provider: its
 * public-pricing valuation needs per-message token counts, which Bedrock's
 * billing records don't expose, and it wouldn't be "real" spend anyway).
 * Both granularities are queried per the same window: MONTHLY buckets become
 * the report's per-month entries and the total that lands in the usage
 * table's cost column, DAILY buckets feed dailyCostUsd (a dollars-by-day
 * breakdown, JSON-visible; deliberately NOT dailyUsage, which is a
 * TOKEN-typed dimension shared with the token-count contribution graph).
 *
 * Cost Explorer only serves its API from us-east-1, regardless of the
 * profile's own region, so the client's region is forced here (credentials
 * are account-global; only the endpoint location matters). Like the Budgets
 * fetcher, auth is the AWS CLI's own SSO profile chain via
 * identities/aws-profile.ts.
 *
 * Mapping conventions: token/message figures are 0 because the source has no
 * token counts — the zeros are honest ("no token data"), never estimates;
 * the queried window is the trailing three calendar months, so totalCost
 * covers exactly the dateSpan the report advertises for this row.
 */

/** Thrown when the identity has no AWS profile mapping: "nothing to report"
 * for an unscoped report, one honest row when the user asked explicitly.
 * Distinct from a query failure, which is always an error row. */
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

function defaultCostExplorerApi(profile: string): CostExplorerApi {
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

export interface AwsBedrockUsageDeps {
  costExplorer?: CostExplorerApi;
  now?: () => Date;
  awsProfileDeps?: AwsProfileDeps;
}

export interface AwsBedrockUsageResult {
  report: TokscaleReport;
  dateSpan?: { firstMs: number; lastMs: number };
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

/** Pure mapping from the two wire responses to the report shape. Zero
 * buckets are skipped (a day/month with no Bedrock traffic contributes
 * nothing, matching how every other source omits empty buckets). Exported
 * for tests. */
export function reportFromCostExplorer(monthly: CostExplorerWire, daily: CostExplorerWire): AwsBedrockUsageResult {
  const entries: TokscaleEntry[] = [];
  let totalCost = 0;
  for (const bucket of monthly.ResultsByTime ?? []) {
    const start = bucket.TimePeriod?.Start;
    const cost = bucketAmount(bucket);
    if (!start || cost === undefined || cost === 0) continue;
    entries.push({
      client: "aws",
      model: start.slice(0, 7),
      provider: "aws-bedrock",
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      messageCount: 0,
      cost,
    });
    totalCost += cost;
  }

  const dailyCostUsd: Record<string, number> = {};
  let firstDay: string | undefined;
  let lastDay: string | undefined;
  for (const bucket of daily.ResultsByTime ?? []) {
    const day = bucket.TimePeriod?.Start?.slice(0, 10);
    const cost = bucketAmount(bucket);
    if (!day || cost === undefined || cost === 0) continue;
    dailyCostUsd[day] = cost;
    firstDay ??= day;
    lastDay = day;
  }

  return {
    report: {
      entries,
      totalInput: 0,
      totalOutput: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      totalMessages: 0,
      totalCost,
    },
    ...(firstDay && lastDay
      ? { dateSpan: { firstMs: Date.parse(`${firstDay}T00:00:00Z`), lastMs: Date.parse(`${lastDay}T23:59:59Z`) } }
      : {}),
    ...(Object.keys(dailyCostUsd).length > 0 ? { dailyCostUsd } : {}),
  };
}

/**
 * Fetches real Bedrock spend for one identity's mapped AWS account. Throws
 * AwsNoProfileMappedError when the identity has no profile mapping (callers
 * treat that as nothing-to-report), and raw errors for everything else
 * (query failures stay error rows; SSO expiry carries the aws sso login
 * hint via isSsoAuthError classification in the caller).
 */
export async function fetchAwsBedrockUsage(identity: Identity, deps: AwsBedrockUsageDeps = {}): Promise<AwsBedrockUsageResult> {
  const target = resolveAwsProfileForIdentity(identity, deps.awsProfileDeps);
  if (!target) {
    throw new AwsNoProfileMappedError(
      `no AWS profile mapping for this identity — set AWS_PROFILE in the identity's registry env, or add one to ~/.ais/config/aws-profiles.json`,
    );
  }

  const { start, end } = costExplorerWindow(deps.now?.() ?? new Date());
  const api = deps.costExplorer ?? defaultCostExplorerApi(target.profile);
  try {
    const [monthly, daily] = await withAwsTransientRetry(() =>
      Promise.all([api.getCostAndUsage("MONTHLY", start, end), api.getCostAndUsage("DAILY", start, end)]),
    );
    return reportFromCostExplorer(monthly, daily);
  } catch (err) {
    if (isSsoAuthError(err)) {
      throw new Error(`AWS SSO credentials expired or unavailable for profile "${target.profile}" — run \`aws sso login --profile ${target.profile}\`, then retry`);
    }
    throw err;
  }
}
