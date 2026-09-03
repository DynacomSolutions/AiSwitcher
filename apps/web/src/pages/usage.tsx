import { useMemo, useState } from "react";
import { ResponsiveBar } from "@nivo/bar";
import type { BarTooltipProps } from "@nivo/bar";

import { IdentityChip, ToolBadge } from "@/components/badges";
import { ProviderIcon, ProviderLabel } from "@/components/provider-icon";
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
import { useUsageQuery } from "@/hooks/queries";
import { formatDateMs, formatMoney, formatTokens } from "@/lib/format";
import type { TokscaleEntry, UsageResult } from "@/types/api";

type Granularity = "day" | "week" | "month";
type SinceDays = 7 | 30 | 90 | 0;

const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
];

const SINCE_OPTIONS: { value: SinceDays; label: string }[] = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
  { value: 0, label: "All time" },
];

const CHART_PALETTE = ["#8b5cf6", "#22d3ee", "#f59e0b", "#34d399", "#f472b6", "#94a3b8"];

interface Bucket {
  [key: string]: string | number;
  date: string;
}

function withinSince(dateKey: string, since: SinceDays): boolean {
  if (since === 0) return true;
  const cutoff = Date.now() - since * 86_400_000;
  return dateKey >= formatDateMs(cutoff);
}

function bucketKey(dateKey: string, granularity: Granularity): string {
  if (granularity === "day") return dateKey;
  const date = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateKey;
  if (granularity === "month") return dateKey.slice(0, 7);
  // Monday-start week: back up from the date to its Monday.
  const day = (date.getDay() + 6) % 7;
  const monday = new Date(date);
  monday.setDate(date.getDate() - day);
  return formatDateMs(monday.getTime());
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function sumReport(results: UsageResult[], pick: (report: NonNullable<UsageResult["report"]>) => number): number {
  let total = 0;
  for (const result of results) if (result.report) total += pick(result.report);
  return total;
}

function filterResults(
  results: UsageResult[],
  filters: { provider: string; tool: string; identity: string; model: string; since: SinceDays },
): UsageResult[] {
  return results.filter((result) => {
    if (filters.provider !== "all" && result.provider !== filters.provider) return false;
    if (filters.tool !== "all" && (result.sourceTool ?? "unknown") !== filters.tool) return false;
    if (filters.identity !== "all" && result.identity.name !== filters.identity) return false;
    if (filters.model !== "all" && !result.report?.entries.some((e) => e.model === filters.model)) return false;
    if (filters.since !== 0 && result.dailyUsage) {
      const keys = Object.keys(result.dailyUsage);
      if (keys.length > 0 && !keys.some((k) => withinSince(k, filters.since))) return false;
    }
    return true;
  });
}

/** Per-bucket token totals stacked by provider. Buckets are padded with zero
 * entries between first and last active bucket so gaps read as zero bars. */
function buildBuckets(results: UsageResult[], granularity: Granularity, since: SinceDays): Bucket[] {
  const perProvider = new Map<string, Map<string, number>>();
  for (const result of results) {
    if (!result.dailyUsage) continue;
    for (const [date, tokens] of Object.entries(result.dailyUsage)) {
      if (!withinSince(date, since)) continue;
      const key = bucketKey(date, granularity);
      let series = perProvider.get(result.provider);
      if (!series) perProvider.set(result.provider, (series = new Map()));
      series.set(key, (series.get(key) ?? 0) + tokens);
    }
  }
  if (perProvider.size === 0) return [];

  const totals = new Map<string, number>();
  for (const series of perProvider.values())
    for (const [key, value] of series) totals.set(key, (totals.get(key) ?? 0) + value);
  const keys = [...totals.keys()].sort();

  const topProviders = [...perProvider.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 5)
    .map(([provider]) => provider);

  // Dense bucket sequence so empty weeks/months render as zero, not gaps.
  const dense: string[] = [];
  let cursor = new Date(`${keys[0]}T00:00:00`);
  const last = new Date(`${keys[keys.length - 1]}T00:00:00`);
  const step = granularity === "day" ? 1 : granularity === "week" ? 7 : 1;
  while (cursor <= last && dense.length < 400) {
    dense.push(formatDateMs(cursor.getTime()));
    if (granularity === "month") cursor.setMonth(cursor.getMonth() + 1);
    else cursor.setDate(cursor.getDate() + step);
  }

  return dense.map((date) => {
    const bucket: Bucket = { date };
    let covered = 0;
    for (const [provider, series] of perProvider) {
      if (!topProviders.includes(provider)) continue;
      const value = series.get(date) ?? 0;
      bucket[provider] = value;
      covered += value;
    }
    const total = totals.get(date) ?? 0;
    bucket.other = Math.max(0, total - covered);
    return bucket;
  });
}

interface ModelRow {
  model: string;
  providers: Set<string>;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  cost: number;
}

function buildModelRows(results: UsageResult[]): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const result of results) {
    const entries: TokscaleEntry[] = result.report?.entries ?? [];
    for (const entry of entries) {
      let row = rows.get(entry.model);
      if (!row) rows.set(entry.model, (row = { model: entry.model, providers: new Set(), input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, cost: 0 }));
      row.providers.add(result.provider);
      row.input += entry.input;
      row.output += entry.output;
      row.cacheRead += entry.cacheRead;
      row.cacheWrite += entry.cacheWrite;
      row.messages += entry.messageCount;
      row.cost += entry.cost;
    }
  }
  return [...rows.values()].sort((a, b) => b.cost - a.cost || b.input + b.output - (a.input + a.output));
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

function FilterSelect({ label, value, onChange, options, width = "w-40" }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  width?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={`${width} h-8 text-xs`} aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="text-xs">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function UsageChart({ buckets, providers }: { buckets: Bucket[]; providers: string[] }) {
  const keys = useMemo(
    () => [...providers, ...(buckets.some((b) => (b.other as number) > 0) ? ["other"] : [])],
    [buckets, providers],
  );
  const tickValues = useMemo(() => {
    if (buckets.length <= 12) return buckets.map((b) => b.date);
    const step = Math.ceil(buckets.length / 12);
    return buckets.filter((_, i) => i % step === 0).map((b) => b.date);
  }, [buckets]);

  return (
    <div className="h-72 w-full">
      <ResponsiveBar
        data={buckets}
        keys={keys}
        indexBy="date"
        margin={{ top: 8, right: 8, bottom: 52, left: 56 }}
        padding={0.2}
        colors={({ id }) => CHART_PALETTE[keys.indexOf(String(id)) % CHART_PALETTE.length]}
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
        axisLeft={{ tickSize: 4, tickPadding: 6, format: (value: number) => formatTokens(value) }}
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
        tooltip={(props: BarTooltipProps<Bucket>) => (
          <div className="rounded-lg border bg-popover px-2.5 py-1.5 text-xs shadow-md">
            <p className="font-mono">{props.data.date}</p>
            <p className="mt-0.5 text-muted-foreground">
              {props.id === "total" || props.id === "other" ? "" : `${String(props.id)}: `}
              {formatTokens(Number(props.value))} tokens
            </p>
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

  const [provider, setProvider] = useState("all");
  const [tool, setTool] = useState("all");
  const [identity, setIdentity] = useState("all");
  const [model, setModel] = useState("all");
  const [since, setSince] = useState<SinceDays>(30);
  const [granularity, setGranularity] = useState<Granularity>("day");

  const filtered = useMemo(
    () => filterResults(results, { provider, tool, identity, model, since }),
    [results, provider, tool, identity, model, since],
  );

  const providerOptions = useMemo(() => uniqueSorted(results.map((r) => r.provider)), [results]);
  const toolOptions = useMemo(() => uniqueSorted(results.map((r) => r.sourceTool ?? "unknown")), [results]);
  const identityOptions = useMemo(() => uniqueSorted(results.map((r) => r.identity.name)), [results]);
  const modelOptions = useMemo(
    () => uniqueSorted(results.flatMap((r) => r.report?.entries.map((e) => e.model) ?? [])),
    [results],
  );

  const buckets = useMemo(() => buildBuckets(filtered, granularity, since), [filtered, granularity, since]);
  const bucketProviders = useMemo(() => perProviderIn(filtered, since).slice(0, 5), [filtered, since]);

  const modelRows = useMemo(() => buildModelRows(filtered), [filtered]);
  const totalCost = sumReport(filtered, (r) => r.totalCost);
  const totalInput = sumReport(filtered, (r) => r.totalInput);
  const totalOutput = sumReport(filtered, (r) => r.totalOutput);
  const totalCacheRead = sumReport(filtered, (r) => r.totalCacheRead);
  const totalCacheWrite = sumReport(filtered, (r) => r.totalCacheWrite);
  const totalMessages = sumReport(filtered, (r) => r.totalMessages);
  const hasAnyReport = filtered.some((r) => r.report !== undefined);

  const reset = () => {
    setProvider("all");
    setTool("all");
    setIdentity("all");
    setModel("all");
  };
  const hasActiveFilter = provider !== "all" || tool !== "all" || identity !== "all" || model !== "all";

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
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect label="Provider" value={provider} onChange={setProvider} options={[{ value: "all", label: "All providers" }, ...providerOptions.map((p) => ({ value: p, label: p }))]} />
            <FilterSelect label="Tool" value={tool} onChange={setTool} options={[{ value: "all", label: "All tools" }, ...toolOptions.map((t) => ({ value: t, label: t }))]} />
            <FilterSelect label="Identity" value={identity} onChange={setIdentity} options={[{ value: "all", label: "All identities" }, ...identityOptions.map((i) => ({ value: i, label: i }))]} />
            <FilterSelect label="Model" value={model} onChange={setModel} options={[{ value: "all", label: "All models" }, ...modelOptions.map((m) => ({ value: m, label: m }))]} width="w-52" />
            <FilterSelect label="Period" value={String(since)} onChange={(v) => setSince(Number(v) as SinceDays)} options={SINCE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))} width="w-32" />
            {hasActiveFilter ? (
              <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={reset}>
                Reset filters
              </Button>
            ) : null}
            <span className="ml-auto text-xs text-muted-foreground">
              {filtered.length} of {results.length} series
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatCard label="Input tokens" value={formatTokens(totalInput)} />
            <StatCard label="Output tokens" value={formatTokens(totalOutput)} />
            <StatCard label="Cache tokens" value={formatTokens(totalCacheRead + totalCacheWrite)} sub="reads + writes" />
            <StatCard label="Messages" value={totalMessages.toLocaleString()} />
            <StatCard label="Est. cost" value={formatMoney(totalCost)} sub="filtered set" />
          </div>

          {buckets.length > 0 ? (
            <Card className="gap-3">
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div className="space-y-1">
                  <CardTitle className="text-base">Tokens over time</CardTitle>
                  <CardDescription>Input plus output, stacked by provider.</CardDescription>
                </div>
                <div className="flex gap-1">
                  {GRANULARITIES.map((g) => (
                    <Button
                      key={g.value}
                      variant={granularity === g.value ? "secondary" : "ghost"}
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => setGranularity(g.value)}
                    >
                      {g.label}
                    </Button>
                  ))}
                </div>
              </CardHeader>
              <CardContent>
                <UsageChart buckets={buckets} providers={bucketProviders} />
              </CardContent>
            </Card>
          ) : null}

          {modelRows.length > 0 ? (
            <Card className="gap-3">
              <CardHeader>
                <CardTitle className="text-base">By model</CardTitle>
                <CardDescription>Per-model totals across the filtered set.</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Model</TableHead>
                      <TableHead>Providers</TableHead>
                      <TableHead className="text-right">Input</TableHead>
                      <TableHead className="text-right">Output</TableHead>
                      <TableHead className="text-right">Messages</TableHead>
                      <TableHead className="text-right">Est. cost</TableHead>
                      <TableHead className="w-40">Share</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {modelRows.map((row) => {
                      const share = totalInput + totalOutput > 0 ? (row.input + row.output) / (totalInput + totalOutput) : 0;
                      return (
                        <TableRow key={row.model}>
                          <TableCell className="max-w-72 truncate font-mono text-xs" title={row.model}>
                            {row.model}
                          </TableCell>
                          <TableCell>
                            <span className="flex flex-wrap items-center gap-2">
                              {[...row.providers].map((p) => (
                                <ProviderIcon key={p} provider={p} size={13} />
                              ))}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(row.input)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(row.output)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(row.messages)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatMoney(row.cost)}</TableCell>
                          <TableCell>
                            <span className="flex items-center gap-2">
                              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                                <span className="block h-full rounded-full bg-violet-500" style={{ width: `${Math.round(share * 100)}%` }} />
                              </span>
                              <span className="text-xs tabular-nums text-muted-foreground">{Math.round(share * 100)}%</span>
                            </span>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}

          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Provider</TableHead>
                  <TableHead>Tool</TableHead>
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
                {filtered.map((r, index) => (
                  <TableRow key={`${r.provider}/${r.identity.name}/${index}`}>
                    <TableCell className="font-medium">
                      <ProviderLabel provider={r.provider} />
                    </TableCell>
                    <TableCell>
                      <ToolBadge tool={r.sourceTool ?? "unknown"} />
                    </TableCell>
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
                <TableRow className="border-t-2 hover:bg-transparent">
                  <TableCell colSpan={4} className="font-semibold">
                    TOTAL
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatTokens(totalInput)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatTokens(totalOutput)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatTokens(totalCacheRead)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatTokens(totalCacheWrite)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{totalMessages.toLocaleString()}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{formatMoney(totalCost)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </div>
          {!hasAnyReport && buckets.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No provider returned a usage report for this filter; see the notes column for errors.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Providers with at least one in-window daily bucket, biggest first. */
function perProviderIn(results: UsageResult[], since: SinceDays): string[] {
  const totals = new Map<string, number>();
  for (const result of results) {
    if (!result.dailyUsage) continue;
    for (const [date, tokens] of Object.entries(result.dailyUsage)) {
      if (!withinSince(date, since)) continue;
      totals.set(result.provider, (totals.get(result.provider) ?? 0) + tokens);
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([provider]) => provider);
}

export default UsagePage;
