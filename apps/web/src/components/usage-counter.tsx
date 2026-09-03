import { useMemo } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useLimitsQuery, useUsageQuery } from "@/hooks/queries";
import { formatDateMs, formatMoney, formatTokens } from "@/lib/format";

function CounterCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-xl tabular-nums">{value}</CardTitle>
        {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
      </CardHeader>
    </Card>
  );
}

function barTone(percent: number): string | undefined {
  if (percent >= 80) return "bg-red-500";
  if (percent >= 50) return "bg-amber-500";
  return undefined;
}

/** The global usage counter, mirroring `ais usage`'s TOTAL row (every
 * provider, every identity, all recorded history) plus the CLI limits
 * report's window bars averaged across every provider: one Session bar,
 * one Weekly bar. Per-provider quota detail stays on the provider cards. */
export function GlobalUsageCards({ title = "Global usage" }: { title?: string }) {
  const usage = useUsageQuery();
  const limits = useLimitsQuery();
  const results = usage.data?.results ?? [];
  const limitResults = limits.data?.results ?? [];
  const totals = useMemo(() => {
    let input = 0;
    let output = 0;
    let cost = 0;
    let today = 0;
    const todayKey = formatDateMs(Date.now());
    for (const r of results) {
      const rep = r.report;
      if (rep) {
        input += rep.totalInput;
        output += rep.totalOutput;
        cost += rep.totalCost;
      }
      const dayTokens = r.dailyUsage?.[todayKey];
      if (typeof dayTokens === "number") today += dayTokens;
    }
    return { total: input + output, today, cost };
  }, [results]);

  const windowBars = useMemo(() => {
    const buckets: Record<"session" | "week", number[]> = { session: [], week: [] };
    for (const r of limitResults) {
      if (r.status === "unavailable" || r.status === "pending") continue;
      for (const w of r.windows ?? []) {
        if (w.category === "session") buckets.session.push(w.usedPercent);
        else if (w.category === "week") buckets.week.push(w.usedPercent);
      }
    }
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return [
      { label: "Session", avg: avg(buckets.session), count: buckets.session.length },
      { label: "Weekly", avg: avg(buckets.week), count: buckets.week.length },
    ].filter((b) => b.avg !== null) as { label: string; avg: number; count: number }[];
  }, [limitResults]);

  const usageLoading = usage.isLoading || (results.length === 0 && usage.isPending);
  const limitsLoading = limits.isLoading || (limitResults.length === 0 && limits.isPending);

  return (
    <Card className="gap-3">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        <span className="text-xs text-muted-foreground">{results.length} series</span>
      </CardHeader>
      <CardContent className="space-y-4">
        {usageLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <CounterCard label="Total tokens" value={formatTokens(totals.total)} sub="input + output, all providers" />
            <CounterCard label="Tokens today" value={formatTokens(totals.today)} sub="input + output since midnight" />
            <CounterCard label="Est. spend" value={formatMoney(totals.cost)} sub="all providers, all time" />
            <CounterCard label="Usage series" value={String(results.length)} sub="provider + identity pairs" />
          </div>
        )}

        {!limitsLoading && windowBars.length > 0 ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Quota usage averaged across all providers</p>
            {windowBars.map((bar) => (
              <div key={bar.label} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span>
                    {bar.label}{" "}
                    <span className="text-xs text-muted-foreground">· {bar.count} quotas averaged</span>
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">{bar.avg.toFixed(1)}%</span>
                </div>
                <Progress value={Math.min(100, Math.max(0, bar.avg))} indicatorClassName={barTone(bar.avg)} />
              </div>
            ))}
          </div>
        ) : limitsLoading ? (
          <div className="space-y-2.5">
            <div className="h-6 w-2/3 animate-pulse rounded-md bg-muted" />
            <div className="h-6 w-1/2 animate-pulse rounded-md bg-muted" />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
