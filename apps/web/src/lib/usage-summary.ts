import type { UsageResponse, UsageResult } from "../types/api";

export interface UsageSummaryCounts {
  sources: number;
  errors: number;
  pending: number;
  historyUnavailable: number;
}

export interface UsageFreshness {
  stale: boolean;
  refreshFailed: boolean;
  lastErrorAt?: string;
}

export type UsageErrorKind = "timeout" | "out-of-memory" | "process-failure" | "unavailable" | "unpriced" | "source-error";

/** Return a short category only; source error text can contain paths or other identifiers. */
export function classifyUsageError(error: string | undefined): UsageErrorKind {
  if (!error) return "source-error";
  if (/out of memory|\boom(?:-killed)?\b/i.test(error)) return "out-of-memory";
  if (/timed?\s*out|timeout/i.test(error)) return "timeout";
  if (/unpriced|pricing (?:is )?unavailable|no pricing/i.test(error)) return "unpriced";
  if (/unavailable|not available|no .* data yet|could not read/i.test(error)) return "unavailable";
  if (/exited with code|process failed|failed to spawn/i.test(error)) return "process-failure";
  return "source-error";
}

export function usageErrorLabel(kind: UsageErrorKind): string {
  switch (kind) {
    case "timeout": return "Source timed out";
    case "out-of-memory": return "Source ran out of memory";
    case "process-failure": return "Source process failed";
    case "unavailable": return "Source unavailable";
    case "unpriced": return "Pricing unavailable";
    case "source-error": return "Source error";
  }
}

export function isInitialUsageScanPending(response: Pick<UsageResponse, "pending" | "results"> | undefined): boolean {
  return response?.pending === true && response.results.length === 0;
}

/** Check source coverage independently of date and model filters. */
export function hasPartialUsageCoverage(
  results: UsageResult[],
  filters: { provider: string; tool: string; identity: string },
): boolean {
  return results.some((result) => {
    if (filters.provider !== "all" && result.provider !== filters.provider) return false;
    if (filters.tool !== "all" && (result.sourceTool ?? "unknown") !== filters.tool) return false;
    if (filters.identity !== "all" && result.identity.name !== filters.identity) return false;
    return Boolean(result.error || result.pending);
  });
}

/** Collapse server and client refresh state without returning raw error text. */
export function usageFreshness(
  response: Partial<Pick<UsageResponse, "stale" | "lastError" | "lastErrorAt">> | undefined,
  queryRefreshFailed = false,
): UsageFreshness {
  const refreshFailed = queryRefreshFailed || Boolean(response?.lastError);
  return {
    stale: response?.stale === true || refreshFailed,
    refreshFailed,
    ...(response?.lastErrorAt ? { lastErrorAt: response.lastErrorAt } : {}),
  };
}

/** Summarise source coverage without treating a zero dollar estimate as proof
 * that pricing is missing. The API does not expose pricing coverage. */
export function summarizeUsageSources(results: UsageResult[]): UsageSummaryCounts {
  let errors = 0;
  let pending = 0;
  let historyUnavailable = 0;
  let hasHistoryCoverage = false;

  for (const result of results) {
    if (result.error) errors += 1;
    if (result.pending) pending += 1;
    if (result.report && result.dailyUsage && Object.keys(result.dailyUsage).length > 0) hasHistoryCoverage = true;
  }

  if (hasHistoryCoverage) {
    historyUnavailable = results.filter((result) => result.report && !Object.keys(result.dailyUsage ?? {}).length).length;
  }

  return { sources: results.length, errors, pending, historyUnavailable };
}

export function formatUsageResponseTime(generatedAt: string | undefined): string | undefined {
  if (!generatedAt) return undefined;
  const time = new Date(generatedAt);
  if (Number.isNaN(time.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(time);
}
