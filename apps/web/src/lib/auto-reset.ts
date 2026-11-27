import type { AutoResetLastClaim, AutoResetProviderView, AutoResetResponse } from "@/types/api";

/** The automatic reset view of one tool. Undefined while the gateway reports nothing for it. */
export function autoResetProviderFor(view: AutoResetResponse | undefined, tool: string): AutoResetProviderView | undefined {
  return view?.configured ? view.providers.find((row) => row.provider === tool) : undefined;
}

/** The last claim that a pool made on one member of a supported provider. */
export function memberClaimFor(view: AutoResetResponse | undefined, tool: string, identity: string): AutoResetLastClaim | undefined {
  const row = autoResetProviderFor(view, tool);
  return row?.supported ? row.memberClaims[identity] : undefined;
}
