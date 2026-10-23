import { formatUsageResponseTime, summarizeUsageSources, usageFreshness } from "@/lib/usage-summary";
import type { UsageResponse } from "@/types/api";

export function UsageDataStatus({
  response,
  refreshFailed = false,
}: {
  response?: UsageResponse;
  refreshFailed?: boolean;
}) {
  const results = response?.results ?? [];
  const counts = summarizeUsageSources(results);
  const freshness = usageFreshness(response, refreshFailed);
  const responseTime = formatUsageResponseTime(response?.generatedAt);
  const lastErrorTime = formatUsageResponseTime(freshness.lastErrorAt);

  // A successful empty response is still before the first usage data point.
  // Avoid presenting a source-coverage report until there is something to assess.
  if (!response || results.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-lg border px-3 py-2 text-xs ${freshness.stale || counts.errors > 0 || counts.pending > 0 || counts.historyUnavailable > 0 ? "border-amber-500/40 bg-amber-500/5" : "bg-muted/40"}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        <span>
          Estimate updated: {responseTime ?? "time unavailable"}.
        </span>
        {freshness.stale ? (
          <span className="font-medium">
            {freshness.refreshFailed
              ? `Showing the last available estimate; refresh failed${lastErrorTime ? ` at ${lastErrorTime}` : ""}.`
              : "Showing the last available estimate while refresh is in progress."}
          </span>
        ) : null}
        <span>{counts.sources} sources</span>
        {counts.errors > 0 ? <span>{counts.errors} error{counts.errors === 1 ? "" : "s"}</span> : null}
        {counts.pending > 0 ? <span>{counts.pending} pending</span> : null}
        {counts.historyUnavailable > 0 ? <span>{counts.historyUnavailable} without daily history</span> : null}
        {counts.errors > 0 || counts.pending > 0 ? <span>Totals may be partial.</span> : null}
      </div>
    </div>
  );
}
