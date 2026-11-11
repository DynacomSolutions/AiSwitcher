import { useMemo, useState } from "react";
import { ResponsiveBar } from "@nivo/bar";
import type { BarTooltipProps } from "@nivo/bar";

import { IdentityChip } from "@/components/badges";
import { ProviderIcon, ProviderLabel } from "@/components/provider-icon";
import { PageTabRedirect, PageTabs, usePageTab, type PageTab } from "@/components/page-tabs";
import { UsageProjects } from "@/components/usage-projects";
import { UsageDataStatus } from "@/components/usage-data-status";
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
import { useGatewayUsageQuery, useUsageQuery } from "@/hooks/queries";
import { formatCount, formatDateMs, formatMoney, formatTokens } from "@/lib/format";
import { applyPeriod, buildBuckets, periodLabel, providersByTokens, type Bucket, type Granularity, type SinceDays } from "@/lib/usage-period";
import { classifyUsageError, hasPartialUsageCoverage, usageErrorLabel } from "@/lib/usage-summary";
import type { GatewayUsageResponse, RealCostInfo, TokscaleEntry, UsageResult } from "@/types/api";


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
  filters: { provider: string; identity: string; model: string },
): UsageResult[] {
  return results.filter((result) => {
    if (filters.provider !== "all" && result.provider !== filters.provider) return false;
    if (filters.identity !== "all" && result.identity.name !== filters.identity) return false;
    if (filters.model !== "all" && !result.report?.entries.some((e) => e.model === filters.model)) return false;
    return true;
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

/** Theme-aware chart colours. nivo draws axis text as SVG <text>, which is
 * painted with `fill` (not CSS `color`), so the theme must set `fill`; the
 * CSS variables follow the light/dark class on <html>. */
const CHART_THEME = {
  text: { fill: "var(--muted-foreground)", fontSize: 11 },
  axis: {
    ticks: {
      line: { stroke: "var(--border)" },
      text: { fill: "var(--muted-foreground)", fontSize: 11 },
    },
    legend: { text: { fill: "var(--muted-foreground)", fontSize: 11 } },
  },
  grid: { line: { stroke: "var(--border)", strokeWidth: 1 } },
};

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
  const colourOf = (key: string) => CHART_PALETTE[keys.indexOf(key) % CHART_PALETTE.length];

  return (
    <div className="h-72 w-full">
      <ResponsiveBar
        data={buckets}
        keys={keys}
        indexBy="date"
        margin={{ top: 8, right: 8, bottom: 52, left: 56 }}
        padding={0.2}
        colors={({ id }) => colourOf(String(id))}
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
        enableLabel={false}
        theme={CHART_THEME}
        tooltip={(props: BarTooltipProps<Bucket>) => {
          const rows = keys
            .map((key) => ({ key, tokens: Number(props.data[key] ?? 0) }))
            .filter((row) => row.tokens > 0);
          const total = rows.reduce((sum, row) => sum + row.tokens, 0);
          return (
            <div className="w-max rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
              <p className="whitespace-nowrap font-mono font-medium">{props.data.date}</p>
              <ul className="mt-1.5 space-y-0.5">
                {rows.map((row) => (
                  <li
                    key={row.key}
                    className={`flex items-center gap-2 whitespace-nowrap ${row.key === String(props.id) ? "font-semibold" : "text-muted-foreground"}`}
                  >
                    <span className="size-2.5 shrink-0 rounded-sm" style={{ background: colourOf(row.key) }} />
                    <span>{row.key}</span>
                    <span className="ml-auto pl-4 tabular-nums">{formatTokens(row.tokens)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-1.5 flex items-center gap-2 whitespace-nowrap border-t pt-1.5 font-bold">
                <span>Total</span>
                <span className="ml-auto pl-4 tabular-nums">{formatTokens(total)} tokens</span>
              </div>
            </div>
          );
        }}
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

/** Upper bound for an in-cell error reason: a chatty Cost Explorer failure
 * must not stretch the Notes column just to carry a diagnostic. */
const MAX_REASON_CHARS = 60;

function shortReason(error: string): string {
  return error.length > MAX_REASON_CHARS ? `${error.slice(0, MAX_REASON_CHARS - 1)}…` : error;
}

/** The real-cost cell aligned under the Notes column (this table's real-spend
 * slot, the same place kimi's overage rides): REAL AWS-reported spend plus
 * the compact budget context, never in the Est. cost column. An errored
 * query reads "unavailable": a missing real figure is not a zero. */
function realCostValue(real: RealCostInfo): string {
  if (real.monthToDateUsd === undefined) {
    return `real unavailable${real.error ? `: ${shortReason(real.error)}` : ""}`;
  }
  let text = `real ${formatMoney(real.monthToDateUsd)}`;
  if (real.windowUsd !== undefined && Math.abs(real.windowUsd - real.monthToDateUsd) > 0.005) {
    text += ` · trailing 3mo ${formatMoney(real.windowUsd)}`;
  }
  if (real.budgetLimitUsd !== undefined) {
    text +=
      real.budgetActualUsd !== undefined
        ? ` · budget ${formatMoney(real.budgetActualUsd)}/${formatMoney(real.budgetLimitUsd)}`
        : ` · budget ${formatMoney(real.budgetLimitUsd)}`;
  }
  if (real.note) text += ` (${real.note})`;
  return text;
}

/** The dimmed dashes filling a real-cost sub-row's numeric columns. */
function RealSubDashCells() {
  return (
    <>
      {Array.from({ length: 5 }, (_, i) => (
        <TableCell key={i} className="border-none py-1 text-center text-xs text-muted-foreground">
          ─
        </TableCell>
      ))}
    </>
  );
}

function NotesCell({ result }: { result: UsageResult }) {
  if (result.pending) return <Badge variant="muted">Collecting</Badge>;
  if (result.error)
    return (
      <span className="block max-w-64 truncate text-xs text-muted-foreground">
        {usageErrorLabel(classifyUsageError(result.error))}
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

/** Per-app gateway tokens from the admin API (only reachable when the console has gateway admin credentials). */
function GatewayAppsCard({ data, days }: { data: GatewayUsageResponse; days: number }) {
  const total = data.rows.reduce((sum, row) => sum + row.tokens, 0);
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-base">Gateway apps</CardTitle>
        <CardDescription>
          Tokens per gateway app over the last {days} days (input, output and cache writes).
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {data.error ? (
          <p className="px-6 text-xs text-muted-foreground">Gateway usage unavailable: {data.error}</p>
        ) : data.rows.length === 0 ? (
          <p className="px-6 text-xs text-muted-foreground">No gateway apps yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>App</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="w-40">Share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row) => (
                <TableRow key={row.app}>
                  <TableCell className="font-mono text-xs">{row.app}</TableCell>
                  <TableCell>
                    <ProviderLabel provider={row.provider} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatTokens(row.tokens)}</TableCell>
                  <TableCell>
                    <div className="h-1.5 w-full rounded-full bg-muted">
                      <div
                        className="h-1.5 rounded-full bg-primary"
                        style={{ width: `${total > 0 ? Math.round((row.tokens / total) * 100) : 0}%` }}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

const USAGE_BASE = "/usage";

export function UsagePage() {
  const query = useUsageQuery();
  const gateway = useGatewayUsageQuery(7);
  const gatewayData = gateway.data?.configured ? gateway.data : undefined;
  const results = query.data?.results ?? [];

  const [provider, setProvider] = useState("all");
  const [identity, setIdentity] = useState("all");
  const [model, setModel] = useState("all");
  const [since, setSince] = useState<SinceDays>(0);
  const [granularity, setGranularity] = useState<Granularity>("day");

  const filtered = useMemo(
    () => filterResults(results, { provider, identity, model }),
    [results, provider, identity, model],
  );

  const providerOptions = useMemo(() => uniqueSorted(results.map((r) => r.provider)), [results]);
  const identityOptions = useMemo(() => uniqueSorted(results.map((r) => r.identity.name)), [results]);
  const modelOptions = useMemo(
    () => uniqueSorted(results.flatMap((r) => r.report?.entries.map((e) => e.model) ?? [])),
    [results],
  );

  const buckets = useMemo(() => buildBuckets(filtered, granularity, since), [filtered, granularity, since]);
  const bucketProviders = useMemo(() => providersByTokens(filtered, since).slice(0, 5), [filtered, since]);

  // Every figure below follows the selected period. "All time" leaves the
  // reports untouched, so it matches the CLI's TOTAL row exactly.
  const { rows: shown, withoutHistory } = useMemo(() => applyPeriod(filtered, since), [filtered, since]);
  const period = periodLabel(since);
  // Per-model figures exist only for the whole history, so this card is always all time.
  const modelRows = useMemo(() => buildModelRows(filtered), [filtered]);
  const modelTotal = modelRows.reduce((sum, row) => sum + row.input + row.output, 0);
  const totalCost = sumReport(shown, (r) => r.totalCost);
  const totalInput = sumReport(shown, (r) => r.totalInput);
  const totalOutput = sumReport(shown, (r) => r.totalOutput);
  const totalCacheRead = sumReport(shown, (r) => r.totalCacheRead);
  const totalCacheWrite = sumReport(shown, (r) => r.totalCacheWrite);
  const totalMessages = sumReport(shown, (r) => r.totalMessages);
  const hasAnyReport = shown.some((r) => r.report !== undefined);
  const hasPartialCoverage = hasPartialUsageCoverage(results, { provider, tool: "all", identity });
  // Real AWS spend is summarised separately from the estimate total: only
  // rows whose Cost Explorer query actually answered contribute (an
  // unavailable figure must not read as a confirmed zero).
  const realTotal = shown.reduce((sum, r) => (typeof r.realCost?.monthToDateUsd === "number" ? sum + r.realCost.monthToDateUsd : sum), 0);
  const hasRealTotal = shown.some((r) => typeof r.realCost?.monthToDateUsd === "number");

  const reset = () => {
    setProvider("all");
    setIdentity("all");
    setModel("all");
  };
  const hasActiveFilter = provider !== "all" || identity !== "all" || model !== "all";

  const ready = !(query.isLoading || (query.data?.pending && results.length === 0)) && !(query.isError && !query.data) && results.length > 0;
  const tabs = useMemo<PageTab[]>(
    () => [
      { segment: "overview", label: "Overview" },
      { segment: "models", label: "Models" },
      { segment: "sources", label: "Sources" },
      { segment: "projects", label: "Projects" },
      { segment: "repos", label: "Repos" },
      { segment: "orgs", label: "Orgs" },
      ...(gatewayData ? [{ segment: "gateway", label: "Gateway apps" }] : []),
    ],
    [gatewayData],
  );
  const { active, invalid } = usePageTab(tabs);
  if (invalid) return <PageTabRedirect to={USAGE_BASE} />;


  const stateBlock = query.isLoading || (query.data?.pending && results.length === 0) ? (
    <div className="space-y-4">
      <div className="h-72 animate-pulse rounded-xl bg-muted" />
      <div className="h-64 animate-pulse rounded-xl bg-muted" />
    </div>
  ) : query.isError && !query.data ? (
    <ErrorBanner message="Usage data could not be loaded. Try again shortly." />
  ) : results.length === 0 ? (
    <EmptyState
      title="No usage recorded"
      description="Token usage appears once identities have local session history."
    />
  ) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Usage"
        description="Local token and cost estimates per upstream provider, aggregated by the server."
        updatedAt={query.dataUpdatedAt}
      />

      {query.data ? (
        <UsageDataStatus response={query.data} refreshFailed={query.isError} />
      ) : null}

      {ready ? (
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect label="Provider" value={provider} onChange={setProvider} options={[{ value: "all", label: "All providers" }, ...providerOptions.map((p) => ({ value: p, label: p }))]} />
          <FilterSelect label="Identity" value={identity} onChange={setIdentity} options={[{ value: "all", label: "All identities" }, ...identityOptions.map((i) => ({ value: i, label: i }))]} />
          <FilterSelect label="Model" value={model} onChange={setModel} options={[{ value: "all", label: "All models" }, ...modelOptions.map((m) => ({ value: m, label: m }))]} width="w-52" />
          <FilterSelect label="Period" value={String(since)} onChange={(v) => setSince(Number(v) as SinceDays)} options={SINCE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))} width="w-32" />
          {hasActiveFilter ? (
            <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={reset}>
              Reset filters
            </Button>
          ) : null}
          <span className="ml-auto text-xs text-muted-foreground">
            {shown.length} of {results.length} series
          </span>
        </div>

      ) : null}

      {ready || gatewayData ? <PageTabs tabs={tabs} active={active} base={USAGE_BASE} /> : null}

      {active === "gateway" && gatewayData ? (
        <GatewayAppsCard data={gatewayData} days={7} />
      ) : !ready ? (
        stateBlock
      ) : (
        <>
          {active === "overview" ? (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <StatCard label="Input tokens" value={formatCount(totalInput)} sub={period} />
                <StatCard label="Output tokens" value={formatCount(totalOutput)} sub={period} />
                <StatCard label="Cache tokens" value={formatCount(totalCacheRead + totalCacheWrite)} sub={`reads + writes, ${period}`} />
                <StatCard label="Messages" value={formatCount(totalMessages)} sub={period} />
                <StatCard label={`Est. cost (${period})`} value={formatMoney(totalCost)} sub={since === 0 ? "for selected sources" : "sum of per-day costs"} />
              </div>
              {since !== 0 ? (
                <p className="text-xs text-muted-foreground">
                  Totals are exact sums of per-day figures for the {period}.
                  {withoutHistory > 0
                    ? ` ${withoutHistory} ${withoutHistory === 1 ? "series has" : "series have"} no daily history and only count under All time, because their source has no per-day split.`
                    : ""}
                </p>
              ) : null}

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
            </>
          ) : null}

          {active === "models" ? (
            modelRows.length > 0 ? (
              (
                <Card className="gap-3">
                  <CardHeader>
                    <CardTitle className="text-base">By model</CardTitle>
                    <CardDescription>Per-model totals across the filtered set, always all time (the API has no per-day model split).</CardDescription>
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
                          <TableHead className="text-right">Est. cost (all time)</TableHead>
                          <TableHead className="w-40">Share</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {modelRows.map((row) => {
                          const share = modelTotal > 0 ? (row.input + row.output) / modelTotal : 0;
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
                              <TableCell className="text-right tabular-nums">{formatCount(row.input)}</TableCell>
                              <TableCell className="text-right tabular-nums">{formatCount(row.output)}</TableCell>
                              <TableCell className="text-right tabular-nums">{formatCount(row.messages)}</TableCell>
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
              )
            ) : (
              <EmptyState title="No per-model figures" description="No model breakdown is available for this filter." />
            )
          ) : null}

          {active === "sources" ? (
            <>
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
                      <TableHead className="text-right">Est. cost ({period})</TableHead>
                      <TableHead>Notes</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.flatMap((r, index) => [
                      <TableRow key={`${r.provider}/${r.identity.name}/${index}`}>
                        <TableCell className="font-medium">
                          <ProviderLabel provider={r.provider} />
                        </TableCell>
                        <TableCell>
                          <span className="flex items-center gap-1.5">
                            <IdentityChip name={r.identity.name} />
                            {r.identity.retired ? <Badge variant="muted">Retired</Badge> : null}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {spanText(r)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.report ? formatCount(r.report.totalInput) : "-"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.report ? formatCount(r.report.totalOutput) : "-"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {r.report ? formatCount(r.report.totalCacheRead) : "-"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {r.report ? formatCount(r.report.totalCacheWrite) : "-"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.report ? formatCount(r.report.totalMessages) : "-"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.report ? formatMoney(r.report.totalCost) : "-"}
                        </TableCell>
                        <TableCell>
                          <NotesCell result={r} />
                        </TableCell>
                      </TableRow>,
                      // Real-cost sub-row: a genuine row in the same column grid
                      // (label under Identity, dashes across the numeric columns),
                      // with the real dollars ONLY in the Notes cell, so real AWS
                      // spend never sits in the Est. cost column.
                      r.realCost ? (
                        <TableRow key={`${r.provider}/${r.identity.name}/${index}/real`} className="hover:bg-transparent">
                          <TableCell className="border-none py-1" />
                          <TableCell className="border-none py-1 text-xs text-muted-foreground">└ {r.realCost.label}</TableCell>
                          <TableCell className="border-none py-1" />
                          <RealSubDashCells />
                          <TableCell className="border-none py-1" />
                          <TableCell className="border-none py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                            {realCostValue(r.realCost)}
                          </TableCell>
                        </TableRow>
                      ) : null,
                    ])}
                    <TableRow className="border-t-2 hover:bg-transparent">
                      <TableCell colSpan={3} className="font-semibold">
                        {hasPartialCoverage ? `PARTIAL TOTAL (${period} estimate)` : `TOTAL (${period} estimate)`}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{formatCount(totalInput)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{formatCount(totalOutput)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{formatCount(totalCacheRead)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{formatCount(totalCacheWrite)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{formatCount(totalMessages)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{formatMoney(totalCost)}</TableCell>
                      <TableCell />
                    </TableRow>
                    {hasRealTotal ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell className="border-none py-1" />
                        <TableCell className="border-none py-1 text-xs text-muted-foreground">└ real AWS total</TableCell>
                        <TableCell className="border-none py-1" />
                        <RealSubDashCells />
                        <TableCell className="border-none py-1" />
                        <TableCell className="border-none py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                          real {formatMoney(realTotal)}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
              {!hasAnyReport && buckets.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No provider returned a usage report for this filter; see the notes column for errors.
                </p>
              ) : null}
            </>
          ) : null}

          {active === "projects" ? <UsageProjects grouping="project" since={since} provider={provider} identity={identity} usageCost={totalCost} /> : null}
          {active === "repos" ? <UsageProjects grouping="repo" since={since} provider={provider} identity={identity} usageCost={totalCost} /> : null}
          {active === "orgs" ? <UsageProjects grouping="org" since={since} provider={provider} identity={identity} usageCost={totalCost} /> : null}
        </>
      )}
    </div>
  );
}

export default UsagePage;
