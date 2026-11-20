import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { expandPath } from "../identities/match.ts";
import { isSwapPool } from "../identities/pool/swap-pool.ts";
import { loadIdentitiesFile } from "../identities/store.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG } from "../identities/tool-configs.ts";
import type { IdentitiesFile } from "../identities/types.ts";
import { identityForConfigDir } from "../shared/browser-wiring.ts";
import { launchHeaders } from "./mcp-launch.ts";
import { readTokenFile, resolvePoolAuth } from "./mcp-shim.ts";
import { launchSessionLabel } from "./session-label.ts";

export type BrowserTool = "claude" | "codex";

export interface HeadersInput {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Tool override (`--tool`). `claude` never reads CODEX_HOME and `codex` never reads CLAUDE_CONFIG_DIR. Default: Claude when CLAUDE_CONFIG_DIR is set, else Codex when CODEX_HOME is set. */
  tool?: BrowserTool | undefined;
  /** Folder override (`--config-dir`). Codex runs the helper without CODEX_HOME, so its config entry names the folder. */
  configDir?: string | undefined;
  loadFile?: (tool: BrowserTool) => Promise<IdentitiesFile>;
  readToken?: (dir: string) => Promise<string | undefined>;
  poolAuth?: typeof resolvePoolAuth;
  label?: typeof launchSessionLabel;
  t3Gateway?: string;
  real?: (p: string) => string;
  /** Reads the file named by `AIS_BROWSER_AGENT_TOKEN_FILE`. Default: the file, trimmed. */
  readTokenPath?: (path: string) => Promise<string | undefined>;
}

/**
 * Agent pods (hq0 cluster) have no identity registry and no token in the identity folder. The pod mounts its
 * identity's agent token from a Secret and names the file here. Used only when the registry maps the folder to no identity.
 */
export const BROWSER_TOKEN_FILE_ENV = "AIS_BROWSER_AGENT_TOKEN_FILE";

const readTrimmed = async (path: string): Promise<string | undefined> => {
  try {
    return (await readFile(path, "utf8")).trim() || undefined;
  } catch {
    return undefined;
  }
};

/** A folder or identity that talks to another model provider (Kimi, Z.ai). Page content must never go there. */
const OTHER_PROVIDER = /(^|[-_.])(kimi|zai|z-ai)([-_.]|$)/i;

export const isOtherProviderName = (name: string): boolean => OTHER_PROVIDER.test(name);

/**
 * The HTTP headers for the gateway browser MCP endpoint, for the session that calls this (Claude `headersHelper`,
 * Codex `http_headers_helper`). Returns `{}` for a folder that maps to no identity, to a Kimi or Z.ai folder,
 * or to an identity without a token: the endpoint then refuses the call. Never throws, never logs.
 */
export async function browserHeaders(i: HeadersInput): Promise<Record<string, string>> {
  try {
    const tool: BrowserTool | undefined = i.tool ?? (i.env.CLAUDE_CONFIG_DIR ? "claude" : i.env.CODEX_HOME ? "codex" : undefined);
    const configDir = i.configDir ?? (tool === "codex" ? i.env.CODEX_HOME : i.env.CLAUDE_CONFIG_DIR);
    if (!tool || !configDir) return {};
    if (isOtherProviderName(basename(resolve(expandPath(configDir))))) return {};
    const fromRegistry = await registryAuth(i, tool, configDir).catch(() => undefined);
    let token = fromRegistry?.token;
    const pool = fromRegistry?.pool;
    if (!fromRegistry && i.env[BROWSER_TOKEN_FILE_ENV]) token = await (i.readTokenPath ?? readTrimmed)(i.env[BROWSER_TOKEN_FILE_ENV]!);
    if (!token) return {};
    const label = await (i.label ?? launchSessionLabel)(i.env, tool, i.cwd).catch(() => "");
    return { Authorization: `Bearer ${token}`, ...launchHeaders({ label, pool }) };
  } catch {
    return {};
  }
}

/**
 * Token (and pool) from the identity registry. `undefined`: the folder maps to no identity (the pod fallback may then
 * apply). `{}`: it maps to an identity that must get no headers (another provider, or no token).
 */
async function registryAuth(i: HeadersInput, tool: BrowserTool, configDir: string): Promise<{ token?: string; pool?: string } | undefined> {
  const file = await (i.loadFile ?? ((t) => loadIdentitiesFile((t === "claude" ? CLAUDE_CONFIG : CODEX_CONFIG).identitiesJsonPath)))(tool);
  const identity = identityForConfigDir(file, configDir, i.real, i.t3Gateway);
  if (!identity) return undefined;
  if (isOtherProviderName(identity.name)) return {};
  if (isSwapPool(identity)) {
    const auth = await (i.poolAuth ?? resolvePoolAuth)(identity.name, tool);
    return auth.error || !auth.token ? {} : { token: auth.token, pool: identity.name };
  }
  const token = await (i.readToken ?? readTokenFile)(expandPath(identity.configDir));
  return token ? { token } : {};
}
