import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CreditCard, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { ToolBadge } from "@/components/badges";
import { ProviderLabel } from "@/components/provider-icon";
import { PoolUsageCards } from "@/components/pool-usage-cards";
import { GlobalUsageCards } from "@/components/usage-counter";
import { PageTabRedirect, PageTabs, usePageTab, type PageTab } from "@/components/page-tabs";
import { EmptyState, ErrorBanner, PageHeader } from "@/components/page-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { qk, useLimitsQuery, usePoolsUsageQuery } from "@/hooks/queries";
import { api } from "@/lib/api";
import { clampPercent, formatMoney, relTime } from "@/lib/format";
import type { LimitFetchStatus, LimitWindow, ManualResetInfo, OverageInfo, ResetGrant, ToolLimitResult } from "@/types/api";

function StatusBadge({ status }: { status: LimitFetchStatus }) {
  switch (status) {
    case "live":
      return <Badge variant="success">Live</Badge>;
    case "cached":
      return <Badge variant="warning">Cached</Badge>;
    default:
      return <Badge variant="muted">{status === "pending" ? "Pending" : "Unavailable"}</Badge>;
  }
}

function windowTone(percent: number): string | undefined {
  if (percent >= 90) return "bg-red-500";
  if (percent >= 70) return "bg-amber-500";
  return undefined;
}

function WindowRow({ window }: { window: LimitWindow }) {
  const pct = clampPercent(window.usedPercent);
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate" title={window.label}>
          {window.label}
        </span>
        <span className="shrink-0 font-medium tabular-nums">{pct.toFixed(1)}%</span>
      </div>
      <Progress value={pct} indicatorClassName={windowTone(pct)} />
      {(window.resetsAt || window.note) && (
        <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{window.resetsAt ?? ""}</span>
          {window.note ? (
            <span className="shrink-0 text-amber-600 dark:text-amber-400">{window.note}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function OverageBlock({ overage }: { overage: OverageInfo }) {
  const amounts =
    overage.spentUsd !== undefined
      ? overage.limitUsd !== undefined
        ? ` (${formatMoney(overage.spentUsd)} of ${formatMoney(overage.limitUsd)})`
        : ` (${formatMoney(overage.spentUsd)} spent)`
      : "";
  return (
    <>
      <Separator />
      <div
        className={
          overage.active
            ? "flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400"
            : "flex items-start gap-2 text-xs text-muted-foreground"
        }
      >
        <CreditCard aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Overage: {overage.label}
          {amounts}
        </span>
      </div>
    </>
  );
}

const GRANT_KIND: Record<ResetGrant["kind"], string> = { full: "Full", fable: "Fable only", other: "Other" };

function grantState(grant: ResetGrant, cooldown: boolean): string {
  if (grant.resetsLeft <= 0) return "used up";
  if (grant.paused) return "paused";
  if (cooldown) return "cooling down";
  return grant.usableNow ? "usable now" : "not usable now";
}

function UseResetDialog({ identity, grant, onClose }: { identity: string; grant: ResetGrant; onClose: () => void }) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.useClaudeReset(identity, grant.id),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.limits });
      const left = r.resetsLeft !== undefined ? `, ${r.resetsLeft} left` : "";
      toast.success(`Reset ${r.result}`, { description: `${identity}: ${grant.label ?? grant.id}${left}${r.cleared.length ? `; cleared ${r.cleared.join(", ")}` : ""}` });
      onClose();
    },
    onError: (error) => toast.error("Reset failed", { description: error.message }),
  });
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Use a reset on {identity}?</AlertDialogTitle>
          <AlertDialogDescription>
            Spends one of {grant.resetsLeft} left on “{grant.label ?? grant.id}” ({GRANT_KIND[grant.kind]}). Anthropic clears the matching usage
            limits now; a spent reset cannot be given back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={mutation.isPending}
            onClick={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
          >
            {mutation.isPending ? "Resetting..." : "Use reset"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ManualResetBlock({ reset, result }: { reset: ManualResetInfo; result: ToolLimitResult }) {
  const [using, setUsing] = useState<ResetGrant | null>(null);
  if (!reset.grants) {
    // Codex credits (and old cached Claude reads): one summary line.
    if (reset.availableCount <= 0) return null;
    const count = reset.availableCount > 1 ? ` ×${reset.availableCount}` : "";
    const label = reset.label ? `: ${reset.label}` : "";
    const expiry = reset.expiresAt ? ` (expires ${reset.expiresAt})` : "";
    return (
      <>
        <Separator />
        <div className="flex items-start gap-2 text-xs text-emerald-600 dark:text-emerald-400">
          <RotateCcw aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Manual reset available{count}
            {label}
            {expiry}
          </span>
        </div>
      </>
    );
  }
  const cooldown = reset.cooldownUntil !== undefined && Date.parse(reset.cooldownUntil) > Date.now();
  // A spend is offered only on a live list for a real claude identity (a pool row mirrors a member's login).
  const canSpend = result.toolName === "claude" && !reset.stale && !cooldown;
  return (
    <>
      <Separator />
      <div className="space-y-2 text-xs">
        <div className="flex items-center gap-2 font-medium">
          <RotateCcw aria-hidden className="size-3.5 shrink-0" />
          Reset credits ({reset.grants.length})
          {reset.grantsCapturedAt ? (
            <span className={reset.stale ? "font-normal text-amber-600 dark:text-amber-400" : "font-normal text-muted-foreground"}>
              {reset.stale ? "last seen " : "seen "}
              {relTime(reset.grantsCapturedAt)}
            </span>
          ) : null}
        </div>
        {reset.stale ? (
          <p className="text-muted-foreground">Anthropic lists reset credits only near a limit; this is the last list it sent.</p>
        ) : null}
        {cooldown ? <p className="text-amber-600 dark:text-amber-400">Cooling down until {new Date(reset.cooldownUntil!).toLocaleString()}.</p> : null}
        {reset.grants.length === 0 ? <p className="text-muted-foreground">No reset credits.</p> : null}
        <ul className="space-y-2">
          {reset.grants.map((g) => (
            <li key={g.id} className="flex items-start justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={g.kind === "full" ? "success" : g.kind === "fable" ? "warning" : "muted"}>{GRANT_KIND[g.kind]}</Badge>
                  <span className="min-w-0 break-words" title={g.id}>
                    {g.label ?? g.id}
                  </span>
                </div>
                <div className="text-muted-foreground">
                  {g.resetsLeft} left · {grantState(g, cooldown)}
                  {g.endsAt ? ` · ${Date.parse(g.endsAt) > Date.now() ? "expires" : "expired"} ${new Date(g.endsAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : ""}
                </div>
              </div>
              {canSpend && g.usableNow && g.resetsLeft > 0 ? (
                <Button variant="outline" size="sm" className="h-7 shrink-0 text-xs" onClick={() => setUsing(g)}>
                  Use reset
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      {using ? <UseResetDialog identity={result.identity.name} grant={using} onClose={() => setUsing(null)} /> : null}
    </>
  );
}

function LimitCard({ result }: { result: ToolLimitResult }) {
  const unavailable = result.status === "unavailable" || result.status === "pending";
  return (
    <Card className="gap-4">
      <CardHeader className="space-y-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium" title={result.identity.name}>
              {result.identity.name}
            </span>
            <ToolBadge tool={result.toolName} />
          </div>
          <StatusBadge status={result.status} />
        </div>
        <CardDescription>
          {result.capturedAt ? `Captured ${relTime(result.capturedAt)}` : "No capture timestamp"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!unavailable && result.windows.length > 0 ? (
          <div className="space-y-4">
            {result.windows.map((w) => (
              <WindowRow key={w.label} window={w} />
            ))}
          </div>
        ) : null}
        {unavailable ? (
          <p className="text-sm text-muted-foreground">
            {result.error ?? "Quota information is not available for this identity."}
          </p>
        ) : null}
        {result.windows.length === 0 && !unavailable ? (
          <p className="text-sm text-muted-foreground">This tool reported no quota windows.</p>
        ) : null}
        {result.overage ? <OverageBlock overage={result.overage} /> : null}
        {result.manualReset ? <ManualResetBlock reset={result.manualReset} result={result} /> : null}
      </CardContent>
    </Card>
  );
}

export function LimitsPage() {
  const query = useLimitsQuery();
  const poolsQuery = usePoolsUsageQuery();
  // A pool mirrors its active member's token, so its own limits row only ever
  // says "not fetched"; the pool cards above carry the real figures instead.
  const poolKeys = useMemo(() => new Set((poolsQuery.data?.pools ?? []).map((p) => `${p.tool}/${p.name}`)), [poolsQuery.data]);
  const allResults = query.data?.results ?? [];
  const results = useMemo(() => allResults.filter((r) => !poolKeys.has(`${r.toolName}/${r.identity.name}`)), [allResults, poolKeys]);

  // Provider-first grouping, mirroring the CLI report: provider is the
  // grouping key, the wrapper tool is secondary info on each identity row.
  const providerGroups = useMemo(() => {
    const map = new Map<string, ToolLimitResult[]>();
    for (const result of results) {
      const key = result.provider || "unattributed";
      const bucket = map.get(key);
      if (bucket) bucket.push(result);
      else map.set(key, [result]);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.identity.name.localeCompare(b.identity.name));
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [results]);

  const tabs = useMemo<PageTab[]>(
    () => [
      { segment: "overview", label: "Overview" },
      ...providerGroups.map(([provider]) => ({ segment: provider, label: provider })),
    ],
    [providerGroups],
  );
  const { active, invalid } = usePageTab(tabs);
  // A provider tab is unknown until the limits have loaded: only redirect once they have.
  if (invalid && query.data) return <PageTabRedirect to="/limits" />;
  const activeGroup = providerGroups.find(([provider]) => provider === active);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Limits"
        description="Live provider quota per identity. The server caches upstream fetches for 45 seconds."
        updatedAt={query.dataUpdatedAt}
      />

      <PageTabs tabs={tabs} active={active} base="/limits" />

      {active === "overview" ? (
        <>
          <GlobalUsageCards title="Global usage" />

          <PoolUsageCards />
        </>
      ) : null}

      {active === "overview" ? null : query.isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-52 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : query.isError && !query.data ? (
        <ErrorBanner message={query.error.message} />
      ) : results.length === 0 ? (
        <EmptyState
          title="No limit data"
          description="Add identities with configured credentials; quotas appear once the server can fetch them."
        />
      ) : (
        (activeGroup ? [activeGroup] : []).map(([provider, group]) => (
          <section key={provider} className="space-y-3">
            <div className="flex items-center gap-2">
              <ProviderLabel provider={provider} size={16} className="text-base font-semibold" />
              <Badge variant="muted">{group.length}</Badge>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {group.map((r) => (
                <LimitCard key={`${r.provider}/${r.toolName}/${r.identity.name}`} result={r} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

export default LimitsPage;
