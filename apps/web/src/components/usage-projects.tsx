import type * as React from "react";
import { useMemo, useState } from "react";

import { EmptyState, ErrorBanner } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useUsageProjectsQuery } from "@/hooks/queries";
import { Button } from "@/components/ui/button";
import { formatCount, formatDateMs, formatMoney, formatTokens } from "@/lib/format";
import { filterProjectRows, groupProjects, projectCoverage, type ProjectGrouping } from "@/lib/usage-projects";
import { periodLabel, type SinceDays } from "@/lib/usage-period";

const ROW_LIMIT = 25;

export type { ProjectGrouping };

const COPY: Record<ProjectGrouping, { title: string; noun: string; head: string }> = {
  project: { title: "By project", noun: "working directory", head: "Project" },
  repo: { title: "By repository", noun: "repository", head: "Repository" },
  org: { title: "By GitHub org", noun: "remote owner", head: "Org" },
};

function ShareBar({ share }: { share: number }) {
  const pct = Math.round(share * 100);
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-violet-500" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </span>
  );
}

/** Per project / repository / GitHub org usage from the native usage store. */
export function UsageProjects({
  grouping,
  since,
  provider,
  identity,
  usageCost,
}: {
  grouping: ProjectGrouping;
  since: SinceDays;
  provider: string;
  identity: string;
  /** The Usage page's total for the same provider, identity and period filters. */
  usageCost: number;
}) {
  const query = useUsageProjectsQuery(true);
  const copy = COPY[grouping];

  const filtered = useMemo(
    () => filterProjectRows(query.data?.rows ?? [], { provider, identity, since }),
    [query.data, provider, identity, since],
  );
  const rows = useMemo(() => groupProjects(filtered, grouping), [filtered, grouping]);
  const coverage = useMemo(() => projectCoverage(filtered, usageCost), [filtered, usageCost]);
  const totalCost = coverage.projectsCost;
  // Long tails (hundreds of task folders) would make the tab as long as the old page.
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, ROW_LIMIT);

  const description = (
    <>
      Estimated cost per {copy.noun}, {periodLabel(since)}, from the same native usage records as the totals above.
      Estimates, never real billed spend. The provider, identity and period filters apply; the model filter does not.
      <span className="mt-1 block tabular-nums">
        Covers {formatMoney(coverage.projectsCost)} of {formatMoney(coverage.usageCost)} estimated for this period
        {coverage.remainder >= 0.005
          ? `; the remaining ${formatMoney(coverage.remainder)} has no session logs behind it (for example AWS Bedrock billing).`
          : "."}
      </span>
    </>
  );

  let body: React.ReactNode;
  if (query.isLoading || (query.data?.pending && (query.data.rows.length === 0))) {
    body = <div className="mx-6 h-48 animate-pulse rounded-xl bg-muted" />;
  } else if (query.isError && !query.data) {
    body = (
      <div className="px-6">
        <ErrorBanner message={query.error.message} />
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div className="px-6">
        <EmptyState title="No project activity" description={`No usage recorded for these filters, ${periodLabel(since)}.`} />
      </div>
    );
  } else {
    body = (
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{copy.head}</TableHead>
            <TableHead className="text-right">Turns</TableHead>
            <TableHead className="text-right">Input</TableHead>
            <TableHead className="text-right">Output</TableHead>
            <TableHead className="text-right">Cache</TableHead>
            <TableHead className="text-right">Est. cost</TableHead>
            <TableHead className="w-32">Share</TableHead>
            <TableHead>Last used</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="max-w-72">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-mono text-xs" title={row.title ?? row.label}>
                    {row.label}
                  </span>
                  {row.noRemote && grouping !== "org" ? <Badge variant="muted">no remote</Badge> : null}
                  {row.missing ? <Badge variant="muted">not on this host</Badge> : null}
                </span>
                {row.sub ? (
                  <span className="block truncate font-mono text-xs text-muted-foreground" title={row.sub}>
                    {row.sub}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCount(row.turns)}</TableCell>
              <TableCell className="text-right tabular-nums" title={formatCount(row.input)}>{formatTokens(row.input)}</TableCell>
              <TableCell className="text-right tabular-nums" title={formatCount(row.output)}>{formatTokens(row.output)}</TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground" title={formatCount(row.cache)}>{formatTokens(row.cache)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatMoney(row.cost)}</TableCell>
              <TableCell>
                <ShareBar share={totalCost > 0 ? row.cost / totalCost : 0} />
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                {row.lastUsedAt ? formatDateMs(Date.parse(row.lastUsedAt)) : "-"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
    if (rows.length > ROW_LIMIT) {
      body = (
        <>
          {body}
          <div className="px-6 pt-2">
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setShowAll((v) => !v)}>
              {showAll ? `Show top ${ROW_LIMIT}` : `Show all ${rows.length}`}
            </Button>
          </div>
        </>
      );
    }
  }

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-base">{copy.title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">{body}</CardContent>
    </Card>
  );
}
