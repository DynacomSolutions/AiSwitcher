import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CreditCard, RotateCcw } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ToolBadge } from "@/components/badges";
import { ProviderLabel } from "@/components/provider-icon";
import { PoolUsageCards } from "@/components/pool-usage-cards";
import { ResetPushToggle } from "@/components/reset-push-toggle";
import { ResetCountdown } from "@/components/reset-countdown";
import { GlobalUsageCards } from "@/components/usage-counter";
import { PageTabRedirect, PageTabs, usePageTab, type PageTab } from "@/components/page-tabs";
import { EmptyState, ErrorBanner, PageHeader } from "@/components/page-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { qk, useLimitsQuery, usePoolsUsageQuery } from "@/hooks/queries";
import { api } from "@/lib/api";
import { creditsNote } from "@/lib/credits-note";
import { clampPercent, formatMoney, relTime } from "@/lib/format";
import { formatResetTimes } from "@/lib/reset-time";
import { AccountWarnings } from "@/components/account-line";
import type { LimitFetchStatus, LimitsResponse, LimitWindow, ManualResetInfo, OverageInfo, ResetGrant, ToolLimitResult, UseCodexResetResult, UseResetResult } from "@/types/api";

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
      {/* The times wrap inside the card. The separator stays on the times. The countdown is one piece that wraps alone. */}
      {(window.resetsAt || window.resetsAtMs !== undefined || window.note) && (
        <div
          data-slot="reset-line"
          className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
        >
          <span
            data-slot="reset-times"
            className="min-w-0 break-words"
            title={window.resetsAtMs !== undefined ? formatResetTimes(window.resetsAtMs) : undefined}
          >
            {window.resetsAtMs !== undefined ? (
              <>
                {formatResetTimes(window.resetsAtMs)}
                {/* A non-breaking space binds the separator to the times, so a wrapped line never starts with it. */}
                {"\u00a0· "}
                <ResetCountdown ms={window.resetsAtMs} />
              </>
            ) : (window.resetsAt ?? "")}
          </span>
          {window.note ? (
            <span data-slot="window-note" className="ml-auto min-w-0 break-words text-amber-600 dark:text-amber-400">
              {window.note}
            </span>
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

const GRANT_KIND: Record<ResetGrant["kind"], string> = { full: "Full", fable: "Fable only", other: "Other" };

function ResetCreditsHeading({ count, capturedAt, stale }: { count: number; capturedAt?: string; stale?: boolean }) {
  return (
    <div className="flex items-center gap-2 font-medium">
      <RotateCcw aria-hidden className="size-3.5 shrink-0" />
      Reset credits ({count})
      {capturedAt ? (
        <span className={stale ? "font-normal text-amber-600 dark:text-amber-400" : "font-normal text-muted-foreground"}>
          {stale ? "last seen " : "seen "}{relTime(capturedAt)}
        </span>
      ) : null}
    </div>
  );
}

function ResetKindBadge({ kind }: { kind: ResetGrant["kind"] }) {
  const variant = kind === "full" ? "success" : kind === "fable" ? "warning" : "muted";
  return <Badge variant={variant}>{GRANT_KIND[kind]}</Badge>;
}

function ResetCreditAction({ ariaLabel, onClick }: { ariaLabel?: string; onClick: () => void }) {
  return <Button variant="outline" size="sm" className="h-7 shrink-0 text-xs" aria-label={ariaLabel} onClick={onClick}>Use reset</Button>;
}

function formatCreditExpiry(endsAt: string): string {
  const state = Date.parse(endsAt) > Date.now() ? "expires" : "expired";
  const date = new Date(endsAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  return `${state} ${date}`;
}

function grantState(grant: ResetGrant, cooldown: boolean): string {
  if (grant.resetsLeft <= 0) return "used up";
  if (grant.paused) return "paused";
  if (cooldown) return "cooling down";
  return grant.usableNow ? "usable now" : "not usable now";
}

/** Mirrors clearSpentWindows in src/cli/limits/claude-limits.ts: the cleared windows at 0%, by `cleared` kind, else grant kind. */
function clearSpentWindows(windows: LimitWindow[], cleared: string[], grantKind: ResetGrant["kind"] | undefined): LimitWindow[] {
  const kinds = cleared.map((c) => c.toLowerCase());
  const matches = (w: LimitWindow): boolean =>
    kinds.some((k) =>
      k.includes("session") || k.includes("five_hour")
        ? w.category === "session"
        : k === "weekly_all" || k === "seven_day" || k === "weekly"
          ? w.label === "week (all)"
          : k.includes("scoped")
            ? w.model !== undefined
            : w.model !== undefined && k.includes(w.model.toLowerCase()),
    );
  const clears = windows.some(matches)
    ? matches
    : grantKind === "full"
      ? () => true
      : grantKind === "fable"
        ? (w: LimitWindow) => /fable/i.test(w.model ?? w.label)
        : () => false;
  if (!windows.some(clears)) return windows;
  return windows.map((w) => {
    if (!clears(w)) return w;
    const { resetsAt: _r, resetsAtMs: _m, ...rest } = w;
    return { ...rest, usedPercent: 0 };
  });
}

/** The row with the spent grant applied, as the server records it, until the next read arrives. */
function spendGrant(row: ToolLimitResult, spent: UseResetResult): ToolLimitResult {
  if (row.toolName !== "claude" || row.identity.name !== spent.identity) return row;
  const kind = row.manualReset?.grants?.find((g) => g.id === spent.grantId)?.kind;
  row = { ...row, windows: clearSpentWindows(row.windows, spent.cleared, kind) };
  const reset = row.manualReset;
  if (!reset?.grants) return row;
  const grants = reset.grants.map((g) =>
    g.id !== spent.grantId ? g : { ...g, ...(spent.resetsLeft !== undefined ? { resetsLeft: spent.resetsLeft, usableNow: g.usableNow && spent.resetsLeft > 0 } : { usableNow: false }) },
  );
  const availableCount = grants.filter((g) => g.usableNow).reduce((n, g) => n + g.resetsLeft, 0);
  return { ...row, manualReset: { ...reset, grants, availableCount, ...(spent.cooldownUntil ? { cooldownUntil: spent.cooldownUntil } : {}) } };
}

function UseResetDialog({ identity, grant, onClose }: { identity: string; grant: ResetGrant; onClose: () => void }) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.useClaudeReset(identity, grant.id),
    onSuccess: (r) => {
      // Show the spent credit now; the refetch then brings the cleared windows from Anthropic.
      qc.setQueryData<LimitsResponse>(qk.limits, (prev) => prev && { ...prev, results: prev.results.map((row) => spendGrant(row, r)) });
      void qc.invalidateQueries({ queryKey: qk.limits });
      const left = r.resetsLeft !== undefined ? `, ${r.resetsLeft} left` : "";
      toast.success(`Reset ${r.result}`, { description: `${identity}: ${grant.label ?? grant.id}${left}${r.cleared.length ? `; cleared ${r.cleared.join(", ")}` : ""}` });
      onClose();
    },
    onError: (error) => toast.error("Reset failed", { description: error.message }),
  });
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Use a reset on {identity}?</AlertDialogTitle>
          <AlertDialogDescription>
            Spends one of {grant.resetsLeft} left on “{grant.label ?? grant.id}” ({GRANT_KIND[grant.kind]}). Anthropic clears the matching usage
            limits now; a spent reset cannot be given back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={mutation.isPending}
            onClick={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
          >
            {mutation.isPending ? "Resetting..." : "Use reset"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function UseCodexResetDialog({ identity, availableCount, onClose }: { identity: string; availableCount: number; onClose: () => void }) {
  const qc = useQueryClient();
  const submitted = useRef(false);
  const requestId = useRef<string | null>(null);
  const mutation = useMutation({
    mutationFn: (redeemRequestId: string) => api.useCodexReset(identity, redeemRequestId),
    retry: false,
    onSuccess: async (result: UseCodexResetResult) => {
      // Discard older GET /api/limits work before applying the account-scoped reading from this consume.
      await qc.cancelQueries({ queryKey: qk.limits });
      qc.setQueryData<LimitsResponse>(qk.limits, (prev) => prev && ({
        ...prev,
        results: prev.results.map((row) => {
          if (row.toolName !== "codex" || row.identity.name !== result.identity) return row;
          const reset = row.manualReset;
          const manualReset = reset
            ? {
                ...reset,
                ...(result.result === "reset" ? { availableCount: Math.max(0, reset.availableCount - 1) } : {}),
                stale: true,
              }
            : undefined;
          const usage = result.reconciliation?.status === "confirmed" ? result.reconciliation.usage : undefined;
          return {
            ...row,
            ...(usage ? { ...usage, identity: row.identity } : result.reconciliation?.status === "pending" ? { status: "cached" as const, error: "OpenAI usage refresh is pending. Showing last-known data." } : {}),
            ...(manualReset ? { manualReset } : {}),
          };
        }),
      }));
      void qc.invalidateQueries({ queryKey: qk.poolsUsage });
      if (result.result === "reset") {
        if (result.reconciliation?.status === "confirmed") {
          toast.success("Reset used", { description: `OpenAI confirmed the reset for ${result.identity}. Fresh usage read for this account.` });
        } else {
          toast.info("Reset used, usage pending", { description: `OpenAI confirmed reset for ${result.identity}. Limits keeps the last-known reading.` });
        }
      } else if (result.result === "already_redeemed") {
        toast.info("Reset already redeemed", { description: result.reconciliation?.status === "confirmed" ? `Request processed for ${result.identity}. Fresh usage read for this account.` : `Request processed for ${result.identity}. Limits keeps the last-known reading.` });
      } else if (result.result === "nothing_to_reset") {
        toast.info("No windows reset", { description: `${result.identity} had no eligible limit windows.` });
      } else {
        toast.error("No reset credit", { description: `${result.identity} has no available reset credit.` });
      }
      onClose();
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: qk.limits });
      void qc.invalidateQueries({ queryKey: qk.poolsUsage });
    },
  });
  return (
    <AlertDialog open onOpenChange={(open) => !open && !mutation.isPending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Use a reset on {identity}?</AlertDialogTitle>
          <AlertDialogDescription>
            This spends one of {availableCount} available reset credits on this Codex account. The reset cannot be returned.
            After OpenAI accepts the request, Console makes up to three fresh usage reads for this account. If OpenAI is slow, Limits keeps the last-known reading and reports pending.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {mutation.error ? <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p> : null}
        {mutation.isPending ? <p role="status" className="text-sm text-muted-foreground">Sending reset request…</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={mutation.isPending || submitted.current}
            onClick={(event) => {
              event.preventDefault();
              if (submitted.current || mutation.isPending) return;
              submitted.current = true;
              requestId.current ??= crypto.randomUUID();
              mutation.mutate(requestId.current);
            }}
          >
            {mutation.isPending ? "Using reset…" : "Confirm use reset"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ManualResetBlock({ reset, result }: { reset: ManualResetInfo; result: ToolLimitResult }) {
  const [using, setUsing] = useState<ResetGrant | null>(null);
  const [usingCodex, setUsingCodex] = useState(false);
  if (!reset.grants) {
    // Codex has account-level credits, so it has one action and one summary row.
    const available = reset.availableCount > 0;
    const canSpendCodex = result.toolName === "codex" && result.gatewayManaged === true && result.status === "live" && !reset.stale && available && !result.identity.retired && !result.identity.swapPool;
    const expiries = reset.creditExpiries ?? [];
    const kind = /\bfull\b/i.test(reset.label ?? "") ? "full" : /\bfable\b/i.test(reset.label ?? "") ? "fable" : undefined;
    return (
      <>
        <Separator />
        <div className="space-y-2 text-xs">
          <ResetCreditsHeading count={reset.availableCount} />
          {reset.stale ? <p className="text-muted-foreground">Reset status may be out of date.</p> : null}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-0.5">
              {available && reset.label ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {kind ? <ResetKindBadge kind={kind} /> : null}
                  <span className="min-w-0 break-words">{reset.label}</span>
                </div>
              ) : null}
              <div className="text-muted-foreground">
                {available ? `${reset.availableCount} available` : "No reset credits available"}
              </div>
              {expiries.length === 0 && reset.expiresAt ? <div className="text-muted-foreground">expires {reset.expiresAt}</div> : null}
              {expiries.map((credit) => (
                <div key={credit.id} className="break-words text-muted-foreground">
                  {credit.label ?? credit.id}: {formatCreditExpiry(credit.endsAt)}
                </div>
              ))}
            </div>
            {canSpendCodex ? <ResetCreditAction ariaLabel={`Use reset on ${result.identity.name}`} onClick={() => setUsingCodex(true)} /> : null}
          </div>
        </div>
        {usingCodex ? <UseCodexResetDialog identity={result.identity.name} availableCount={reset.availableCount} onClose={() => setUsingCodex(false)} /> : null}
      </>
    );
  }
  const cooldown = reset.cooldownUntil !== undefined && Date.parse(reset.cooldownUntil) > Date.now();
  // A spend is offered only on a live list for a real claude identity (a pool row mirrors a member's login).
  const canSpend = result.toolName === "claude" && !reset.stale && !cooldown;
  return (
    <>
      <Separator />
      <div className="space-y-2 text-xs">
        <ResetCreditsHeading count={reset.grants.length} capturedAt={reset.grantsCapturedAt} stale={reset.stale} />
        {reset.stale ? (
          <p className="text-muted-foreground">Anthropic lists reset credits only near a limit; this is the last list it sent.</p>
        ) : null}
        {cooldown ? <p className="text-amber-600 dark:text-amber-400">Cooling down until {new Date(reset.cooldownUntil!).toLocaleString()}.</p> : null}
        {reset.grants.length === 0 ? <p className="text-muted-foreground">No reset credits.</p> : null}
        <ul className="space-y-2">
          {reset.grants.map((g) => (
            <li key={g.id} className="flex items-start justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <ResetKindBadge kind={g.kind} />
                  <span className="min-w-0 break-words" title={g.id}>
                    {g.label ?? g.id}
                  </span>
                </div>
                <div className="text-muted-foreground">
                  {g.resetsLeft} left · {grantState(g, cooldown)}
                  {g.endsAt ? ` · ${formatCreditExpiry(g.endsAt)}` : ""}
                </div>
              </div>
              {canSpend && g.usableNow && g.resetsLeft > 0 ? (
                <ResetCreditAction onClick={() => setUsing(g)} />
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      {using ? <UseResetDialog identity={result.identity.name} grant={using} onClose={() => setUsing(null)} /> : null}
    </>
  );
}

function LimitCard({ result }: { result: ToolLimitResult }) {
  const unavailable = result.status === "unavailable" || result.status === "pending";
  return (
    <Card className="gap-4">
      <CardHeader className="space-y-0">
        {/* A plan badge that leaves less than 4rem for the name goes onto a second line, under the name. */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 grow flex-wrap items-center gap-2">
            <div className="flex min-w-0 grow items-center gap-2">
              <span className="w-0 min-w-16 grow truncate font-medium" title={result.identity.name}>
                {result.identity.name}
              </span>
              <ToolBadge tool={result.toolName} />
            </div>
            {result.plan ? (
              <Badge variant="secondary" title="Account plan">
                {result.plan}
              </Badge>
            ) : null}
          </div>
          <StatusBadge status={result.status} />
        </div>
        {result.account ? (
          <div className="space-y-0.5 text-xs">
            <div className="break-all text-muted-foreground" title={result.account.email ?? result.account.label}>
              {result.account.email ?? result.account.label ?? result.account.accountId}
            </div>
            <AccountWarnings account={result.account} />
          </div>
        ) : null}
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
        {result.status === "cached" && result.error ? <p className="text-sm text-muted-foreground">{result.error}</p> : null}
        {result.windows.length === 0 && !unavailable ? (
          <p className="text-sm text-muted-foreground">This tool reported no quota windows.</p>
        ) : null}
        {result.overage ? <OverageBlock overage={result.overage} /> : null}
        {result.toolName === "codex" && !unavailable && result.extraUsage ? (
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <CreditCard aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>{creditsNote(result.extraUsage)}</span>
          </div>
        ) : null}
        {result.manualReset ? <ManualResetBlock reset={result.manualReset} result={result} /> : null}
      </CardContent>
    </Card>
  );
}

export function LimitsPage() {
  const query = useLimitsQuery();
  const poolsQuery = usePoolsUsageQuery();
  // A pool mirrors its active member's token, so its own limits row only ever
  // says "not fetched"; the pool cards above carry the real figures instead.
  const poolKeys = useMemo(() => new Set((poolsQuery.data?.pools ?? []).map((p) => `${p.tool}/${p.name}`)), [poolsQuery.data]);
  const allResults = query.data?.results ?? [];
  const results = useMemo(() => allResults.filter((r) => !poolKeys.has(`${r.toolName}/${r.identity.name}`)), [allResults, poolKeys]);

  // Provider-first grouping, mirroring the CLI report: provider is the
  // grouping key, the wrapper tool is secondary info on each identity row.
  const providerGroups = useMemo(() => {
    const map = new Map<string, ToolLimitResult[]>();
    for (const result of results) {
      const key = result.provider || "unattributed";
      const bucket = map.get(key);
      if (bucket) bucket.push(result);
      else map.set(key, [result]);
    }
    for (const bucket of map.values()) bucket.sort((a, b) => a.identity.name.localeCompare(b.identity.name));
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [results]);

  const tabs = useMemo<PageTab[]>(
    () => [
      { segment: "overview", label: "Overview" },
      ...providerGroups.map(([provider]) => ({ segment: provider, label: provider })),
    ],
    [providerGroups],
  );
  const { active, invalid } = usePageTab(tabs);
  // A provider tab is unknown until the limits have loaded: only redirect once they have.
  if (invalid && query.data) return <PageTabRedirect to="/limits" />;
  const activeGroup = providerGroups.find(([provider]) => provider === active);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Limits"
        description="Live provider quota per identity. The server caches upstream fetches for 45 seconds."
        updatedAt={query.dataUpdatedAt}
      />

      <PageTabs tabs={tabs} active={active} base="/limits" />

      {active === "overview" ? (
        <>
          <ResetPushToggle />

          <GlobalUsageCards title="Global usage" />

          <PoolUsageCards />
        </>
      ) : null}

      {active === "overview" ? null : query.isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
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
        (activeGroup ? [activeGroup] : []).map(([provider, group]) => (
          <section key={provider} className="space-y-3">
            <div className="flex items-center gap-2">
              <ProviderLabel provider={provider} size={16} className="text-base font-semibold" />
              <Badge variant="muted">{group.length}</Badge>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {group.map((r) => (
                <LimitCard key={`${r.provider}/${r.toolName}/${r.identity.name}`} result={r} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

export default LimitsPage;
