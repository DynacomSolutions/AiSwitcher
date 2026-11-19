import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { appTokenKey, readSecretsKey } from "../cli/gateway/secrets-file.ts";
import { GATEWAY_TOKEN_PREFIX } from "./claude-gateway-entry.ts";
import { writeFileAtomic } from "./pool/fs.ts";
import { t3Paths } from "./t3-anthropic-proxy.ts";

/**
 * T3 Code's built-in OpenCode and Grok drivers read their usage from files in the instance folders. This gives them a
 * credential that is only the gateway app token (never a provider key): the gateway answers the usage calls, and the T3
 * preload sends those calls to it. The source of truth is T3's settings.json (providerInstances), which is only read.
 */

export type UsageStatus = "updated" | "current" | "failed" | "skipped" | "problem";

export interface UsageResult {
  id: string;
  driver: string;
  file: string;
  status: UsageStatus;
  /** Why it failed, was skipped or is a problem. Never holds a token. */
  detail?: string;
}

export interface UsageOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  secretsPath?: string;
  /** Writes nothing; "updated" then means "out of date". */
  check?: boolean;
}

const OPENCODE_GO = "opencode-go";
const GROK_CREDENTIAL = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
/** Grok env that makes T3 show no Grok usage. */
const GROK_BLOCKING_ENV = [
  "XAI_API_KEY",
  "GROK_OIDC_ISSUER",
  "GROK_OIDC_CLIENT_ID",
  "GROK_OAUTH2_ISSUER",
  "GROK_OAUTH2_CLIENT_ID",
  "GROK_OAUTH2_PRINCIPAL_TYPE",
  "GROK_OAUTH2_PRINCIPAL_ID",
  "GROK_AUTH_PROVIDER_COMMAND",
  "GROK_LOCAL_AUTH",
  "GROK_CLI_CHAT_PROXY_BASE_URL",
  "GROK_MODELS_BASE_URL",
  "GROK_CONFIG",
  "GROK_CONFIG_PATH",
  "GROK_AUTH",
];

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isToken = (v: unknown): v is string => typeof v === "string" && v.startsWith(GATEWAY_TOKEN_PREFIX);

interface InstanceEnv {
  /** Names set on the instance (a sensitive value is redacted in settings.json, so only the name is known). */
  names: Set<string>;
  /** Readable plain values. */
  values: Map<string, string>;
}

function readEnv(instance: Json): InstanceEnv {
  const names = new Set<string>();
  const values = new Map<string, string>();
  if (Array.isArray(instance.environment)) {
    for (const item of instance.environment) {
      if (!isObject(item) || typeof item.name !== "string") continue;
      names.add(item.name);
      if (typeof item.value === "string" && item.value !== "" && item.valueRedacted !== true && item.sensitive !== true) values.set(item.name, item.value);
    }
  }
  return { names, values };
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** The app name of the last /gateway/<app> segment in a URL, if any. */
export function appFromBaseUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  let path = raw;
  try {
    path = new URL(raw).pathname;
  } catch {}
  let app: string | undefined;
  for (const m of path.matchAll(/\/gateway\/([^/?#]+)/g)) app = m[1];
  return app;
}

async function tokenFromFile(path: string): Promise<string | undefined> {
  const text = await readText(path).catch(() => undefined);
  const t = text?.trim();
  return isToken(t) ? t : undefined;
}

async function tokenFromSecrets(app: string | undefined, opts: UsageOptions): Promise<string | undefined> {
  if (!app) return undefined;
  const v = await readSecretsKey(appTokenKey(app), opts.secretsPath);
  return isToken(v) ? v : undefined;
}

function expand(path: string, home: string, base: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(base, path);
}

/** Whether `path` holds exactly `content` with mode 0600. */
async function isCurrent(path: string, content: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")) === content && ((await stat(path)).mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

/** Writes (unless check) a file that differs from `content` or is not 0600; "current" when nothing is to do. */
async function ensureFile(r: Omit<UsageResult, "status">, content: string, check: boolean): Promise<UsageResult> {
  if (await isCurrent(r.file, content)) return { ...r, status: "current" };
  if (!check) {
    await mkdir(dirname(r.file), { recursive: true });
    await writeFileAtomic(r.file, content);
    await chmod(r.file, 0o600);
  }
  return { ...r, status: "updated" };
}

const asJson = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

async function opencodeInstance(id: string, env: InstanceEnv, opts: UsageOptions, home: string): Promise<UsageResult[]> {
  const configDir = env.values.get("OPENCODE_CONFIG_DIR");
  const dataHome = env.values.get("XDG_DATA_HOME");
  const authFile = dataHome ? join(expand(dataHome, home, home), "opencode", "auth.json") : "-";
  if (!configDir || !dataHome) {
    return [{ id, driver: "opencode", file: authFile, status: "skipped", detail: "OPENCODE_CONFIG_DIR or XDG_DATA_HOME not set on the instance" }];
  }
  const dir = expand(configDir, home, home);
  const configFile = join(dir, "opencode.json");
  const fail = (file: string, detail: string): UsageResult[] => [{ id, driver: "opencode", file, status: "failed", detail }];
  let config: Json;
  try {
    const text = await readText(configFile);
    if (text === undefined) return fail(configFile, "opencode.json is missing");
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) return fail(configFile, "opencode.json is not a JSON object");
    config = parsed;
  } catch (err) {
    return fail(configFile, `opencode.json unreadable: ${(err as Error).message}`);
  }
  let app: string | undefined;
  let apiKey: unknown;
  if (isObject(config.provider)) {
    for (const p of Object.values(config.provider)) {
      const options = isObject(p) && isObject(p.options) ? p.options : undefined;
      const found = appFromBaseUrl(options?.baseURL);
      if (found) {
        app = found;
        apiKey = options?.apiKey;
        break;
      }
    }
  }
  if (!app) return fail(configFile, "no provider with a /gateway/<app> baseURL");
  let token = await tokenFromFile(join(dir, "token"));
  if (!token && isToken(apiKey)) token = apiKey;
  if (!token && typeof apiKey === "string") {
    const m = /^\{file:(.+)\}$/.exec(apiKey.trim());
    if (m) token = await tokenFromFile(expand(m[1]!.trim(), home, dir));
  }
  if (!token) token = await tokenFromSecrets(app, opts);
  if (!token) return fail(authFile, `no gateway token (${GATEWAY_TOKEN_PREFIX}...) for app ${app}`);

  const out: UsageResult[] = [];
  // auth.json: only the opencode-go entry is ours.
  try {
    const text = await readText(authFile);
    let auth: Json = {};
    if (text !== undefined && text.trim() !== "") {
      const parsed: unknown = JSON.parse(text);
      if (!isObject(parsed)) throw new Error("not a JSON object");
      auth = parsed;
    }
    auth[OPENCODE_GO] = { type: "api", key: token };
    out.push(await ensureFile({ id, driver: "opencode", file: authFile }, asJson(auth), opts.check === true));
  } catch (err) {
    out.push({ id, driver: "opencode", file: authFile, status: "failed", detail: `auth.json: ${(err as Error).message}` });
  }
  // opencode.json: the opencode binary must never send the gateway token to opencode.ai itself.
  try {
    const disabled = config.disabled_providers;
    if (disabled !== undefined && !Array.isArray(disabled)) {
      out.push({ id, driver: "opencode", file: configFile, status: "failed", detail: "disabled_providers is not an array" });
    } else if (disabled?.includes(OPENCODE_GO)) {
      out.push({ id, driver: "opencode", file: configFile, status: "current" });
    } else {
      config.disabled_providers = [...(disabled ?? []), OPENCODE_GO];
      const r: UsageResult = { id, driver: "opencode", file: configFile, status: "updated" };
      if (opts.check !== true) {
        const mode = (await stat(configFile)).mode & 0o777;
        await writeFileAtomic(configFile, asJson(config));
        await chmod(configFile, mode);
      }
      out.push(r);
    }
  } catch (err) {
    out.push({ id, driver: "opencode", file: configFile, status: "failed", detail: `opencode.json: ${(err as Error).message}` });
  }
  return out;
}

/**
 * T3 merges usage rows by driver and account email. Without an email, every T3 environment shows its own row for the
 * same Grok account. A fixed email per gateway app gives one row for each app across all T3 environments.
 */
export const grokAccountEmail = (app: string): string => `${app}@gateway.invalid`;

async function grokInstance(id: string, env: InstanceEnv, opts: UsageOptions, home: string): Promise<UsageResult[]> {
  const grokHome = env.values.get("GROK_HOME");
  if (!grokHome) return [{ id, driver: "grok", file: "-", status: "skipped", detail: "GROK_HOME not set on the instance" }];
  const dir = expand(grokHome, home, home);
  const authFile = join(dir, "auth.json");
  const out: UsageResult[] = [];
  const problem = (detail: string) => out.push({ id, driver: "grok", file: authFile, status: "problem", detail });
  const blocking = GROK_BLOCKING_ENV.filter((n) => env.names.has(n));
  if (blocking.length > 0) problem(`${blocking.join(", ")} set on the instance: T3 then shows no Grok usage`);
  const authPath = env.values.get("GROK_AUTH_PATH");
  if (!authPath) problem("GROK_AUTH_PATH is not set: the grok binary would read the T3-facing auth.json");
  else if (resolve(expand(authPath, home, home)) === resolve(authFile)) problem("GROK_AUTH_PATH equals <GROK_HOME>/auth.json: the grok binary would read the T3-facing file");
  const app = appFromBaseUrl(env.values.get("GROK_XAI_API_BASE_URL"));
  const token = (await tokenFromFile(join(dir, "token"))) ?? (await tokenFromSecrets(app, opts));
  if (!token) {
    out.push({ id, driver: "grok", file: authFile, status: "failed", detail: `no gateway token (${GATEWAY_TOKEN_PREFIX}...)${app ? ` for app ${app}` : " (no /gateway/<app> in GROK_XAI_API_BASE_URL)"}` });
    return out;
  }
  try {
    out.push(await ensureFile({ id, driver: "grok", file: authFile }, asJson({ [GROK_CREDENTIAL]: { key: token, auth_mode: "oidc", email: grokAccountEmail(app ?? id) } }), opts.check === true));
  } catch (err) {
    out.push({ id, driver: "grok", file: authFile, status: "failed", detail: (err as Error).message });
  }
  return out;
}

/** One result per file of every OpenCode and Grok instance in T3's settings.json. Never writes settings.json. */
export async function syncT3UsageCredentials(opts: UsageOptions = {}): Promise<UsageResult[]> {
  const home = opts.home ?? homedir();
  const settings = join(t3Paths({ home, env: opts.env }).t3Home, "userdata", "settings.json");
  let instances: Json;
  try {
    const text = await readText(settings);
    if (text === undefined) return [];
    const parsed: unknown = JSON.parse(text);
    instances = isObject(parsed) && isObject(parsed.providerInstances) ? parsed.providerInstances : {};
  } catch (err) {
    return [{ id: "-", driver: "-", file: settings, status: "failed", detail: `settings.json unreadable: ${(err as Error).message}` }];
  }
  const results: UsageResult[] = [];
  for (const [id, raw] of Object.entries(instances)) {
    if (!isObject(raw)) continue;
    try {
      if (raw.driver === "opencode") results.push(...(await opencodeInstance(id, readEnv(raw), opts, home)));
      else if (raw.driver === "grok") results.push(...(await grokInstance(id, readEnv(raw), opts, home)));
    } catch (err) {
      results.push({ id, driver: String(raw.driver), file: "-", status: "failed", detail: (err as Error).message });
    }
  }
  return results;
}

/** One output line: id, driver, file, status (and the reason). */
export function describeUsageResult(r: UsageResult, check = false): string {
  const status = check && r.status === "updated" ? "out of date" : r.status;
  return `${r.id} ${r.driver} ${r.file} ${status}${r.detail ? `: ${r.detail}` : ""}`;
}

/** Results that make `--check` fail. */
export const isUsageTrouble = (r: UsageResult, check: boolean): boolean => r.status === "failed" || r.status === "problem" || (check && r.status === "updated");
