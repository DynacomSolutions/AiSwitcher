import { useMemo } from "react";

import { AutoResetControl } from "@/components/auto-reset-control";
import { AccountWarnings } from "@/components/account-line";
import { ToolBadge } from "@/components/badges";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ResetCountdown } from "@/components/reset-countdown";
import { useLimitsQuery, usePoolsUsageQuery, useUsageQuery } from "@/hooks/queries";
import { creditsNote } from "@/lib/credits-note";
import { clampPercent, formatMoney, formatTokens } from "@/lib/format";
import { formatResetTimes } from "@/lib/reset-time";
import { partialLabel, summarisePools, type MemberPeriod, type PeriodTotal, type PoolSummary } from "@/lib/pool-usage";
import type { AutoResetStatus, ToolName } from "@/types/api";

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
          <Badge variant="warning" className="max-w-full whitespace-normal">{partial}</Badge>
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

function PoolCard({ pool, autoReset }: { pool: PoolSummary; autoReset?: AutoResetStatus }) {
  return (
    <Card className="gap-4">
      <CardHeader className="space-y-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words font-medium">{pool.name}</span>
          <ToolBadge tool={pool.tool as ToolName} />
          <Badge variant="muted">{pool.members.length} members</Badge>
        </div>
        <CardDescription>{pool.active ? `Active member: ${pool.active}` : "No active member"}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {autoReset ? <AutoResetControl kind="pool" setting={autoReset} /> : null}
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
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3 text-xs uppercase tracking-wide text-muted-foreground">
            <span>Member</span>
            <span>7d tokens</span>
            <span>Worst window</span>
          </div>
          {pool.members.map((m) => (
            <div key={m.name} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 text-sm">
              <span className="truncate" title={m.name}>
                {m.name}
                {m.name === pool.active ? " (active)" : ""}
                {m.allowed ? "" : " (excluded)"}
              </span>
              <span className="tabular-nums">{memberTokens(m.week)}</span>
              <span className="tabular-nums" title={m.worstLabel ?? m.limitMissing}>
                {m.worstPercent !== undefined ? `${clampPercent(m.worstPercent).toFixed(0)}%` : `n/a: ${m.limitMissing}`}
              </span>
              {m.worstResetsAtMs !== undefined || m.extraUsage ? (
                <div className="col-span-3 space-y-0.5 text-xs text-muted-foreground">
                  {m.worstResetsAtMs !== undefined ? (
                    <div>
                      {/* A non-breaking space binds the separator to the times, so a wrapped line never starts with it. */}
                      Resets {formatResetTimes(m.worstResetsAtMs)}
                      {"\u00a0· "}
                      <ResetCountdown ms={m.worstResetsAtMs} />
                    </div>
                  ) : null}
                  {m.extraUsage ? <div>{creditsNote(m.extraUsage)}</div> : null}
                </div>
              ) : null}
              {m.account ? (
                <div className="col-span-3 space-y-0.5 text-xs">
                  <div className="break-all text-muted-foreground">{m.account.email ?? m.account.label ?? m.account.accountId}</div>
                  <AccountWarnings account={m.account} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** Pools with summed usage and limits; shown instead of the pool's own "unavailable" mirror row. */
export function PoolUsageCards({ autoResetPools }: { autoResetPools?: Array<AutoResetStatus & { members: string[] }> }) {
  const pools = usePoolsUsageQuery();
  const usage = useUsageQuery();
  const limits = useLimitsQuery();
  const summaries = useMemo(
    () => (pools.data ? summarisePools(pools.data.pools, usage.data?.results ?? [], limits.data?.results ?? [], pools.data) : []),
    [pools.data, usage.data, limits.data],
  );
  const poolSettings = new Map(autoResetPools?.map((pool) => [pool.name, pool]));
  const reportedCodexPools = new Set(summaries.filter((pool) => pool.tool === "codex").map((pool) => pool.name));
  const missingCodexPools = (autoResetPools ?? []).filter((pool) => !reportedCodexPools.has(pool.name));
  const usageError = pools.isError && !pools.data ? pools.error.message : undefined;
  if (summaries.length === 0 && missingCodexPools.length === 0 && !usageError) return null;
  const loading = usage.isLoading || limits.isLoading;
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">Pools</h2>
        {loading ? <Badge variant="muted">loading members</Badge> : null}
      </div>
      {usageError ? <p className="text-sm text-muted-foreground">Pool usage could not be loaded: {usageError}</p> : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {summaries.map((p) => (
          <PoolCard key={p.key} pool={p} autoReset={p.tool === "codex" ? poolSettings.get(p.name) : undefined} />
        ))}
        {missingCodexPools.map((pool) => (
          <Card key={`codex/${pool.name}`} className="gap-4">
            <CardHeader className="space-y-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 break-words font-medium">{pool.name}</span>
                <ToolBadge tool="codex" />
                <Badge variant="muted">{pool.members.length} members</Badge>
              </div>
            </CardHeader>
            <CardContent><AutoResetControl kind="pool" setting={pool} /></CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
