import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { expandPath } from "../identities/match.ts";
import { allowedAccounts, isSwapPool, type PoolIdentity } from "../identities/pool/swap-pool.ts";
import { isRetired } from "../identities/retired.ts";
import { findIdentityByNameOrAlias } from "../identities/store.ts";
import { t3Paths } from "../identities/t3-anthropic-proxy.ts";
import type { IdentitiesFile, Identity } from "../identities/types.ts";

/** Longest relay call (wait: 120 s) plus margin; the MCP client must not give up first. */
const TOOL_TIMEOUT_SEC = 135;
const TOKEN_FILE = "ais-browser-token";

/** Claude subcommands: a leading --mcp-config would precede them, so they get no wiring. */
const CLAUDE_SUBCOMMANDS = new Set(["mcp", "doctor", "update", "upgrade", "config", "install", "migrate-installer", "setup-token", "plugin", "plugins", "agents", "auth", "api-key", "ultrareview"]);

export interface BrowserWiring {
  identityName?: string;
  /** Gateway root URL when known at launch (non-secret). */
  gateway?: string;
  /** First user argv entry, to detect subcommands. */
  firstArg?: string;
  exists?: (p: string) => boolean;
  /**
   * Swap pool launch: the shim resolves the pool's active member on every call, so the
   * wiring needs a token in ANY of these (allowed, non-retired) member config dirs.
   */
  pool?: { name: string; memberConfigDirs: string[] };
}

/** Config dirs of the allowed, non-retired members of `pool` (retired identities are never wired). */
export function poolMemberConfigDirs(file: IdentitiesFile, pool: PoolIdentity): string[] {
  const dirs: string[] = [];
  for (const name of allowedAccounts(pool)) {
    const member = findIdentityByNameOrAlias(file.identities, name);
    if (member && !isRetired(member)) dirs.push(expandPath(member.configDir));
  }
  return dirs;
}

const normaliseDir = (dir: string): string => {
  const r = resolve(expandPath(dir));
  return r.length > 1 ? r.replace(/\/+$/, "") : r;
};

/** Transcript folders a launcher's own config folder may link into an identity's folder (Claude, Codex). */
const TRANSCRIPT_LINKS = ["projects", "sessions"];

const realOrNormal = (dir: string, real: (p: string) => string): string => {
  try {
    return normaliseDir(real(expandPath(dir)));
  } catch {
    return normaliseDir(dir);
  }
};

/** Folder-name candidates for a T3 gateway folder, in order of preference. */
function t3GatewayCandidates(folderName: string): string[] {
  const stem = folderName.replace(/^t3-(?:claude|codex)-/, "");
  // No kimi-/zai- stripping: a Kimi or Z.ai backed session must never get a Claude identity's browser,
  // because it would send page content to another provider.
  return [...new Set([folderName, stem])];
}

/** Identity for a folder directly inside <T3 home>/gateway, matched by name or alias (T3 instance folders hold only a gateway token). */
function identityForT3GatewayFolder(live: Identity[], configDir: string, t3Gateway: string, real: (p: string) => string): Identity | undefined {
  const dir = normaliseDir(configDir);
  if (realOrNormal(dirname(dir), real) !== realOrNormal(t3Gateway, real)) return undefined;
  const pools = live.filter((i) => isSwapPool(i));
  for (const candidate of t3GatewayCandidates(basename(dir))) {
    const named = findIdentityByNameOrAlias(live, candidate);
    if (named) return named;
    if (candidate === "pool" && pools.length === 1) return pools[0];
  }
  return undefined;
}

/**
 * Registered identity (pool or plain) a preset CLAUDE_CONFIG_DIR / CODEX_HOME belongs to (T3 Code,
 * other launchers). Identity resolution skips the registry then, but the browser wiring still needs
 * the identity. Match: the folder is the identity's config dir, or (a launcher's own folder, such as
 * T3's per-account ~/.t3/gateway/t3-claude-<name>) its `projects` / `sessions` link points into the
 * identity's config dir, or the folder sits directly in <T3 home>/gateway and its name (without a
 * t3-claude-/t3-codex- prefix) is an identity name or alias. Retired
 * identities are never returned. `t3Gateway` is injectable for tests.
 */
export function identityForConfigDir(
  file: IdentitiesFile,
  configDir: string,
  real: (p: string) => string = realpathSync,
  t3Gateway: string = join(t3Paths().t3Home, "gateway"),
): Identity | undefined {
  const live = file.identities.filter((i) => !isRetired(i));
  const target = normaliseDir(configDir);
  const direct = live.find((i) => normaliseDir(i.configDir) === target);
  if (direct) return direct;
  for (const sub of TRANSCRIPT_LINKS) {
    let linked: string;
    try {
      linked = normaliseDir(dirname(real(join(expandPath(configDir), sub))));
    } catch {
      continue;
    }
    if (linked === realOrNormal(configDir, real)) continue;
    const owner = live.find((i) => realOrNormal(i.configDir, real) === linked);
    if (owner) return owner;
  }
  return identityForT3GatewayFolder(live, configDir, t3Gateway, real);
}

/**
 * Pool wiring input for a launch: set only for a claude/codex swap pool identity whose registry
 * loads. This is the exact step run-wrapper performs before `browserMcpArgs`.
 */
export async function browserPoolWiring(toolName: string, identity: Identity | undefined, loadFile: () => Promise<IdentitiesFile>): Promise<BrowserWiring["pool"]> {
  if (!identity || !isSwapPool(identity) || (toolName !== "claude" && toolName !== "codex")) return undefined;
  try {
    return { name: identity.name, memberConfigDirs: poolMemberConfigDirs(await loadFile(), identity) };
  } catch {
    return undefined;
  }
}

/**
 * Launch args registering the ais-browser MCP server, or [] when the identity has no
 * browser token or is retired. The shim gets its config as args (Codex strips the MCP
 * server environment); the token itself stays in the 0600 file. Claude: --mcp-config=<json>
 * (single-token form; the flag is variadic). Codex: root -c overrides.
 */
export function browserMcpArgs(tool: string, configDir: string, identity: Pick<Identity, "retired"> | undefined, aisBinary: string | undefined, w: BrowserWiring = {}): string[] {
  if (tool !== "claude" && tool !== "codex") return [];
  if (aisBinary === undefined) return []; // never fall back to the running executable (it may be bun, not ais)
  if (identity && isRetired(identity)) return [];
  const exists = w.exists ?? existsSync;
  if (w.pool) {
    if (!w.pool.memberConfigDirs.some((d) => exists(join(d, TOKEN_FILE)))) return [];
  } else if (!exists(join(configDir, TOKEN_FILE))) return [];
  if (tool === "claude" && w.firstArg !== undefined && CLAUDE_SUBCOMMANDS.has(w.firstArg)) return [];
  const target = w.pool
    ? ["--pool", w.pool.name, "--tool", tool]
    : ["--config-dir", configDir, ...(w.identityName ? ["--identity", w.identityName] : [])];
  const shimArgs = ["browser", "mcp", ...target, ...(w.gateway ? ["--gateway", w.gateway] : [])];
  if (tool === "claude") {
    return [`--mcp-config=${JSON.stringify({ mcpServers: { "ais-browser": { command: aisBinary, args: shimArgs } } })}`];
  }
  return [
    "-c", `mcp_servers.ais-browser.command=${JSON.stringify(aisBinary)}`,
    "-c", `mcp_servers.ais-browser.args=${JSON.stringify(shimArgs)}`,
    "-c", `mcp_servers.ais-browser.env_vars=["CODEX_HOME","AIS_GATEWAY_PROXY_URL","AI_PROFILE_SWITCHER_SESSION","T3CODE_THREAD_ID","T3CODE_HOME"]`,
    "-c", `mcp_servers.ais-browser.tool_timeout_sec=${TOOL_TIMEOUT_SEC}`,
  ];
}

/**
 * Env for the claude launch when the browser server is wired. Claude Code has no per-server
 * timeout field in its MCP config, only the MCP_TOOL_TIMEOUT env (ms); set it unless the user did.
 */
export function browserLaunchEnv(tool: string, browserArgs: string[], env: Record<string, string | undefined>): Record<string, string> {
  if (tool !== "claude" || browserArgs.length === 0 || env.MCP_TOOL_TIMEOUT !== undefined) return {};
  return { MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_SEC * 1000) };
}

export interface LaunchBrowserWiringInput {
  toolName: string;
  /** The config dir the launch resolved (a preset env value for T3 Code). */
  configDirValue: string;
  /** Identity the launch already resolved, if any. */
  resolvedIdentity?: Identity | undefined;
  /** True when the config dir came from a preset env var, so the registry maps it back. */
  fromEnv: boolean;
  activeIdentity?: string | undefined;
  gatewayUrl?: string | undefined;
  firstArg?: string | undefined;
  aisBinary: string | undefined;
  loadFile: () => Promise<IdentitiesFile>;
  exists?: (p: string) => boolean;
  real?: (p: string) => string;
  t3Gateway?: string;
}

export interface LaunchBrowserWiring {
  identity: Identity | undefined;
  pool: BrowserWiring["pool"];
  identityName: string | undefined;
  /** Folder that holds the browser token (the identity's own, not a launcher's folder). */
  configDir: string;
  args: string[];
}

/**
 * The whole browser wiring decision of one launch. run-wrapper and `ais browser wiring` both call
 * this, so the check cannot drift from what a launch does.
 */
export async function browserLaunchWiring(i: LaunchBrowserWiringInput): Promise<LaunchBrowserWiring> {
  const identity = i.resolvedIdentity ?? (i.fromEnv ? await i.loadFile().then((f) => identityForConfigDir(f, i.configDirValue, i.real, i.t3Gateway), () => undefined) : undefined);
  const pool = await browserPoolWiring(i.toolName, identity, i.loadFile);
  const identityName = identity?.name ?? i.activeIdentity;
  // The token lives in the identity's folder, not in a launcher's own folder that only links to it.
  const configDir = identity && !i.resolvedIdentity ? expandPath(identity.configDir) : i.configDirValue;
  const args = browserMcpArgs(i.toolName, configDir, identity, i.aisBinary, {
    ...(identityName !== undefined ? { identityName } : {}),
    ...(i.gatewayUrl ? { gateway: i.gatewayUrl } : {}),
    ...(pool ? { pool } : {}),
    ...(i.firstArg !== undefined ? { firstArg: i.firstArg } : {}),
    ...(i.exists ? { exists: i.exists } : {}),
  });
  return { identity, pool, identityName, configDir, args };
}
