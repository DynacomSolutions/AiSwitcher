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
import { useProcessesQuery, useStatusQuery } from "@/hooks/queries";
import { durationSince, formatUptime } from "@/lib/format";

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
