import { homedir } from "node:os";
import { loadGatewayGuard } from "../sync/gateway-guard.ts";
import { gatewayManagesLogin } from "./host-login-gate.ts";
import type { PgHomeStore } from "./home-store.ts";

/**
 * Removes the stale store copy of a host-owned login (host-login-gate.ts): a claude or codex identity folder login row for
 * an identity that neither this host nor the gateway manages. Earlier host store syncs pushed such rows, and the console
 * then took them as proof that the gateway renews the login. The row is removed only when all of these hold:
 * - the row is the folder login of an identity in this host's registry, and it is not a swap pool folder;
 * - this host sees no gateway management of it (no member copy, no sticky ownership, no routed pool);
 * - the gateway's own list of renewed logins (GET /logins/renewal) was read and does not name it;
 * - the row has not moved since it was listed (compare-and-swap on its version).
 * An unreadable gateway list removes nothing. Member store rows, registries and other tools' rows are never touched.
 */

export interface PruneReport {
  removed: string[];
  kept: Array<{ path: string; why: string }>;
}

export interface PruneOptions {
  home?: string;
  dryRun?: boolean;
  /** The logins ("tool/identity") the gateway renews, or undefined when its list could not be read. */
  gatewayLogins: () => Promise<Set<string> | undefined>;
}

export async function pruneUnmanagedLogins(store: Pick<PgHomeStore, "list" | "delete">, opts: PruneOptions): Promise<PruneReport> {
  const home = opts.home ?? homedir();
  const report: PruneReport = { removed: [], kept: [] };
  const gateway = await opts.gatewayLogins();
  if (!gateway) {
    report.kept.push({ path: "(all)", why: "the gateway's list of renewed logins could not be read" });
    return report;
  }
  const guard = await loadGatewayGuard(home);
  for (const meta of await store.list(0)) {
    if (meta.kind !== "login") continue;
    const login = guard.native.get(meta.path);
    if (!login || login.pool) continue;
    const account = `${login.tool}/${login.name}`;
    if (meta.account !== account) {
      report.kept.push({ path: meta.path, why: "the row names another account" });
      continue;
    }
    if (gateway.has(account)) {
      report.kept.push({ path: meta.path, why: "the gateway renews this login" });
      continue;
    }
    if (await gatewayManagesLogin(guard, login, home)) {
      report.kept.push({ path: meta.path, why: "this host sees the gateway manage this login" });
      continue;
    }
    if (opts.dryRun || (await store.delete(meta.path, meta.version))) report.removed.push(meta.path);
    else report.kept.push({ path: meta.path, why: "the row changed while it was checked" });
  }
  return report;
}
