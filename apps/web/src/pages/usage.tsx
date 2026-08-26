import { useMemo } from "react";
import { ResponsiveBar } from "@nivo/bar";
import type { BarTooltipProps } from "@nivo/bar";

import { IdentityChip } from "@/components/badges";
import { EmptyState, ErrorBanner, PageHeader } from "@/components/page-header";
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
import { useUsageQuery } from "@/hooks/queries";
import { formatDateMs, formatMoney, formatTokens } from "@/lib/format";
import type { UsageResult } from "@/types/api";

/** Nivo requires an index signature on chart datum objects. */
interface ChartPoint {
  [key: string]: string | number;
  date: string;
  tokens: number;
}

function aggregateDaily(results: UsageResult[]): ChartPoint[] {
  const totals = new Map<string, number>();
  for (const result of results) {
    if (!result.dailyUsage) continue;
    for (const [date, tokens] of Object.entries(result.dailyUsage)) {
      totals.set(date, (totals.get(date) ?? 0) + tokens);
    }
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, tokens]) => ({ date, tokens }));
}

function DailyUsageChart({ data }: { data: ChartPoint[] }) {
  const tickValues = useMemo(() => {
    if (data.length <= 12) return data.map((d) => d.date);
    const step = Math.ceil(data.length / 12);
    return data.filter((_, i) => i % step === 0).map((d) => d.date);
  }, [data]);

  return (
    <div className="h-72 w-full">
      <ResponsiveBar
        data={data}
        keys={["tokens"]}
        indexBy="date"
        margin={{ top: 8, right: 8, bottom: 52, left: 56 }}
        padding={0.25}
        colors={["#8b5cf6"]}
        borderRadius={3}
        axisTop={null}
        axisRight={null}
        axisBottom={{
          tickSize: 4,
          tickPadding: 6,
          tickRotation: -45,
          tickValues,
          format: (value: string) => value.slice(5),
        }}
        axisLeft={{
          tickSize: 4,
          tickPadding: 6,
          format: (value: number) => formatTokens(value),
        }}
        enableGridY
        theme={{
          text: { color: "#a1a1aa", fontSize: 11 },
          grid: { line: { stroke: "rgba(148,163,184,0.14)" } },
          tooltip: {
            container: {
              background: "#1b1b21",
              color: "#e4e4e7",
              fontSize: "12px",
              borderRadius: "8px",
              border: "1px solid rgba(255,255,255,0.08)",
            },
          },
        }}
        tooltip={(props: BarTooltipProps<ChartPoint>) => (
          <div className="rounded-lg border bg-popover px-2.5 py-1.5 text-xs shadow-md">
            <p className="font-mono">{props.data.date}</p>
            <p className="mt-0.5 text-muted-foreground">{formatTokens(props.data.tokens)} tokens</p>
          </div>
        )}
      />
    </div>
  );
}

function spanText(result: UsageResult): string {
  if (!result.dateSpan) return "-";
  const first = formatDateMs(result.dateSpan.firstMs);
  const last = formatDateMs(result.dateSpan.lastMs);
  return first === last ? first : `${first} to ${last}`;
}

function NotesCell({ result }: { result: UsageResult }) {
  if (result.pending) return <Badge variant="muted">Collecting</Badge>;
  if (result.error)
    return (
      <span className="block max-w-64 truncate text-xs text-muted-foreground" title={result.error}>
        {result.error}
      </span>
    );
  if (result.extraCost) {
    const amount =
      result.extraCost.spentUsd !== undefined
        ? ` (${formatMoney(result.extraCost.spentUsd)}${
            result.extraCost.limitUsd !== undefined ? ` of ${formatMoney(result.extraCost.limitUsd)}` : ""
          })`
        : "";
    return (
      <span className={result.extraCost.active ? "text-xs text-amber-600 dark:text-amber-400" : "text-xs text-muted-foreground"}>
        {result.extraCost.label}
        {amount}
      </span>
    );
  }
  return <span className="text-muted-foreground">-</span>;
}

export function UsagePage() {
  const query = useUsageQuery();
  const results = query.data?.results ?? [];
  const chartData = useMemo(() => aggregateDaily(results), [results]);
  const hasAnyReport = results.some((r) => r.report !== undefined);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Usage"
        description="Local token and cost estimates per upstream provider, aggregated by the server."
        updatedAt={query.dataUpdatedAt}
      />

      {query.isLoading ? (
        <div className="space-y-4">
          <div className="h-72 animate-pulse rounded-xl bg-muted" />
          <div className="h-64 animate-pulse rounded-xl bg-muted" />
        </div>
      ) : query.isError && !query.data ? (
        <ErrorBanner message={query.error.message} />
      ) : results.length === 0 ? (
        <EmptyState
          title="No usage recorded"
          description="Token usage appears once identities have local session history."
        />
      ) : (
        <>
          {chartData.length > 0 ? (
            <Card className="gap-3">
              <CardHeader>
                <CardTitle className="text-base">Daily tokens</CardTitle>
                <CardDescription>Input plus output tokens across all providers.</CardDescription>
              </CardHeader>
              <CardContent>
                <DailyUsageChart data={chartData} />
              </CardContent>
            </Card>
          ) : null}

          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Provider</TableHead>
                  <TableHead>Identity</TableHead>
                  <TableHead>Span</TableHead>
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Cache read</TableHead>
                  <TableHead className="text-right">Cache write</TableHead>
                  <TableHead className="text-right">Messages</TableHead>
                  <TableHead className="text-right">Est. cost</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((r, index) => (
                  <TableRow key={`${r.provider}/${r.identity.name}/${index}`}>
                    <TableCell className="font-medium">{r.provider}</TableCell>
                    <TableCell>
                      <IdentityChip name={r.identity.name} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {spanText(r)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.report ? formatTokens(r.report.totalInput) : "-"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.report ? formatTokens(r.report.totalOutput) : "-"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {r.report ? formatTokens(r.report.totalCacheRead) : "-"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {r.report ? formatTokens(r.report.totalCacheWrite) : "-"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.report ? formatTokens(r.report.totalMessages) : "-"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.report ? `$${r.report.totalCost.toFixed(2)}` : "-"}
                    </TableCell>
                    <TableCell>
                      <NotesCell result={r} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {!hasAnyReport && !chartData.length ? (
            <p className="text-xs text-muted-foreground">
              No provider returned a usage report; see the notes column for errors.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export default UsagePage;
