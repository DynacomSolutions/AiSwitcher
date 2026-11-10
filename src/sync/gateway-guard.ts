import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { withOauthRefreshLock } from "../identities/claude-swap-lock.ts";
import { hasMemberCopy, MEMBER_STORE_TOOLS, memberLoginFile, memberStoreRoot, type MemberStoreTool } from "../identities/gateway-members.ts";
import { backupUnique, classifyLogin, isPureGatewayEntry, loginAccount, relateToRouting, routingOf } from "../identities/gateway-routed.ts";
import { expandPath } from "../identities/match.ts";
import { createFileDurable, writeFileDurable } from "../identities/pool/fs.ts";
import { withLockDir } from "../identities/pool/grant-file-adapter.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG, PI_CONFIG } from "../identities/tool-configs.ts";

/**
 * Keeps AIS sync (and the live inbox) from undoing `ais identities route-all-via-gateway` on any host.
 *
 * Refresh tokens are single-use. Once a host routes an identity, its gateway alone renews the login (from the gateway
 * member store, ~/.ais/gateway-members, which is never synced) and the identity folder holds the gateway entry. Every other
 * copy of that login, on any host, must stop being used, or its next refresh spends the token the gateway renews
 * (`refresh_token_reused`). The rules, applied by the receiving host to the claude `.credentials.json` / codex `auth.json`
 * of every plain identity. The gateway entry carries a routing record (gateway-routed.ts: routing host, fingerprints of the
 * routed refresh tokens, freshness and account of the routed login) that tells "the login that was routed" from "a sign-in
 * made later on another host" (a new refresh token family the gateway never held, harmless to it):
 *   - this host holds a member store copy for the identity: its folder file is never replaced, whatever arrives;
 *   - an arriving gateway entry replaces a real login only when that login is the routed one: a routed refresh token, or
 *     provably not fresher than the routed copy and not a different account. The replaced file is backed up (unique,
 *     0600, under ~/.ais/gateway-replaced, which is never synced) and a line names the identity. The routed state spreads
 *     that way, and gateway-managed.ts then treats the identity as the gateway's there too (no refresh, no reconcile with
 *     pi). Sessions there stop working until the user signs in again on that host; that sign-in is then kept, and logged at
 *     each sync. A login that cannot be told apart (an entry without a routing record, an undatable login) is kept too;
 *   - the routing host itself (it routed the identity, and holds no member store copy any more: it was un-routed) keeps its
 *     login whatever entry arrives;
 *   - a gateway entry is replaced by a real login only when that login is provably a separate one (fresher than the routed
 *     copy, or a different account): a host that has not seen the routing yet must not undo it with its old copy, while a
 *     fresh sign-in, or the login the routing host restored when un-routing, spreads like any login;
 *   - pi's same-named copy (`anthropic` / `openai-codex` in the pi identity's auth.json) of a routed login is stripped from
 *     what arrives and, after the merge, from the live file (backup first, under pi's lock).
 * Everything else merges as before (newest wins).
 */

export const PI_PROVIDER_OF: Record<MemberStoreTool, string> = { claude: "anthropic", codex: "openai-codex" };

const REGISTRY_OF: Record<MemberStoreTool | "pi", string> = {
  claude: CLAUDE_CONFIG.identitiesJsonPath,
  codex: CODEX_CONFIG.identitiesJsonPath,
  pi: PI_CONFIG.identitiesJsonPath,
};

export interface GuardedLogin {
  tool: MemberStoreTool;
  name: string;
  dir: string;
  /** A swap pool folder: it never holds a login of its own, and once routed only the gateway entry belongs there. */
  pool?: boolean;
}

export interface GuardedPiFile {
  name: string;
  dir: string;
  path: string;
}

export interface GatewayGuard {
  memberRoot: string;
  /** This host's name, compared with the routing record's host. */
  host: string;
  /** Home-relative login file of every claude/codex identity (swap pool folders marked `pool`). */
  native: Map<string, GuardedLogin>;
  /** Home-relative auth.json of every plain pi identity. */
  pi: Map<string, GuardedPiFile>;
}

function rerooted(path: string, home: string): string {
  const real = homedir();
  return path.startsWith(`${real}/`) ? join(home, path.slice(real.length + 1)) : path;
}

function relativeTo(home: string, path: string): string | undefined {
  const rel = relative(home, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : undefined;
}

/** Reads the registries under `home` (an unreadable registry contributes nothing). */
export async function loadGatewayGuard(home: string = homedir(), registries: Partial<Record<MemberStoreTool | "pi", string>> = {}, host: string = hostname()): Promise<GatewayGuard> {
  const guard: GatewayGuard = { memberRoot: memberStoreRoot(home), host, native: new Map(), pi: new Map() };
  for (const tool of [...MEMBER_STORE_TOOLS, "pi"] as const) {
    let identities;
    try {
      identities = (await loadIdentitiesFile(registries[tool] ?? rerooted(REGISTRY_OF[tool], home))).identities;
    } catch {
      continue;
    }
    for (const identity of identities) {
      if (identity.swapPool && tool === "pi") continue;
      const dir = rerooted(expandPath(identity.configDir), home);
      if (identity.swapPool) {
        // A routed pool folder keeps its gateway entry (planCredentialMerge); other pool files merge as before.
        const rel = relativeTo(home, join(dir, memberLoginFile(tool as MemberStoreTool)));
        if (rel) guard.native.set(rel, { tool: tool as MemberStoreTool, name: identity.name, dir, pool: true });
        continue;
      }
      if (tool === "pi") {
        const path = join(dir, "auth.json");
        const rel = relativeTo(home, path);
        if (rel) guard.pi.set(rel, { name: identity.name, dir, path });
        continue;
      }
      const rel = relativeTo(home, join(dir, memberLoginFile(tool)));
      if (rel) guard.native.set(rel, { tool, name: identity.name, dir });
    }
  }
  return guard;
}

const readSync = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** True when this host holds the gateway member store copy of the identity's login (never for a pool folder). */
export const memberHere = (guard: GatewayGuard, login: GuardedLogin): boolean => !login.pool && hasMemberCopy(login.tool, login.name, guard.memberRoot);

/** Names of the identities routed on this host right now (a member store copy, or the folder holds the gateway entry). */
export function routedNow(guard: GatewayGuard): Record<MemberStoreTool, Set<string>> {
  const routed: Record<MemberStoreTool, Set<string>> = { claude: new Set(), codex: new Set() };
  for (const login of guard.native.values()) {
    if (login.pool) continue;
    if (memberHere(guard, login) || isPureGatewayEntry(login.tool, readSync(join(login.dir, memberLoginFile(login.tool))))) routed[login.tool].add(login.name);
  }
  return routed;
}

/** pi providers of `piName` whose same-named claude/codex identity is routed. */
export const routedProviders = (routed: Record<MemberStoreTool, Set<string>>, piName: string): string[] =>
  MEMBER_STORE_TOOLS.filter((tool) => routed[tool].has(piName)).map((tool) => PI_PROVIDER_OF[tool]);

export type CredentialMerge = "keep-local" | "take-incoming" | "merge";

/** Why a guarded login file was kept or replaced; each reason except `plain` is logged by the caller. */
export type CredentialReason =
  | "plain" // nothing gateway-related decided it
  | "member-here" // this host's gateway holds the login
  | "entry-replaces-login" // the arriving entry replaces this host's copy of the routed login (back up, log)
  | "entry-replaces-none" // the arriving entry replaces a file without a login
  | "kept-fresh-login" // this host's login is a separate sign-in: the entry does not replace it
  | "kept-unknown-login" // this host's login cannot be told apart from the routed one: kept
  | "kept-routing-host" // this host routed the identity and un-routed it since: its login stays
  | "kept-entry" // a real login never replaces the entry unless provably separate
  | "kept-pool-entry" // a routed swap pool folder keeps its gateway entry: no member login goes there (log)
  | "login-replaces-entry"; // a separate login (fresh sign-in, or the un-routed login) replaces the entry (log)

export interface CredentialPlan {
  action: CredentialMerge;
  reason: CredentialReason;
  /** The routing host named by the entry, when one decided it. */
  routedBy?: string;
}

export interface CredentialContext {
  memberHere: boolean;
  /** The file is a swap pool folder's login file. */
  pool?: boolean;
  /** This host's name (default os.hostname()). */
  host?: string;
  /** claude: the identity folder's `.claude.json` text (its account uuid); codex reads the account from the token. */
  claudeJsonText?: string;
}

/** How the receiving host merges an identity login file (see the module comment). */
export function planCredentialMerge(tool: MemberStoreTool, localText: string | undefined, incomingText: string | undefined, ctx: CredentialContext): CredentialPlan {
  if (ctx.memberHere) return { action: "keep-local", reason: "member-here" };
  const local = classifyLogin(tool, localText);
  const incoming = classifyLogin(tool, incomingText);
  if (ctx.pool) {
    // The gateway picks a routed pool's member; a member login arriving over the entry would be refreshed by the pool's
    // sessions. Anything else about a pool file (both logins, both entries, an entry arriving) merges as before.
    return local === "gateway" && incoming !== "gateway" ? { action: "keep-local", reason: "kept-pool-entry" } : { action: "merge", reason: "plain" };
  }
  if (local === "gateway" && incoming !== "gateway") {
    const routing = routingOf(localText);
    if (incoming === "login" && routing && relateToRouting(tool, incomingText, loginAccount(tool, incomingText, ctx.claudeJsonText), routing) === "separate") {
      return { action: "take-incoming", reason: "login-replaces-entry", routedBy: routing.host };
    }
    return { action: "keep-local", reason: "kept-entry" };
  }
  if (incoming === "gateway" && local !== "gateway") {
    if (local === "none") return { action: "take-incoming", reason: "entry-replaces-none" };
    const routing = routingOf(incomingText);
    if (!routing) return { action: "keep-local", reason: "kept-unknown-login" };
    if (routing.host === (ctx.host ?? hostname())) return { action: "keep-local", reason: "kept-routing-host", routedBy: routing.host };
    const relation = relateToRouting(tool, localText, loginAccount(tool, localText, ctx.claudeJsonText), routing);
    if (relation === "routed") return { action: "take-incoming", reason: "entry-replaces-login", routedBy: routing.host };
    return { action: "keep-local", reason: relation === "separate" ? "kept-fresh-login" : "kept-unknown-login", routedBy: routing.host };
  }
  return { action: "merge", reason: "plain" };
}

/** planCredentialMerge's action alone. */
export const decideCredentialMerge = (tool: MemberStoreTool, localText: string | undefined, incomingText: string | undefined, memberStoreCopyHere: boolean, host?: string): CredentialMerge =>
  planCredentialMerge(tool, localText, incomingText, { memberHere: memberStoreCopyHere, ...(host ? { host } : {}) }).action;

/** The context planCredentialMerge needs for a guarded login of this host. */
export async function credentialContext(guard: GatewayGuard, login: GuardedLogin): Promise<CredentialContext> {
  return {
    memberHere: memberHere(guard, login),
    ...(login.pool ? { pool: true } : {}),
    host: guard.host,
    ...(login.tool === "claude" ? { claudeJsonText: await readFile(join(login.dir, ".claude.json"), "utf8").catch(() => undefined) } : {}),
  };
}

/**
 * Backs up a login file the gateway guard replaces: `~/.ais/gateway-replaced/<tool>-<identity>-<file>.<timestamp>[-n].bak`,
 * created exclusively with mode 0600 (that folder is never synced, so the login does not travel on). Returns the path.
 */
export async function backupReplacedLogin(guard: GatewayGuard, login: GuardedLogin, text: string, now: () => number = Date.now): Promise<string> {
  const dir = join(dirname(guard.memberRoot), "gateway-replaced");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  for (let n = 0; ; n++) {
    const target = join(dir, `${login.tool}-${login.name}-${memberLoginFile(login.tool)}.${stamp}${n === 0 ? "" : `-${n}`}.bak`);
    try {
      await createFileDurable(target, text);
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 1000) throw err;
    }
  }
}

/** The log line for a plan that changed or refused something (undefined for the quiet ones). */
export function credentialPlanLine(login: GuardedLogin, plan: CredentialPlan, backup?: string): string | undefined {
  const who = `${login.tool} identity ${login.name}`;
  const by = plan.routedBy ? ` on ${plan.routedBy}` : "";
  switch (plan.reason) {
    case "entry-replaces-login":
      return `${who}: the gateway entry (routed${by}) replaced this host's copy of the routed login${backup ? ` (backed up to ${backup})` : ""}; its sessions here stop working until you sign in again on this host (that sign-in is then kept)`;
    case "kept-fresh-login":
      return `${who}: kept this host's login, a sign-in made after the identity was routed${by} (the gateway never held it); the arriving gateway entry was not applied`;
    case "kept-unknown-login":
      return `${who}: kept this host's login: it cannot be told apart from the login routed${by} (the entry has no routing record, or the login is undatable); re-run ais identities route-all-via-gateway on the routing host to add the record`;
    case "kept-routing-host":
      return `${who}: kept this host's login: this host routed the identity and holds no gateway member copy any more (un-routed); the arriving gateway entry was not applied`;
    case "kept-pool-entry":
      return `${login.tool} swap pool ${login.name}: kept its gateway entry; the arriving login was not applied (the gateway picks the pool's member)`;
    case "login-replaces-entry":
      return `${who}: a login made after the routing${by} (a fresh sign-in, or the login restored on the routing host) replaced the gateway entry`;
    default:
      return undefined;
  }
}

/** A pi auth.json text without the given providers, or undefined when it holds none of them (or is not a JSON object). */
export function withoutProviders(text: string | undefined, providers: readonly string[]): string | undefined {
  if (text === undefined || providers.length === 0) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const record = json as Record<string, unknown>;
  if (!providers.some((p) => Object.hasOwn(record, p))) return undefined;
  for (const p of providers) delete record[p];
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Strips pi's copy of every routed login from the live pi auth.json files, each under AIS's refresh lock and pi's own
 * (`auth.json.lock`), after a unique `.pre-gateway` backup. Returns one line per file changed or failed. Best effort.
 */
export async function stripRoutedPiCopies(guard: GatewayGuard, now: () => number = Date.now): Promise<string[]> {
  const routed = routedNow(guard);
  const lines: string[] = [];
  for (const pi of guard.pi.values()) {
    const providers = routedProviders(routed, pi.name);
    if (providers.length === 0 || withoutProviders(await readFile(pi.path, "utf8").catch(() => undefined), providers) === undefined) continue;
    try {
      const line = await withOauthRefreshLock(pi.dir, () =>
        withLockDir(join(pi.dir, "auth.json.lock"), 30_000, `pi is refreshing its credentials in ${pi.dir}`, async () => {
          const stripped = withoutProviders(await readFile(pi.path, "utf8").catch(() => undefined), providers);
          if (stripped === undefined) return undefined;
          const backup = await backupUnique(pi.path, now);
          await writeFileDurable(pi.path, stripped);
          return `pi identity ${pi.name}: removed its copy of the gateway-routed login (${providers.join(", ")}; backed up to ${backup})`;
        }),
      );
      if (line) lines.push(line);
    } catch (err) {
      lines.push(`pi identity ${pi.name}: could not remove its copy of the gateway-routed login (${providers.join(", ")}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return lines;
}
