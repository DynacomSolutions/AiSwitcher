import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { AccountLine } from "@/components/account-line";
import { AuthStateBadge, ToolBadge } from "@/components/badges";
import { EmptyState, ErrorBanner, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { flowIsLive, qk, useAuthQuery, useAuthRefreshQuery, useLoginFlowQuery } from "@/hooks/queries";
import { api, supportsFix } from "@/lib/api";
import {
  AUTH_SORT_LABELS,
  AUTH_STATE_LABELS,
  authTools,
  combineAuthRows,
  readAuthParams,
  visibleAuthRows,
  withAuthParam,
  type AuthListParams,
  type AuthListRow,
  type AuthSortKey,
  type AuthStateFilter,
} from "@/lib/auth-list";
import { cn } from "@/lib/utils";
import type { AuthEntry, LoginFlowStatus } from "@/types/api";

export function flowStatusLabel(status: LoginFlowStatus): string {
  switch (status) {
    case "starting":
      return "Starting CLI login";
    case "waiting":
      return "Waiting for you";
    case "callback":
      return "Credentials received";
    case "completed":
      return "Logged in";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function FlowStatusBadge({ status }: { status: LoginFlowStatus }) {
  switch (status) {
    case "starting":
      return <Badge variant="secondary">{flowStatusLabel(status)}</Badge>;
    case "waiting":
    case "callback":
      return <Badge variant="warning">{flowStatusLabel(status)}</Badge>;
    case "completed":
      return <Badge variant="success">{flowStatusLabel(status)}</Badge>;
    default:
      return <Badge variant="destructive">{flowStatusLabel(status)}</Badge>;
  }
}

/** Live view of one daemon-managed login flow: the CLI's own auth URL,
 * a paste box for redirect-code fallbacks, and cancel. Polls while the
 * flow can still move on its own. */
function LoginFlowDialog({ flowId, onClose }: { flowId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [paste, setPaste] = useState("");
  const query = useLoginFlowQuery(flowId);
  const flow = query.data;
  const completedRef = useRef(false);

  // Reacting to async server state (the flow finishing while we poll) is
  // exactly a sync-with-external-system concern.
  useEffect(() => {
    if (flow?.status === "completed" && !completedRef.current) {
      completedRef.current = true;
      void qc.invalidateQueries({ queryKey: qk.auth });
      if (flow.gateway?.outcome === "error") toast.error("Signed in, but the gateway could not take the new login", { description: flow.gateway.message });
      else if (flow.gateway?.outcome === "attention") toast.warning("Signed in", { description: flow.gateway.message });
      else toast.success("Logged in", { description: flow.gateway?.message ?? `${flow.toolName}/${flow.identity}` });
    }
  }, [flow, qc]);

  const submitMutation = useMutation({
    mutationFn: (code: string) => api.submitLoginFlow(flowId, code),
    onSuccess: (updated) => {
      qc.setQueryData(qk.loginFlow(flowId), updated);
      setPaste("");
    },
    onError: (error) => toast.error("Could not submit", { description: error.message }),
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.cancelLoginFlow(flowId),
    onSuccess: (updated) => {
      qc.setQueryData(qk.loginFlow(flowId), updated);
      void qc.invalidateQueries({ queryKey: qk.auth });
    },
    onError: (error) => toast.error("Could not cancel", { description: error.message }),
  });

  const live = flowIsLive(flow?.status);
  const finished = flow?.status === "completed" || flow?.status === "failed" || flow?.status === "cancelled";

  return (
    <Dialog open onOpenChange={(open) => !open && finished && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Log in to {flow?.toolName ?? "..."}/{flow?.identity ?? "..."}
          </DialogTitle>
          <DialogDescription>
            The daemon is running this tool's own login flow. Your browser is not on this machine, so
            open the link on any device that is.
          </DialogDescription>
        </DialogHeader>

        {query.isLoading || !flow ? (
          <div className="h-24 animate-pulse rounded-lg bg-muted" />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <FlowStatusBadge status={flow.status} />
              {live ? (
                <span className="text-xs text-muted-foreground">polling every 1.5s...</span>
              ) : null}
            </div>

            {flow.authUrl ? (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Auth URL</Label>
                <a
                  href={flow.authUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-start gap-1.5 break-all rounded-lg border bg-muted/40 p-2.5 font-mono text-xs text-primary underline-offset-2 hover:underline"
                >
                  {flow.authUrl}
                  <ExternalLink aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                </a>
              </div>
            ) : null}

            {flow.deviceCode ? (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">One-time code</Label>
                <p className="rounded-lg border bg-muted/40 px-2.5 py-2 font-mono text-base font-semibold tracking-widest">
                  {flow.deviceCode}
                </p>
              </div>
            ) : null}

            {flow.instruction && live ? (
              <p className="text-xs text-muted-foreground">{flow.instruction}</p>
            ) : null}

            {flow.acceptsPaste && live ? (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = paste.trim();
                  if (value.length > 0 && !submitMutation.isPending) submitMutation.mutate(value);
                }}
              >
                <Input
                  className="font-mono text-xs"
                  placeholder={
                    flow.toolName === "codex"
                      ? "Paste the full http://localhost address here"
                      : "Paste the code (or the full redirect URL) here"
                  }
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  spellCheck={false}
                />
                <Button type="submit" disabled={!paste.trim() || submitMutation.isPending}>
                  Submit
                </Button>
              </form>
            ) : null}

            {flow.gateway ? (
              <p
                className={`break-words rounded-lg border p-2.5 text-xs ${
                  flow.gateway.outcome === "error"
                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                    : flow.gateway.outcome === "attention"
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                }`}
              >
                {flow.gateway.message}
              </p>
            ) : null}

            {flow.error ? (
              <p className="break-words rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                {flow.error}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {live ? (
            <Button
              variant="outline"
              disabled={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              <X aria-hidden />
              Cancel login
            </Button>
          ) : (
            <Button onClick={onClose}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ZaiKeyDialog({ entry, onClose }: { entry: AuthEntry; onClose: () => void }) {
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const tool = entry.toolName === "ali" ? "ali" : "zai";

  const mutation = useMutation({
    mutationFn: () => api.setZaiKey(tool, entry.identity, apiKey),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.auth });
      toast.success("API key updated", { description: `${tool}/${entry.identity}` });
      onClose();
    },
    onError: (error) => toast.error("Could not write key", { description: error.message }),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set API key</DialogTitle>
          <DialogDescription>
            Writes the provider key into {tool}/{entry.identity}'s own crush.json. The value is
            never displayed again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="zai-key-input">API key</Label>
          <Input
            id="zai-key-input"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={apiKey.length === 0 || mutation.isPending} onClick={() => mutation.mutate()}>
            Save key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AliCookieDialog({ entry, onClose }: { entry: AuthEntry; onClose: () => void }) {
  const qc = useQueryClient();
  const [cookie, setCookie] = useState("");

  const mutation = useMutation({
    mutationFn: () => api.setAliCookie(entry.identity, cookie.trim()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.auth });
      toast.success("Console cookie saved", { description: `${entry.toolName}/${entry.identity}` });
      onClose();
    },
    onError: (error) => toast.error("Could not save cookie", { description: error.message }),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Paste console cookie</DialogTitle>
          <DialogDescription>
            The Alibaba Token plan quota endpoint authenticates with your browser session. Paste the
            full Cookie header from a logged-in OneConsole tab; it is stored as plain text in this
            identity's config directory.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="ali-cookie-input">Cookie header</Label>
          <Textarea
            id="ali-cookie-input"
            rows={6}
            className="font-mono text-xs break-all"
            placeholder="cna=...; t=...; login_aliyunid_ticket=...; ..."
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            spellCheck={false}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={cookie.trim().length === 0 || mutation.isPending} onClick={() => mutation.mutate()}>
            Save cookie
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FixActions({ entry, onFlow }: { entry: AuthEntry; onFlow: (flowId: string) => void }) {
  const qc = useQueryClient();
  const [keyDialogFor, setKeyDialogFor] = useState<AuthEntry | null>(null);
  const [cookieDialogFor, setCookieDialogFor] = useState<AuthEntry | null>(null);

  const refreshMutation = useMutation({
    mutationFn: (identity: string) => api.refreshKimiToken(identity),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.auth });
      toast.success("Token refreshed", { description: `${entry.toolName}/${entry.identity}` });
    },
    onError: (error) => toast.error("Refresh failed", { description: error.message }),
  });

  const loginMutation = useMutation({
    mutationFn: () => api.startLogin(entry.toolName, entry.identity),
    onSuccess: (result) => {
      if (result.kind === "managed") {
        onFlow(result.flow.flowId);
      } else if (result.spawned) {
        toast.success("Login launched in a new terminal window", { description: result.command });
      } else {
        toast.info("Run this command in a terminal to log in", { description: result.command });
      }
    },
    onError: (error) => toast.error("Login failed", { description: error.message }),
  });

  function unknownFix(fix: string) {
    return (
      <Button key={fix} variant="outline" size="sm" disabled title="No automated fix in the console">
        {fix}
      </Button>
    );
  }

  return (
    <>
      <div className="flex flex-wrap justify-end gap-1.5">
        {supportsFix(entry, "refresh") ? (
          <Button
            variant="outline"
            size="sm"
            disabled={refreshMutation.isPending}
            title="Ask the provider for a new token now"
            onClick={() => refreshMutation.mutate(entry.identity)}
          >
            Refresh token
          </Button>
        ) : null}
        {supportsFix(entry, "login") ? (
          <Button variant="outline" size="sm" disabled={loginMutation.isPending} onClick={() => loginMutation.mutate()}>
            Log in
          </Button>
        ) : null}
        {supportsFix(entry, "zai-key") ? (
          <Button variant="outline" size="sm" onClick={() => setKeyDialogFor(entry)}>
            Set API key
          </Button>
        ) : null}
        {supportsFix(entry, "ali-cookie") ? (
          <Button variant="outline" size="sm" onClick={() => setCookieDialogFor(entry)}>
            Paste cookie
          </Button>
        ) : null}
        {entry.fixable
          .filter(
            (fix) =>
              !["refresh", "login", "zai-key", "ali-cookie"].includes(fix.toLowerCase()),
          )
          .map((fix) => unknownFix(fix))}
      </div>
      {keyDialogFor ? <ZaiKeyDialog entry={keyDialogFor} onClose={() => setKeyDialogFor(null)} /> : null}
      {cookieDialogFor ? (
        <AliCookieDialog entry={cookieDialogFor} onClose={() => setCookieDialogFor(null)} />
      ) : null}
    </>
  );
}

/** The label above a value: visible on a narrow card, read by a screen reader in the wide grid. */
function Cell({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("min-w-0 space-y-0.5", className)}>
      <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground @[84rem]:sr-only">{label}</span>
      <div className="min-w-0 text-xs">{children}</div>
    </div>
  );
}

/** Grid of the wide layout. The narrow layout stacks each row as a card. */
const GRID = "@[84rem]:grid-cols-[minmax(9rem,1.3fr)_6rem_4.5rem_5rem_6.5rem_6.5rem_5.5rem_minmax(8rem,1fr)_minmax(6rem,1fr)_14rem]";

const TONE_VARIANT = { ok: "success", warning: "warning", destructive: "destructive", muted: "secondary" } as const;

function AuthRowView({ row, onFlow }: { row: AuthListRow; onFlow: (flowId: string) => void }) {
  const qc = useQueryClient();
  const refreshMutation = useMutation({
    mutationFn: () => api.refreshCredential(row.tool, row.identity),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: qk.authRefresh });
      if (result.ok) toast.success("Credential refreshed", { description: row.key });
      else toast.warning("Refresh did not write cookies", { description: row.key });
    },
    onError: (error) => toast.error("Refresh failed", { description: error.message }),
  });
  const running = row.renewal?.host?.running ?? false;
  const entry = row.entry;

  return (
    <li
      data-slot="auth-row"
      data-key={row.key}
      className={cn("grid grid-cols-2 items-start gap-x-4 gap-y-3 p-3 @2xl:grid-cols-5 @[84rem]:gap-x-3 @[84rem]:py-2.5", GRID)}
    >
      <div className="col-span-2 min-w-0 space-y-1 @2xl:col-span-5 @[84rem]:col-span-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ToolBadge tool={row.tool} />
          <span className="min-w-0 break-all text-sm font-medium">{row.identity}</span>
        </div>
        {entry?.account ? <AccountLine account={entry.account} /> : null}
      </div>
      <Cell label="Auth state" className="col-span-1">
        <AuthStateBadge state={row.state} />
      </Cell>
      <Cell label="Kind" className="col-span-1">
        {row.kind ? (
          <Badge variant="outline" className="font-mono text-[10px]">
            {row.kind}
          </Badge>
        ) : (
          <span className="text-muted-foreground">-</span>
        )}
      </Cell>
      <Cell label="Expires">
        <span title={row.entry?.expiresAt ? new Date(row.entry.expiresAt).toLocaleString() : undefined}>{row.expires}</span>
      </Cell>
      <Cell label="Last renewal">{row.lastRenewal}</Cell>
      <Cell label="Next renewal">{row.nextRenewal}</Cell>
      <Cell label="Renewed by">{row.renewedBy}</Cell>
      <Cell label="Renewal status" className="col-span-2 @2xl:col-span-1">
        {row.status ? <Badge variant={TONE_VARIANT[row.status.tone]}>{row.status.label}</Badge> : <span className="text-muted-foreground">-</span>}
      </Cell>
      <Cell label="Detail and last error" className="col-span-2 @2xl:col-span-5 @[84rem]:col-span-1">
        {row.error ? (
          <span className="block break-words text-destructive" title={row.error}>
            {row.error}
          </span>
        ) : row.detail ? null : (
          <span className="text-muted-foreground">-</span>
        )}
        {row.detail ? <span className="mt-0.5 block break-words text-muted-foreground">{row.detail}</span> : null}
      </Cell>
      <div className="col-span-2 flex flex-wrap justify-start gap-1.5 @2xl:col-span-5 @[84rem]:col-span-1 @[84rem]:justify-end">
        {entry && !row.retired ? <FixActions entry={entry} onFlow={onFlow} /> : null}
        {row.canRefreshHere ? (
          <Button variant="outline" size="sm" title="Run the renewal pass of this host for this login now" disabled={refreshMutation.isPending || running} onClick={() => refreshMutation.mutate()}>
            {running || refreshMutation.isPending ? "Renewing…" : "Run host renewal"}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

const ALL = "all";

/** The one list of the Auth page: auth state and renewal of every identity and tool. View options live in the URL (replace). */
function AuthList({ onFlow }: { onFlow: (flowId: string) => void }) {
  const authQuery = useAuthQuery();
  const renewalQuery = useAuthRefreshQuery();
  const [searchParams, setSearchParams] = useSearchParams();
  const rows = combineAuthRows(authQuery.data?.entries ?? [], renewalQuery.data?.rows ?? []);
  const toolNames = authTools(rows);
  const listLoaded = rows.length > 0;
  const params = readAuthParams(searchParams, listLoaded ? toolNames : undefined);
  const unknownTool = listLoaded && (searchParams.get("tool") ?? "") !== params.tool;
  // An unknown tool in the URL reads as "all tools"; the address is corrected with history replace.
  useEffect(() => {
    if (unknownTool) setSearchParams(withAuthParam(searchParams, "tool", ""), { replace: true });
  }, [unknownTool, searchParams, setSearchParams]);
  const setParam = (key: keyof AuthListParams, value: string) => setSearchParams(withAuthParam(searchParams, key, value), { replace: true });

  const visible = visibleAuthRows(rows, params);
  const attention = rows.filter((r) => r.attention).length;
  const gatewayState = renewalQuery.data?.gateway?.state;
  const loading = (authQuery.isLoading && !authQuery.data) || (renewalQuery.isLoading && !renewalQuery.data);

  if (loading) return <div className="h-64 animate-pulse rounded-xl bg-muted" />;
  if (authQuery.isError && !authQuery.data) return <ErrorBanner message={authQuery.error.message} />;
  if (rows.length === 0) return <EmptyState title="No auth entries" description="Create identities first; their credentials are checked here." />;

  return (
    <section aria-labelledby="auth-list-title" className="space-y-3">
      <div className="space-y-1">
        <h2 id="auth-list-title" className="text-base font-semibold">
          Credentials and scheduled renewal
        </h2>
        <p className="text-xs text-muted-foreground">
          The gateway renews the logins it owns every few hours. This host renews only the logins the gateway does not own, on a
          10-minute loop while the daemon runs.
        </p>
        <p className="text-xs text-muted-foreground" role="status">
          {rows.length - attention} of {rows.length} healthy, {attention} need attention
          {gatewayState && gatewayState !== "ok" ? " (gateway renewal state unavailable)" : ""}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={params.q}
          onChange={(e) => setParam("q", e.target.value)}
          placeholder="Filter by tool, identity or error"
          aria-label="Filter credentials"
          className="h-8 w-full max-w-xs text-xs"
        />
        <Select value={params.tool || ALL} onValueChange={(v) => setParam("tool", v === ALL ? "" : v)}>
          <SelectTrigger className="h-8 w-36 text-xs" aria-label="Tool">
            <SelectValue placeholder="All tools" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">
              All tools
            </SelectItem>
            {toolNames.map((tool) => (
              <SelectItem key={tool} value={tool} className="text-xs">
                {tool}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={params.state} onValueChange={(v) => setParam("state", v)}>
          <SelectTrigger className="h-8 w-40 text-xs" aria-label="State">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(AUTH_STATE_LABELS) as AuthStateFilter[]).map((key) => (
              <SelectItem key={key} value={key} className="text-xs">
                {AUTH_STATE_LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={params.sort} onValueChange={(v) => setParam("sort", v)}>
          <SelectTrigger className="h-8 w-48 text-xs" aria-label="Sort by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(AUTH_SORT_LABELS) as AuthSortKey[]).map((key) => (
              <SelectItem key={key} value={key} className="text-xs">
                {AUTH_SORT_LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {params.sort !== "default" ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            aria-label={params.dir === "asc" ? "Sort order: ascending. Switch to descending" : "Sort order: descending. Switch to ascending"}
            onClick={() => setParam("dir", params.dir === "asc" ? "desc" : "asc")}
          >
            {params.dir === "asc" ? "Ascending" : "Descending"}
          </Button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <EmptyState title="No matches" description="No credential matches these filters." />
      ) : (
        <div className="@container overflow-hidden rounded-xl border">
          <div aria-hidden className={cn("hidden border-b bg-muted/40 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground @[84rem]:grid @[84rem]:gap-x-3", GRID)}>
            <span>Identity</span>
            <span>Auth state</span>
            <span>Kind</span>
            <span>Expires</span>
            <span>Last renewal</span>
            <span>Next renewal</span>
            <span>Renewed by</span>
            <span>Renewal status</span>
            <span>Detail, last error</span>
            <span className="text-right">Actions</span>
          </div>
          <ul className="divide-y">
            {visible.map((row) => (
              <AuthRowView key={row.key} row={row} onFlow={onFlow} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function AuthPage() {
  const query = useAuthQuery();
  const [activeFlowId, setActiveFlowId] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Auth"
        description="Credential health and scheduled renewal for every identity across every registry. Logins run the real CLI's own flow right here, so no terminal is needed."
        updatedAt={query.dataUpdatedAt}
      />

      <AuthList onFlow={setActiveFlowId} />

      {activeFlowId ? <LoginFlowDialog flowId={activeFlowId} onClose={() => setActiveFlowId(null)} /> : null}
    </div>
  );
}

export default AuthPage;
