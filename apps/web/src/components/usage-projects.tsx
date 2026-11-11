import type * as React from "react";
import { useMemo, useState } from "react";

import { EmptyState, ErrorBanner } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useProjectsBreakdownQuery } from "@/hooks/queries";
import { Button } from "@/components/ui/button";
import { formatCount, formatDateMs, formatMoney, formatTokens } from "@/lib/format";
import type { BreakdownProject } from "@/types/api";

const ROW_LIMIT = 25;

export type ProjectGrouping = "project" | "repo" | "org";

interface GroupRow {
  key: string;
  label: string;
  /** Muted second line (full path, host or repo count). */
  sub?: string;
  title?: string;
  noRemote: boolean;
  /** Every underlying directory is gone from this host. */
  missing: boolean;
  turns: number;
  input: number;
  output: number;
  cache: number;
  cost: number;
  lastUsedAt: string | null;
}

const COPY: Record<ProjectGrouping, { title: string; noun: string; head: string }> = {
  project: { title: "By project", noun: "working directory", head: "Project" },
  repo: { title: "By repository", noun: "repository", head: "Repository" },
  org: { title: "By GitHub org", noun: "remote owner", head: "Org" },
};

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function laterOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/** Aggregate raw per-directory rows into the chosen grouping. */
export function groupProjects(projects: BreakdownProject[], grouping: ProjectGrouping): GroupRow[] {
  const groups = new Map<string, GroupRow & { paths: Set<string>; repos: Set<string>; present: number; rows: number }>();
  for (const p of projects) {
    let key: string;
    let label: string;
    let sub: string | undefined;
    let title: string | undefined;
    let noRemote = false;
    if (grouping === "project") {
      key = p.path;
      label = p.path === "" ? "(no working directory)" : lastSegment(p.path);
      sub = p.path === "" ? undefined : p.repo ? `${p.repo}${p.inferred ? " (inferred from folder name)" : ""} · ${p.path}` : p.path;
      title = p.path || undefined;
    } else if (grouping === "repo") {
      if (p.repo) {
        key = `repo:${p.host ?? ""}/${p.repo}`;
        label = p.repo;
        sub = p.host;
        title = p.host ? `${p.host}/${p.repo}` : p.repo;
      } else {
        key = `path:${p.path}`;
        label = p.path === "" ? "(no working directory)" : lastSegment(p.path);
        sub = p.path || undefined;
        title = p.path || undefined;
        noRemote = true;
      }
    } else {
      const owner = p["org"];
      key = owner ? `org:${owner}` : "none";
      label = owner ?? "(no git remote)";
      noRemote = !owner;
    }
    let row = groups.get(key);
    if (!row) {
      row = {
        key, label, sub, title, noRemote, missing: false,
        turns: 0, input: 0, output: 0, cache: 0, cost: 0, lastUsedAt: null,
        paths: new Set(), repos: new Set(), present: 0, rows: 0,
      };
      groups.set(key, row);
    }
    row.turns += p.turns;
    row.input += p.inputTokens;
    row.output += p.outputTokens;
    row.cache += p.cacheReadTokens + p.cacheWriteTokens;
    row.cost += p.estCostUsd;
    row.lastUsedAt = laterOf(row.lastUsedAt, p.lastUsedAt);
    row.paths.add(p.path);
    if (p.repo) row.repos.add(p.repo);
    row.rows += 1;
    if (p.source !== "missing") row.present += 1;
  }
  const rows = [...groups.values()].map((g) => {
    if (grouping === "org" && g.rows > 0) {
      const n = g.repos.size;
      g.sub = n > 0 ? `${n} ${n === 1 ? "repository" : "repositories"}` : `${g.paths.size} ${g.paths.size === 1 ? "directory" : "directories"}`;
    } else if (grouping === "repo" && g.paths.size > 1) {
      g.sub = `${g.sub ? `${g.sub} · ` : ""}${g.paths.size} directories`;
    }
    g.missing = g.present === 0;
    return g;
  });
  return rows.sort((a, b) => b.cost - a.cost || b.turns - a.turns || a.label.localeCompare(b.label));
}

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

/** Per project / repository / GitHub org usage from the breakdown endpoint. */
export function UsageProjects({
  grouping,
  days,
  identity,
}: {
  grouping: ProjectGrouping;
  /** Page period in days (0 = all time, which maps to the 30-day window the host collector keeps fresh; longer cold scans of every transcript take tens of minutes). */
  days: number;
  identity: string;
}) {
  const windowDays = days === 0 ? 30 : days;
  const query = useProjectsBreakdownQuery(identity === "all" ? undefined : identity, windowDays, true);
  const results = query.data?.results ?? [];
  const copy = COPY[grouping];

  const { rows, scanned } = useMemo(() => {
    const projects: BreakdownProject[] = [];
    let scanned = false;
    for (const result of results) {
      if (result.unavailable) continue;
      if (result.projects) scanned = true;
      projects.push(...(result.projects ?? []));
    }
    return { rows: groupProjects(projects, grouping), scanned };
  }, [results, grouping]);
  const totalCost = rows.reduce((sum, r) => sum + r.cost, 0);
  // Long tails (hundreds of task folders) would make the tab as long as the old page.
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, ROW_LIMIT);

  const description = (
    <>
      Estimated cost per {copy.noun} over the last {windowDays} days{days === 0 ? " (project figures cover the last 30 days under All time; pick 90 days for longer)" : ""}.
      Estimates from local session logs, Claude and Codex only; never real billed spend. The provider and model
      filters do not apply here (the breakdown is per identity); the period and identity filters do.
    </>
  );

  let body: React.ReactNode;
  if (query.isLoading || (query.data?.pending && results.length === 0)) {
    body = <div className="mx-6 h-48 animate-pulse rounded-xl bg-muted" />;
  } else if (query.isError && !query.data) {
    body = (
      <div className="px-6">
        <ErrorBanner message={query.error.message} />
      </div>
    );
  } else if (!scanned && rows.length === 0 && results.length > 0 && results.every((r) => r.unavailable)) {
    body = (
      <div className="px-6">
        <ErrorBanner message="Per-project breakdown is unavailable for the selected identities." />
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div className="px-6">
        <EmptyState
          title={scanned ? "No project activity" : "No project data"}
          description={
            scanned
              ? `No local session activity in the last ${windowDays} days.`
              : "This server did not report per-project figures. Update the console to see them."
          }
        />
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
