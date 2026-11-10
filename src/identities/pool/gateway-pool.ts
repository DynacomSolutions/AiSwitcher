import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { LOCAL_GATEWAY_ROUTES } from "../../gateway/local-routes.ts";
import { isGatewayAccessToken, isGatewayRoutedDir } from "../claude-gateway-entry.ts";
import { codexAuthPath, readCodexAuthText } from "../codex-auth.ts";
import { buildCodexGatewayAuth, parseGatewayProvider } from "../codex-gateway-home.ts";
import { hasMemberCopy, isMemberStoreTool } from "../gateway-members.ts";
import { classifyLogin, folderHoldsGatewayEntry } from "../gateway-routed.ts";
import { expandPath } from "../match.ts";
import type { Identity } from "../types.ts";
import { writeFileAtomic } from "./fs.ts";

/**
 * Swap pools whose folder routes through the AIS gateway.
 *
 * A routed pool folder holds the gateway entry (claude: `.credentials.json` with the `aisg_` app token; codex: `auth.json`
 * `{auth_mode: "apikey", OPENAI_API_KEY: "aisg_..."}` or the `ais gateway codex-home` placeholder login, plus config.toml
 * on the `ais-gateway` provider), never a member's login. The gateway holds every member login (its member store,
 * gateway-members.ts) and picks the member for each request itself (gateway/select.ts: the member with the most headroom;
 * the local fallback path tries the pool's active member first). So for such a pool:
 *   - a swap records the active member (registry and ledger) and never copies a login into the folder;
 *   - heal keeps the gateway entry in place (a real login found there is backed up, then replaced) and never restores a
 *     member's login over it;
 *   - the gateway entry counts as the pool's credentials (the launch check does not bootstrap a copy over it).
 * A plain (unrouted) pool never takes a gateway-routed member's login either: the swap is refused with the way out.
 */

export const CODEX_GATEWAY_PROVIDER = "ais-gateway";

function readSync(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** True when config.toml text selects the `ais-gateway` model provider. */
export function codexConfigUsesGateway(text: string | undefined): boolean {
  if (text === undefined) return false;
  try {
    return (parseToml(text) as { model_provider?: unknown }).model_provider === CODEX_GATEWAY_PROVIDER;
  } catch {
    return false;
  }
}

/** True when a codex auth.json text is a gateway entry (an `aisg_` app token, no member login). */
export const isCodexGatewayAuth = (text: string | undefined): boolean => classifyLogin("codex", text) === "gateway";

/** A codex pool folder routes through the gateway: its auth.json holds the gateway entry, or its config.toml selects the gateway provider. */
export function isCodexGatewayPoolDir(configDir: string): boolean {
  const dir = expandPath(configDir);
  return isCodexGatewayAuth(readSync(codexAuthPath(dir))) || codexConfigUsesGateway(readSync(join(dir, "config.toml")));
}

/** True when a pool folder of `tool` routes through the AIS gateway (see the module comment). Tools without a gateway route: false. */
export async function isGatewayRoutedPool(tool: string, configDir: string): Promise<boolean> {
  if (tool === "claude") return isGatewayRoutedDir(expandPath(configDir));
  if (tool === "codex") return isCodexGatewayPoolDir(configDir);
  return false;
}

/** True when the gateway holds this member's login: a member store copy on this host, or its folder holds the gateway entry. */
export function isGatewayMember(tool: string, member: Identity, root?: string): boolean {
  if (!isMemberStoreTool(tool)) return false;
  return hasMemberCopy(tool, member.name, root) || folderHoldsGatewayEntry(tool, member);
}

/** The note every swap of a routed pool carries. */
export const gatewaySelectsNote = (pool: string): string =>
  `pool ${pool} routes through the AIS gateway: the gateway picks the member for each request (the one with the most headroom; the local fallback tries the active member first), so the swap only recorded the active member and copied no login into the pool folder`;

/** Why a plain pool cannot swap to a gateway-routed member. */
export const gatewayMemberRefusal = (tool: string, target: string, pool: string): string =>
  `Account "${target}" is routed through the AIS gateway: the gateway holds its login (member store), and a swap never copies it into the ${tool} pool "${pool}" (a second copy would spend the refresh token the gateway renews). Route the pool too (ais identities route-all-via-gateway); the gateway then picks the member.`;

/* ------------------------------------------------------------------ codex gateway entry */

/** The gateway entry text for a codex pool folder: the codex-home placeholder login when config.toml uses `chatgpt_base_url`, else the API-key entry. Undefined when the secrets file has no token. */
export async function codexPoolEntryText(configDir: string, secretsPath?: string): Promise<string | undefined> {
  const { appTokenKey, readSecretsKey } = await import("../../cli/gateway/secrets-file.ts");
  const config = readSync(join(expandPath(configDir), "config.toml"));
  let app = LOCAL_GATEWAY_ROUTES.codex!.app;
  let placeholder = false;
  if (config !== undefined && /^\s*chatgpt_base_url\s*=/m.test(config)) {
    try {
      app = parseGatewayProvider(config).app;
      placeholder = true;
    } catch {
      // no parseable provider base: the API-key entry for the local route
    }
  }
  const token = await readSecretsKey(appTokenKey(app), secretsPath);
  if (!token || !isGatewayAccessToken(token)) return undefined;
  return placeholder ? buildCodexGatewayAuth(app, token) : `${JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: token })}\n`;
}

export interface EnsureEntryResult {
  changed: boolean;
  notes: string[];
}

/**
 * Keeps the gateway entry in a routed codex pool folder (caller holds the pool folder's refresh lock). The entry in place:
 * nothing. A real login there (a `codex login` in the pool, an older build's swap) is backed up (0600 `.pre-<kind>` copy,
 * never written back to a member: the gateway holds the members' logins) and replaced; an empty or damaged file is replaced.
 * No token in the secrets file: an error, never a silent fall back to a member login.
 */
export async function ensureCodexPoolEntry(
  pool: { name: string; configDir: string },
  kind: "swap" | "heal",
  opts: { secretsPath?: string; backup: (path: string, kind: "swap" | "heal", text: string) => Promise<string> },
): Promise<EnsureEntryResult> {
  const text = await readCodexAuthText(pool.configDir);
  if (isCodexGatewayAuth(text)) return { changed: false, notes: [] };
  const entry = await codexPoolEntryText(pool.configDir, opts.secretsPath);
  if (!entry) throw new Error(`pool ${pool.name} routes through the AIS gateway, but the secrets file has no gateway token for it (AIS_GATEWAY_APP_AGENTS_CODEX_TOKEN); run "ais gateway app add agents-codex" or restore it`);
  const notes: string[] = [];
  if (text !== undefined && classifyLogin("codex", text) === "login") {
    notes.push(`a login found in the gateway-routed pool ${pool.name} was not used; kept a 0600 copy at ${await opts.backup(codexAuthPath(pool.configDir), kind, text)}`);
  }
  await writeFileAtomic(codexAuthPath(pool.configDir), entry);
  notes.push(`restored the gateway entry in pool ${pool.name}`);
  return { changed: true, notes };
}
