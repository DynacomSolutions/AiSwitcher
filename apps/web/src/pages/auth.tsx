import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { AuthStateBadge, ToolBadge } from "@/components/badges";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { flowIsLive, qk, useAuthQuery, useAuthRefreshQuery, useLoginFlowQuery } from "@/hooks/queries";
import { api, supportsFix } from "@/lib/api";
import { relTime } from "@/lib/format";
import type { AuthEntry, AuthRefreshStatus, LoginFlowStatus } from "@/types/api";

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
      toast.success("Logged in", { description: `${flow.toolName}/${flow.identity}` });
    }
  }, [flow, qc]);

  const submitMutation = useMutation({
    mutationFn: (code: string) => api.submitLoginFlow(flowId, code),
    onSuccess: (updated) => {
      qc.setQueryData(qk.loginFlow(flowId), updated);
      setPaste("");
    },
    onError: (error) => toast.error("Could not submit code", { description: error.message }),
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
                  placeholder="Paste the code (or the full redirect URL) here"
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  spellCheck={false}
                />
                <Button type="submit" disabled={!paste.trim() || submitMutation.isPending}>
                  Submit
                </Button>
              </form>
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

/** Mirrors ESCALATION_THRESHOLD in src/server/auth-refresh.ts: past this many
 * consecutive failures the renewal row shows the escalated destructive badge
 * instead of a bare count. */
const AUTH_REFRESH_ESCALATION_THRESHOLD = 3;

function RenewalRow({ status }: { status: AuthRefreshStatus }) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.refreshCredential(status.tool, status.identity),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: qk.authRefresh });
      if (result.ok) toast.success("Credential refreshed", { description: `${status.tool}/${status.identity}` });
      else toast.warning("Refresh did not write cookies", { description: `${status.tool}/${status.identity}` });
    },
    onError: (error) => toast.error("Refresh failed", { description: error.message }),
  });

  return (
    <TableRow>
      <TableCell>
        <ToolBadge tool={status.tool} />
      </TableCell>
      <TableCell className="font-medium">{status.identity}</TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {status.lastAttemptAt ? relTime(status.lastAttemptAt) : "never"}
      </TableCell>
      <TableCell className="text-xs">
        {status.lastSuccessAt ? (
          relTime(status.lastSuccessAt)
        ) : (
          <Badge variant="warning">Never</Badge>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {status.consecutiveFailures >= AUTH_REFRESH_ESCALATION_THRESHOLD ? (
          <Badge variant="destructive">{status.consecutiveFailures} consecutive</Badge>
        ) : status.consecutiveFailures > 0 ? (
          <Badge variant="warning">{status.consecutiveFailures}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="max-w-72">
        {status.lastError ? (
          <span className="block truncate text-xs text-destructive" title={status.lastError}>
            {status.lastError}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <Button variant="outline" size="sm" disabled={mutation.isPending || status.running} onClick={() => mutation.mutate()}>
          {status.running || mutation.isPending ? "Refreshing…" : "Refresh now"}
        </Button>
      </TableCell>
    </TableRow>
  );
}

/** Daemon-side scheduled renewal (Alibaba console cookies today). */
function RenewalCard() {
  const query = useAuthRefreshQuery();
  const results = query.data?.results ?? [];
  const healthy = results.filter((r) => r.lastSuccessAt && !r.lastError).length;

  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-base">Scheduled credential renewal</CardTitle>
        <CardDescription>
          The daemon renews Alibaba console cookies on a 10-minute loop while it runs, so
          dashboards and quota checks keep working without the host timers.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <div className="h-16 animate-pulse rounded-lg bg-muted" />
        ) : results.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No renewals recorded yet. The first pass runs about 15 seconds after the daemon starts,
            and refreshable credentials appear here.
          </p>
        ) : (
          <>
            <p className="mb-3 text-xs text-muted-foreground">
              {healthy} of {results.length} renewing cleanly
            </p>
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Tool</TableHead>
                    <TableHead>Identity</TableHead>
                    <TableHead>Last attempt</TableHead>
                    <TableHead>Last success</TableHead>
                    <TableHead>Fails</TableHead>
                    <TableHead>Error</TableHead>
                    <TableHead className="text-right"> </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map((status) => (
                    <RenewalRow key={`${status.tool}/${status.identity}`} status={status} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function AuthPage() {
  const query = useAuthQuery();
  const entries = query.data?.entries ?? [];
  const [activeFlowId, setActiveFlowId] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Auth"
        description="Credential health for every identity across every registry. Logins run the real CLI's own flow right here, so no terminal is needed."
        updatedAt={query.dataUpdatedAt}
      />

      <RenewalCard />

      {query.isLoading && !query.data ? (
        <div className="h-64 animate-pulse rounded-xl bg-muted" />
      ) : query.isError && !query.data ? (
        <ErrorBanner message={query.error.message} />
      ) : entries.length === 0 ? (
        <EmptyState title="No auth entries" description="Create identities first; their credentials are checked here." />
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Tool</TableHead>
                <TableHead>Identity</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Detail</TableHead>
                <TableHead className="text-right">Fixes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={`${entry.toolName}/${entry.identity}`}>
                  <TableCell>
                    <ToolBadge tool={entry.toolName} />
                  </TableCell>
                  <TableCell className="font-medium">{entry.identity}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {entry.kind}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <AuthStateBadge state={entry.state} />
                  </TableCell>
                  <TableCell className="max-w-72">
                    <span
                      className={`block truncate text-xs ${entry.state === "ok" ? "" : "text-muted-foreground"}`}
                      title={
                        [
                          entry.detail,
                          entry.expiresAt ? `expires ${new Date(entry.expiresAt).toLocaleString()}` : undefined,
                          entry.lastRefreshAt ? `last refresh ${relTime(entry.lastRefreshAt)}` : undefined,
                          entry.refreshError,
                        ]
                          .filter(Boolean)
                          .join("\n") || undefined
                      }
                    >
                      {entry.detail ?? "-"}
                      {entry.refreshError ? (
                        <span className="block truncate text-destructive">{entry.refreshError}</span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    <FixActions entry={entry} onFlow={setActiveFlowId} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {activeFlowId ? <LoginFlowDialog flowId={activeFlowId} onClose={() => setActiveFlowId(null)} /> : null}
    </div>
  );
}

export default AuthPage;
