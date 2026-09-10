import { BudgetsClient, DescribeBudgetCommand, DescribeBudgetsCommand } from "@aws-sdk/client-budgets";
import { fromIni } from "@aws-sdk/credential-providers";
import type { Identity } from "../../identities/types.ts";
import { resolveAwsProfileForIdentity, type AwsProfileDeps } from "../../identities/aws-profile.ts";
import type { LimitWindow, OverageInfo, ToolLimitResult } from "./types.ts";

/**
 * AWS Bedrock limits, sourced from AWS Budgets — the ONLY AWS-native notion
 * of "how much of my spend allowance have I used" for an account (Bedrock
 * itself has no quota/usage endpoint that reports spend against a plan; the
 * model-running identity pays per token into the owning AWS account, and any
 * ceiling the user imposes is expressed as a Budget). Each COST budget in the
 * identity's mapped AWS account renders as one LimitWindow: the budget's
 * limit is the 100% mark, CalculatedSpend.ActualSpend is the usage, and the
 * reset follows the budget's own TimeUnit (a MONTHLY budget rolls over on the
 * 1st, a DAILY one tomorrow, and so on) — AWS recurring budgets set
 * TimePeriod.End to a far-future sentinel (2087), so the period END date is
 * never used as the reset, only the TimeUnit-derived next boundary.
 *
 * Auth is the AWS CLI's own: credentials come fromIni({ profile }) (which
 * transparently uses and refreshes the ~/.aws/sso/cache token for an
 * sso-session profile), the account id comes from the profile's
 * `sso_account_id` in ~/.aws/config (see identities/aws-profile.ts for the
 * identity -> profile mapping order). When that SSO token has expired the SDK
 * cannot authenticate non-interactively — reported honestly as unavailable
 * with the exact `aws sso login` command that fixes it (running the login
 * flow from inside ais is deliberately NOT attempted: it needs a browser).
 *
 * Identity -> tool mapping note: Bedrock-backed identities are regular codex
 * (or claude) AIS identities whose config points at Bedrock, so the codex
 * entry in limits/collect.ts's FETCHERS routes here for any identity
 * isBedrockIdentity() answers true for. This fetcher stamps provider
 * "aws-bedrock" ITSELF (multi-provider-adapter style) rather than going
 * through singleToolFetcher — providerForTool(codex) is "openai", which is
 * simply not the provider these results came from.
 */

/** The subset of the AWS Budgets `Budget` shape this module reads. Amounts
 * arrive as STRINGS on the wire. */
export interface BudgetWire {
  BudgetName?: string;
  BudgetType?: string;
  TimeUnit?: string;
  BudgetLimit?: { Amount?: string; Unit?: string };
  TimePeriod?: { Start?: string; End?: string };
  CalculatedSpend?: { ActualSpend?: { Amount?: string; Unit?: string } };
}

/** Seam over the two Budgets calls the fetcher needs — tests inject fixture
 * responses here instead of stubbing SDK classes. */
export interface BudgetsApi {
  listBudgets(accountId: string): Promise<BudgetWire[]>;
  describeBudget(accountId: string, budgetName: string): Promise<BudgetWire>;
}

function defaultBudgetsApi(profile: string, region: string | undefined): BudgetsApi {
  const client = new BudgetsClient({
    ...(region ? { region } : {}),
    credentials: fromIni({ profile, ignoreCache: false }),
  });
  return {
    async listBudgets(accountId) {
      const budgets: BudgetWire[] = [];
      let nextToken: string | undefined;
      do {
        // The Budgets service's list operation is old-style "Describe*" —
        // there is no ListBudgets command in the SDK.
        const page = (await client.send(new DescribeBudgetsCommand({ AccountId: accountId, ...(nextToken ? { NextToken: nextToken } : {}) }))) as {
          Budgets?: BudgetWire[];
          NextToken?: string;
        };
        budgets.push(...(page.Budgets ?? []));
        nextToken = page.NextToken;
      } while (nextToken);
      return budgets;
    },
    async describeBudget(accountId, budgetName) {
      const response = await client.send(new DescribeBudgetCommand({ AccountId: accountId, BudgetName: budgetName }));
      return (response.Budget as BudgetWire | undefined) ?? {};
    },
  };
}

export interface AwsBedrockLimitsDeps {
  budgets?: BudgetsApi;
  now?: () => Date;
  awsProfileDeps?: AwsProfileDeps;
}

/** The account-scoped budget fetch shared by the `ais limits` identity path
 * (fetchAwsBedrockLimits below) and the spend guard's per-account cycle
 * (spend/compute.ts): DescribeBudgets for the list (which alone carries no
 * CalculatedSpend), then DescribeBudget per budget for the actual-spend
 * figure. Transient blips retry like every other fetcher; SSO expiry and
 * hard failures come back classified in `error`/`ssoError` instead of
 * thrown, so neither caller has to re-implement the taxonomy. Exported for
 * the guard and for tests. */
export async function fetchAccountBudgetWires(
  target: { profile: string; region?: string; accountId: string },
  api: BudgetsApi = defaultBudgetsApi(target.profile, target.region),
): Promise<{ budgets: BudgetWire[]; error?: string; ssoError?: boolean }> {
  try {
    return {
      budgets: await withAwsTransientRetry(async () => {
        const listed = await api.listBudgets(target.accountId);
        return Promise.all(
          listed.map(async (budget) =>
            budget.BudgetName ? { ...budget, ...(await api.describeBudget(target.accountId, budget.BudgetName!)) } : budget,
          ),
        );
      }),
    };
  } catch (err) {
    if (isSsoAuthError(err)) {
      return {
        budgets: [],
        ssoError: true,
        error: `AWS SSO credentials expired or unavailable for profile "${target.profile}" — run \`aws sso login --profile ${target.profile}\`, then retry`,
      };
    }
    return { budgets: [], error: `AWS Budgets query failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function formatResetsAt(date: Date): string {
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The next boundary of the period CONTAINING `now`, per the budget's own
 * TimeUnit — what AWS's recurring budgets actually reset on. Exported pure
 * for tests. */
export function resetDateForTimeUnit(timeUnit: string | undefined, now: Date): Date | undefined {
  const year = now.getFullYear();
  const month = now.getMonth();
  switch (timeUnit) {
    case "DAILY":
      return new Date(year, month, now.getDate() + 1);
    case "MONTHLY":
      return new Date(year, month + 1, 1);
    case "QUARTERLY":
      return new Date(year, month + (3 - (month % 3)), 1);
    case "ANNUALLY":
      return new Date(year + 1, 0, 1);
    default:
      return undefined;
  }
}

function amount(wire: { Amount?: string; Unit?: string } | undefined): number | undefined {
  if (!wire?.Amount) return undefined;
  const value = Number(wire.Amount);
  return Number.isFinite(value) ? value : undefined;
}

/** Pure mapping from one DescribeBudget-calibre Budget object to a display
 * window. Only COST budgets render (a USAGE/RI-utilisation budget's "limit"
 * is not dollars); a COST budget with no parseable limit is skipped rather
 * than guessed at. usedPercent is deliberately NOT clamped — an over-budget
 * account is over 100%, renderBar clamps for display, and the raw figure
 * stays honest in --json output. Exported for tests. */
export function windowFromBudget(budget: BudgetWire, deps: AwsBedrockLimitsDeps = {}): LimitWindow | undefined {
  if (budget.BudgetType !== "COST") return undefined;
  const name = budget.BudgetName;
  const limit = amount(budget.BudgetLimit);
  if (!name || limit === undefined) return undefined;
  const actual = amount(budget.CalculatedSpend?.ActualSpend) ?? 0;
  const over = actual > limit;
  return {
    label: `budget: ${name}`,
    category: "month",
    usedPercent: limit > 0 ? (actual / limit) * 100 : actual > 0 ? 100 : 0,
    resetsAt: (() => {
      const reset = resetDateForTimeUnit(budget.TimeUnit, deps.now?.() ?? new Date());
      return reset ? formatResetsAt(reset) : undefined;
    })(),
    ...(over ? { note: `over budget: $${actual.toFixed(2)} of $${limit.toFixed(2)}` } : {}),
  };
}

/** A budget actually blown past its limit IS real billed usage beyond the
 * configured allowance — the one AWS state that carries OverageInfo's
 * meaning (active: true, real dollars spent, real configured cap). Under
 * budget: no overage (a budget is a watch line, not a hard quota — being at
 * 90% of one is not "overage pending"). Exported for tests. */
export function overageFromBudgets(budgets: BudgetWire[]): OverageInfo | undefined {
  for (const budget of budgets) {
    if (budget.BudgetType !== "COST") continue;
    const limit = amount(budget.BudgetLimit);
    const actual = amount(budget.CalculatedSpend?.ActualSpend);
    if (limit === undefined || actual === undefined) continue;
    if (actual > limit) {
      return {
        active: true,
        label: `over budget: ${budget.BudgetName} ($${actual.toFixed(2)} of $${limit.toFixed(2)})`,
        spentUsd: actual,
        limitUsd: limit,
      };
    }
  }
  return undefined;
}

/** The AWS SDK's SSO-auth failure signatures (an expired or absent
 * sso-session token). Classified so the user gets the exact fix — an
 * interactive `aws sso login` this CLI cannot and must not attempt — instead
 * of a raw SDK stack line. Exported for tests. */
export function isSsoAuthError(error: unknown): boolean {
  const name = (error as { name?: string } | undefined)?.name ?? "";
  const message = error instanceof Error ? error.message : String(error);
  return /sso/i.test(name) || /sso session|sso token|expired token|invalid token|could not load credentials|no credentials/i.test(message);
}

/** Transport-level failure signatures (DNS, reset, Bun's endpoint-resolution
 * error) — the same machine's connectivity blips under report load that
 * ali-limits.ts's fetchWithRetry and codex-limits.ts's transient pattern
 * both ride out. SSO/auth failures never match, so they stay un-retried and
 * honestly classified. Exported for tests. */
const TRANSIENT_AWS_ERROR_PATTERN =
  /typo in the url|socket hang up|econn(reset|refused)|enotfound|etimedout|eai_again|connection (reset|closed|error)|premature close|aborted|timeout/i;

export function isTransientAwsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_AWS_ERROR_PATTERN.test(message);
}

/** Same pauses as limits/http.ts's fetchWithRetry and codex-limits.ts's
 * backoff (observed sufficient on this machine's blips). */
const AWS_RETRY_PAUSES_MS = [3_000, 8_000];

export async function withAwsTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= AWS_RETRY_PAUSES_MS.length; attempt++) {
    if (attempt > 0) await Bun.sleep(AWS_RETRY_PAUSES_MS[attempt - 1]!);
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientAwsError(err)) throw err;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${message} (still failing after ${AWS_RETRY_PAUSES_MS.length + 1} attempts)`);
}

function unavailable(identity: Identity, error: string): ToolLimitResult {
  return { toolName: "codex", provider: "aws-bedrock", identity, windows: [], status: "unavailable", error };
}

/**
 * Fetches the mapped AWS account's COST budgets for one Bedrock-backed
 * identity. Multi-provider-adapter shape: constructs full ToolLimitResults
 * (provider "aws-bedrock" stamped here) and may return [] — per the
 * explicitTool convention, an identity with nothing to report renders no row
 * in an unscoped report and one honest unavailable row when the user asked
 * for this source specifically. Real failures (SSO expired, SDK error,
 * malformed machine-local mapping) stay error rows either way.
 */
export async function fetchAwsBedrockLimits(identity: Identity, explicitTool: boolean, deps: AwsBedrockLimitsDeps = {}): Promise<ToolLimitResult[]> {
  let target;
  try {
    target = resolveAwsProfileForIdentity(identity, deps.awsProfileDeps);
  } catch (err) {
    return [unavailable(identity, err instanceof Error ? err.message : String(err))];
  }
  if (!target) {
    return explicitTool
      ? [unavailable(identity, `no AWS profile mapping for this identity — set AWS_PROFILE in the identity's registry env, or add one to ~/.ais/config/aws-profiles.json`)]
      : [];
  }

  if (!target.accountId) {
    return [unavailable(identity, `AWS profile "${target.profile}" has no sso_account_id in the AWS CLI config — cannot scope Budgets to an account`)];
  }

  const api = deps.budgets ?? defaultBudgetsApi(target.profile, target.region);
  const { budgets, error, ssoError } = await fetchAccountBudgetWires(
    { profile: target.profile, ...(target.region ? { region: target.region } : {}), accountId: target.accountId },
    api,
  );
  if (error !== undefined) {
    return [unavailable(identity, error)];
  }

  const windows = budgets.map((budget) => windowFromBudget(budget, deps)).filter((w): w is LimitWindow => w !== undefined);
  if (windows.length === 0) {
    return explicitTool ? [unavailable(identity, `no AWS COST budgets defined in account ...${target.accountId!.slice(-4)} — Budgets is the only limits source this provider has`)] : [];
  }

  const overage = overageFromBudgets(budgets);
  return [
    {
      toolName: "codex",
      provider: "aws-bedrock",
      identity,
      windows,
      status: "live",
      capturedAt: new Date().toISOString(),
      ...(overage ? { overage } : {}),
    },
  ];
}
