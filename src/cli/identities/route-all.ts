import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { LOCAL_GATEWAY_ROUTES } from "../../gateway/local-routes.ts";
import { GATEWAY_TOKEN_PREFIX, gatewayEntryScopesFor, gatewayEntryText, isGatewayAccessToken } from "../../identities/claude-gateway-entry.ts";
import { withOauthRefreshLock, withOauthRefreshLocks } from "../../identities/claude-swap-lock.ts";
import { withPoolLock } from "../../identities/pool/lock.ts";
import { HEARTBEAT_FRESH_MS, readHeartbeat, type GatewayHeartbeat } from "../../identities/gateway-heartbeat.ts";
import { hasMemberCopy, isMemberStoreTool, memberDir, memberLoginFile, memberStoreEnabled, memberStoreRoot, type MemberStoreTool } from "../../identities/gateway-members.ts";
import { backupUnique, classifyLogin, loginAccount, loginFreshness, refreshOf, routingFor, routingOf, withRouting, type GatewayRouting } from "../../identities/gateway-routed.ts";
import { clearLoginRevoked } from "../../identities/gateway-revoked.ts";
import { scanLiveSessions, type SessionTool } from "../../identities/live-sessions.ts";
import { readPiEntry } from "../../identities/oauth-reconcile.ts";
import { withLockDir } from "../../identities/pool/grant-file-adapter.ts";
import { writeFileAtomic, writeFileDurable } from "../../identities/pool/fs.ts";
import { isRetired } from "../../identities/retired.ts";
import { loadIdentitiesFile } from "../../identities/store.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG, GROK_CONFIG, KIMI_CONFIG, PI_CONFIG } from "../../identities/tool-configs.ts";
import type { Identity } from "../../identities/types.ts";
import { loadSyncConfig, syncConfigPath } from "../../sync/config.ts";
import { appTokenKey, defaultSecretsPath, readSecretsKey } from "../gateway/secrets-file.ts";

export { backupUnique, classifyLogin, loginFreshness };

/**
 * `ais identities route-all-via-gateway [--dry-run]`: points every local agent identity at the AIS gateway.
 *
 * Per identity, under the account's refresh lock (the lock the gateway takes before it refreshes the login):
 *   1. the gateway must demonstrably hold the account: a fresh heartbeat from a gateway built with the member store names
 *      it with a successful renewal;
 *   2. no running session may use the folder: a Claude Code or Codex session started before the switch keeps the old login
 *      in memory and later refreshes it with the single-use refresh token the gateway now renews, which kills the gateway's
 *      copy (`refresh_token_reused`); Codex also writes that login back over the gateway entry. A session scan that cannot
 *      run (no readable /proc) refuses. No other holder may keep the login (holdersProblem): a swap pool folder holding it
 *      (active member, same refresh token or account) refuses unless the pool is routed (or is routed by this run, see
 *      below); pi's copy in the same-named pi identity is removed after a
 *      backup (refused while any pi session runs, or when pi's copy may be the fresher one). Checked before and again
 *      under the locks, and sessions are scanned once more after the switch (reported as a warning, exit code 1);
 *   3. pi's copy is removed first; then the login moves into the gateway's own member store (gateway-members.ts), so the
 *      gateway keeps the account after the local file changes. The store copy is written durably (flushed, renamed, folder
 *      flushed) and read back before anything local changes. A store copy already there is replaced only by a fresher login
 *      of the same account. Any failure after the store write rolls back (rollBack): the folder gets its login back and the
 *      store copy written by this run is set aside, so the login always has exactly one holder;
 *   4. each local file about to change is copied to a unique `<file>.pre-gateway.<timestamp>.bak` (never overwritten,
 *      never deleted, flushed and read back), then the gateway entry is written: the base URL of the local gateway route
 *      and the app's `aisg_` key.
 *
 * Refused and reported, nothing written: a tool with no local gateway route (grok, kimi, pi today) or no key, an account the
 * gateway does not hold, a folder with running sessions (or no way to check), a login a swap pool or another pi identity
 * still holds, a pi copy that may be fresher, a folder whose login is a different account than its store copy,
 * a folder with no refreshable login, and any file that is a symlink.
 *
 * Swap pool folders are routed first (routePool), so their members are no longer held by them: a routed pool folder holds
 * the gateway entry, the gateway picks its member per request, and `ais swap` only records the active member
 * (pool/gateway-pool.ts). Same checks as a member: the gateway must hold at least one of the pool's members, no running
 * session may use the pool folder, no symlinked file. A login in the pool folder is a copy of a member's login (sessions in
 * the pool may have refreshed it): under the pool lock and the refresh locks of the pool folder and its owner, it is
 * written back to the owning member (its member store copy when the gateway holds it, else its folder) when it is provably
 * fresher, then the folder file is backed up and replaced by the gateway entry. A pool login that matches no member is
 * only backed up. A member whose pool is still not routed is reported with a warning (that pool's swaps cannot use it).
 * Re-running changes nothing in an identity already routed, but its other holders are checked again: a swap pool or pi copy
 * is reported (exit code 1), and pi's same-named copy is removed as on a first run.
 *
 * AIS sync remotes (sync/gateway-guard.ts) get the gateway entry at the next sync and never send a login back over it, but
 * their running sessions cannot be seen from here: the report warns, naming the remotes, that those must be stopped first.
 */

export const ROUTE_TOOLS = ["claude", "codex", "grok", "kimi", "pi"] as const;
export type RouteTool = (typeof ROUTE_TOOLS)[number];

const REGISTRY_OF: Record<RouteTool, string> = {
  claude: CLAUDE_CONFIG.identitiesJsonPath,
  codex: CODEX_CONFIG.identitiesJsonPath,
  grok: GROK_CONFIG.identitiesJsonPath,
  kimi: KIMI_CONFIG.identitiesJsonPath,
  pi: PI_CONFIG.identitiesJsonPath,
};

const LOCAL_PORT_DEFAULT = 47140;
const CODEX_PROVIDER = "ais-gateway";

export interface RouteAllOptions {
  dryRun?: boolean;
  /** Registry path per tool (tests). */
  registries?: Partial<Record<RouteTool, string>>;
  secretsPath?: string;
  memberRoot?: string;
  heartbeatPath?: string;
  /** Home for the codex key helper and the tools' default folders (default the user's home). */
  home?: string;
  /** /proc for the running-session check (tests pass a fake tree). */
  procRoot?: string;
  port?: number;
  /** AIS sync config (default the user's): its remotes get the routed folders too (see sync/gateway-guard.ts). */
  syncConfigPath?: string;
  now?: () => number;
  /** This host's name in the routing record of the entries written (default os.hostname()). */
  hostname?: string;
  /** Route only this one identity (the portal, after a sign-in on it). */
  only?: { tool: RouteTool; identity: string };
  /**
   * The folder's login is a sign-in just made on a routed identity: the gateway already holds the account (it has the store
   * copy, possibly dead), so the "gateway has renewed it" heartbeat proof is not asked for. Every other rule stands: same
   * account, provably fresher than the store copy, no running session, no other holder.
   */
  afterLogin?: boolean;
  out?: (line: string) => void;
}

export type RouteStatus = "routed" | "already-routed" | "would-route" | "refused";

export interface RouteLine {
  tool: string;
  identity: string;
  status: RouteStatus;
  detail?: string;
  /** Routed, but something needs the user now (a session started during the switch): the exit code is non-zero. */
  attention?: boolean;
}

export interface RouteReport {
  lines: RouteLine[];
  /** Tools reported as having no gateway route or no key (identities untouched). */
  unroutedTools: Array<{ tool: string; reason: string }>;
  /** True when anything was refused or any tool is unrouted: the caller should exit non-zero. */
  incomplete: boolean;
  /** AIS sync remotes that sync every identity folder (undefined: the sync config could not be read). */
  syncRemotes: string[] | undefined;
}

/* ------------------------------------------------------------------ login files */

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Files this command may write in an identity folder (the login file first). */
const FILES_OF: Record<MemberStoreTool, string[]> = {
  claude: [".credentials.json", "settings.json"],
  codex: ["auth.json", "config.toml"],
};

/* ------------------------------------------------------------------ gateway holds the account */

/** Why the running gateway does not demonstrably hold this account, or undefined when it does. */
export function heldProblem(tool: string, name: string, hb: GatewayHeartbeat | undefined, nowMs: number): string | undefined {
  if (!hb) return "no gateway heartbeat: the gateway has not confirmed it holds this account";
  const age = nowMs - Date.parse(hb.passAt);
  if (age > HEARTBEAT_FRESH_MS || age < -60_000) return "the gateway heartbeat is stale (is the gateway running?)";
  if (hb.memberStore !== true) return "the running gateway predates the member store; deploy a build with it, then wait for its heartbeat";
  const held = hb.held[`${tool}/${name}`];
  if (!Object.hasOwn(hb.held, `${tool}/${name}`) || held === undefined) return "the gateway does not hold this account (it is not one of its members)";
  if (!held.lastSuccessAt) return "the gateway holds this account but has not yet renewed it successfully";
  return undefined;
}

/* ------------------------------------------------------------------ member store */

/** The account a login belongs to: claude the `.claude.json` account uuid next to it, codex the token's account id. */
async function accountOf(tool: MemberStoreTool, dir: string, loginText: string): Promise<string | undefined> {
  return loginAccount(tool, loginText, tool === "claude" ? await readText(join(dir, ".claude.json")) : undefined);
}

interface StorePlan {
  refused?: string;
  note?: string;
  /** Set when the folder's login goes into the store: `replacing` an older store copy of the same account, or a new one. */
  write?: { replacing: boolean };
}

/**
 * How the folder's login gets into the member store, the copy the gateway reads from then on (nothing written yet; runs
 * under the account's refresh locks). A store copy already there is the gateway's live login: it is replaced only by a
 * login of the same account that is provably fresher (a fresh sign-in). A different account in the folder is refused (it
 * would move the membership); an older, equally fresh or undatable local login leaves the store copy as it is (a restored
 * or touched folder may hold a refresh token the gateway already spent).
 */
async function planStoreMove(tool: MemberStoreTool, identity: Identity, localText: string, root: string): Promise<StorePlan> {
  const dir = memberDir(tool, identity.name, root);
  const storeText = await readText(join(dir, memberLoginFile(tool)));
  if (!hasMemberCopy(tool, identity.name, root) || storeText === undefined) return { write: { replacing: false } };
  if (storeText === localText) return {};
  const [localAccount, storeAccount] = [await accountOf(tool, identity.configDir, localText), await accountOf(tool, dir, storeText)];
  if (localAccount !== undefined && storeAccount !== undefined && localAccount !== storeAccount) {
    return { refused: "the folder's login is a different account than the gateway's member store copy; nothing changed (sign the folder back into its own account, or give the other account its own identity)" };
  }
  const [localFresh, storeFresh] = [loginFreshness(tool, localText), loginFreshness(tool, storeText)];
  if (localAccount === undefined || storeAccount === undefined) return { note: "could not confirm the folder's login is the same account as the member store copy; kept the store copy" };
  if (localFresh === undefined || storeFresh === undefined || localFresh <= storeFresh) return { note: "the member store copy is as fresh or fresher than the folder's login (the gateway renewed it); kept it" };
  return { write: { replacing: true } };
}

/**
 * Writes the planned store copy: a replaced copy is backed up uniquely first. The login file is written last, durably, and
 * read back: its presence is what makes the gateway switch to the store.
 */
async function writeStoreCopy(tool: MemberStoreTool, identity: Identity, localText: string, root: string, replacing: boolean, now: () => number): Promise<string | undefined> {
  const dir = memberDir(tool, identity.name, root);
  const storePath = join(dir, memberLoginFile(tool));
  if (replacing) {
    const b = await backupUnique(storePath, now);
    await writeAccountRecord(tool, identity, dir);
    await writeFileDurable(storePath, localText);
    await clearLoginRevoked(tool, identity.name, root); // the new login is not the one the gateway found dead
    return `the fresher local login of the same account replaced the member store copy (old copy backed up to ${b})`;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeAccountRecord(tool, identity, dir);
  await writeFileDurable(storePath, localText);
  return undefined;
}

/**
 * Undoes a switch that failed after the store copy was written, so the login has exactly one holder again: the folder gets
 * its login back (when it changed), then the store copy this run wrote is set aside (renamed, never deleted), so the gateway
 * reads the folder as before. When the folder cannot be restored the store copy stays active: it is then the only holder.
 */
async function rollBack(tool: MemberStoreTool, identity: Identity, localText: string, root: string, wroteStore: boolean, now: () => number): Promise<string> {
  const loginPath = join(identity.configDir, memberLoginFile(tool));
  try {
    if ((await readText(loginPath)) !== localText) await writeFileDurable(loginPath, localText);
  } catch (err) {
    return `rollback could not restore the folder's login (${(err as NodeJS.ErrnoException).code ?? "error"}); the gateway keeps the login in its member store, the folder's own copy is in its .pre-gateway backup`;
  }
  if (!wroteStore) return "rolled back: the folder holds its login again";
  const storePath = join(memberDir(tool, identity.name, root), memberLoginFile(tool));
  const aside = `${storePath}.rolled-back.${new Date(now()).toISOString().replace(/[:.]/g, "-")}.bak`;
  try {
    await rename(storePath, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "rolled back: the folder holds its login again";
    return `rollback restored the folder's login but could not set the member store copy aside (${(err as NodeJS.ErrnoException).code ?? "error"}): both hold the login now; move ${storePath} away by hand before the gateway or a session refreshes it`;
  }
  return `rolled back: the folder holds its login again and the gateway reads it from there (store copy set aside as ${aside})`;
}

/** claude: only the account record of `.claude.json` (swap logic compares its uuid); the rest is large, local and changes constantly. */
async function writeAccountRecord(tool: MemberStoreTool, identity: Identity, dir: string): Promise<void> {
  if (tool !== "claude") return;
  const account = parseJson(await readText(join(identity.configDir, ".claude.json")))?.oauthAccount;
  if (account !== undefined) await writeFileDurable(join(dir, ".claude.json"), `${JSON.stringify({ oauthAccount: account })}\n`);
}

/* ------------------------------------------------------------------ running sessions */

const scanOpts = (opts: RouteAllOptions) => ({ ...(opts.procRoot ? { procRoot: opts.procRoot } : {}), ...(opts.home ? { home: opts.home } : {}) });
const LABEL_OF: Record<SessionTool, string> = { claude: "Claude Code", codex: "Codex", pi: "pi" };
const sessionsText = (tool: SessionTool, pids: number[]): string => `${pids.length} running ${LABEL_OF[tool]} session${pids.length === 1 ? "" : "s"} (pid ${pids.join(", ")})`;

/** Running sessions of `tool` in `dir` (null: any folder), or the refusal when the scan cannot run (no /proc, hidepid). */
async function sessionsIn(tool: SessionTool, dir: string | null, opts: RouteAllOptions): Promise<{ pids: number[]; unavailable?: string }> {
  return scanLiveSessions(tool, dir, scanOpts(opts));
}

/** Why running sessions block the switch, or undefined when none use the folder. A scan that cannot run refuses too. */
async function sessionsProblem(tool: MemberStoreTool, dir: string, opts: RouteAllOptions): Promise<string | undefined> {
  const scan = await sessionsIn(tool, dir, opts);
  if (scan.unavailable) return `${scan.unavailable}; a running session would later refresh the refresh token the gateway takes over, so nothing changed (run this on Linux with a readable /proc)`;
  const pids = scan.pids;
  if (pids.length === 0) return undefined;
  const writeBack = tool === "codex" ? " and write that login back over the gateway entry" : "";
  return `${pids.length} running ${LABEL_OF[tool]} session${pids.length === 1 ? "" : "s"} use${pids.length === 1 ? "s" : ""} this folder (pid ${pids.join(", ")}): a session started before the switch keeps the old login in memory and would later refresh it with the refresh token the gateway now owns, killing the gateway's copy${writeBack}; end ${pids.length === 1 ? "it" : "them"}, then run this again`;
}

/* ------------------------------------------------------------------ other holders of the login */


/** pi's auth.json provider that holds its copy of each tool's login (oauth-reconcile.ts pairs them by identity name). */
const PI_PROVIDER_OF: Record<MemberStoreTool, string> = { claude: "anthropic", codex: "openai-codex" };

/** A pi auth.json entry this run removes: pi's own copy of the identity's login. */
interface PiRemoval {
  name: string;
  dir: string;
  path: string;
  provider: string;
  /** The entry's refresh token when analysed: removal is skipped (refused) if it changed since. */
  refresh: string | undefined;
  why: string;
}

interface HoldersOutcome {
  refused?: string;
  piRemovals: PiRemoval[];
}

/**
 * Every other place that holds a copy of this login, which would refresh the single-use refresh token the gateway takes
 * over (and so kill the gateway's copy, `refresh_token_reused`):
 *  - a swap pool folder of the same tool that is not gateway-routed and whose active member is this identity, or whose
 *    login is the same refresh token or account: refused (this command never writes pool folders; every session started
 *    with the pool uses that copy). Swap the pool to another member first, or route the pool;
 *  - pi: the same-named pi identity's `anthropic` / `openai-codex` entry is pi's copy of this login (oauth-reconcile.ts).
 *    pi has no local gateway route, so the entry is removed (after a unique backup) when it is the same refresh token or
 *    provably older than the login the gateway gets; a pi copy that may be fresher (pi refreshed it, so the folder's
 *    token may be spent) is refused: run `ais auth sync --tool=pi` first. A pi swap pool or a differently named pi
 *    identity holding the same refresh token is refused. Removing needs no running pi session at all: one pi instance
 *    reads every pi identity's auth.json.
 */
async function holdersProblem(identity: Identity, ctx: ToolContext, localText: string | undefined): Promise<HoldersOutcome> {
  const { tool, root } = ctx;
  const storeText = hasMemberCopy(tool, identity.name, root) ? await readText(join(memberDir(tool, identity.name, root), memberLoginFile(tool))) : undefined;
  const tokens = new Set([refreshOf(tool, localText), refreshOf(tool, storeText)].filter(nonEmpty));
  const localKind = classifyLogin(tool, localText);
  const account = localKind === "login" ? await accountOf(tool, identity.configDir, localText!) : storeText ? await accountOf(tool, memberDir(tool, identity.name, root), storeText) : undefined;

  for (const pool of ctx.pools) {
    if (ctx.routedPools.has(pool.name) && ctx.opts.dryRun) continue; // this dry run routes the pool first
    const poolText = await readText(join(pool.configDir, memberLoginFile(tool)));
    if (classifyLogin(tool, poolText) !== "login") continue; // gateway-routed or empty: holds no login
    const poolRt = refreshOf(tool, poolText);
    const reason =
      pool.swapPool?.active === identity.name ? "this identity is its active member"
      : poolRt !== undefined && tokens.has(poolRt) ? "it holds the same refresh token"
      : account !== undefined && (await accountOf(tool, pool.configDir, poolText!)) === account ? "it holds the same account"
      : undefined;
    if (!reason) continue;
    const other = pool.swapPool?.accounts.find((a) => a !== identity.name);
    const how = other ? `swap the pool to another member first (ais swap ${tool} to ${other} --pool=${pool.name}), or route the pool itself` : "take this identity out of the pool, or route the pool itself";
    return { refused: `swap pool ${pool.name} holds a copy of this login (${reason}): every session started with that pool would refresh the refresh token the gateway takes over and kill the gateway's copy; nothing changed. ${how[0]!.toUpperCase()}${how.slice(1)}, then run this again`, piRemovals: [] };
  }

  const provider = PI_PROVIDER_OF[tool];
  const fresh = Math.max(...[localKind === "login" ? localText : undefined, storeText].map((t) => (t === undefined ? -1 : (loginFreshness(tool, t) ?? -1))));
  const piRemovals: PiRemoval[] = [];
  for (const pi of ctx.piIdentities) {
    const path = join(pi.configDir, "auth.json");
    let entry;
    try {
      entry = await readPiEntry(path, provider);
    } catch {
      return { refused: `pi identity ${pi.name}: its auth.json could not be read; nothing changed`, piRemovals: [] };
    }
    if (!entry) continue;
    const rt = entry.grant.refresh_token;
    const same = rt !== undefined && tokens.has(rt);
    if (pi.swapPool) {
      if (same || pi.swapPool.active === identity.name) return { refused: `pi swap pool ${pi.name} holds a copy of this login (${same ? "the same refresh token" : "this identity is its active member"}): its sessions would refresh the refresh token the gateway takes over; nothing changed. Swap the pi pool to another member first (ais swap pi to <member> --pool=${pi.name}), then run this again`, piRemovals: [] };
      continue;
    }
    if (pi.name !== identity.name) {
      if (same) return { refused: `pi identity ${pi.name} holds this login's refresh token in its ${provider} entry: pi would refresh the token the gateway takes over; nothing changed. Remove that entry or sign ${pi.name} in to its own account, then run this again`, piRemovals: [] };
      continue;
    }
    // pi's copy: claude compares access-token expiry (ms), codex the last refresh (pi: the token's iat, seconds).
    const piFresh = tool === "claude" ? (entry.grant.expires_at !== undefined ? entry.grant.expires_at * 1000 : undefined) : entry.grant.minted_at;
    const older = piFresh !== undefined && fresh > 0 && piFresh < fresh;
    if (!same && !older) return { refused: `pi identity ${pi.name} holds a different copy of this login (${provider}) that is not provably older than the one the gateway gets: pi may have refreshed it, so that refresh token may already be spent; nothing changed. Run ais auth sync --tool=pi to converge the copies, then run this again`, piRemovals: [] };
    piRemovals.push({ name: pi.name, dir: pi.configDir, path, provider, refresh: rt, why: same ? "the same login" : "an older copy" });
  }
  if (piRemovals.length > 0) {
    const scan = await sessionsIn("pi", null, ctx.opts);
    if (scan.unavailable) return { refused: `${scan.unavailable}; pi's copy of this login must be removed while no pi session runs, so nothing changed`, piRemovals: [] };
    if (scan.pids.length > 0) return { refused: `${sessionsText("pi", scan.pids)} would keep refreshing pi's copy of this login (one pi instance reads every pi identity's auth.json); nothing changed. End ${scan.pids.length === 1 ? "it" : "them"}, then run this again`, piRemovals: [] };
  }
  return { piRemovals };
}

/** Removes pi's copy under pi's own refresh lock (`auth.json.lock`) and AIS's: unique backup first, the rest of auth.json kept. */
async function removePiCopy(r: PiRemoval, now: () => number): Promise<string> {
  return withOauthRefreshLock(r.dir, () =>
    withLockDir(join(r.dir, "auth.json.lock"), 30_000, `pi is refreshing its credentials in ${r.dir}`, async () => {
      const text = await readText(r.path);
      const json = parseJson(text);
      const entry = json?.[r.provider] as { refresh?: unknown } | undefined;
      if (!json || entry === undefined) return `pi identity ${r.name} no longer had a ${r.provider} entry`;
      if ((nonEmpty(entry.refresh) ? entry.refresh : undefined) !== r.refresh) throw new PiChanged(r.name);
      const b = await backupUnique(r.path, now);
      delete json[r.provider];
      await writeFileDurable(r.path, `${JSON.stringify(json, null, 2)}\n`);
      return `pi identity ${r.name}: removed its ${r.provider} entry (${r.why}; backed up to ${b}); pi has no gateway route yet, so pi sessions of ${r.name} have no ${r.provider} login until it does`;
    }),
  );
}

class PiChanged extends Error {
  constructor(name: string) {
    super(`pi identity ${name}'s copy of this login changed while this run waited; run this again`);
  }
}

/* ------------------------------------------------------------------ gateway entries */

async function readKey(app: string, opts: RouteAllOptions): Promise<string | undefined> {
  const token = await readSecretsKey(appTokenKey(app), opts.secretsPath ?? defaultSecretsPath());
  return token && token.startsWith(GATEWAY_TOKEN_PREFIX) ? token : undefined;
}

const gatewayBase = (tool: string, opts: RouteAllOptions): string => `http://127.0.0.1:${opts.port ?? (Number(process.env.AIS_GATEWAY_LOCAL_PORT) || LOCAL_PORT_DEFAULT)}/${tool}`;

/* claude */

async function claudeRouted(dir: string, token: string, base: string): Promise<{ entry: boolean; settings: boolean; helper: boolean }> {
  const settings = parseJson(await readText(join(dir, "settings.json")));
  const env = settings?.env as Record<string, unknown> | undefined;
  const oauth = parseJson(await readText(join(dir, ".credentials.json")))?.claudeAiOauth as { accessToken?: unknown; refreshToken?: unknown } | undefined;
  return {
    entry: oauth?.accessToken === token && !nonEmpty(oauth?.refreshToken),
    settings: env?.ANTHROPIC_BASE_URL === base,
    helper: !(settings && "apiKeyHelper" in settings),
  };
}

/** The claude gateway entry text with the routing record (see gateway-routed.ts). */
const claudeEntryText = async (dir: string, token: string, routing: GatewayRouting): Promise<string> => withRouting(gatewayEntryText(token, await gatewayEntryScopesFor(dir)), routing);

async function applyClaude(dir: string, token: string, base: string, routing: GatewayRouting, now: () => number): Promise<string[]> {
  const notes: string[] = [];
  const state = await claudeRouted(dir, token, base);
  if (!state.entry) {
    const b = await backupUnique(join(dir, ".credentials.json"), now);
    if (b) notes.push(`login backed up to ${b}`);
    await writeFileAtomic(join(dir, ".credentials.json"), await claudeEntryText(dir, token, routing));
  }
  if (!state.settings || !state.helper) {
    const path = join(dir, "settings.json");
    const settings = parseJson(await readText(path)) ?? {};
    const b = await backupUnique(path, now);
    if (b) notes.push(`settings backed up to ${b}`);
    settings.env = { ...((settings.env as Record<string, unknown> | undefined) ?? {}), ANTHROPIC_BASE_URL: base };
    // An apiKeyHelper would take Claude Code out of subscriber mode (see claude-gateway-entry.ts).
    if ("apiKeyHelper" in settings) {
      delete settings.apiKeyHelper;
      notes.push("removed apiKeyHelper");
    }
    await writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return notes;
}

/* codex */

/** Helper the codex model provider runs to print the app key; shared with the hand-made codex-pool setup when present. */
export const codexKeyHelperPath = (home: string): string => join(home, ".local", "bin", "ais-codex-gateway-key");
const codexKeyHelperText = (keyName: string): string =>
  `#!/bin/sh\n# Codex model-provider auth command: prints the AIS gateway token for agent sessions from ~/.secrets.\nexec sed -n 's/^${keyName}=//p' "$HOME/.secrets"\n`;

export function codexConfigRouted(text: string | undefined, base: string, helper: string): boolean {
  if (text === undefined) return false;
  try {
    const cfg = parseToml(text) as { model_provider?: unknown; model_providers?: Record<string, { base_url?: unknown; auth?: { command?: unknown } }> };
    const p = cfg.model_providers?.[CODEX_PROVIDER];
    return cfg.model_provider === CODEX_PROVIDER && p?.base_url === base && p?.auth?.command === helper;
  } catch {
    return false;
  }
}

/** Sets `model_provider` and the provider tables in config.toml text, keeping every other line (comments, other tables) as it was. */
export function routeCodexConfigText(text: string, base: string, helper: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[(.+?)\]\s*(#.*)?$/.exec(line);
    if (header) skipping = header[1] === `model_providers.${CODEX_PROVIDER}` || header[1] === `model_providers.${CODEX_PROVIDER}.auth`;
    if (!skipping) out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  const firstTable = out.findIndex((l) => /^\s*\[/.test(l));
  const topEnd = firstTable === -1 ? out.length : firstTable;
  const existing = out.slice(0, topEnd).findIndex((l) => /^\s*model_provider\s*=/.test(l));
  if (existing !== -1) out[existing] = `model_provider = "${CODEX_PROVIDER}"`;
  else out.unshift(`model_provider = "${CODEX_PROVIDER}"`);
  const tables = [`[model_providers.${CODEX_PROVIDER}]`, 'name = "AIS Gateway"', `base_url = ${JSON.stringify(base)}`, 'wire_api = "responses"', "", `[model_providers.${CODEX_PROVIDER}.auth]`, `command = ${JSON.stringify(helper)}`];
  const result = `${[...out, "", ...tables].join("\n")}\n`;
  if (!codexConfigRouted(result, base, helper)) throw new Error("could not produce a valid routed config.toml");
  return result;
}

const codexEntryText = (token: string, routing: GatewayRouting): string => withRouting(`${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: token })}\n`, routing);

async function applyCodex(dir: string, token: string, base: string, helper: string, routing: GatewayRouting, now: () => number): Promise<string[]> {
  const notes: string[] = [];
  const authPath = join(dir, "auth.json");
  const auth = parseJson(await readText(authPath));
  if (!(auth?.OPENAI_API_KEY === token && auth.tokens === undefined)) {
    const b = await backupUnique(authPath, now);
    if (b) notes.push(`login backed up to ${b}`);
    await writeFileAtomic(authPath, codexEntryText(token, routing));
  }
  const cfgPath = join(dir, "config.toml");
  const cfg = await readText(cfgPath);
  if (!codexConfigRouted(cfg, base, helper)) {
    const b = await backupUnique(cfgPath, now);
    if (b) notes.push(`config backed up to ${b}`);
    await writeFileAtomic(cfgPath, routeCodexConfigText(cfg ?? "", base, helper));
  }
  return notes;
}

async function ensureCodexHelper(path: string): Promise<void> {
  if ((await readText(path)) !== undefined) return; // an existing helper is never overwritten
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, codexKeyHelperText(appTokenKey(LOCAL_GATEWAY_ROUTES.codex!.app)), { mode: 0o755, flag: "wx" });
  await chmod(path, 0o755);
}

async function isRoutedAlready(tool: MemberStoreTool, dir: string, token: string, base: string, helper: string): Promise<boolean> {
  if (tool === "claude") {
    const s = await claudeRouted(dir, token, base);
    return s.entry && s.settings && s.helper;
  }
  const auth = parseJson(await readText(join(dir, "auth.json")));
  return auth?.OPENAI_API_KEY === token && auth.tokens === undefined && codexConfigRouted(await readText(join(dir, "config.toml")), base, helper);
}

/* ------------------------------------------------------------------ the command */

async function accountsOf(tool: RouteTool, opts: RouteAllOptions): Promise<Identity[]> {
  const file = await loadIdentitiesFile(opts.registries?.[tool] ?? REGISTRY_OF[tool]);
  return file.identities.filter((i) => !isRetired(i));
}

interface ToolContext {
  tool: MemberStoreTool;
  token: string;
  base: string;
  helper: string;
  root: string;
  hb: GatewayHeartbeat | undefined;
  opts: RouteAllOptions;
  now: () => number;
  /** Swap pools each identity is a member of (by name). */
  poolsOf: Map<string, string[]>;
  /** The tool's swap pool identities. */
  pools: Identity[];
  /** Live pi identities (pools included): pi keeps its own copy of each identity's claude and codex login. */
  piIdentities: Identity[];
  /** This host's name, for the routing record. */
  host: string;
  /** Pools routed, already routed or (dry run) about to be routed by this run: they hold no member login. */
  routedPools: Set<string>;
  /** Live members of each pool, by pool name. */
  membersOf: Map<string, Identity[]>;
}

/**
 * The routing record written into the gateway entry: fingerprints and freshness of the folder's login (when it holds one)
 * and of the member store copy, so another host can tell its copy of this login from a later sign-in there.
 */
async function routingNow(identity: Identity, ctx: ToolContext, localText: string | undefined): Promise<GatewayRouting> {
  const { tool, root } = ctx;
  const storeDir = memberDir(tool, identity.name, root);
  const storeText = await readText(join(storeDir, memberLoginFile(tool)));
  const folderLogin = classifyLogin(tool, localText) === "login" ? localText : undefined;
  const account = (folderLogin && (await accountOf(tool, identity.configDir, folderLogin))) || (storeText && (await accountOf(tool, storeDir, storeText))) || undefined;
  return routingFor(tool, [folderLogin, storeText], account, ctx.host, ctx.now());
}

async function routeOne(identity: Identity, ctx: ToolContext): Promise<RouteLine> {
  let line: RouteLine;
  try {
    line = await routeOneRaw(identity, ctx);
  } catch (err) {
    if (!(err instanceof PiChanged)) throw err;
    line = { tool: ctx.tool, identity: identity.name, status: "refused", detail: err.message };
  }
  if (identity.swapPool) return line;
  // A routed pool holds no login (the gateway picks its member): only a pool left unrouted is worth a word.
  const unrouted = (ctx.poolsOf.get(identity.name) ?? []).filter((p) => !ctx.routedPools.has(p));
  if (unrouted.length === 0 || (line.status !== "routed" && line.status !== "would-route" && line.status !== "already-routed")) return line;
  const warn = `member of swap pool ${unrouted.join(", ")}, which is not routed: that pool cannot swap to it (its login is the gateway's now) until the pool is routed too (fix what this report says about the pool, then run this again)`;
  return { ...line, detail: line.detail ? `${line.detail}; ${warn}` : warn };
}

async function routeOneRaw(identity: Identity, ctx: ToolContext): Promise<RouteLine> {
  const { tool, token, base, helper, root, opts, now } = ctx;
  const line = { tool, identity: identity.name };
  const dir = identity.configDir;
  if (identity.swapPool) return routePool(identity, ctx);
  if (await isRoutedAlready(tool, dir, token, base, helper)) return alreadyRouted(identity, ctx);
  for (const f of FILES_OF[tool]) {
    if (await isSymlink(join(dir, f))) return { ...line, status: "refused", detail: `${f} is a symlink (shared with other folders?); not written through` };
  }
  const kind = classifyLogin(tool, await readText(join(dir, memberLoginFile(tool))));
  const stored = hasMemberCopy(tool, identity.name, root);
  if (kind === "none" && !stored) return { ...line, status: "refused", detail: "no refreshable login in this folder (logged out, API key or Bedrock); nothing for the gateway to hold" };
  if (kind === "gateway" && !stored) return { ...line, status: "refused", detail: "the folder already holds the gateway entry but the member store has no login for it; restore the login from its .pre-gateway backup first" };
  if (kind === "login" && !(opts.afterLogin && stored)) {
    const problem = heldProblem(tool, identity.name, ctx.hb, now());
    if (problem) return { ...line, status: "refused", detail: problem };
  }
  const busy = await sessionsProblem(tool, dir, opts);
  if (busy) return { ...line, status: "refused", detail: busy };
  const holders = await holdersProblem(identity, ctx, await readText(join(dir, memberLoginFile(tool))));
  if (holders.refused) return { ...line, status: "refused", detail: holders.refused };
  if (opts.dryRun) {
    const pi = holders.piRemovals.map((r) => `; pi identity ${r.name}'s ${r.provider} entry would be removed (backed up)`).join("");
    return { ...line, status: "would-route", detail: `${kind === "login" ? "login would move to the member store, local files backed up, then replaced" : "gateway entry would be completed"}${pi}` };
  }

  const notes: string[] = [];
  let removedPi = false;
  if (kind === "login") {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
  }
  // The gateway refreshes this account under these locks: holding them, the login copied below is the latest one.
  const outcome = await withOauthRefreshLocks([dir, memberDir(tool, identity.name, root)], async () => {
    // A session may have started while this run waited for the locks.
    const busyNow = await sessionsProblem(tool, dir, opts);
    if (busyNow) return busyNow;
    const localText = await readText(join(dir, memberLoginFile(tool)));
    const holdersNow = await holdersProblem(identity, ctx, localText);
    if (holdersNow.refused) return holdersNow.refused;
    const nowKind = classifyLogin(tool, localText);
    const plan = nowKind === "login" ? await planStoreMove(tool, identity, localText!, root) : {};
    if (plan.refused) return plan.refused;
    if (nowKind !== "login" && !hasMemberCopy(tool, identity.name, root)) return "the login disappeared while waiting for the lock; nothing changed";
    // pi's copy goes first: a failure here (PiChanged, EACCES) leaves the store and the folder as they were.
    for (const r of holdersNow.piRemovals) notes.push(await removePiCopy(r, now));
    removedPi = holdersNow.piRemovals.length > 0;
    if (plan.note) notes.push(plan.note);
    // From the store write on, a failure rolls back so the login has exactly one holder (the folder, or else the store).
    let wroteStore = false;
    try {
      if (plan.write) {
        wroteStore = true;
        const note = await writeStoreCopy(tool, identity, localText!, root, plan.write.replacing, now);
        if (note) notes.push(note);
      }
      // Nothing local changes unless the store demonstrably holds a usable login now.
      if (!hasMemberCopy(tool, identity.name, root)) throw Object.assign(new Error("the member store copy could not be confirmed after writing it"), { code: "EVERIFY" });
      if (tool === "codex") await ensureCodexHelper(helper);
      const routing = await routingNow(identity, ctx, localText);
      notes.push(...(tool === "claude" ? await applyClaude(dir, token, base, routing, now) : await applyCodex(dir, token, base, helper, routing, now)));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.name : "error");
      if (nowKind !== "login") return `failed while completing the gateway entry (${code}); the member store still holds the login`;
      return `failed while switching (${code}); ${await rollBack(tool, identity, localText!, root, wroteStore, now)}${removedPi ? `; ${notes.filter((n) => n.startsWith("pi identity")).join("; ")}` : ""}`;
    }
    return undefined;
  });
  if (outcome) return { ...line, status: "refused", detail: outcome };
  // A session that started during the switch (after the check under the locks) holds the old login: report it.
  const late = await lateSessions(tool, dir, removedPi, opts);
  if (late) notes.push(late);
  return { ...line, status: "routed", ...(late ? { attention: true } : {}), ...(notes.length > 0 ? { detail: notes.join("; ") } : {}) };
}

/* ------------------------------------------------------------------ swap pool folders */

/** What happens to the login found in a pool folder (see routePool). */
interface PoolLoginPlan {
  refused?: string;
  /** The member whose login it is. */
  owner?: Identity;
  /** Write the pool's login back over the owner's copy (it is provably fresher): the store copy, or the owner's folder. */
  writeBack?: { path: string; where: "store" | "folder" };
  note?: string;
}

/** The owner's copy a pool login is compared with: the member store copy when the gateway holds the member, else its folder's login. */
async function ownerCopy(tool: MemberStoreTool, member: Identity, root: string): Promise<{ path: string; text: string | undefined; dir: string; where: "store" | "folder" } | undefined> {
  if (hasMemberCopy(tool, member.name, root)) {
    const dir = memberDir(tool, member.name, root);
    const path = join(dir, memberLoginFile(tool));
    return { path, text: await readText(path), dir, where: "store" };
  }
  const path = join(member.configDir, memberLoginFile(tool));
  const text = await readText(path);
  return classifyLogin(tool, text) === "login" ? { path, text, dir: member.configDir, where: "folder" } : undefined;
}

/**
 * Finds the member a pool folder's login belongs to (the same refresh token, else the same account; the active member is
 * tried first) and whether the pool's copy must be written back first: it is when it is provably fresher than the owner's
 * copy (a session in the pool refreshed it), since the owner's own refresh token is then spent.
 */
async function planPoolLogin(pool: Identity, ctx: ToolContext, poolText: string): Promise<PoolLoginPlan> {
  const { tool, root } = ctx;
  const members = [...(ctx.membersOf.get(pool.name) ?? [])].sort((a, b) => Number(b.name === pool.swapPool?.active) - Number(a.name === pool.swapPool?.active));
  const poolRt = refreshOf(tool, poolText);
  const poolAccount = await accountOf(tool, pool.configDir, poolText);
  let owner: { member: Identity; copy: NonNullable<Awaited<ReturnType<typeof ownerCopy>>> } | undefined;
  for (const pass of ["token", "account"] as const) {
    for (const member of members) {
      const copy = await ownerCopy(tool, member, root);
      if (!copy || copy.text === undefined) continue;
      const match = pass === "token" ? poolRt !== undefined && refreshOf(tool, copy.text) === poolRt : poolAccount !== undefined && (await accountOf(tool, copy.dir, copy.text)) === poolAccount;
      if (match) {
        owner = { member, copy };
        break;
      }
    }
    if (owner) break;
  }
  if (!owner) return { note: "the pool's login matches none of its members; kept only in its backup" };
  const { member, copy } = owner;
  if (poolRt !== undefined && refreshOf(tool, copy.text) === poolRt) return { owner: member };
  const [poolFresh, ownerFresh] = [loginFreshness(tool, poolText), loginFreshness(tool, copy.text!)];
  if (poolFresh === undefined || ownerFresh === undefined || poolFresh <= ownerFresh) return { owner: member, note: `the pool's copy of ${member.name}'s login is not fresher than ${copy.where === "store" ? "the member store copy" : "the member's own"}; kept that one` };
  return { owner: member, writeBack: { path: copy.path, where: copy.where } };
}

/**
 * Routes a swap pool folder (see the module comment): the gateway must hold one of its members, no session may run in it,
 * then, under the pool lock and the refresh locks (pool folder first, then the owner's folder and store copy, as refresh
 * and swap take them), a fresher pool login goes back to its owner and the folder gets the gateway entry.
 */
async function routePool(pool: Identity, ctx: ToolContext): Promise<RouteLine> {
  const { tool, token, base, helper, root, opts, now } = ctx;
  const line = { tool, identity: pool.name };
  const dir = pool.configDir;
  // A pool whose login file already holds a gateway entry is routed, in whichever form it was set up (this command's, or
  // `ais gateway codex-home`'s placeholder login with chatgpt_base_url): never rewrite it into this command's form.
  const loginFile = join(dir, memberLoginFile(tool));
  if (await isRoutedAlready(tool, dir, token, base, helper) || classifyLogin(tool, await readText(loginFile)) === "gateway") {
    ctx.routedPools.add(pool.name);
    return { ...line, status: "already-routed" };
  }
  for (const f of FILES_OF[tool]) {
    if (await isSymlink(join(dir, f))) return { ...line, status: "refused", detail: `${f} is a symlink (shared with other folders?); not written through` };
  }
  const members = ctx.membersOf.get(pool.name) ?? [];
  const problems = members.map((m) => heldProblem(tool, m.name, ctx.hb, now()));
  if (!problems.some((p) => p === undefined)) {
    return { ...line, status: "refused", detail: `swap pool folder: the gateway holds none of its members (${members.length === 0 ? "the pool has no members" : `${members[0]!.name}: ${problems[0]}`}), so its sessions would get no account; nothing changed` };
  }
  const busy = await sessionsProblem(tool, dir, opts);
  if (busy) return { ...line, status: "refused", detail: busy };
  const loginPath = join(dir, memberLoginFile(tool));
  const firstText = await readText(loginPath);
  const firstPlan = classifyLogin(tool, firstText) === "login" ? await planPoolLogin(pool, ctx, firstText!) : {};
  if (firstPlan.refused) return { ...line, status: "refused", detail: firstPlan.refused };
  if (opts.dryRun) {
    ctx.routedPools.add(pool.name);
    const wb = firstPlan.writeBack ? `; its fresher login would go back to ${firstPlan.owner!.name} (${firstPlan.writeBack.where === "store" ? "member store copy" : "its folder"})` : "";
    return { ...line, status: "would-route", detail: `swap pool folder would get the gateway entry (local files backed up); the gateway then picks its member${wb}${firstPlan.note ? `; ${firstPlan.note}` : ""}` };
  }

  const notes: string[] = [];
  const ownerDirs = firstPlan.owner ? [firstPlan.owner.configDir, memberDir(tool, firstPlan.owner.name, root)] : [];
  const outcome = await withPoolLock(dir, () =>
    withOauthRefreshLock(dir, () =>
      withOauthRefreshLocks(ownerDirs, async () => {
        const busyNow = await sessionsProblem(tool, dir, opts);
        if (busyNow) return busyNow;
        const poolText = await readText(loginPath);
        const kind = classifyLogin(tool, poolText);
        const plan = kind === "login" ? await planPoolLogin(pool, ctx, poolText!) : {};
        if (plan.refused) return plan.refused;
        if (plan.owner && plan.owner.name !== firstPlan.owner?.name) return "the pool's login changed owner while this run waited for the locks; nothing changed, run this again";
        // Restores the owner's old copy if the entry never made it into the pool folder: the pool then keeps the only copy
        // of its fresher login, as before this run, instead of the pool and the owner both holding it.
        let undoWriteBack: (() => Promise<void>) | undefined;
        try {
          if (plan.writeBack) {
            const target = plan.writeBack.path;
            const previous = await readText(target);
            const b = await backupUnique(target, now);
            await writeFileDurable(target, poolText!);
            undoWriteBack = async () => {
              if (previous !== undefined) await writeFileDurable(target, previous);
            };
            notes.push(`the pool's fresher copy of ${plan.owner!.name}'s login went back to ${plan.writeBack.where === "store" ? "the member store" : "its folder"} (old copy backed up to ${b})`);
          }
          if (plan.note) notes.push(plan.note);
          if (tool === "codex") await ensureCodexHelper(helper);
          const account = kind === "login" ? await accountOf(tool, dir, poolText!) : undefined;
          const routing = routingFor(tool, [kind === "login" ? poolText : undefined], account, ctx.host, now());
          notes.push(...(tool === "claude" ? await applyClaude(dir, token, base, routing, now) : await applyCodex(dir, token, base, helper, routing, now)));
        } catch (err) {
          const entryIn = classifyLogin(tool, await readText(loginPath)) === "gateway";
          if (undoWriteBack && !entryIn) {
            await undoWriteBack().catch(() => undefined);
            notes.push("the pool's login stayed in the pool; the owner's old copy was put back");
          }
          return `failed while routing the pool folder (${(err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.name : "error")}); ${notes.length > 0 ? `done so far: ${notes.join("; ")}` : "nothing changed"}`;
        }
        return undefined;
      }),
    ),
  );
  if (outcome) return { ...line, status: "refused", detail: outcome };
  ctx.routedPools.add(pool.name);
  notes.push("the gateway now picks this pool's member per request; ais swap records the active member only");
  const late = await lateSessions(tool, dir, false, opts);
  if (late) notes.push(late);
  return { ...line, status: "routed", ...(late ? { attention: true } : {}), detail: notes.join("; ") };
}

/**
 * An identity routed before still must have no other holder: a swap pool or pi copy that appeared since (or that an older
 * build left) is reported with attention (exit code 1); pi's same-named copy is removed as on a first run.
 */
async function alreadyRouted(identity: Identity, ctx: ToolContext): Promise<RouteLine> {
  const { tool, root, opts, now } = ctx;
  const line = { tool, identity: identity.name, status: "already-routed" as const };
  const notes: string[] = hasMemberCopy(tool, identity.name, root) ? [] : ["the gateway member store holds no login for it"];
  const loginPath = join(identity.configDir, memberLoginFile(tool));
  const holders = await holdersProblem(identity, ctx, await readText(loginPath));
  const done = (attention: boolean): RouteLine => ({ ...line, ...(attention ? { attention: true } : {}), ...(notes.length > 0 ? { detail: notes.join("; ") } : {}) });
  if (holders.refused) {
    notes.push(`but ${holders.refused}`);
    return done(true);
  }
  // An entry written before the routing record existed gets one, so other hosts can tell a fresh sign-in from this login.
  const needsRecord = hasMemberCopy(tool, identity.name, root) && routingOf(await readText(loginPath)) === undefined;
  if (holders.piRemovals.length === 0 && !needsRecord) return done(false);
  if (opts.dryRun) {
    if (needsRecord) notes.push("the gateway entry would get its routing record");
    notes.push(...holders.piRemovals.map((r) => `pi identity ${r.name}'s ${r.provider} entry would be removed (backed up)`));
    return done(false);
  }
  const problem = await withOauthRefreshLocks([identity.configDir, memberDir(tool, identity.name, root)], async () => {
    const entryText = await readText(loginPath);
    const again = await holdersProblem(identity, ctx, entryText);
    if (again.refused) return again.refused;
    for (const r of again.piRemovals) notes.push(await removePiCopy(r, now));
    if (needsRecord && entryText !== undefined && routingOf(entryText) === undefined && classifyLogin(tool, entryText) === "gateway") {
      await writeFileAtomic(loginPath, withRouting(entryText, await routingNow(identity, ctx, undefined)));
      notes.push("added the routing record to the gateway entry");
    }
    return undefined;
  });
  if (problem) notes.push(`but ${problem}`);
  return done(problem !== undefined);
}

/** Sessions found right after the switch (folder, and any pi session when pi's copy was removed), as a warning. */
async function lateSessions(tool: MemberStoreTool, dir: string, pi: boolean, opts: RouteAllOptions): Promise<string | undefined> {
  const found: string[] = [];
  const own = await sessionsIn(tool, dir, opts);
  if (own.pids.length > 0) found.push(sessionsText(tool, own.pids));
  if (pi) {
    const p = await sessionsIn("pi", null, opts);
    if (p.pids.length > 0) found.push(sessionsText("pi", p.pids));
  }
  if (found.length === 0) return undefined;
  return `WARNING: ${found.join(" and ")} found right after the switch: one started during it may hold the old login; end them now and start them again, before one refreshes the token the gateway took over`;
}

export async function routeAllViaGateway(opts: RouteAllOptions = {}): Promise<RouteReport> {
  // In a gateway process the registry points at the member store; routing from there would rewrite the store itself.
  if (memberStoreEnabled()) throw new Error("route-all-via-gateway runs from the host CLI, never from a gateway process");
  const root = opts.memberRoot ?? memberStoreRoot();
  const now = opts.now ?? Date.now;
  const lines: RouteLine[] = [];
  const unroutedTools: RouteReport["unroutedTools"] = [];
  const hb = await readHeartbeat(opts.heartbeatPath);
  const helper = codexKeyHelperPath(opts.home ?? homedir());
  for (const tool of ROUTE_TOOLS) {
    if (opts.only && opts.only.tool !== tool) continue;
    const accounts = await accountsOf(tool, opts);
    const route = LOCAL_GATEWAY_ROUTES[tool];
    if (!route || !isMemberStoreTool(tool)) {
      const names = accounts.map((a) => a.name).join(", ");
      unroutedTools.push({ tool, reason: `the local gateway has no /${tool} route; left as they are: ${names || "(no identities)"}` });
      continue;
    }
    const token = await readKey(route.app, opts);
    if (!token) {
      unroutedTools.push({ tool, reason: `no ${appTokenKey(route.app)} (aisg_ key) in the secrets file; run: ais gateway app add ${route.app} ...` });
      continue;
    }
    const poolsOf = new Map<string, string[]>();
    for (const pool of accounts) {
      for (const member of pool.swapPool?.accounts ?? []) poolsOf.set(member, [...(poolsOf.get(member) ?? []), pool.name]);
    }
    const pools = accounts.filter((a) => a.swapPool);
    const membersOf = new Map(pools.map((p) => [p.name, (p.swapPool?.accounts ?? []).map((n) => accounts.find((a) => a.name === n && !a.swapPool)).filter((a): a is Identity => a !== undefined)]));
    const ctx: ToolContext = { tool, token, base: gatewayBase(tool, opts), helper, root, hb, opts, now, poolsOf, pools, piIdentities: await accountsOf("pi", opts), host: opts.hostname ?? hostname(), routedPools: new Set(), membersOf };
    // Pools first: a routed pool no longer holds its members' logins, so they can be routed in the same run.
    for (const identity of [...pools, ...accounts.filter((a) => !a.swapPool)]) {
      if (opts.only && opts.only.identity !== identity.name) continue;
      try {
        lines.push(await routeOne(identity, ctx));
      } catch (err) {
        lines.push({ tool, identity: identity.name, status: "refused", detail: `failed: ${(err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.name : "error")}` });
      }
    }
  }
  const syncRemotes = await loadSyncConfig(opts.syncConfigPath ?? syncConfigPath(process.env, opts.home ?? homedir())).then(
    (c) => c.remotes,
    () => undefined,
  );
  return { lines, unroutedTools, incomplete: unroutedTools.length > 0 || lines.some((l) => l.status === "refused" || l.attention === true), syncRemotes };
}

/**
 * The warning for hosts this one syncs with. Their copies of a routed login cannot be checked from here: a session there
 * that started before the gateway entry arrived keeps the old login in memory, and its next refresh spends the refresh
 * token the gateway renews. Sync carries the gateway entry there and never copies a login back (sync/gateway-guard.ts).
 */
export function syncWarning(report: RouteReport): string[] {
  const touched = report.lines.filter((l) => l.status === "routed" || l.status === "would-route").map((l) => `${l.tool}/${l.identity}`);
  if (touched.length === 0) return [];
  if (report.syncRemotes === undefined) {
    return [`WARNING: the AIS sync config could not be read, so this run cannot tell which hosts sync ${touched.join(", ")}; on every host that syncs with this one, stop their Claude Code, Codex and pi sessions first (see docs/agents/gateway.md)`];
  }
  if (report.syncRemotes.length === 0) return [];
  return [
    `WARNING: AIS sync copies the folders of ${touched.join(", ")} to ${report.syncRemotes.join(", ")}.`,
    `  Before routing, stop every Claude Code, Codex and pi session of these identities on ${report.syncRemotes.length === 1 ? "that host" : "those hosts"}: this run cannot see them, and one that keeps the old login in memory spends the gateway's refresh token at its next refresh (refresh_token_reused).`,
    "  The next sync gives their folders the gateway entry (their copy of the login is backed up under ~/.ais/gateway-replaced), strips pi's copy there, and never copies their login back here; every synced host must run an AIS build with this sync guard.",
    `  These identities then STOP WORKING on ${report.syncRemotes.length === 1 ? "that host" : "those hosts"}: the gateway there has no copy of the login. To use one there again, sign in again on that host (/login, codex login); sync keeps that new sign-in.`,
  ];
}

/* ------------------------------------------------------------------ output */

export function formatReport(report: RouteReport, title: string): string[] {
  const out: string[] = [title];
  for (const l of report.lines) out.push(`  ${l.tool}/${l.identity}: ${l.status}${l.detail ? ` (${l.detail})` : ""}`);
  for (const t of report.unroutedTools) out.push(`  ${t.tool}: NOT ROUTED, ${t.reason}`);
  out.push(...syncWarning(report));
  const count = (s: RouteStatus): number => report.lines.filter((l) => l.status === s).length;
  out.push(`summary: ${report.lines.length} identities; routed ${count("routed")}, would route ${count("would-route")}, already routed ${count("already-routed")}, refused ${count("refused")}; tools without a route ${report.unroutedTools.length}`);
  return out;
}

/** CLI entry: prints the report and sets a non-zero exit code when anything was refused or left unrouted. */
export async function runRouteAllViaGateway(flags: Record<string, string | true>, opts: RouteAllOptions = {}): Promise<void> {
  const merged: RouteAllOptions = { dryRun: flags["dry-run"] === true || flags["dry-run"] === "true", ...opts };
  const out = merged.out ?? ((line: string) => console.info(line));
  const report = await routeAllViaGateway(merged);
  for (const line of formatReport(report, `route identities via the gateway${merged.dryRun ? " (dry run: nothing written)" : ""}`)) out(line);
  if (report.incomplete) process.exitCode = 1;
}
