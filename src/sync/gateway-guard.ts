import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { withOauthRefreshLock } from "../identities/claude-swap-lock.ts";
import { hasMemberCopy, MEMBER_STORE_TOOLS, memberLoginFile, memberStoreRoot, type MemberStoreTool } from "../identities/gateway-members.ts";
import { backupUnique, classifyLogin, isPureGatewayEntry } from "../identities/gateway-routed.ts";
import { expandPath } from "../identities/match.ts";
import { writeFileDurable } from "../identities/pool/fs.ts";
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
 * of every plain identity:
 *   - this host holds a member store copy for the identity: its folder file is never replaced, whatever arrives;
 *   - a gateway entry is never replaced by a real login (a host that has not seen the routing yet must not undo it);
 *   - an arriving gateway entry replaces a real login, whatever the times say: the routed state spreads to every synced
 *     host, so their folders stop holding (and their refreshers stop refreshing) the login. gateway-managed.ts then treats
 *     the identity as the gateway's there too (no refresh, no reconcile with pi);
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
}

export interface GuardedPiFile {
  name: string;
  dir: string;
  path: string;
}

export interface GatewayGuard {
  memberRoot: string;
  /** Home-relative login file of every plain claude/codex identity. */
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
export async function loadGatewayGuard(home: string = homedir(), registries: Partial<Record<MemberStoreTool | "pi", string>> = {}): Promise<GatewayGuard> {
  const guard: GatewayGuard = { memberRoot: memberStoreRoot(home), native: new Map(), pi: new Map() };
  for (const tool of [...MEMBER_STORE_TOOLS, "pi"] as const) {
    let identities;
    try {
      identities = (await loadIdentitiesFile(registries[tool] ?? rerooted(REGISTRY_OF[tool], home))).identities;
    } catch {
      continue;
    }
    for (const identity of identities) {
      if (identity.swapPool) continue;
      const dir = rerooted(expandPath(identity.configDir), home);
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

/** True when this host holds the gateway member store copy of the identity's login. */
export const memberHere = (guard: GatewayGuard, login: GuardedLogin): boolean => hasMemberCopy(login.tool, login.name, guard.memberRoot);

/** Names of the identities routed on this host right now (a member store copy, or the folder holds the gateway entry). */
export function routedNow(guard: GatewayGuard): Record<MemberStoreTool, Set<string>> {
  const routed: Record<MemberStoreTool, Set<string>> = { claude: new Set(), codex: new Set() };
  for (const login of guard.native.values()) {
    if (memberHere(guard, login) || isPureGatewayEntry(login.tool, readSync(join(login.dir, memberLoginFile(login.tool))))) routed[login.tool].add(login.name);
  }
  return routed;
}

/** pi providers of `piName` whose same-named claude/codex identity is routed. */
export const routedProviders = (routed: Record<MemberStoreTool, Set<string>>, piName: string): string[] =>
  MEMBER_STORE_TOOLS.filter((tool) => routed[tool].has(piName)).map((tool) => PI_PROVIDER_OF[tool]);

export type CredentialMerge = "keep-local" | "take-incoming" | "merge";

/** How the receiving host merges an identity login file (see the module comment). */
export function decideCredentialMerge(tool: MemberStoreTool, localText: string | undefined, incomingText: string | undefined, memberStoreCopyHere: boolean): CredentialMerge {
  if (memberStoreCopyHere) return "keep-local";
  const local = classifyLogin(tool, localText);
  const incoming = classifyLogin(tool, incomingText);
  if (local === "gateway" && incoming !== "gateway") return "keep-local";
  if (incoming === "gateway" && local !== "gateway") return "take-incoming";
  return "merge";
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
