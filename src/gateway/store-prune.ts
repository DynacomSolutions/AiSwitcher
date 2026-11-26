import { homedir } from "node:os";
import { parseTombstones, tombstoneCovers } from "../identities/tombstones.ts";
import { loadGatewayGuard } from "../sync/gateway-guard.ts";
import { gatewayManagesLogin, piCopyOf } from "./host-login-gate.ts";
import type { PgHomeStore } from "./home-store.ts";

/**
 * Removes the stale store copy of a host-owned login (host-login-gate.ts): a claude or codex identity folder login row for
 * an identity that neither this host nor the gateway manages. Earlier host store syncs pushed such rows, and the console
 * then took them as proof that the gateway renews the login. The row is removed only when all of these hold:
 * - the row is the folder login of an identity in this host's registry (or pi's copy of a claude login), and not a swap pool folder;
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
    // The folder login, or pi's auth.json copy of a claude login (same refresh token, account pi/<name>).
    const piCopy = guard.native.has(meta.path) ? undefined : piCopyOf(guard, meta.path);
    const login = guard.native.get(meta.path) ?? piCopy;
    if (!login || login.pool) continue;
    const account = `${login.tool}/${login.name}`;
    if (meta.account !== (piCopy ? `pi/${login.name}` : account)) {
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

export interface RetiredOptions {
  tool: string;
  dryRun?: boolean;
  /** Per identity name, the providers of the active gateway pin apps that pin it, or undefined when the app list could not be read. */
  activePins: () => Promise<Map<string, ReadonlySet<string>> | undefined>;
}

/**
 * The gateway app provider that reads a tool's store folder (`.<tool>/identities/...`). The names are equal for every tool except
 * kimi, whose store folder is `.kimi-code` and whose apps use the provider `kimi`. A pin app of another provider never reads the
 * folder, so its pin does not keep a row. A tool that is not listed has no known provider: every active pin keeps its names then.
 */
export const STORE_TOOL_PROVIDER: Readonly<Record<string, string>> = {
  opencode: "opencode",
  claude: "claude",
  codex: "codex",
  grok: "grok",
  zai: "zai",
  ali: "ali",
  kimi: "kimi",
  "kimi-code": "kimi",
};

/** Thrown when a retired-identity run must stop before it removes anything. */
export class PruneRefused extends Error {}

const TOOL_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Removes the store rows of identities that a tool's store registry (`.<tool>/identities.json`) no longer holds: every row below
 * `.<tool>/identities/<name>/` whose name is tombstoned (and the tombstone covers the entry) or not listed. A name is kept when it is
 * a pool record, a pool account, or pinned by an active gateway app of the tool's own provider (STORE_TOOL_PROVIDER; any provider for an unlisted tool). Each delete is compare-and-swap on the version listed.
 * Refuses the whole run (throws PruneRefused, removes nothing) when the registry row is missing, does not decrypt, lists no
 * identity (an empty registry must never read as "all retired"), or the app list cannot be read.
 */
export async function pruneRetiredIdentities(store: Pick<PgHomeStore, "list" | "get" | "delete">, opts: RetiredOptions): Promise<PruneReport> {
  if (!TOOL_RE.test(opts.tool)) throw new PruneRefused(`"${opts.tool}" is not a tool name`);
  const registryPath = `.${opts.tool}/identities.json`;
  const [row] = await store.get([registryPath]);
  if (!row) throw new PruneRefused(`the registry row ${registryPath} is missing or does not decrypt`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.content.toString("utf8"));
  } catch {
    throw new PruneRefused(`the registry row ${registryPath} is not valid JSON`);
  }
  const reg = (typeof parsed === "object" && parsed !== null ? parsed : {}) as { identities?: unknown; deleted?: unknown };
  const listed = new Map<string, unknown>();
  const poolNames = new Set<string>();
  const poolAccounts = new Set<string>();
  if (Array.isArray(reg.identities)) {
    for (const i of reg.identities) {
      const rec = (typeof i === "object" && i !== null ? i : {}) as { name?: unknown; swapPool?: { accounts?: unknown } };
      if (typeof rec.name !== "string" || !rec.name) continue;
      listed.set(rec.name, i);
      if (rec.swapPool) {
        poolNames.add(rec.name);
        if (Array.isArray(rec.swapPool.accounts)) for (const a of rec.swapPool.accounts) if (typeof a === "string") poolAccounts.add(a);
      }
    }
  }
  if (listed.size === 0) throw new PruneRefused(`the registry row ${registryPath} lists no identity, so it is not read as "all retired"`);
  const tombs = new Map(parseTombstones(reg.deleted).map((t) => [t.name, t]));
  const pinned = await opts.activePins();
  if (!pinned) throw new PruneRefused("the gateway app list could not be read");
  const provider = Object.hasOwn(STORE_TOOL_PROVIDER, opts.tool) ? STORE_TOOL_PROVIDER[opts.tool] : undefined;
  const pinWhy = (name: string): string | undefined => {
    const providers = pinned.get(name);
    if (!providers || providers.size === 0) return undefined;
    if (!provider) return `an active gateway app pins it (the tool ${opts.tool} has no known provider, so any provider counts)`;
    return providers.has(provider) ? `an active ${provider} gateway app pins it` : undefined;
  };

  const prefix = `.${opts.tool}/identities/`;
  const report: PruneReport = { removed: [], kept: [] };
  for (const meta of await store.list(0)) {
    if (!meta.path.startsWith(prefix)) continue;
    const name = meta.path.slice(prefix.length).split("/")[0] ?? "";
    if (!name || !meta.path.slice(prefix.length + name.length).startsWith("/")) continue;
    const entry = listed.get(name);
    let why: string | undefined;
    if (entry !== undefined && !tombstoneCovers(tombs.get(name), entry)) why = "the registry still lists this identity";
    else if (poolNames.has(name)) why = "a swap pool record";
    else if (poolAccounts.has(name)) why = "an account of a swap pool";
    else why = pinWhy(name);
    if (why) {
      report.kept.push({ path: meta.path, why });
      continue;
    }
    if (opts.dryRun || (await store.delete(meta.path, meta.version))) report.removed.push(meta.path);
    else report.kept.push({ path: meta.path, why: "the row changed while it was checked" });
  }
  return report;
}
