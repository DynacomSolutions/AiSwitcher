import type * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { EmptyState, ErrorBanner, PageHeader } from "@/components/page-header";
import { ProviderLabel } from "@/components/provider-icon";
import { RelativeTime } from "@/components/updated-ago";
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
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { qk, useGatewayAppsQuery } from "@/hooks/queries";
import { api } from "@/lib/api";
import { formatTokens } from "@/lib/format";
import type { GatewayAppDto, GatewayAppPatch, GatewayRotateResult } from "@/types/api";

function TargetCell({ app }: { app: GatewayAppDto }) {
  if (app.target.kind === "pin") {
    return (
      <span className="text-xs">
        pin: <span className="font-mono">{app.target.identity}</span>
      </span>
    );
  }
  const members = app.target.identities;
  return (
    <span className="text-xs">
      pool:{" "}
      {members && members.length > 0 ? (
        <span className="font-mono">{members.join(", ")}</span>
      ) : (
        <span className="text-muted-foreground">all {app.provider} identities</span>
      )}
    </span>
  );
}

function usage(value: number | null): string {
  return value === null ? "-" : formatTokens(value);
}

function EditDialog({ app, defaultReserve, onClose }: { app: GatewayAppDto; defaultReserve: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [reserve, setReserve] = useState(app.reservePercent !== undefined ? String(app.reservePercent) : "");
  const [models, setModels] = useState((app.models ?? []).join(", "));
  const [daily, setDaily] = useState(app.dailyTokens !== undefined ? String(app.dailyTokens) : "");
  const mutation = useMutation({
    mutationFn: (patch: GatewayAppPatch) => api.updateGatewayApp(app.name, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.gatewayApps });
      toast.success("App updated", { description: app.name });
      onClose();
    },
    onError: (error) => toast.error("Update failed", { description: error.message }),
  });
  const submit = () => {
    const list = models
      .split(/[\s,]+/)
      .map((m) => m.trim())
      .filter(Boolean);
    mutation.mutate({
      reservePercent: reserve.trim() === "" ? null : Number(reserve),
      models: list.length === 0 ? null : list,
      dailyTokens: daily.trim() === "" ? null : Number(daily.replace(/[_,\s]/g, "")),
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {app.name}</DialogTitle>
          <DialogDescription>Leave a field empty to use the default (no model limit, no daily cap, reserve {defaultReserve}%).</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="gw-reserve">Reserve (% of each identity's limit apps may use, 1 to 100)</Label>
            <Input id="gw-reserve" inputMode="numeric" placeholder={`${defaultReserve} (default)`} value={reserve} onChange={(e) => setReserve(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gw-models">Models (exact ids, comma separated)</Label>
            <Input id="gw-models" placeholder="any model" value={models} onChange={(e) => setModels(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gw-daily">Daily token cap</Label>
            <Input id="gw-daily" inputMode="numeric" placeholder="no cap" value={daily} onChange={(e) => setDaily(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDialog({
  title,
  description,
  action,
  destructive,
  pending,
  onConfirm,
  onClose,
}: {
  title: string;
  description: React.ReactNode;
  action: string;
  destructive?: boolean;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={destructive ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
            disabled={pending}
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            {pending ? "Working..." : action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RevokeDialog({ app, onClose }: { app: GatewayAppDto; onClose: () => void }) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.revokeGatewayApp(app.name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.gatewayApps });
      toast.success("App revoked", { description: app.name });
      onClose();
    },
    onError: (error) => toast.error("Revoke failed", { description: error.message }),
  });
  return (
    <ConfirmDialog
      title={`Revoke ${app.name}?`}
      description={
        <>
          Every token of <span className="font-mono text-xs">{app.name}</span> stops working at once and the app cannot be re-enabled. To
          use it again, add it anew with <span className="font-mono text-xs">ais gateway app add</span>.
        </>
      }
      action="Revoke"
      destructive
      pending={mutation.isPending}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
    />
  );
}

function RotateDialog({ app, onClose, onRotated }: { app: GatewayAppDto; onClose: () => void; onRotated: (r: GatewayRotateResult) => void }) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.rotateGatewayApp(app.name),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: qk.gatewayApps });
      onRotated(result);
    },
    onError: (error) => toast.error("Rotate failed", { description: error.message }),
  });
  return (
    <ConfirmDialog
      title={`Rotate the token of ${app.name}?`}
      description={
        <>
          A new token is minted and written to Secret <span className="font-mono text-xs">ais-gateway-{app.name}</span> in{" "}
          <span className="font-mono text-xs">{app.namespace}</span> and to the console host's secrets file, as{" "}
          <span className="font-mono text-xs">ais gateway app rotate</span> does. Earlier tokens keep working for the overlap window (24 hours by
          default) so pods can restart onto the new Secret.
        </>
      }
      action="Rotate"
      pending={mutation.isPending}
      onConfirm={() => mutation.mutate()}
      onClose={onClose}
    />
  );
}

function NewTokenDialog({ result, onClose }: { result: GatewayRotateResult; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.token);
      setCopied(true);
    } catch {
      toast.error("Copy failed", { description: "Select the token and copy it by hand." });
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New token for {result.app}</DialogTitle>
          <DialogDescription>
            Shown once. The gateway stores only a prefix and a hash, so this token cannot be shown again; rotate again if it is lost.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input readOnly value={result.token} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="New token" />
          <Button type="button" variant="outline" size="icon" onClick={() => void copy()} aria-label="Copy token">
            {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          </Button>
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            Base URL: <span className="font-mono">{result.url}</span>
          </p>
          {result.previousTokensExpireAt ? <p>Previous tokens keep working until {new Date(result.previousTokensExpireAt).toLocaleString()}.</p> : null}
          {result.messages.map((line) => (
            <p key={line} className="font-mono">
              {line}
            </p>
          ))}
        </div>
        {result.deliveryError ? <ErrorBanner message={`The token is valid, but delivery was incomplete: ${result.deliveryError}`} /> : null}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Pending = { kind: "edit" | "rotate" | "revoke"; app: GatewayAppDto } | null;

export function GatewayPage() {
  const query = useGatewayAppsQuery();
  const [showRevoked, setShowRevoked] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [rotated, setRotated] = useState<GatewayRotateResult | null>(null);
  const data = query.data;
  const defaultReserve = data?.defaultReservePercent ?? 100;
  const revokedCount = data?.apps.filter((a) => a.state === "revoked").length ?? 0;
  const apps = (data?.apps ?? []).filter((a) => showRevoked || a.state === "active");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Gateway"
        description="Apps that reach providers through the AIS gateway: targets, limits, tokens and usage."
        updatedAt={query.dataUpdatedAt}
      />

      <p className="text-xs text-muted-foreground">
        Existing tokens cannot be shown: the gateway keeps only each token's prefix and a hash. Rotate an app to get a new token, shown once.
      </p>

      {query.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : query.isError && !data ? (
        <ErrorBanner message={query.error.message} />
      ) : !data?.configured ? (
        <EmptyState
          title="Gateway admin not configured"
          description="Set AIS_GATEWAY_ADMIN_URL and AIS_GATEWAY_ADMIN_TOKEN in the console's ~/.secrets or environment."
        />
      ) : data.error ? (
        <ErrorBanner message={`Gateway apps could not be loaded: ${data.error}`} />
      ) : data.apps.length === 0 ? (
        <EmptyState title="No gateway apps" description="Add one with ais gateway app add <name> --namespace=<ns> --provider=<provider> --pool." />
      ) : (
        <>
          {data.usageError ? <ErrorBanner message={`Usage figures unavailable: ${data.usageError}`} /> : null}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              {apps.length} of {data.apps.length} apps
            </span>
            {revokedCount > 0 ? (
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowRevoked((v) => !v)}>
                {showRevoked ? "Hide" : "Show"} {revokedCount} revoked
              </Button>
            ) : null}
          </div>
          <Card className="py-0">
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>App</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead className="text-right">Reserve</TableHead>
                    <TableHead>Models</TableHead>
                    <TableHead className="text-right">Daily cap</TableHead>
                    <TableHead className="text-right">1 day</TableHead>
                    <TableHead className="text-right">7 days</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apps.map((app) => (
                    <TableRow key={app.name}>
                      <TableCell>
                        <div className="font-mono text-xs">{app.name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          ns <span className="font-mono">{app.namespace}</span>
                          {app.owner ? ` · ${app.owner}` : ""}
                        </div>
                      </TableCell>
                      <TableCell>
                        <ProviderLabel provider={app.provider} />
                        <div className="text-[11px] text-muted-foreground">{app.style}</div>
                      </TableCell>
                      <TableCell className="max-w-56 whitespace-normal">
                        <TargetCell app={app} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {app.effectiveReservePercent}%
                        {app.reservePercent === undefined ? <div className="text-[11px] text-muted-foreground">default</div> : null}
                      </TableCell>
                      <TableCell className="max-w-48 whitespace-normal font-mono text-[11px]">
                        {app.models && app.models.length > 0 ? app.models.join(", ") : <span className="font-sans text-muted-foreground">any</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{app.dailyTokens !== undefined ? formatTokens(app.dailyTokens) : <span className="text-muted-foreground">none</span>}</TableCell>
                      <TableCell className="text-right tabular-nums">{usage(app.usage1d)}</TableCell>
                      <TableCell className="text-right tabular-nums">{usage(app.usage7d)}</TableCell>
                      <TableCell className="whitespace-normal">
                        {app.tokens.length === 0 ? (
                          <span className="text-xs text-muted-foreground">none</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {app.tokens.map((t) => (
                              <li key={t.prefix} className="flex items-center gap-1.5 text-[11px]">
                                <KeyRound className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                                <span className="font-mono">{t.prefix}…</span>
                                {t.createdAt ? <RelativeTime iso={t.createdAt} className="text-muted-foreground" /> : null}
                                {t.expiresAt ? (
                                  <span className="text-muted-foreground">
                                    {Date.parse(t.expiresAt) > Date.now() ? "expires " : "expired "}
                                    <RelativeTime iso={t.expiresAt} />
                                  </span>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                      <TableCell>{app.state === "active" ? <Badge variant="success">Active</Badge> : <Badge variant="muted">Revoked</Badge>}</TableCell>
                      <TableCell className="text-right">
                        {app.state === "active" ? (
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPending({ kind: "edit", app })}>
                              Edit
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setPending({ kind: "rotate", app })}>
                              Rotate
                            </Button>
                            <Button variant="ghost" size="sm" className="h-7 text-xs text-destructive" onClick={() => setPending({ kind: "revoke", app })}>
                              Revoke
                            </Button>
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {pending?.kind === "edit" ? <EditDialog app={pending.app} defaultReserve={defaultReserve} onClose={() => setPending(null)} /> : null}
      {pending?.kind === "revoke" ? <RevokeDialog app={pending.app} onClose={() => setPending(null)} /> : null}
      {pending?.kind === "rotate" ? (
        <RotateDialog
          app={pending.app}
          onClose={() => setPending(null)}
          onRotated={(r) => {
            setPending(null);
            setRotated(r);
          }}
        />
      ) : null}
      {rotated ? <NewTokenDialog result={rotated} onClose={() => setRotated(null)} /> : null}
    </div>
  );
}

export default GatewayPage;
