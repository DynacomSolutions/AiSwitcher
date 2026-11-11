import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { aisHome } from "../shared/ais-home.ts";
import { LOCAL_GATEWAY_ROUTES } from "../gateway/local-routes.ts";
import { LOCAL_GATEWAY_HTTP_PORT, localGatewayTlsPort, localTlsBundlePath } from "../gateway/local-tls.ts";
import { writeFileAtomic } from "./pool/fs.ts";

/**
 * Client-side setup of a Codex folder (CODEX_HOME) that runs through the AIS gateway, so Codex and T3 Code
 * (`codex app-server`) show real usage limits from the gateway's served `/backend-api/wham/usage`.
 *
 * The folder gets a placeholder ChatGPT login whose `access_token` is the gateway app token, `chatgpt_base_url`
 * pointing at the gateway, and `requires_openai_auth = true` on the gateway provider (codex refuses that combined
 * with a provider auth command, so the `.auth` table is removed). Proven live with codex-cli 0.145.
 */

const PROVIDER = "ais-gateway";
const PROVIDER_TABLE = `model_providers.${PROVIDER}`;

const b64url = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The gateway base and app name from the folder's `[model_providers.ais-gateway] base_url = "<base>/<app>"`.
 * A local-route base_url (loopback host, last segment a LOCAL_GATEWAY_ROUTES key, e.g. `http://127.0.0.1:47140/codex`)
 * maps to that route's app (`agents-codex`) and reports the route segment, which stays the URL path the gateway serves.
 * The cluster form `<gateway base>/<app>` has no `route`.
 */
export function parseGatewayProvider(configText: string): { base: string; app: string; route?: string } {
  const parsed = parseToml(configText) as { model_providers?: Record<string, { base_url?: unknown }> };
  const baseUrl = parsed.model_providers?.[PROVIDER]?.base_url;
  if (typeof baseUrl !== "string" || baseUrl === "") throw new Error(`config.toml has no [${PROVIDER_TABLE}] base_url`);
  const trimmed = baseUrl.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  const segment = trimmed.slice(cut + 1);
  const base = trimmed.slice(0, cut);
  if (cut < 0 || segment === "" || /^[a-z][a-z0-9+.-]*:$/i.test(base) || base.endsWith("/")) throw new Error(`base_url of [${PROVIDER_TABLE}] is not <gateway base>/<app>`);
  const local = Object.hasOwn(LOCAL_GATEWAY_ROUTES, segment) ? LOCAL_GATEWAY_ROUTES[segment] : undefined;
  if (local && isLoopbackOrigin(base)) return { base, app: local.app, route: segment };
  return { base, app: segment };
}

function isLoopbackOrigin(base: string): boolean {
  try {
    const u = new URL(base);
    return (u.protocol === "http:" || u.protocol === "https:") && (u.pathname === "/" || u.pathname === "") && LOOPBACK_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** The account id of the placeholder ChatGPT login of a gateway app (auth.json `chatgpt_account_id`); the gateway's accounts/check answer lists the same id. */
export const codexGatewayAccountId = (app: string): string => `ais-${app}`;

/** The placeholder ChatGPT login (auth.json text). The id_token carries a non-empty signature: codex 0.145 rejects an empty one. */
export function buildCodexGatewayAuth(app: string, token: string): string {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      email: `${app}@gateway.invalid`,
      exp: 4102444800,
      iat: 1700000000,
      "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: codexGatewayAccountId(app) },
    }),
  );
  return `${JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: `${header}.${claims}.c2ln`, access_token: token, refresh_token: "none", account_id: codexGatewayAccountId(app) }, last_refresh: "2099-01-01T00:00:00Z" }, null, 2)}\n`;
}

const HEADER = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?$/;
const tableName = (line: string): string | undefined => {
  const m = HEADER.exec(line);
  return m ? m[1]!.replace(/\s*\.\s*/g, ".").replace(/"/g, "") : undefined;
};

/** Edits config.toml text line by line (comments and every other key survive). Idempotent. */
export function transformCodexGatewayConfig(configText: string, base: string, app: string, route: string = app): string {
  const out: string[] = [];
  let section: string | undefined; // undefined = top level
  let sawRequires = false;
  let providerHeaderAt = -1;
  for (const line of configText.split("\n")) {
    const name = tableName(line);
    if (name !== undefined) {
      section = name;
      if (name === `${PROVIDER_TABLE}.auth`) continue;
      if (name === PROVIDER_TABLE) providerHeaderAt = out.length;
    } else if (section === `${PROVIDER_TABLE}.auth`) {
      continue; // body of the removed auth table
    } else if (section === undefined && /^\s*chatgpt_base_url\s*=/.test(line)) {
      continue;
    } else if (section === PROVIDER_TABLE && /^\s*requires_openai_auth\s*=/.test(line)) {
      if (sawRequires) continue;
      sawRequires = true;
      out.push("requires_openai_auth = true");
      continue;
    }
    out.push(line);
  }
  if (!sawRequires && providerHeaderAt >= 0) out.splice(providerHeaderAt + 1, 0, "requires_openai_auth = true");
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n");
  return `chatgpt_base_url = ${JSON.stringify(`${base}/${route}/backend-api`)}\n${text}`;
}

const defaultHttpPort = (): number => Number(process.env.AIS_GATEWAY_LOCAL_PORT) || LOCAL_GATEWAY_HTTP_PORT;

/**
 * Codex 0.167 refuses a non-HTTPS ChatGPT backend, so a home aimed at the LOCAL gateway (plain HTTP on loopback) goes to
 * its HTTPS listener (`https://localhost:<tlsPort>`) instead. Rewrites the quoted `http://127.0.0.1|localhost:<httpPort>/codex`
 * URLs (chatgpt_base_url and the provider base_url) unconditionally; remote gateways are untouched.
 */
export function rewriteLocalGatewayUrls(configText: string, httpPort: number = defaultHttpPort(), tlsPort: number = localGatewayTlsPort(httpPort)): string {
  const re = new RegExp(`(["'])http://(?:127\\.0\\.0\\.1|localhost):${httpPort}(/codex(?:/backend-api)?/?)(?=\\1)`, "g");
  return configText.replace(re, (_m, q: string, path: string) => `${q}https://localhost:${tlsPort}${path}`);
}

/**
 * Automatic migration (launch, gateway start): only a placeholder-login home, whose top-level `chatgpt_base_url` is the local
 * plain-HTTP gateway, moves to HTTPS (both that URL and the provider base_url). A route-all API-key home (provider base_url
 * only) stays on plain HTTP: it never calls account/read, and a launch outside the wrapper would not trust the CA.
 */
export function migrateLocalGatewayConfigText(configText: string, httpPort: number = defaultHttpPort(), tlsPort: number = localGatewayTlsPort(httpPort)): string {
  let chatgpt: unknown;
  try {
    chatgpt = (parseToml(configText) as { chatgpt_base_url?: unknown }).chatgpt_base_url;
  } catch {
    return configText;
  }
  if (typeof chatgpt !== "string" || !new RegExp(`^http://(?:127\\.0\\.0\\.1|localhost):${httpPort}/codex/backend-api/?$`).test(chatgpt)) return configText;
  return rewriteLocalGatewayUrls(configText, httpPort, tlsPort);
}

/** True when the config's provider base_url or chatgpt_base_url is the local gateway's HTTPS listener (so codex needs CODEX_CA_CERTIFICATE). */
export function usesLocalGatewayTls(configText: string, tlsPort: number = localGatewayTlsPort()): boolean {
  let parsed: { chatgpt_base_url?: unknown; model_providers?: Record<string, { base_url?: unknown }> };
  try {
    parsed = parseToml(configText) as typeof parsed;
  } catch {
    return false;
  }
  const urls = [parsed.chatgpt_base_url, parsed.model_providers?.[PROVIDER]?.base_url];
  return urls.some((u) => {
    if (typeof u !== "string") return false;
    try {
      const url = new URL(u);
      return url.protocol === "https:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1") && Number(url.port) === tlsPort;
    } catch {
      return false;
    }
  });
}

/**
 * The environment a codex launch needs for `configDir`: CODEX_CA_CERTIFICATE (system roots + the AIS local CA) when the home
 * points at the local HTTPS gateway, unless the caller already set one. A home still on the plain-HTTP local URL is moved
 * to HTTPS first, but only once the gateway has produced its CA bundle (an older gateway has no HTTPS listener).
 */
export async function codexLocalGatewayEnv(configDir: string, inherited: NodeJS.ProcessEnv = process.env, bundlePath: string = localTlsBundlePath()): Promise<Record<string, string>> {
  if (inherited.CODEX_CA_CERTIFICATE) return {};
  const path = join(configDir, "config.toml");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  const bundleExists = await stat(bundlePath).then(() => true, () => false);
  if (!bundleExists) return {};
  const migrated = migrateLocalGatewayConfigText(text);
  if (migrated !== text) {
    try {
      const mode = (await stat(path)).mode & 0o777;
      await writeFileAtomic(path, migrated);
      await chmod(path, mode);
      text = migrated;
    } catch {
      return {};
    }
  }
  return usesLocalGatewayTls(text) ? { CODEX_CA_CERTIFICATE: bundlePath } : {};
}

/** Moves every registered gateway home from the local plain-HTTP URL to the HTTPS listener. Returns the migrated folders. */
export async function migrateRegisteredLocalCodexHomes(httpPort?: number, tlsPort?: number, registryPath = codexGatewayHomesPath()): Promise<string[]> {
  const done: string[] = [];
  for (const h of await loadCodexGatewayHomes(registryPath)) {
    const path = join(h.dir, "config.toml");
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const next = migrateLocalGatewayConfigText(text, httpPort, tlsPort);
    if (next === text) continue;
    const mode = (await stat(path)).mode & 0o777;
    await writeFileAtomic(path, next);
    await chmod(path, mode);
    done.push(h.dir);
  }
  return done;
}

export interface ConfiguredHome {
  dir: string;
  app: string;
}

/** What `--check` finds in a folder: undefined when it is fully configured for its gateway app. */
export async function codexGatewayHomeProblem(dir: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, "config.toml"), "utf8");
  } catch {
    return "no config.toml";
  }
  let target: { base: string; app: string; route?: string };
  try {
    target = parseGatewayProvider(text);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (transformCodexGatewayConfig(text, target.base, target.app, target.route) !== text) return "config.toml needs chatgpt_base_url / requires_openai_auth";
  try {
    const auth = JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as { tokens?: { account_id?: unknown; access_token?: unknown; id_token?: unknown } };
    if (auth.tokens?.account_id !== `ais-${target.app}` || typeof auth.tokens.access_token !== "string" || auth.tokens.access_token === "") return "auth.json is not the gateway placeholder login";
    if (typeof auth.tokens.id_token !== "string" || (auth.tokens.id_token.split(".")[2] ?? "") === "") return "auth.json id_token has an empty signature";
  } catch {
    return "auth.json missing or unreadable";
  }
  return undefined;
}

/** Reads the folder's app from config.toml. */
export async function readCodexGatewayHomeApp(dir: string): Promise<{ base: string; app: string; route?: string; text: string }> {
  const text = await readFile(join(dir, "config.toml"), "utf8");
  return { ...parseGatewayProvider(text), text };
}

/** Writes auth.json (0600) and rewrites config.toml (mode kept). Returns the app. Never logs the token. */
export async function configureCodexGatewayHome(dir: string, token: string): Promise<{ app: string }> {
  const read = await readCodexGatewayHomeApp(dir);
  const { app } = read;
  const text = read.text;
  // A local plain-HTTP target is written as the HTTPS listener; the placeholder-login shape stays the same.
  const localText = rewriteLocalGatewayUrls(text);
  const { base, route } = localText === text ? read : parseGatewayProvider(localText);
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(join(dir, "auth.json"), buildCodexGatewayAuth(app, token));
  const next = transformCodexGatewayConfig(localText, base, app, route);
  if (next !== text) {
    const path = join(dir, "config.toml");
    const mode = (await stat(path)).mode & 0o777;
    await writeFileAtomic(path, next);
    await chmod(path, mode);
  }
  return { app };
}

/** Rewrites only auth.json (used on token rotation). */
export async function writeCodexGatewayAuth(dir: string, app: string, token: string): Promise<void> {
  await writeFileAtomic(join(dir, "auth.json"), buildCodexGatewayAuth(app, token));
}

export const codexGatewayHomesPath = (): string => join(aisHome(), "gateway-codex-homes.json");

export async function loadCodexGatewayHomes(path = codexGatewayHomesPath()): Promise<ConfiguredHome[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((h): h is ConfiguredHome => typeof h === "object" && h !== null && typeof (h as ConfiguredHome).dir === "string" && typeof (h as ConfiguredHome).app === "string");
}

/** Adds (or updates) a home in the registry. */
export async function registerCodexGatewayHome(home: ConfiguredHome, path = codexGatewayHomesPath()): Promise<void> {
  const homes = (await loadCodexGatewayHomes(path)).filter((h) => h.dir !== home.dir);
  homes.push(home);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(homes, null, 2)}\n`);
}

/** Rewrites auth.json in every registered home of `app`; one failing home does not stop the rest. */
export async function refreshRegisteredCodexHomes(app: string, token: string, path = codexGatewayHomesPath()): Promise<{ updated: number; failed: string[] }> {
  let updated = 0;
  const failed: string[] = [];
  for (const h of await loadCodexGatewayHomes(path)) {
    if (h.app !== app) continue;
    try {
      await writeCodexGatewayAuth(h.dir, app, token);
      updated += 1;
    } catch (e) {
      failed.push(`${h.dir}: ${(e instanceof Error ? e.message : String(e)).split(token).join("[redacted]")}`);
    }
  }
  return { updated, failed };
}
