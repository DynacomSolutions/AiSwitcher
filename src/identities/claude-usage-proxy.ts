import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./pool/fs.ts";

/**
 * Claude Code settings for the gateway's CONNECT usage proxy (`ais gateway serve`, row 4.161).
 *
 * Claude Code reads its plan usage from Anthropic's own host, not from ANTHROPIC_BASE_URL, so a gateway-routed folder
 * reaches the gateway's usage answer only through HTTPS_PROXY (the CONNECT proxy) with NODE_EXTRA_CA_CERTS trusting the
 * proxy's certificate. Claude Code sends EVERY request through that proxy, including a plain-HTTP loopback
 * ANTHROPIC_BASE_URL (the `ais gateway local` failover proxy). The CONNECT proxy cannot carry plain HTTP, so without a
 * loopback NO_PROXY every model call fails with 405 (incident 9 Nov 2026: the whole swap pool down for 4.5 min).
 * So HTTPS_PROXY is only ever written together with a NO_PROXY that covers loopback, and the doctor reports a folder
 * where that pairing is missing.
 */

/** The loopback names a NO_PROXY must cover when a proxy is set. */
export const LOOPBACK_NO_PROXY = ["127.0.0.1", "localhost", "::1"] as const;

const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const;
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"] as const;

type Env = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** The NO_PROXY entries, lower-cased, ports and brackets dropped ("[::1]:80" is "::1"). */
function noProxyEntries(env: Env): string[] {
  const raw = NO_PROXY_KEYS.map((k) => str(env[k])).filter((v): v is string => v !== undefined).join(",");
  return raw
    .split(/[\s,]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "")
    .map((e) => (e.startsWith("[") ? e.slice(1, e.indexOf("]") === -1 ? undefined : e.indexOf("]")) : /^[^:]+:\d+$/.test(e) ? e.slice(0, e.lastIndexOf(":")) : e));
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** Whether NO_PROXY makes the client skip the proxy for `host` ("*" covers all; "127.0.0.0/8" style CIDRs are not read). */
function bypassed(env: Env, host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return noProxyEntries(env).some((e) => e === "*" || e === h || (e.startsWith(".") ? h.endsWith(e) : h.endsWith(`.${e}`)));
}

/**
 * Why this settings `env` breaks Claude Code, or undefined when it is fine: a proxy is set, ANTHROPIC_BASE_URL is a
 * loopback address, and NO_PROXY does not exempt that host, so model calls go to the proxy and fail.
 */
export function usageProxyProblem(env: Env | undefined): string | undefined {
  if (!env) return undefined;
  const proxyKey = PROXY_KEYS.find((k) => str(env[k]) !== undefined);
  if (!proxyKey) return undefined;
  const base = str(env.ANTHROPIC_BASE_URL);
  if (!base) return undefined;
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    return undefined;
  }
  if (!isLoopbackHost(host) || bypassed(env, host)) return undefined;
  return `${proxyKey} is set but NO_PROXY does not cover the loopback ANTHROPIC_BASE_URL host ${host}: every model call goes to the proxy and fails (405 from the gateway CONNECT proxy). Set NO_PROXY=${LOOPBACK_NO_PROXY.join(",")}.`;
}

/** NO_PROXY with every loopback name added, keeping the existing entries and their order. */
export function withLoopbackNoProxy(current: unknown): string {
  const have = (str(current) ?? "").split(",").map((e) => e.trim()).filter((e) => e !== "");
  const lower = new Set(have.map((e) => e.toLowerCase()));
  return [...have, ...LOOPBACK_NO_PROXY.filter((e) => !lower.has(e))].join(",");
}

export interface UsageProxyOptions {
  /** The CONNECT proxy, e.g. "http://<gateway connect service>:47132". */
  proxyUrl: string;
  /** The proxy's CA certificate (the gateway publishes it to AIS_GATEWAY_CONNECT_CA_PUBLISH). */
  caPath: string;
}

/** Settings with the usage proxy turned on. HTTPS_PROXY is never set without a loopback NO_PROXY. Other keys are kept. */
export function withUsageProxy(settings: Record<string, unknown>, opts: UsageProxyOptions): Record<string, unknown> {
  const proxy = str(opts.proxyUrl);
  const ca = str(opts.caPath);
  if (!proxy || !/^https?:\/\//i.test(proxy)) throw new Error(`usage proxy URL must be http(s)://host:port, got "${opts.proxyUrl}"`);
  if (!ca) throw new Error("usage proxy CA path is required");
  const env: Env = typeof settings.env === "object" && settings.env !== null && !Array.isArray(settings.env) ? { ...(settings.env as Env) } : {};
  const noProxy = withLoopbackNoProxy(env.NO_PROXY ?? env.no_proxy);
  delete env.no_proxy;
  env.HTTPS_PROXY = proxy;
  env.NODE_EXTRA_CA_CERTS = ca;
  env.NO_PROXY = noProxy;
  const out = { ...settings, env };
  const problem = usageProxyProblem(env);
  if (problem) throw new Error(problem); // unreachable by construction; refuses to write a broken folder
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

/** Turns the usage proxy on in a Claude config folder's settings.json (atomic, 0600). Returns the new env. */
export async function configureUsageProxy(configDir: string, opts: UsageProxyOptions): Promise<Env> {
  const path = join(configDir, "settings.json");
  const next = withUsageProxy(await readSettings(path), opts);
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  await addProfileScopeToGatewayEntry(configDir);
  return next.env as Env;
}

/**
 * With the proxy on, a gateway entry (an `aisg_` access token, no refresh token) needs `user:profile` so Claude Code asks
 * for its limits. Only the scope list changes; a real login is never touched.
 */
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
    return usageProxyProblem(typeof env === "object" && env !== null ? (env as Env) : undefined);
  } catch {
    return undefined;
  }
}
