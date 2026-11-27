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
import type { AutoResetLastClaim, AutoResetProvider, AutoResetResponse, AutoResetStatus } from "@/types/api";

const CREDIT_NAME: Record<AutoResetProvider, string> = { codex: "Codex reset credit", claude: "Claude reset grant" };

function ClaimText({ claim, where }: { claim: AutoResetLastClaim | undefined; where: "pool" | "member" }) {
  if (!claim) return <>None</>;
  return (
    <>
      {claim.status} at <time dateTime={claim.startedAt} title={claim.startedAt}>{formatResetTimes(Date.parse(claim.startedAt), { roundUp: false })}</time>
      {where === "pool" ? ` on ${claim.identity}` : ` in ${claim.pool}`}
      {claim.creditExpiresAt ? <>. Credit expiry <time dateTime={claim.creditExpiresAt} title={claim.creditExpiresAt}>{formatResetTimes(Date.parse(claim.creditExpiresAt), { roundUp: false })}</time></> : null}
    </>
  );
}

/** The on and off control of one pool. Automatic reset is a pool setting only. */
export function AutoResetControl({ provider, setting }: { provider: AutoResetProvider; setting: AutoResetStatus }) {
  const client = useQueryClient();
  const change = useMutation({
    mutationFn: (enabled: boolean) => api.setAutoReset(provider, setting.name, enabled),
    onSuccess: async ({ name, enabled }) => {
      await client.cancelQueries({ queryKey: qk.autoReset });
      client.setQueryData<AutoResetResponse>(qk.autoReset, (view) => {
        if (!view?.configured) return view;
        return {
          ...view,
          providers: view.providers.map((row) => row.supported && row.provider === provider
            ? { ...row, pools: row.pools.map((p) => p.name === name ? { ...p, enabled } : p) } : row),
        };
      });
      await client.invalidateQueries({ queryKey: qk.autoReset });
    },
    onError: (error) => {
      toast.error("Automatic reset setting could not be changed", { description: error.message });
      void client.invalidateQueries({ queryKey: qk.autoReset });
    },
  });
  const status = `Automatic reset ${setting.enabled ? "on" : "off"}`;
  const label = `${setting.enabled ? "Disable" : "Enable"} automatic resets for ${provider} pool ${setting.name}`;
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
                The gateway can spend a {CREDIT_NAME[provider]} automatically when every account of this pool reaches its weekly limit.
                This is a pool setting. No single account has its own setting.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => change.mutate(true)}>Enable automatic resets</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <p className="break-words text-muted-foreground">Last claim: <ClaimText claim={setting.lastClaim} where="pool" /></p>
    </div>
  );
}

/** The last claim that a pool made on one account. It has no control: the setting belongs to the pool. */
export function AutoResetMemberClaim({ claim }: { claim: AutoResetLastClaim | undefined }) {
  return (
    <p className="break-words text-xs text-muted-foreground">
      Last automatic reset: <ClaimText claim={claim} where="member" />
    </p>
  );
}

/** Shown for a provider that has no reset credit or grant API. It has no toggle. */
export function AutoResetUnsupported({ provider, reason }: { provider: string; reason: string }) {
  return (
    <p className="break-words text-xs text-muted-foreground" data-testid={`auto-reset-unsupported-${provider}`}>
      Automatic reset: not supported. {reason}
    </p>
  );
}
