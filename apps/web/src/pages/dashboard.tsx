import type * as React from "react";

import { IdentityChip, ToolBadge } from "@/components/badges";
import { EmptyState, ErrorBanner, PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/updated-ago";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GlobalUsageCards } from "@/components/usage-counter";
import { useHerdrBridgeQuery, useProcessesQuery, useSpendGuardQuery, useStatusQuery } from "@/hooks/queries";
import { clampPercent, durationSince, formatMoney, formatUptime } from "@/lib/format";
import type { HerdrBridgeResponse, SpendGuardAccountState, SpendGuardKillRecord } from "@/types/api";

function SummaryCard({
  title,
  value,
  hint,
}: {
  title: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint ? (
        <CardContent className="text-xs text-muted-foreground">{hint}</CardContent>
      ) : null}
    </Card>
  );
}

function ProcessesTable() {
  const query = useProcessesQuery();
  const processes = query.data?.processes ?? [];

  if (query.isLoading) {
    return (
      <div className="space-y-2.5 px-1 py-1">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-8 animate-pulse rounded-md bg-muted"
            style={{ width: `${92 - i * 7}%` }}
          />
        ))}
      </div>
    );
  }

  if (processes.length === 0) {
    return (
      <EmptyState
        title="No agent processes detected"
        description="Sessions launched through an AIS wrapper appear here within a few seconds."
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-20">PID</TableHead>
          <TableHead className="w-24">Tool</TableHead>
          <TableHead className="w-36">Identity</TableHead>
          <TableHead>Working directory</TableHead>
          <TableHead className="w-24">Uptime</TableHead>
          <TableHead className="w-80">Command</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {processes.map((p) => (
          <TableRow key={p.pid}>
            <TableCell className="font-mono text-xs tabular-nums">{p.pid}</TableCell>
            <TableCell>
              {p.tool ? <ToolBadge tool={p.tool} /> : <span className="text-muted-foreground">-</span>}
            </TableCell>
            <TableCell>
              {p.identity ? (
                <IdentityChip name={p.identity} />
              ) : (
                <span className="text-xs text-muted-foreground">direct</span>
              )}
            </TableCell>
            <TableCell className="max-w-56">
              <span className="block truncate font-mono text-xs" title={p.cwd ?? undefined}>
                {p.cwd ?? "-"}
              </span>
            </TableCell>
            <TableCell className="text-xs tabular-nums">
              {p.startedAt ? durationSince(p.startedAt) : "-"}
            </TableCell>
            <TableCell className="max-w-80">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="block truncate font-mono text-xs">{p.command}</span>
                </TooltipTrigger>
                <TooltipContent side="top" className="font-mono">
                  {p.command}
                </TooltipContent>
              </Tooltip>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function AccountRow({ account, mode }: { account: SpendGuardAccountState; mode: "warn" | "enforce" }) {
  const pct = account.budgetLimitUsd !== undefined && account.budgetLimitUsd > 0 ? clampPercent((account.effectiveUsd / account.budgetLimitUsd) * 100) : undefined;
  const enforceBreach = account.breached && mode === "enforce";
  const warnBreach = account.breached && mode !== "enforce";
  const tone = enforceBreach ? "bg-red-500" : warnBreach ? "bg-amber-500" : pct !== undefined && pct >= 70 ? "bg-amber-500" : undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium" title={account.budgetName}>
          {account.budgetName ?? "no usable budget"}
        </span>
        <span className="shrink-0 tabular-nums">
          {formatMoney(account.effectiveUsd)} {account.budgetLimitUsd !== undefined ? `/ ${formatMoney(account.budgetLimitUsd)}` : ""}
        </span>
      </div>
      {pct !== undefined ? <Progress value={pct} indicatorClassName={tone} /> : null}
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          local {formatMoney(account.localEstimateUsd)}
          {account.realReportedUsd !== undefined ? ` · Cost Explorer ${formatMoney(account.realReportedUsd)}` : ""}
          {account.identities.length > 0 ? ` · ${account.identities.join(", ")}` : ""}
        </span>
        {enforceBreach ? (
          <Badge variant="destructive">BREACHED (enforced): launches blocked, active sessions terminated</Badge>
        ) : warnBreach ? (
          <Badge variant="warning">BREACHED (warning): not blocking</Badge>
        ) : account.degraded ? (
          <Badge variant="warning">UNENFORCED</Badge>
        ) : (
          <Badge variant="success">Enforcing</Badge>
        )}
      </div>
      {account.degraded && account.reason ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">{account.reason}</p>
      ) : null}
    </div>
  );
}

function SpendGuardCard() {
  const query = useSpendGuardQuery();
  // Hidden entirely when the endpoint is unavailable (no daemon-side guard):
  // a machine without AWS mappings has nothing to show either way.
  if (query.isError) return null;
  const data = query.data;
  if (!data) return null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">
          Spend guard{" "}
          {data.accounts.some((a) => a.breached) ? (
            data.config.mode === "enforce" ? (
              <Badge variant="destructive">OVER CAP</Badge>
            ) : (
              <Badge variant="warning">OVER CAP (warning only)</Badge>
            )
          ) : null}
        </CardTitle>
        <CardDescription>
          Per AWS account: local estimate blended with real AWS-reported spend against the account's own Budgets cap.
          {data.config.mode === "enforce" ? " Breaches block launches and terminate sessions." : " Breaches warn only; set mode=enforce in ~/.ais/config/spend-guard.json to block."}
          {data.lastCycleAt ? (
            <>
              {" "}Last cycle <RelativeTime iso={data.lastCycleAt} />.
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No AWS accounts are mapped for enforcement.</p>
        ) : (
          data.accounts.map((account) => <AccountRow key={account.accountId} account={account} mode={data.config.mode} />)
        )}
        {data.lastError ? <p className="text-xs text-muted-foreground">Last cycle errors: {data.lastError}</p> : null}
        {data.recentKills.length > 0 ? (
          <div className="space-y-1.5">
            {data.recentKills.slice(-5).reverse().map((kill) => (
              <RecentKill key={`${kill.pid}-${kill.at}`} kill={kill} />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RecentKill({ kill }: { kill: SpendGuardKillRecord }) {
  return (
    <div className="flex items-start gap-2 text-xs">
      <Badge variant="destructive">{kill.signal}</Badge>
      <span className="text-muted-foreground">
        pid {kill.pid} ({kill.tool}, {kill.identity}, account ...{kill.accountId.slice(-4)}) terminated{" "}
        <RelativeTime iso={kill.at} />: {kill.reason}
      </span>
    </div>
  );
}

function herdrBridgeBadge(state: HerdrBridgeResponse["state"]) {
  switch (state) {
    case "active":
      return <Badge variant="success">Active</Badge>;
    case "pending":
      return <Badge variant="warning">Pending</Badge>;
    case "idle":
      return <Badge variant="muted">Idle</Badge>;
    default:
      return <Badge variant="muted">Disabled</Badge>;
  }
}

function HerdrBridgeCard() {
  const query = useHerdrBridgeQuery();
  // Hidden entirely when the endpoint is unavailable (no daemon-side
  // bridge): a machine without herdr has nothing to show either way.
  if (query.isError) return null;
  const data = query.data;
  if (!data) return null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">
          herdr bridge {herdrBridgeBadge(data.state)}
          {data.config.push ? null : <Badge variant="muted">push off</Badge>}
        </CardTitle>
        <CardDescription>
          Feeds AIS limit percentages to herdr's sidebar per agent pane via display-only metadata tokens
          {data.herdrVersion ? ` (herdr ${data.herdrVersion})` : ""}. {data.panes.length} attributed pane
          {data.panes.length === 1 ? "" : "s"}.
          {data.lastCycleAt ? (
            <>
              {" "}Last cycle <RelativeTime iso={data.lastCycleAt} />
              {data.lastPushAt ? (
                <>
                  , last push <RelativeTime iso={data.lastPushAt} />
                </>
              ) : null}
              .
            </>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.state === "pending" && data.pendingReason ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">{data.pendingReason}; the bridge flips to active automatically once herdr supports report-metadata.</p>
        ) : null}
        {data.state === "idle" ? (
          <p className="text-xs text-muted-foreground">herdr is not running; the bridge retries every {data.config.intervalS}s.</p>
        ) : null}
        {data.panes.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Pane</TableHead>
                <TableHead className="w-24">Tool</TableHead>
                <TableHead className="w-36">Identity</TableHead>
                <TableHead className="w-20">Session</TableHead>
                <TableHead className="w-20">Week</TableHead>
                <TableHead className="w-20">Month</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.panes.map((pane) => (
                <TableRow key={pane.paneId}>
                  <TableCell className="font-mono text-xs">{pane.paneId}</TableCell>
                  <TableCell>{pane.tool ? <ToolBadge tool={pane.tool} /> : <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>{pane.identity ? <IdentityChip name={pane.identity} /> : <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell className="text-xs tabular-nums">{pane.session !== undefined ? `${pane.session}%` : "-"}</TableCell>
                  <TableCell className="text-xs tabular-nums">{pane.week !== undefined ? `${pane.week}%` : "-"}</TableCell>
                  <TableCell className="text-xs tabular-nums">{pane.month !== undefined ? `${pane.month}%` : "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">
            No AIS-wrapped agent panes detected in herdr right now.
          </p>
        )}
        {data.lastError ? <p className="text-xs text-muted-foreground">{data.lastError}</p> : null}
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const status = useStatusQuery();
  const processes = useProcessesQuery();
  if (status.isError && !status.data) {
    return (
      <div className="space-y-4">
        <PageHeader title="Dashboard" updatedAt={status.dataUpdatedAt} />
        <ErrorBanner message="The console API is unreachable. It may not be running; start it with: ais web start" />
      </div>
    );
  }

  const data = status.data;
  const tools = data?.tools ?? [];
  const registriesOk = tools.filter((t) => t.registryExists).length;
  const binariesFound = tools.filter((t) => t.binaryPath !== null).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        description="Server health and live agent processes."
        updatedAt={status.dataUpdatedAt}
      />

      {!data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard title="Version" value={data.version} hint={`home ${data.home}`} />
          <SummaryCard title="Uptime" value={formatUptime(data.uptimeS)} />
          <SummaryCard
            title="Registries"
            value={`${registriesOk}/${tools.length}`}
            hint="identity registries present"
          />
          <SummaryCard
            title="Binaries"
            value={`${binariesFound}/${tools.length}`}
            hint="real CLIs resolved on PATH"
          />
        </div>
      )}

      <GlobalUsageCards />

      <SpendGuardCard />

      <HerdrBridgeCard />

      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="text-base">Tool registries</CardTitle>
          <CardDescription>
            Registry file and real binary resolution per wrapped tool.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {tools.map((tool) => (
            <div key={tool.toolName} className="rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <ToolBadge tool={tool.toolName} />
                <Badge variant={tool.registryExists ? "success" : "destructive"}>
                  {tool.registryExists ? "Registry present" : "Registry missing"}
                </Badge>
              </div>
              <p
                className="mt-2.5 truncate font-mono text-xs text-muted-foreground"
                title={tool.registryPath}
              >
                {tool.registryPath}
              </p>
              {tool.binaryPath ? (
                <p className="truncate font-mono text-xs" title={tool.binaryPath}>
                  {tool.binaryPath}
                </p>
              ) : (
                <p className="font-mono text-xs text-amber-500">
                  Binary not found ({tool.realBinaryName})
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="text-base">
            Live processes{" "}
            <span className="ml-1 align-middle font-normal text-muted-foreground">
              {processes.data ? `(${processes.data.processes.length})` : ""}
            </span>
          </CardTitle>
          <CardDescription>
            {processes.data?.scannedAt ? (
              <>
                Process table scanned <RelativeTime iso={processes.data.scannedAt} />.
              </>
            ) : (
              "Attributed to AIS identities via session markers."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProcessesTable />
        </CardContent>
      </Card>
    </div>
  );
}

export default DashboardPage;
