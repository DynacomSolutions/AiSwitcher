import { useMemo } from "react";

import { ToolBadge } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useLimitsQuery, usePoolsUsageQuery, useUsageQuery } from "@/hooks/queries";
import { clampPercent, formatMoney, formatTokens } from "@/lib/format";
import { partialLabel, summarisePools, type MemberPeriod, type PeriodTotal, type PoolSummary } from "@/lib/pool-usage";
import type { ToolName } from "@/types/api";

function tone(percent: number): string | undefined {
  if (percent >= 90) return "bg-red-500";
  if (percent >= 70) return "bg-amber-500";
  return undefined;
}

function TotalBlock({ title, total }: { title: string; total: PeriodTotal }) {
  const partial = partialLabel(total);
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="text-lg font-semibold tabular-nums">{formatTokens(total.tokens)} tokens</div>
      <div className="text-sm tabular-nums text-muted-foreground">
        {total.unpricedRequests > 0 ? "at least " : "about "}
        {formatMoney(total.costUsd)}
      </div>
      <div className="text-xs text-muted-foreground">
        native {formatTokens(total.nativeTokens)}{total.gatewayCoveredByNative > 0 ? ` (includes ${formatTokens(total.gatewayCoveredByNative)} via agent gateway)` : ""}, gateway {formatTokens(total.gatewayTokens)}
      </div>
      {partial ? (
        <div className="space-y-0.5">
          <Badge variant="warning">{partial}</Badge>
          {total.missing.map((m) => (
            <div key={m.member} className="text-xs text-amber-600 dark:text-amber-400">
              {m.member}: {m.reason}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function memberTokens(p: MemberPeriod): string {
  if ("missing" in p.native || "missing" in p.gateway) {
    const known = ("missing" in p.native ? 0 : p.native.tokens) + ("missing" in p.gateway ? 0 : p.gateway.tokens);
    return `${formatTokens(known)}+`;
  }
  return formatTokens(p.native.tokens + p.gateway.tokens);
}

function PoolCard({ pool }: { pool: PoolSummary }) {
  return (
    <Card className="gap-4">
      <CardHeader className="space-y-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{pool.name}</span>
          <ToolBadge tool={pool.tool as ToolName} />
          <Badge variant="muted">{pool.members.length} members</Badge>
        </div>
        <CardDescription>{pool.active ? `Active member: ${pool.active}` : "No active member"}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <TotalBlock title="Today" total={pool.today} />
          <TotalBlock title="Last 7 days" total={pool.week} />
        </div>
        {pool.windows.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Pool limit windows (average, worst)</div>
            {pool.windows.map((w) => (
              <div key={w.label} className="space-y-1">
                <div className="flex justify-between gap-3 text-sm">
                  <span className="truncate">{w.label}</span>
                  <span className="shrink-0 tabular-nums">
                    {clampPercent(w.meanPercent).toFixed(0)}% avg, {clampPercent(w.worstPercent).toFixed(0)}% worst
                    {w.reporting < w.total ? ` (${w.reporting} of ${w.total})` : ""}
                  </span>
                </div>
                <Progress value={clampPercent(w.meanPercent)} indicatorClassName={tone(w.meanPercent)} />
              </div>
            ))}
          </div>
        ) : null}
        <div className="space-y-1.5">
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-xs uppercase tracking-wide text-muted-foreground">
            <span>Member</span>
            <span>7d tokens</span>
            <span>Worst window</span>
          </div>
          {pool.members.map((m) => (
            <div key={m.name} className="grid grid-cols-[1fr_auto_auto] items-baseline gap-x-3 text-sm">
              <span className="truncate" title={m.name}>
                {m.name}
                {m.name === pool.active ? " (active)" : ""}
                {m.allowed ? "" : " (excluded)"}
              </span>
              <span className="tabular-nums">{memberTokens(m.week)}</span>
              <span className="tabular-nums" title={m.worstLabel ?? m.limitMissing}>
                {m.worstPercent !== undefined ? `${clampPercent(m.worstPercent).toFixed(0)}%` : `n/a: ${m.limitMissing}`}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** Pools with summed usage and limits; shown instead of the pool's own "unavailable" mirror row. */
export function PoolUsageCards() {
  const pools = usePoolsUsageQuery();
  const usage = useUsageQuery();
  const limits = useLimitsQuery();
  const summaries = useMemo(
    () => (pools.data ? summarisePools(pools.data.pools, usage.data?.results ?? [], limits.data?.results ?? [], pools.data) : []),
    [pools.data, usage.data, limits.data],
  );
  if (pools.isError && !pools.data) return <p className="text-sm text-muted-foreground">Pool usage could not be loaded: {pools.error.message}</p>;
  if (summaries.length === 0) return null;
  const loading = usage.isLoading || limits.isLoading;
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">Pools</h2>
        {loading ? <Badge variant="muted">loading members</Badge> : null}
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {summaries.map((p) => (
          <PoolCard key={p.key} pool={p} />
        ))}
      </div>
    </section>
  );
}
