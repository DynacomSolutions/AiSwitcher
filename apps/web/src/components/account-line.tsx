import { TriangleAlert } from "lucide-react";

import { ProviderLabel } from "@/components/provider-icon";
import { Badge } from "@/components/ui/badge";
import type { AccountInfo } from "@/types/api";

/** The account behind a login: email or label, organisation, gateway marker and the two warnings. */
export function AccountLine({ account }: { account?: AccountInfo }) {
  if (!account) return <span className="text-xs text-muted-foreground">-</span>;
  const name = account.email ?? account.label ?? account.accountId;
  return (
    <div className="min-w-0 space-y-0.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="break-all font-medium" title={name}>
          {name}
        </span>
        {account.source === "gateway-member" ? (
          <Badge variant="outline" className="text-[10px]">
            via gateway
          </Badge>
        ) : null}
      </div>
      {account.organization ? <div className="truncate text-muted-foreground">{account.organization}</div> : null}
      {account.logins && account.logins.length > 0 ? (
        <div className="space-y-0.5 text-[11px] text-muted-foreground">
          {account.logins.map((l) => (
            <div key={l.provider} className="break-all">
              <ProviderLabel provider={l.provider} size={11} className="align-middle" />: {l.email ?? l.label ?? l.accountId ?? "-"}
            </div>
          ))}
        </div>
      ) : null}
      <AccountWarnings account={account} />
    </div>
  );
}

export function AccountWarnings({ account }: { account?: AccountInfo }) {
  if (!account) return null;
  const folder = account.mismatch?.folderEmail ?? account.mismatch?.folderAccountId;
  return (
    <>
      {account.mismatch ? (
        <div className="flex items-start gap-1 text-destructive">
          <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span>
            Identity folder is signed in to {folder ?? "another account"}. The gateway uses {account.email ?? account.label ?? "its member account"}.
          </span>
        </div>
      ) : null}
      {account.sharedWith && account.sharedWith.length > 0 ? (
        <div className="flex items-start gap-1 text-amber-500">
          <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
          <span>Same account as {account.sharedWith.join(", ")}</span>
        </div>
      ) : null}
    </>
  );
}
