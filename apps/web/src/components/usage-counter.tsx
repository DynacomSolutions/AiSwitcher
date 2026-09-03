import { useMemo } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useUsageQuery } from "@/hooks/queries";
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

/** The global usage counter, mirroring `ais usage`'s TOTAL row: every
 * provider, every identity, all recorded history. Rendered anywhere a
 * global view makes sense (dashboard, limits page). */
export function GlobalUsageCards({ title = "Global usage" }: { title?: string }) {
  const query = useUsageQuery();
  const results = query.data?.results ?? [];
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

  return (
    <Card className="gap-3">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        <span className="text-xs text-muted-foreground">{results.length} series</span>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <CounterCard label="Total tokens" value={formatTokens(totals.total)} sub="input + output, all providers" />
          <CounterCard label="Tokens today" value={formatTokens(totals.today)} sub="input + output since midnight" />
          <CounterCard label="Est. spend" value={formatMoney(totals.cost)} sub="all providers, all time" />
          <CounterCard label="Usage series" value={String(results.length)} sub="provider + identity pairs" />
        </div>
      </CardContent>
    </Card>
  );
}
