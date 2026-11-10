import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { LOCAL_GATEWAY_ROUTES } from "../../gateway/local-routes.ts";
import { GATEWAY_TOKEN_PREFIX, isGatewayAccessToken, writeGatewayEntry } from "../../identities/claude-gateway-entry.ts";
import { withOauthRefreshLocks } from "../../identities/claude-swap-lock.ts";
import { HEARTBEAT_FRESH_MS, readHeartbeat, type GatewayHeartbeat } from "../../identities/gateway-heartbeat.ts";
import { codexAccountOf, codexRecency, parseCodexAuth } from "../../identities/codex-auth.ts";
import { hasMemberCopy, isMemberStoreTool, memberDir, memberLoginFile, memberStoreEnabled, memberStoreRoot, type MemberStoreTool } from "../../identities/gateway-members.ts";
import { liveSessionPids } from "../../identities/live-sessions.ts";
import { createFileDurable, writeFileAtomic, writeFileDurable } from "../../identities/pool/fs.ts";
import { isRetired } from "../../identities/retired.ts";
import { loadIdentitiesFile } from "../../identities/store.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG, GROK_CONFIG, KIMI_CONFIG, PI_CONFIG } from "../../identities/tool-configs.ts";
import type { Identity } from "../../identities/types.ts";
import { appTokenKey, defaultSecretsPath, readSecretsKey } from "../gateway/secrets-file.ts";

/**
 * `ais identities route-all-via-gateway [--dry-run]`: points every local agent identity at the AIS gateway.
 *
 * Per identity, under the account's refresh lock (the lock the gateway takes before it refreshes the login):
 *   1. the gateway must demonstrably hold the account: a fresh heartbeat from a gateway built with the member store names
 *      it with a successful renewal;
 *   2. no running session may use the folder: a Claude Code or Codex session started before the switch keeps the old login
 *      in memory and later refreshes it with the single-use refresh token the gateway now renews, which kills the gateway's
 *      copy (`refresh_token_reused`); Codex also writes that login back over the gateway entry. Checked before and again
 *      under the locks;
 *   3. the login moves into the gateway's own member store (gateway-members.ts), so the gateway keeps the account after
 *      the local file changes. The store copy is written durably (flushed, renamed, folder flushed) and read back before
 *      anything local changes. A store copy already there is replaced only by a fresher login of the same account;
 *   4. each local file about to change is copied to a unique `<file>.pre-gateway.<timestamp>.bak` (never overwritten,
 *      never deleted, flushed and read back), then the gateway entry is written: the base URL of the local gateway route
 *      and the app's `aisg_` key.
 *
 * Refused and reported, nothing written: a tool with no local gateway route (grok, kimi, pi today) or no key, an account the
 * gateway does not hold, a folder with running sessions, a folder whose login is a different account than its store copy,
 * a folder with no refreshable login, a swap pool folder that is not routed yet (a pool folder holds a copy of a member's
 * login, and this command never writes one), and any file that is a symlink. A swap pool swaps by copying a member's login
 * out of the member's folder, so once its members are routed the pool's swaps no longer get a working login (codex: "no
 * usable Codex login") until the pool is routed with its own setup; the report says so for each routed pool member.
 * Re-running changes nothing for an identity already routed.
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
  now?: () => number;
  out?: (line: string) => void;
}

export type RouteStatus = "routed" | "already-routed" | "would-route" | "refused";

export interface RouteLine {
  tool: string;
  identity: string;
  status: RouteStatus;
  detail?: string;
}

export interface RouteReport {
  lines: RouteLine[];
  /** Tools reported as having no gateway route or no key (identities untouched). */
  unroutedTools: Array<{ tool: string; reason: string }>;
  /** True when anything was refused or any tool is unrouted: the caller should exit non-zero. */
  incomplete: boolean;
}

/* ------------------------------------------------------------------ login files */

type LoginKind = "login" | "gateway" | "none";

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

/** What a folder's login file holds: a real refreshable login, the gateway entry, or neither (logged out, API key, Bedrock). */
export function classifyLogin(tool: MemberStoreTool, text: string | undefined): LoginKind {
  const json = parseJson(text);
  if (!json) return "none";
  if (tool === "claude") {
    const oauth = json.claudeAiOauth as { accessToken?: unknown; refreshToken?: unknown } | undefined;
    if (isGatewayAccessToken(oauth?.accessToken)) return "gateway";
    return nonEmpty(oauth?.accessToken) && nonEmpty(oauth?.refreshToken) ? "login" : "none";
  }
  if (isGatewayAccessToken(json.OPENAI_API_KEY)) return "gateway";
  const tokens = json.tokens as { access_token?: unknown; refresh_token?: unknown } | undefined;
  return nonEmpty(tokens?.access_token) && nonEmpty(tokens?.refresh_token) ? "login" : "none";
}

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

/**
 * `<file>.pre-gateway.<timestamp>[-n].bak`, created exclusively with mode 0600, flushed to disk and read back: an existing
 * backup is never overwritten or removed.
 */
export async function backupUnique(path: string, now: () => number = Date.now): Promise<string | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  for (let n = 0; ; n++) {
    const target = `${path}.pre-gateway.${stamp}${n === 0 ? "" : `-${n}`}.bak`;
    try {
      await createFileDurable(target, text);
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 1000) throw err;
    }
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
  if (tool === "codex") return codexAccountOf(parseCodexAuth(loginText)).id;
  const account = parseJson(await readText(join(dir, ".claude.json")))?.oauthAccount as { accountUuid?: unknown } | undefined;
  return nonEmpty(account?.accountUuid) ? account.accountUuid : undefined;
}

/** How fresh a login is (larger is fresher), or undefined: claude its access token expiry, codex its last refresh. */
export function loginFreshness(tool: MemberStoreTool, text: string): number | undefined {
  if (tool === "codex") {
    const at = codexRecency(parseCodexAuth(text));
    return at > 0 ? at : undefined;
  }
  const expiresAt = (parseJson(text)?.claudeAiOauth as { expiresAt?: unknown } | undefined)?.expiresAt;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : undefined;
}

interface StoreOutcome {
  refused?: string;
  note?: string;
}

/**
 * Puts the folder's login into the member store, the copy the gateway reads from then on. Runs under the account's refresh
 * locks. A store copy already there is the gateway's live login: it is replaced only by a login of the same account that is
 * provably fresher (a fresh sign-in), after a unique backup. A different account in the folder is refused (it would move the
 * membership); an older, equally fresh or undatable local login leaves the store copy as it is (a restored or touched folder
 * may hold a refresh token the gateway already spent). The login file is written last, durably, and read back: its presence
 * is what makes the gateway switch to the store.
 */
async function moveLoginToStore(tool: MemberStoreTool, identity: Identity, localText: string, root: string, now: () => number): Promise<StoreOutcome> {
  const dir = memberDir(tool, identity.name, root);
  const storePath = join(dir, memberLoginFile(tool));
  const storeText = await readText(storePath);
  if (hasMemberCopy(tool, identity.name, root) && storeText !== undefined) {
    if (storeText === localText) return {};
    const [localAccount, storeAccount] = [await accountOf(tool, identity.configDir, localText), await accountOf(tool, dir, storeText)];
    if (localAccount !== undefined && storeAccount !== undefined && localAccount !== storeAccount) {
      return { refused: "the folder's login is a different account than the gateway's member store copy; nothing changed (sign the folder back into its own account, or give the other account its own identity)" };
    }
    const [localFresh, storeFresh] = [loginFreshness(tool, localText), loginFreshness(tool, storeText)];
    if (localAccount === undefined || storeAccount === undefined) return { note: "could not confirm the folder's login is the same account as the member store copy; kept the store copy" };
    if (localFresh === undefined || storeFresh === undefined || localFresh <= storeFresh) return { note: "the member store copy is as fresh or fresher than the folder's login (the gateway renewed it); kept it" };
    const b = await backupUnique(storePath, now);
    await writeAccountRecord(tool, identity, dir);
    await writeFileDurable(storePath, localText);
    return { note: `the fresher local login of the same account replaced the member store copy (old copy backed up to ${b})` };
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeAccountRecord(tool, identity, dir);
  await writeFileDurable(storePath, localText);
  return {};
}

/** claude: only the account record of `.claude.json` (swap logic compares its uuid); the rest is large, local and changes constantly. */
async function writeAccountRecord(tool: MemberStoreTool, identity: Identity, dir: string): Promise<void> {
  if (tool !== "claude") return;
  const account = parseJson(await readText(join(identity.configDir, ".claude.json")))?.oauthAccount;
  if (account !== undefined) await writeFileDurable(join(dir, ".claude.json"), `${JSON.stringify({ oauthAccount: account })}\n`);
}

/* ------------------------------------------------------------------ running sessions */

/** Why running sessions block the switch, or undefined when none use the folder. */
async function sessionsProblem(tool: MemberStoreTool, dir: string, opts: RouteAllOptions): Promise<string | undefined> {
  const pids = await liveSessionPids(tool, dir, { ...(opts.procRoot ? { procRoot: opts.procRoot } : {}), ...(opts.home ? { home: opts.home } : {}) });
  if (pids.length === 0) return undefined;
  const label = tool === "claude" ? "Claude Code" : "Codex";
  const writeBack = tool === "codex" ? " and write that login back over the gateway entry" : "";
  return `${pids.length} running ${label} session${pids.length === 1 ? "" : "s"} use${pids.length === 1 ? "s" : ""} this folder (pid ${pids.join(", ")}): a session started before the switch keeps the old login in memory and would later refresh it with the refresh token the gateway now owns, killing the gateway's copy${writeBack}; end ${pids.length === 1 ? "it" : "them"}, then run this again`;
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

async function applyClaude(dir: string, token: string, base: string, now: () => number): Promise<string[]> {
  const notes: string[] = [];
  const state = await claudeRouted(dir, token, base);
  if (!state.entry) {
    const b = await backupUnique(join(dir, ".credentials.json"), now);
    if (b) notes.push(`login backed up to ${b}`);
    await writeGatewayEntry(dir, token);
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

const codexEntryText = (token: string): string => `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: token })}\n`;

async function applyCodex(dir: string, token: string, base: string, helper: string, now: () => number): Promise<string[]> {
  const notes: string[] = [];
  const authPath = join(dir, "auth.json");
  const auth = parseJson(await readText(authPath));
  if (!(auth?.OPENAI_API_KEY === token && auth.tokens === undefined)) {
    const b = await backupUnique(authPath, now);
    if (b) notes.push(`login backed up to ${b}`);
    await writeFileAtomic(authPath, codexEntryText(token));
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
}

async function routeOne(identity: Identity, ctx: ToolContext): Promise<RouteLine> {
  const line = await routeOneRaw(identity, ctx);
  const pools = ctx.poolsOf.get(identity.name);
  if (!pools || (line.status !== "routed" && line.status !== "would-route" && line.status !== "already-routed")) return line;
  const warn = `member of swap pool ${pools.join(", ")}: the pool swaps by copying this folder's login, which is now the gateway entry, so swaps to it no longer get a working login (codex: "no usable Codex login") until the pool is routed with its own setup`;
  return { ...line, detail: line.detail ? `${line.detail}; ${warn}` : warn };
}

async function routeOneRaw(identity: Identity, ctx: ToolContext): Promise<RouteLine> {
  const { tool, token, base, helper, root, opts, now } = ctx;
  const line = { tool, identity: identity.name };
  const dir = identity.configDir;
  if (await isRoutedAlready(tool, dir, token, base, helper)) {
    const lost = !identity.swapPool && !hasMemberCopy(tool, identity.name, root);
    return { ...line, status: "already-routed", ...(lost ? { detail: "the gateway member store holds no login for it" } : {}) };
  }
  if (identity.swapPool) {
    return { ...line, status: "refused", detail: "swap pool folder: it holds a copy of a member's login and this command never writes one; once its members are routed, swaps to them no longer get a working login (codex: \"no usable Codex login\") until the pool is routed with its own setup" };
  }
  for (const f of FILES_OF[tool]) {
    if (await isSymlink(join(dir, f))) return { ...line, status: "refused", detail: `${f} is a symlink (shared with other folders?); not written through` };
  }
  const kind = classifyLogin(tool, await readText(join(dir, memberLoginFile(tool))));
  const stored = hasMemberCopy(tool, identity.name, root);
  if (kind === "none" && !stored) return { ...line, status: "refused", detail: "no refreshable login in this folder (logged out, API key or Bedrock); nothing for the gateway to hold" };
  if (kind === "gateway" && !stored) return { ...line, status: "refused", detail: "the folder already holds the gateway entry but the member store has no login for it; restore the login from its .pre-gateway backup first" };
  if (kind === "login") {
    const problem = heldProblem(tool, identity.name, ctx.hb, now());
    if (problem) return { ...line, status: "refused", detail: problem };
  }
  const busy = await sessionsProblem(tool, dir, opts);
  if (busy) return { ...line, status: "refused", detail: busy };
  if (opts.dryRun) return { ...line, status: "would-route", detail: kind === "login" ? "login would move to the member store, local files backed up, then replaced" : "gateway entry would be completed" };

  const notes: string[] = [];
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
    const nowKind = classifyLogin(tool, localText);
    if (nowKind === "login") {
      const moved = await moveLoginToStore(tool, identity, localText!, root, now);
      if (moved.refused) return moved.refused;
      if (moved.note) notes.push(moved.note);
    }
    // Nothing local changes unless the store demonstrably holds a usable login now.
    if (!hasMemberCopy(tool, identity.name, root)) {
      return nowKind === "login" ? "the member store copy could not be confirmed after writing it; nothing local changed" : "the login disappeared while waiting for the lock; nothing changed";
    }
    if (tool === "codex") await ensureCodexHelper(helper);
    notes.push(...(tool === "claude" ? await applyClaude(dir, token, base, now) : await applyCodex(dir, token, base, helper, now)));
    return undefined;
  });
  if (outcome) return { ...line, status: "refused", detail: outcome };
  return { ...line, status: "routed", ...(notes.length > 0 ? { detail: notes.join("; ") } : {}) };
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
    const ctx: ToolContext = { tool, token, base: gatewayBase(tool, opts), helper, root, hb, opts, now, poolsOf };
    for (const identity of accounts) {
      try {
        lines.push(await routeOne(identity, ctx));
      } catch (err) {
        lines.push({ tool, identity: identity.name, status: "refused", detail: `failed: ${(err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.name : "error")}` });
      }
    }
  }
  return { lines, unroutedTools, incomplete: unroutedTools.length > 0 || lines.some((l) => l.status === "refused") };
}

/* ------------------------------------------------------------------ output */

export function formatReport(report: RouteReport, title: string): string[] {
  const out: string[] = [title];
  for (const l of report.lines) out.push(`  ${l.tool}/${l.identity}: ${l.status}${l.detail ? ` (${l.detail})` : ""}`);
  for (const t of report.unroutedTools) out.push(`  ${t.tool}: NOT ROUTED, ${t.reason}`);
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
