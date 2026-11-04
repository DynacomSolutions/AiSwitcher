import type { BrowserBinding } from "../../browser/types.ts";
import type { GatewayStore } from "../store.ts";
import { parseToken, sameHash } from "../tokens.ts";

/** The active binding a browser token belongs to, or undefined (unknown, wrong secret, revoked binding). */
export async function authBrowserToken(store: GatewayStore, token: string): Promise<BrowserBinding | undefined> {
  const parsed = parseToken(token);
  if (!parsed) return undefined;
  const rec = await store.browserTokenByPrefix(parsed.prefix);
  if (!rec || !sameHash(rec.hash, parsed.secret)) return undefined;
  const binding = await store.getBrowserBinding(rec.app);
  return binding && binding.state === "active" ? binding : undefined;
}

/** The identity an agent token was issued for, or undefined (unknown, wrong secret, revoked). */
export async function authAgentToken(store: GatewayStore, token: string): Promise<{ identity: string } | undefined> {
  const parsed = parseToken(token);
  if (!parsed) return undefined;
  const rec = await store.agentTokenByPrefix(parsed.prefix);
  if (!rec || !sameHash(rec.hash, parsed.secret)) return undefined;
  return { identity: rec.identity };
}
