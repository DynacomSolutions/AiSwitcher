import { useMemo } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";

import { ToolBadge } from "@/components/badges";
import { EmptyState, ErrorBanner, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useResetLogQuery } from "@/hooks/queries";
import { relTime } from "@/lib/format";
import {
  afterView,
  hasResetLogFilters,
  isoMs,
  needsCanonicalSearch,
  percentText,
  readResetLogFilters,
  RESET_LOG_OUTCOME_LABELS,
  RESET_LOG_OUTCOMES,
  RESET_LOG_PATH,
  RESET_LOG_PROVIDER_LABELS,
  RESET_LOG_PROVIDERS,
  RESET_LOG_TRIGGER_LABELS,
  RESET_LOG_TRIGGERS,
  resetLogSearch,
  windowName,
  withResetLogFilter,
  type ResetLogFilterKey,
  type ResetLogFilters,
} from "@/lib/reset-log";
import { formatResetTimes } from "@/lib/reset-time";
import { cn } from "@/lib/utils";
import type { ResetLogRow, ResetLogWindow } from "@/types/api";

const ALL = "all";

/** `/logs` is not a page of its own: it opens the reset log and keeps the query string. */
export function LogsIndexRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: RESET_LOG_PATH, search }} replace />;
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const label = (RESET_LOG_OUTCOME_LABELS as Record<string, string | undefined>)[outcome] ?? outcome;
  const variant = outcome === "reset" ? "success" : outcome === "error" ? "destructive" : outcome === "rejected" || outcome === "already_redeemed" ? "warning" : "muted";
  return <Badge variant={variant}>{label}</Badge>;
}

/** The ICT time first and the UK time alongside, with dates, as the Limits page shows reset times. Each zone has its own line. */
function Times({ iso, stacked = false }: { iso: string; stacked?: boolean }) {
  const ms = isoMs(iso);
  if (ms === null) return <>{iso}</>;
  const text = formatResetTimes(ms, { roundUp: false });
  if (!stacked) return <>{text}</>;
  return (
    <span title={text}>
      {text.split(", ").map((zone) => (
        <span key={zone} className="block whitespace-nowrap">
          {zone}
        </span>
      ))}
    </span>
  );
}

function WindowList({ windows, empty }: { windows: ResetLogWindow[]; empty: string }) {
  if (windows.length === 0) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <ul className="space-y-1">
      {windows.map((w) => (
        <li key={w.key} className="min-w-0">
          <span className="font-medium">{windowName(w)}</span> <span className="tabular-nums">{percentText(w.percent)}</span>
          {w.resetsAt ? (
            <span className="block text-xs text-muted-foreground">
              resets <Times iso={w.resetsAt} />
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function AfterCell({ row }: { row: ResetLogRow }) {
  const view = afterView(row);
  if (view.kind === "waiting") return <span className="text-muted-foreground">Waiting for next reading</span>;
  if (view.kind === "none") return <span className="text-muted-foreground" title="This attempt did not reset any window, so no later reading is expected.">None expected</span>;
  return (
    <div className="space-y-1">
      <WindowList windows={view.windows} empty="No windows in the reading" />
      {view.at ? <div className="text-xs text-muted-foreground">read {relTime(view.at)}</div> : null}
    </div>
  );
}

/** The cell padding of the table: the log has many columns, so each one is tight. */
const CELL = "px-2 align-top";

function ResetLogTableRow({ row }: { row: ResetLogRow }) {
  return (
    <TableRow data-slot="reset-log-row" data-id={row.id} className="align-top">
      <TableCell className={cn(CELL, "min-w-32 whitespace-normal")}>
        <time dateTime={row.at} className="block text-xs">
          <Times iso={row.at} stacked />
        </time>
        <span className="text-xs text-muted-foreground">{relTime(row.at)}</span>
      </TableCell>
      <TableCell className={cn(CELL, "max-w-36 whitespace-normal")}>
        <div className="flex flex-wrap items-center gap-1">
          <ToolBadge tool={row.provider} />
          <Badge variant={row.trigger === "auto" ? "secondary" : "outline"}>{RESET_LOG_TRIGGER_LABELS[row.trigger] ?? row.trigger}</Badge>
        </div>
        <div className="mt-1 break-words text-xs text-muted-foreground" title={`Actor: ${row.actor}`}>
          {row.actor}
        </div>
      </TableCell>
      <TableCell className={cn(CELL, "min-w-36 max-w-52 whitespace-normal")}>
        <div className="break-words font-medium" title={row.identity}>
          {row.identity}
        </div>
        {row.account ? <div className="break-all text-xs text-muted-foreground">{row.account}</div> : null}
        {row.pool ? <div className="break-words text-xs text-muted-foreground">pool {row.pool}</div> : null}
      </TableCell>
      <TableCell className={cn(CELL, "max-w-28 font-mono text-xs")}>
        {row.grantId ? <span className="block truncate" title={row.grantId}>{row.grantId}</span> : <span className="text-muted-foreground">-</span>}
      </TableCell>
      <TableCell className={cn(CELL, "min-w-44 whitespace-normal")}>
        <WindowList windows={row.before} empty="No windows read" />
      </TableCell>
      <TableCell className={cn(CELL, "min-w-28 max-w-56 whitespace-normal")}>
        <OutcomeBadge outcome={row.outcome} />
        {row.message ? <p className={cn("mt-1 break-words text-xs", row.outcome === "error" ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>{row.message}</p> : null}
      </TableCell>
      <TableCell className={cn(CELL, "tabular-nums")}>
        {row.resetsLeftAfter !== null ? row.resetsLeftAfter : <span className="text-muted-foreground" title="The provider did not report how many resets are left.">-</span>}
      </TableCell>
      <TableCell className={cn(CELL, "min-w-44 whitespace-normal")}>
        <AfterCell row={row} />
      </TableCell>
    </TableRow>
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  allLabel,
  options,
  onChange,
  width,
}: {
  label: string;
  value: T | "";
  allLabel: string;
  options: readonly { value: T; label: string }[];
  onChange: (value: T | "") => void;
  width: string;
}) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : (v as T))}>
      <SelectTrigger className={cn("h-8 text-xs", width)} aria-label={label}>
        <SelectValue placeholder={allLabel} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL} className="text-xs">
          {allLabel}
        </SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ResetLog({ filters }: { filters: ResetLogFilters }) {
  const [params, setParams] = useSearchParams();
  const query = useResetLogQuery(filters);
  const setFilter = (key: ResetLogFilterKey, value: string) => setParams(withResetLogFilter(params, key, value), { replace: true });

  const rows = useMemo(() => {
    const seen = new Map<string, ResetLogRow>();
    // A refetch can move a cursor, so one row can come in two pages: keep the first.
    for (const page of query.data?.pages ?? []) for (const row of page.rows) if (!seen.has(row.id)) seen.set(row.id, row);
    return [...seen.values()];
  }, [query.data]);
  // The filter stays selectable while its own answer loads, and also for an identity that has no log row yet.
  const identities = useMemo(() => {
    const names = new Set(query.data?.pages[0]?.identities ?? []);
    if (filters.identity) names.add(filters.identity);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [query.data, filters.identity]);

  const filtered = hasResetLogFilters(filters);
  const loading = query.isPending;
  const stale = query.isPlaceholderData;
  const failedFirst = query.isError && !query.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reset log"
        description="Every reset credit that was used, by hand or by the automatic reset, newest first."
        updatedAt={query.dataUpdatedAt}
      />

      <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Identity"
          value={filters.identity}
          allLabel="All identities"
          options={identities.map((name) => ({ value: name, label: name }))}
          onChange={(v) => setFilter("identity", v)}
          width="w-56"
        />
        <FilterSelect
          label="Provider"
          value={filters.provider}
          allLabel="All providers"
          options={RESET_LOG_PROVIDERS.map((value) => ({ value, label: RESET_LOG_PROVIDER_LABELS[value] }))}
          onChange={(v) => setFilter("provider", v)}
          width="w-36"
        />
        <FilterSelect
          label="Trigger"
          value={filters.trigger}
          allLabel="All triggers"
          options={RESET_LOG_TRIGGERS.map((value) => ({ value, label: RESET_LOG_TRIGGER_LABELS[value] }))}
          onChange={(v) => setFilter("trigger", v)}
          width="w-36"
        />
        <FilterSelect
          label="Outcome"
          value={filters.outcome}
          allLabel="All outcomes"
          options={RESET_LOG_OUTCOMES.map((value) => ({ value, label: RESET_LOG_OUTCOME_LABELS[value] }))}
          onChange={(v) => setFilter("outcome", v)}
          width="w-44"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          From
          <Input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilter("from", e.target.value)} aria-label="From date" className="h-8 w-36 text-xs" />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          To
          <Input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilter("to", e.target.value)} aria-label="To date" className="h-8 w-36 text-xs" />
        </label>
        {filtered ? (
          <Button variant="outline" size="sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {failedFirst ? <ErrorBanner message={query.error.message} /> : null}
      {query.isError && query.data ? <ErrorBanner message={`The log could not be refreshed. ${query.error.message}`} /> : null}

      {loading ? (
        <div className="h-64 animate-pulse rounded-xl bg-muted" />
      ) : failedFirst ? null : rows.length === 0 ? (
        filtered ? (
          <EmptyState title="No resets match these filters" description="Change or clear the filters to see more of the log." />
        ) : (
          <EmptyState title="No resets logged yet" description="A reset appears here once it is used, by hand or by the automatic reset." />
        )
      ) : (
        <section aria-label="Resets" aria-busy={stale} className="space-y-3">
          <p role="status" className="text-xs text-muted-foreground">
            {rows.length} {rows.length === 1 ? "reset" : "resets"} shown{query.hasNextPage ? ", older resets are available" : ", end of the log"}
          </p>
          <div className={cn("overflow-hidden rounded-xl border", stale && "opacity-60")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-2">Time</TableHead>
                  <TableHead className="px-2">Provider, trigger, actor</TableHead>
                  <TableHead className="px-2">Identity</TableHead>
                  <TableHead className="px-2">Grant</TableHead>
                  <TableHead className="px-2">Before</TableHead>
                  <TableHead className="px-2">Outcome</TableHead>
                  <TableHead className="w-14 whitespace-normal px-2">Resets left</TableHead>
                  <TableHead className="px-2">After</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <ResetLogTableRow key={row.id} row={row} />
                ))}
              </TableBody>
            </Table>
          </div>
          {query.hasNextPage ? (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                {query.isFetchingNextPage ? "Loading..." : "Load more"}
              </Button>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}

/** The reset log. The filters live in the query string, written with history replace, so the address alone reproduces the view. */
export function ResetLogPage() {
  const [params] = useSearchParams();
  // An address with an invalid value, an unknown key or another order is rewritten to its canonical form, with history replace.
  if (needsCanonicalSearch(params)) {
    return <Navigate to={{ pathname: RESET_LOG_PATH, search: resetLogSearch(readResetLogFilters(params)).toString() }} replace />;
  }
  return <ResetLog filters={readResetLogFilters(params)} />;
}

export default ResetLogPage;
