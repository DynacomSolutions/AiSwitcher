import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isClusterInternalHost } from "./claude-account-preload.ts";
import { writeFileAtomic } from "./pool/fs.ts";

export const CLAUDE_PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;

type Env = Record<string, unknown>;

/** Why this Claude folder still has a generic forwarding proxy. */
export function directGatewayProblem(env: Env | undefined): string | undefined {
  if (!env) return undefined;
  const proxyKey = CLAUDE_PROXY_ENV_KEYS.find((key) => typeof env[key] === "string" && env[key].trim() !== "");
  return proxyKey === undefined ? undefined : `${proxyKey} is set; direct Claude gateway traffic must not use a generic proxy`;
}

function secureGatewayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("gateway URL must be an HTTPS URL");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.username || url.password || url.hash || url.search || (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || isClusterInternalHost(host))))) {
    throw new Error("gateway URL must be an HTTPS URL, a loopback HTTP URL or a cluster service HTTP URL without credentials, a query or a fragment");
  }
  return url.toString().replace(/\/$/, "");
}

/** Direct Claude settings. Legacy generic proxy variables are removed, but unrelated settings remain. */
export function withDirectGateway(settings: Record<string, unknown>, gatewayUrl: string): Record<string, unknown> {
  const base = secureGatewayUrl(gatewayUrl);
  const env: Env = typeof settings.env === "object" && settings.env !== null && !Array.isArray(settings.env) ? { ...(settings.env as Env) } : {};
  for (const key of CLAUDE_PROXY_ENV_KEYS) delete env[key];
  env.ANTHROPIC_BASE_URL = base;
  const out = { ...settings, env };
  return out;
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

/** Migrates a Claude folder to direct gateway model and account traffic. */
export async function configureDirectGateway(configDir: string, gatewayUrl: string): Promise<Env> {
  const path = join(configDir, "settings.json");
  const next = withDirectGateway(await readSettings(path), gatewayUrl);
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  await addProfileScopeToGatewayEntry(configDir);
  return next.env as Env;
}

/** A gateway entry needs `user:profile` so Claude Code asks AIS for its plan limits. */
async function addProfileScopeToGatewayEntry(configDir: string): Promise<void> {
  const path = join(configDir, ".credentials.json");
  let creds: Record<string, unknown>;
  try {
    creds = await readSettings(path);
  } catch {
    return;
  }
  const oauth = creds.claudeAiOauth as { accessToken?: unknown; refreshToken?: unknown; scopes?: unknown } | undefined;
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken.startsWith("aisg_") || (oauth.refreshToken ?? null) !== null) return;
  const scopes = Array.isArray(oauth.scopes) ? oauth.scopes.filter((x): x is string => typeof x === "string") : [];
  if (scopes.includes("user:profile")) return;
  creds.claudeAiOauth = { ...oauth, scopes: [...scopes, "user:profile"] };
  await writeFileAtomic(path, `${JSON.stringify(creds)}\n`);
}

/** The problem with a Claude config folder's settings.json, if any (unreadable settings are not this check's concern). */
export async function folderUsageProxyProblem(configDir: string): Promise<string | undefined> {
  try {
    const env = (await readSettings(join(configDir, "settings.json"))).env;
    return directGatewayProblem(typeof env === "object" && env !== null ? (env as Env) : undefined);
  } catch {
    return undefined;
  }
}
