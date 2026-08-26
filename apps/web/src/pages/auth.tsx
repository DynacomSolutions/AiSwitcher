import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { ToolBadge } from "@/components/badges";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { qk, useAuthQuery } from "@/hooks/queries";
import { api, supportsFix } from "@/lib/api";
import type { AuthEntry } from "@/types/api";

function StateBadge({ state }: { state: AuthEntry["state"] }) {
  switch (state) {
    case "ok":
      return <Badge variant="success">OK</Badge>;
    case "expiring":
      return <Badge variant="warning">Expiring</Badge>;
    case "expired":
      return <Badge variant="destructive">Expired</Badge>;
    case "missing":
      return <Badge variant="muted">Missing</Badge>;
    default:
      return <Badge variant="secondary">Unknown</Badge>;
  }
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

function FixActions({ entry }: { entry: AuthEntry }) {
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
    mutationFn: () => api.loginIdentity(entry.toolName, entry.identity),
    onSuccess: (result) => {
      if (result.spawned) {
        toast.success("Login launched in a new terminal window", { description: result.command });
      } else {
        toast.info("Run this command to log in", { description: result.command });
      }
      void qc.invalidateQueries({ queryKey: qk.auth });
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

export function AuthPage() {
  const query = useAuthQuery();
  const entries = query.data?.entries ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Auth"
        description="Credential health for every identity across every registry."
        updatedAt={query.dataUpdatedAt}
      />

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
                    <StateBadge state={entry.state} />
                  </TableCell>
                  <TableCell className="max-w-72">
                    <span
                      className={`block truncate text-xs ${entry.state === "ok" ? "" : "text-muted-foreground"}`}
                      title={entry.detail}
                    >
                      {entry.detail ?? "-"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <FixActions entry={entry} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export default AuthPage;
