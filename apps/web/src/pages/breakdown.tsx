import { useMemo, useState } from "react";

import { ToolBadge } from "@/components/badges";
import { EmptyState, ErrorBanner, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useBreakdownQuery, useIdentitiesQuery } from "@/hooks/queries";
import { formatDateTime, formatMoney, formatTokens } from "@/lib/format";
import type { BreakdownCategory, BreakdownResult } from "@/types/api";

const DAY_OPTIONS = [7, 30, 90];

const KIND_LABELS: Record<BreakdownCategory["kind"], string> = {
  conversation: "chat",
  mcp: "mcp",
  edit: "edit",
  web: "web",
  tool: "tool",
  other: "other",
};

/** Colour coding per kind for the small badge next to each name. */
const KIND_BADGE_VARIANT: Record<BreakdownCategory["kind"], "default" | "secondary" | "outline" | "muted"> = {
  conversation: "muted",
  mcp: "default",
  edit: "secondary",
  web: "outline",
  tool: "outline",
  other: "muted",
};

function isToolScoped(result: BreakdownResult | undefined): result is BreakdownResult & { unavailable?: undefined } {
  return result !== undefined && !result.unavailable;
}

/** Code-edit group summary: the Edit/Write/apply_patch-style rows summed so
 * the headline number answers "how much did writing code cost" at a glance. */
function summariseEdits(categories: BreakdownCategory[]): BreakdownCategory | undefined {
  const edits = categories.filter((c) => c.kind === "edit");
  if (edits.length === 0) return undefined;
  return edits.reduce((sum, row) => ({
    kind: "edit",
    name: "code edits",
    callCount: sum.callCount + row.callCount,
    inputTokens: sum.inputTokens + row.inputTokens,
    outputTokens: sum.outputTokens + row.outputTokens,
    cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + row.cacheWriteTokens,
    estCostUsd: sum.estCostUsd + row.estCostUsd,
    lastUsedAt: !sum.lastUsedAt || (row.lastUsedAt ?? "") > sum.lastUsedAt ? row.lastUsedAt : sum.lastUsedAt,
  }));
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
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

function ShareBar({ share }: { share: number }) {
  const pct = Math.round(share * 100);
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-violet-500" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
    </span>
  );
}

function KindBadge({ kind }: { kind: BreakdownCategory["kind"] }) {
  return <Badge variant={KIND_BADGE_VARIANT[kind]}>{KIND_LABELS[kind]}</Badge>;
}

function CategoryRows({
  rows,
  totalCost,
  expandable,
}: {
  rows: BreakdownCategory[];
  totalCost: number;
  expandable?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const detailRow = (tool: BreakdownCategory) => {
    const share = totalCost > 0 ? tool.estCostUsd / totalCost : 0;
    return (
      <TableRow key={tool.name} className="hover:bg-transparent">
        <TableCell className="max-w-72 pl-10">
          <span className="font-mono text-xs text-muted-foreground">{tool.name}</span>
        </TableCell>
        <TableCell className="text-right tabular-nums">{tool.callCount.toLocaleString()}</TableCell>
        <TableCell className="text-right tabular-nums">{formatTokens(tool.inputTokens)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatTokens(tool.outputTokens)}</TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">{formatTokens(tool.cacheReadTokens)}</TableCell>
        <TableCell className="text-right tabular-nums">{formatMoney(tool.estCostUsd)}</TableCell>
        <TableCell>
          <ShareBar share={share} />
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">{formatDateTime(tool.lastUsedAt ?? undefined)}</TableCell>
      </TableRow>
    );
  };

  const cells = (row: BreakdownCategory, share: number) => (
    <>
      <TableCell className="max-w-72">
        <span className="flex items-center gap-2">
          <KindBadge kind={row.kind} />
          {expandable && (row.tools?.length ?? 0) > 0 ? (
            <button type="button" onClick={() => toggle(row.name)} className="font-mono text-xs hover:underline" aria-expanded={expanded.has(row.name)}>
              {row.name}
              <span className="ml-1 text-muted-foreground">{expanded.has(row.name) ? "[-]" : `[+${row.tools!.length}]`}</span>
            </button>
          ) : (
            <span className="font-mono text-xs">{row.name}</span>
          )}
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums">{row.callCount.toLocaleString()}</TableCell>
      <TableCell className="text-right tabular-nums">{formatTokens(row.inputTokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatTokens(row.outputTokens)}</TableCell>
      <TableCell className="text-right tabular-nums text-muted-foreground">{formatTokens(row.cacheReadTokens)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatMoney(row.estCostUsd)}</TableCell>
      <TableCell>
        <ShareBar share={share} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{formatDateTime(row.lastUsedAt ?? undefined)}</TableCell>
    </>
  );

  return (
    <TableBody>
      {rows.map((row) => {
        const share = totalCost > 0 ? row.estCostUsd / totalCost : 0;
        const detail = row.tools ?? [];
        const isOpen = expandable && expanded.has(row.name) && detail.length > 0;
        return (
          <>
            <TableRow key={row.name}>{cells(row, share)}</TableRow>
            {isOpen ? detail.map(detailRow) : null}
          </>
        );
      })}
    </TableBody>
  );
}

const BREAKDOWN_HEADERS = ["Name", "Calls", "Input", "Output", "Cache read", "Est. cost", "Share", "Last used"];

export function BreakdownPage() {
  const registries = useIdentitiesQuery();
  const [days, setDays] = useState(30);

  // (tool, identity) pairs from the registries, not from a heavy unscoped
  // breakdown scan: selecting a pair is what triggers the fetch.
  const pairs = useMemo(
    () =>
      (registries.data?.registries ?? []).flatMap((registry) =>
        registry.identities.map((identity) => ({ tool: registry.toolName, identity: identity.name })),
      ),
    [registries.data],
  );
  const [selected, setSelected] = useState("");
  const effective = selected || (pairs[0] ? `${pairs[0].tool}:${pairs[0].identity}` : "");
  const [selTool, selIdentity] = effective.split(":") as [string, string];

  const query = useBreakdownQuery(selIdentity, selTool, days);
  const result = query.data?.results[0];
  const categories = result && isToolScoped(result) ? result.categories : [];
  const totalCost = categories.reduce((sum, c) => sum + c.estCostUsd, 0);
  const totalCalls = categories.reduce((sum, c) => sum + c.callCount, 0);
  const totalOutput = categories.reduce((sum, c) => sum + c.outputTokens, 0);
  const totalInput = categories.reduce((sum, c) => sum + c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens, 0);
  const editSummary = summariseEdits(categories);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Breakdown"
        description="What used the most tokens and estimated cost per identity: tool calls, MCP servers, code edits. Local-log estimates, not real spend."
        updatedAt={query.dataUpdatedAt}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select value={effective} onValueChange={setSelected}>
          <SelectTrigger className="w-64 h-8 text-xs" aria-label="Identity">
            <SelectValue placeholder="Identity" />
          </SelectTrigger>
          <SelectContent>
            {pairs.map((pair) => (
              <SelectItem key={`${pair.tool}:${pair.identity}`} value={`${pair.tool}:${pair.identity}`} className="text-xs">
                {pair.identity} ({pair.tool})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-32 h-8 text-xs" aria-label="Window">
            <SelectValue placeholder="Window" />
          </SelectTrigger>
          <SelectContent>
            {DAY_OPTIONS.map((option) => (
              <SelectItem key={option} value={String(option)} className="text-xs">
                Last {option} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => query.refetch()}>
          Refresh
        </Button>
        {result ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {result.filesRead} log file{result.filesRead === 1 ? "" : "s"} scanned
          </span>
        ) : null}
      </div>

      {query.isLoading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
          <div className="h-64 animate-pulse rounded-xl bg-muted" />
        </div>
      ) : query.isError && !query.data ? (
        <ErrorBanner message={query.error.message} />
      ) : !result ? (
        <EmptyState title="No identity selected" description="Pick an identity above to scan its local session logs." />
      ) : result.unavailable ? (
        <ErrorBanner
          message={`Per-call breakdown unavailable for ${result.identity} (${result.tool}): ${result.unavailable}`}
        />
      ) : categories.length === 0 ? (
        <EmptyState
          title="No usage in this window"
          description={`No local session activity for ${result.identity} (${result.tool}) in the last ${result.windowDays} days.`}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Est. cost" value={formatMoney(totalCost)} sub={`${result.windowDays}-day window, list prices`} />
            <StatCard label="Tool calls" value={totalCalls.toLocaleString()} sub="attribution: output split per call" />
            <StatCard label="Output tokens" value={formatTokens(totalOutput)} />
            <StatCard label="Prompt tokens" value={formatTokens(totalInput)} sub="input + cache, always on 'chat'" />
          </div>

          {editSummary ? (
            <Card className="gap-3">
              <CardHeader>
                <CardTitle className="text-base">Code edits</CardTitle>
                <CardDescription>
                  Edit/Write-style tools grouped; each tool is still listed individually below.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Group</TableHead>
                      <TableHead className="text-right">Calls</TableHead>
                      <TableHead className="text-right">Output</TableHead>
                      <TableHead className="text-right">Est. cost</TableHead>
                      <TableHead>Share of total cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell className="font-mono text-xs">code edits</TableCell>
                      <TableCell className="text-right tabular-nums">{editSummary.callCount.toLocaleString()}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatTokens(editSummary.outputTokens)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(editSummary.estCostUsd)}</TableCell>
                      <TableCell>
                        <ShareBar share={totalCost > 0 ? editSummary.estCostUsd / totalCost : 0} />
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}

          <Card className="gap-3">
            <CardHeader>
              <div className="space-y-1">
                <CardTitle className="text-base">Top consumers</CardTitle>
                <CardDescription>
                  {result.identity} ({result.tool}), cost-desc. ESTIMATES: per-call attribution is heuristic, never real
                  billed spend. MCP servers expand to their tools.
                </CardDescription>
              </div>
              <ToolBadge tool={result.tool} />
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {BREAKDOWN_HEADERS.map((header, i) => (
                      <TableHead key={header} className={i >= 1 && i <= 5 ? "text-right" : undefined}>
                        {header}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <CategoryRows rows={categories} totalCost={totalCost} expandable />
              </Table>
            </CardContent>
          </Card>

          {result.notes?.map((note) => (
            <p key={note} className="text-xs text-muted-foreground">
              Note: {note}
            </p>
          ))}
        </>
      )}
    </div>
  );
}

export default BreakdownPage;
