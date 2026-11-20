import { basename, join } from "node:path";
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
  /** Tool override (`--tool`). Default: Claude when CLAUDE_CONFIG_DIR is set, else Codex when CODEX_HOME is set. */
  tool?: BrowserTool | undefined;
  /** Folder override (`--config-dir`). Codex runs the helper without CODEX_HOME, so its config entry names the folder. */
  configDir?: string | undefined;
  loadFile?: (tool: BrowserTool) => Promise<IdentitiesFile>;
  readToken?: (dir: string) => Promise<string | undefined>;
  poolAuth?: typeof resolvePoolAuth;
  label?: typeof launchSessionLabel;
  t3Gateway?: string;
  real?: (p: string) => string;
}

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
    if (isOtherProviderName(basename(configDir.replace(/\/+$/, "")))) return {};
    const file = await (i.loadFile ?? ((t) => loadIdentitiesFile((t === "claude" ? CLAUDE_CONFIG : CODEX_CONFIG).identitiesJsonPath)))(tool);
    const identity = identityForConfigDir(file, configDir, i.real, i.t3Gateway);
    if (!identity || isOtherProviderName(identity.name)) return {};
    let token: string | undefined;
    let pool: string | undefined;
    if (isSwapPool(identity)) {
      const auth = await (i.poolAuth ?? resolvePoolAuth)(identity.name, tool);
      if (auth.error || !auth.token) return {};
      token = auth.token;
      pool = identity.name;
    } else {
      token = await (i.readToken ?? readTokenFile)(expandPath(identity.configDir));
    }
    if (!token) return {};
    const sessionId = tool === "claude" ? i.env.CLAUDE_CODE_SESSION_ID || undefined : undefined;
    const label = await (i.label ?? launchSessionLabel)(i.env, tool, i.cwd).catch(() => "");
    return { Authorization: `Bearer ${token}`, ...launchHeaders({ sessionId, label, pool }) };
  } catch {
    return {};
  }
}

/** Where a Codex folder keeps its config, for `ais browser codex-config`. */
export const codexConfigPath = (home: string): string => join(expandPath(home), "config.toml");
