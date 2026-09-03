import { CreditCard } from "lucide-react";

import { ToolBadge } from "@/components/badges";
import { EmptyState, ErrorBanner, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { useLimitsQuery } from "@/hooks/queries";
import { clampPercent, formatMoney, relTime } from "@/lib/format";
import type { LimitFetchStatus, LimitWindow, OverageInfo, ToolLimitResult } from "@/types/api";

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

function LimitCard({ result }: { result: ToolLimitResult }) {
  const unavailable = result.status === "unavailable" || result.status === "pending";
  return (
    <Card className="gap-4">
      <CardHeader className="space-y-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <ToolBadge tool={result.toolName} />
            <span className="truncate font-medium" title={result.identity.name}>
              {result.identity.name}
            </span>
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
      </CardContent>
    </Card>
  );
}

export function LimitsPage() {
  const query = useLimitsQuery();
  const results = query.data?.results ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Limits"
        description="Live provider quota per identity. The server caches upstream fetches for 45 seconds."
        updatedAt={query.dataUpdatedAt}
      />

      {query.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {results.map((r) => (
            <LimitCard key={`${r.toolName}/${r.identity.name}`} result={r} />
          ))}
        </div>
      )}
    </div>
  );
}

export default LimitsPage;
