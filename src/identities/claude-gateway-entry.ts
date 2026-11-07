import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./pool/fs.ts";

/**
 * Subscriber-mode credentials for a Claude identity whose traffic goes through the AIS gateway.
 *
 * Claude Code shows its native "continue automatically / stop and wait" limit handling only in OAuth (subscriber)
 * mode, never with an `apiKeyHelper`. Such an identity therefore holds a `claudeAiOauth` entry whose access token is the
 * gateway app token (never a member login). Findings from live runs of Claude Code 2.1.316:
 *   - `refreshToken: null` and the single scope `user:inference` keep it off the profile and refresh calls that go to the
 *     real Anthropic hosts (a gateway token is rejected there, and a failed refresh ends the session with "Login expired");
 *   - `subscriptionType: "max"` gives the "Claude Max" banner and the limit menu.
 */

/** The gateway app whose token claude identities use. */
export const GATEWAY_CLAUDE_APP = "agents-claude";
/** Every gateway app token starts with this (see gateway/tokens.ts). */
export const GATEWAY_TOKEN_PREFIX = "aisg_";
/** 2100-01-01T00:00:00Z in ms: Claude Code never tries to refresh the entry. */
export const GATEWAY_ENTRY_EXPIRES_AT_MS = 4_102_444_800_000;
export const GATEWAY_ENTRY_SCOPES = ["user:inference"];

export const isGatewayAccessToken = (token: unknown): boolean => typeof token === "string" && token.startsWith(GATEWAY_TOKEN_PREFIX);

/** The `.credentials.json` text for the gateway entry. */
export function gatewayEntryText(token: string): string {
  return `${JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: null, expiresAt: GATEWAY_ENTRY_EXPIRES_AT_MS, scopes: GATEWAY_ENTRY_SCOPES, subscriptionType: "max" } })}\n`;
}

/** The agents-claude gateway token from the secrets file (the one the key helpers print), or undefined. */
export async function readGatewayClaudeToken(secretsPath?: string): Promise<string | undefined> {
  const { appTokenKey, readSecretsKey } = await import("../cli/gateway/secrets-file.ts");
  const token = await readSecretsKey(appTokenKey(GATEWAY_CLAUDE_APP), secretsPath);
  return token && isGatewayAccessToken(token) ? token : undefined;
}

const LOCAL_PORT_DEFAULT = 47140;

/** True when `raw` is the local proxy (loopback on its port) or the same origin as the cluster gateway base. */
export function isGatewayBaseUrl(raw: unknown, opts: { localPort?: number; remoteBase?: string } = {}): boolean {
  if (typeof raw !== "string" || raw === "") return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  const localPort = opts.localPort ?? (Number(process.env.AIS_GATEWAY_LOCAL_PORT) || LOCAL_PORT_DEFAULT);
  if ((host === "localhost" || host === "::1" || /^127\./.test(host)) && port === localPort) return true;
  if (opts.remoteBase) {
    try {
      return new URL(opts.remoteBase).origin === u.origin;
    } catch {
      return false;
    }
  }
  return false;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The access token in the identity's `.credentials.json`, if any. */
export async function storedAccessToken(configDir: string): Promise<string | undefined> {
  const oauth = (await readJson(join(configDir, ".credentials.json")))?.claudeAiOauth as { accessToken?: unknown } | undefined;
  return typeof oauth?.accessToken === "string" ? oauth.accessToken : undefined;
}

/**
 * Whether a pool folder routes through the gateway: its settings send ANTHROPIC_BASE_URL to the local proxy or the cluster
 * gateway, or it already holds the gateway entry. Never reads a member's folder.
 */
export async function isGatewayRoutedDir(configDir: string, opts: { localPort?: number; remoteBase?: string } = {}): Promise<boolean> {
  const env = (await readJson(join(configDir, "settings.json")))?.env as Record<string, unknown> | undefined;
  if (isGatewayBaseUrl(env?.ANTHROPIC_BASE_URL, opts)) return true;
  return isGatewayAccessToken(await storedAccessToken(configDir));
}

/** Writes the gateway entry atomically with mode 0600. */
export async function writeGatewayEntry(configDir: string, token: string): Promise<void> {
  await writeFileAtomic(join(configDir, ".credentials.json"), gatewayEntryText(token));
}

/** Removes `apiKeyHelper` from the folder's settings.json (it would switch Claude Code out of subscriber mode). Other keys
 * are kept; returns whether anything was removed. */
export async function dropApiKeyHelper(configDir: string): Promise<boolean> {
  const path = join(configDir, "settings.json");
  const settings = await readJson(path);
  if (!settings || !("apiKeyHelper" in settings)) return false;
  delete settings.apiKeyHelper;
  await writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}
