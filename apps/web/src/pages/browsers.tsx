import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { EmptyState, ErrorBanner, PageHeader } from "@/components/page-header";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { qk, useBrowsersQuery } from "@/hooks/queries";
import { api } from "@/lib/api";
import type { BrowserBindingDto, BrowserTargetDto } from "@/types/api";

function targetText(t: BrowserTargetDto): string {
  return t.kind === "pool" ? `pool: ${t.pool}` : `identity: ${t.identity}`;
}

function StateBadge({ binding }: { binding: BrowserBindingDto }) {
  if (binding.state === "revoked") return <Badge variant="muted">Revoked</Badge>;
  return binding.connected ? <Badge variant="success">Connected</Badge> : <Badge variant="warning">Offline</Badge>;
}

function RevokeDialog({ binding, onClose }: { binding: BrowserBindingDto; onClose: () => void }) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.revokeBrowser(binding.name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.browsers });
      toast.success("Browser revoked", { description: binding.name });
      onClose();
    },
    onError: (error) => toast.error("Revoke failed", { description: error.message }),
  });
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke browser?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono text-xs">{binding.name}</span> ({binding.profileLabel || "unknown profile"}) will be
            disconnected and its token stops working. Reconnect it from the extension to use it again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={mutation.isPending}
            onClick={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
          >
            {mutation.isPending ? "Revoking..." : "Revoke"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function BrowsersPage() {
  const query = useBrowsersQuery();
  const [showRevoked, setShowRevoked] = useState(false);
  const [revoking, setRevoking] = useState<BrowserBindingDto | null>(null);
  const data = query.data;
  const revokedCount = data?.bindings.filter((b) => b.state === "revoked").length ?? 0;
  const rows = (data?.bindings ?? []).filter((b) => showRevoked || b.state !== "revoked");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Browsers"
        description="AIS Browser extensions paired with this console, and which pool or identity each one drives."
        updatedAt={query.dataUpdatedAt}
        actions={
          revokedCount > 0 ? (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={showRevoked}
                onChange={(e) => setShowRevoked(e.target.checked)}
              />
              Show revoked ({revokedCount})
            </label>
          ) : null
        }
      />
      {query.isError ? <ErrorBanner message={query.error.message} /> : null}
      {query.isLoading ? <Skeleton className="h-40 w-full" /> : null}
      {data && !data.configured ? (
        <EmptyState
          icon={<Globe />}
          title="Browser pairing is not configured"
          description="This console has no gateway admin URL and token, so it cannot list browsers. Set AIS_GATEWAY_ADMIN_URL and AIS_GATEWAY_ADMIN_TOKEN on the console server."
        />
      ) : null}
      {data?.configured && data.error ? <ErrorBanner message={`Could not read browsers: ${data.error}`} /> : null}
      {data?.configured && !data.error && rows.length === 0 ? (
        <EmptyState
          icon={<Globe />}
          title="No browsers connected"
          description={`Open the AIS Browser extension, enter ${window.location.origin} as the address, choose Connect, then Approve on the page that opens.`}
        />
      ) : null}
      {data?.configured && rows.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Profile</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b) => (
                  <TableRow key={b.name}>
                    <TableCell className="font-mono text-xs">{b.name}</TableCell>
                    <TableCell className="text-sm">{b.profileLabel || "-"}</TableCell>
                    <TableCell className="font-mono text-xs">{targetText(b.target)}</TableCell>
                    <TableCell>
                      <StateBadge binding={b} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{b.extensionVersion ?? "unknown"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {b.lastSeenAt ? <RelativeTime iso={b.lastSeenAt} /> : "never"}
                    </TableCell>
                    <TableCell className="text-right">
                      {b.state === "active" ? (
                        <Button variant="outline" size="sm" onClick={() => setRevoking(b)}>
                          Revoke
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
      {revoking ? <RevokeDialog binding={revoking} onClose={() => setRevoking(null)} /> : null}
    </div>
  );
}
