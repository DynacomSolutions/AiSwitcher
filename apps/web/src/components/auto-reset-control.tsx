import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { qk } from "@/hooks/queries";
import { api } from "@/lib/api";
import { formatResetTimes } from "@/lib/reset-time";
import type { AutoResetResponse, AutoResetStatus } from "@/types/api";

export function AutoResetControl({ setting }: { setting: AutoResetStatus }) {
  const client = useQueryClient();
  const claim = setting.lastClaim;
  const change = useMutation({
    mutationFn: (enabled: boolean) => api.setAutoReset(setting.name, enabled),
    onSuccess: async ({ name, enabled }) => {
      await client.cancelQueries({ queryKey: qk.autoReset });
      client.setQueryData<AutoResetResponse>(qk.autoReset, (view) => {
        if (!view?.configured) return view;
        return { ...view, pools: view.pools.map((p) => p.name === name ? { ...p, enabled } : p) };
      });
      await client.invalidateQueries({ queryKey: qk.autoReset });
    },
    onError: (error) => {
      toast.error("Automatic reset setting could not be changed", { description: error.message });
      void client.invalidateQueries({ queryKey: qk.autoReset });
    },
  });
  const status = `Automatic reset ${setting.enabled ? "on" : "off"}`;
  const label = `${setting.enabled ? "Disable" : "Enable"} automatic resets for pool ${setting.name}`;
  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium" role="status">{status}</span>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" size="sm" variant="outline" aria-label={label} aria-disabled={change.isPending} onClick={(event) => {
              if (change.isPending || setting.enabled) event.preventDefault();
              if (!change.isPending && setting.enabled) change.mutate(false);
            }}>
              {setting.enabled ? "Disable" : "Enable"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Enable automatic resets for {setting.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                When the gateway verifies that every routed account has exhausted its weekly quota, it can spend a credit from this pool.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => change.mutate(true)}>Enable automatic resets</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <p className="break-words text-muted-foreground">
        Last claim: {claim ? (
          <>
            {claim.status} at <time dateTime={claim.startedAt} title={claim.startedAt}>{formatResetTimes(Date.parse(claim.startedAt), { roundUp: false })}</time>
            {" on "}{claim.identity}
            {claim.creditExpiresAt ? <>. Credit expiry <time dateTime={claim.creditExpiresAt} title={claim.creditExpiresAt}>{formatResetTimes(Date.parse(claim.creditExpiresAt), { roundUp: false })}</time></> : null}
          </>
        ) : "None"}
      </p>
    </div>
  );
}
