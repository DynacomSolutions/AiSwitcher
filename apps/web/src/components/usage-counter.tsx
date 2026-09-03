import { useMemo } from "react";

import { ProviderIcon } from "@/components/provider-icon";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useUsageQuery } from "@/hooks/queries";
import { formatDateMs, formatMoney, formatTokens } from "@/lib/format";
import type { UsageResult } from "@/types/api";

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
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <CounterCard label="Total tokens" value={formatTokens(totals.total)} sub="input + output, all providers" />
          <CounterCard label="Tokens today" value={formatTokens(totals.today)} sub="input + output since midnight" />
          <CounterCard label="Est. spend" value={formatMoney(totals.cost)} sub="all providers, all time" />
          <CounterCard label="Usage series" value={String(results.length)} sub="provider + identity pairs" />
        </div>
        <ProviderShareBars results={results} total={totals.total} />
      </CardContent>
    </Card>
  );
}

/** Per-provider share of all recorded tokens, biggest first, with a bar per
 * provider so the global counter reads at a glance. */
function ProviderShareBars({ results, total }: { results: UsageResult[]; total: number }) {
  const perProvider = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of results) {
      const rep = r.report;
      if (!rep) continue;
      const tokens = rep.totalInput + rep.totalOutput;
      if (tokens <= 0) continue;
      map.set(r.provider, (map.get(r.provider) ?? 0) + tokens);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [results]);

  if (perProvider.length === 0 || total <= 0) return null;
  const shown = perProvider.slice(0, 7);
  const rest = perProvider.slice(7).reduce((acc, [, tokens]) => acc + tokens, 0);
  const rows: [string, number][] = rest > 0 ? [...shown, ["other", rest]] : shown;

  return (
    <div className="space-y-2.5">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-3 text-sm font-semibold">
          <span>all providers</span>
          <span className="shrink-0 tabular-nums">
            {formatTokens(total)} · 100%
          </span>
        </div>
        <Progress value={100} />
      </div>
      {rows.map(([provider, tokens]) => {
        const share = total > 0 ? tokens / total : 0;
        return (
          <div key={provider} className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-1.5">
                <ProviderIcon provider={provider} size={13} />
                <span className="truncate">{provider}</span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatTokens(tokens)} · {Math.round(share * 100)}%
              </span>
            </div>
            <Progress value={clampShare(share)} />
          </div>
        );
      })}
    </div>
  );
}

function clampShare(share: number): number {
  if (!Number.isFinite(share)) return 0;
  return Math.min(100, Math.max(0, share * 100));
}
