import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appTokenKey, readSecretsKey } from "../cli/gateway/secrets-file.ts";
import { GATEWAY_ENTRY_SCOPES_WITH_USAGE_PROXY, GATEWAY_TOKEN_PREFIX, gatewayEntryText } from "./claude-gateway-entry.ts";
import { withLoopbackNoProxy } from "./claude-usage-proxy.ts";
import { writeFileAtomic } from "./pool/fs.ts";
import { t3Paths } from "./t3-anthropic-proxy.ts";
import { syncT3UsageCredentials, type UsageResult } from "./t3-usage-credentials.ts";

/**
 * Creates or updates one T3 Code provider instance (claude, grok, opencode or pi) whose folder holds only the gateway app token,
 * never a provider key. T3 watches settings.json and applies the change by itself.
 */

export type InstanceDriver = "claude" | "grok" | "opencode" | "pi";

export interface T3InstanceOptions {
  id: string;
  driver: InstanceDriver;
  app: string;
  /** Full gateway URL for the app, e.g. https://<host>/gateway/<app> (resolved by the caller). */
  gatewayUrl: string;
  name?: string;
  models?: string[];
  /** Upstream provider slug of the app (pi only). Falls back to the app name. */
  provider?: string;
  like?: string;
  binary?: string;
  /** CONNECT proxy URL (claude only). */
  proxyUrl?: string;
  /** CA file for the CONNECT proxy (claude only). */
  caPath?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  secretsPath?: string;
  now?: () => number;
  /** Fetch used for the gateway profile lookup (claude only). Injectable for tests. */
  fetch?: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  check?: boolean;
  remove?: boolean;
}

export interface T3InstanceResult {
  status: "created" | "updated" | "current" | "removed" | "absent";
  /** What differs (check) or was changed. Never holds a token. */
  changes: string[];
  backup?: string;
  folder: string;
  usage?: UsageResult[];
  /** Non-fatal problems, for example a failed gateway profile lookup. */
  warnings?: string[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = obj(v);
  if (o) return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function readJsonObject(path: string): Promise<Json | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  const parsed = obj(JSON.parse(text));
  if (!parsed) throw new Error(`${path} is not a JSON object`);
  return parsed;
}

async function fileMatches(path: string, content: string, mode: number): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")) === content && ((await stat(path)).mode & 0o777) === mode;
  } catch {
    return false;
  }
}

/** Where the grok launchers live: a second T3 home gets its own directory. */
export function grokLauncherPath(id: string, opts: { home?: string; env?: Record<string, string | undefined> } = {}): string {
  const home = opts.home ?? homedir();
  const t3Home = t3Paths({ home, ...(opts.env ? { env: opts.env } : {}) }).t3Home;
  const dir = t3Home === join(home, ".t3") ? "grok" : `grok-${createHash("sha256").update(t3Home).digest("hex").slice(0, 8)}`;
  return join(home, ".ais", "t3", dir, id);
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The launcher picks the grok binary each time it starts, so a newer T3 install is used without a re-run.
 * An explicit binary always wins. Without one it uses the newest T3-managed grok from the ACP registry
 * install records, and then the fallback path.
 * `grok agent ...` (the ACP session T3 starts) runs behind the AIS relay when `ais` has it, so a usage limit snoozes the
 * thread and resumes it at the reset time (src/acp/limit-snooze.ts). Without `ais` the binary starts directly.
 */
export function grokLauncherSource(opts: { binary?: string; t3Home: string; fallback: string; ais?: string }): string {
  const resolve = opts.binary
    ? [`BIN=${shQuote(opts.binary)}`]
    : [
        `BIN=""`,
        `BEST=""`,
        `for f in ${shQuote(join(opts.t3Home, "caches", "acp-registry", "package-installs"))}/grok-build-*.json; do`,
        `  [ -r "$f" ] || continue`,
        `  v=$(sed -n 's/.*"agentVersion"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$f" | head -n 1)`,
        `  e=$(sed -n 's/.*"executablePath"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$f" | head -n 1)`,
        `  [ -n "$v" ] && [ -n "$e" ] && [ -f "$e" ] || continue`,
        `  if [ -z "$BEST" ] || [ "$(printf '%s\\n%s\\n' "$BEST" "$v" | sort -V | tail -n 1)" = "$v" ]; then`,
        `    BEST="$v"`,
        `    BIN="$e"`,
        `  fi`,
        `done`,
        `[ -n "$BIN" ] || BIN=${shQuote(opts.fallback)}`,
      ];
  return [
    "#!/bin/sh",
    "# Written by `ais gateway t3-instance`; do not edit. Starts grok with the gateway token of this instance folder.",
    'if [ -z "$GROK_HOME" ] || [ ! -r "$GROK_HOME/token" ]; then',
    '  echo "grok launcher: cannot read the gateway token at \\$GROK_HOME/token (GROK_HOME=${GROK_HOME:-unset})" >&2',
    "  exit 1",
    "fi",
    "# Use XAI_API_KEY, not GROK_CODE_XAI_API_KEY: with the second one `grok models` says \"You are not authenticated\"",
    "# and T3 shows the instance as not logged in. This is safe for usage: T3's usage reader checks only the",
    "# instance environment in settings.json, and that never holds XAI_API_KEY.",
    `XAI_API_KEY=$(tr -d '\\r\\n' < "$GROK_HOME/token")`,
    "export XAI_API_KEY",
    "unset GROK_CODE_XAI_API_KEY",
    ...resolve,
    "# T3 reads `models` output with /you are logged in/i. With XAI_API_KEY grok prints \"You are using XAI_API_KEY.\",",
    "# which T3 treats as unknown, so rewrite that line. Other subcommands (stdio ACP) stay a direct exec.",
    'if [ "$1" = "models" ]; then',
    '  OUT=$("$BIN" "$@" 2>&1)',
    "  RC=$?",
    `  printf '%s\\n' "$OUT" | sed 's/^You are using XAI_API_KEY\\.\\{0,1\\}$/You are logged in (AIS gateway token)./'`,
    '  exit "$RC"',
    "fi",
    ...(opts.ais
      ? [
          `AIS=${shQuote(opts.ais)}`,
          'if [ "$1" = "agent" ] && [ -x "$AIS" ] && "$AIS" __acp_relay --supported >/dev/null 2>&1; then',
          '  exec "$AIS" __acp_relay grok-build "--binary=$BIN" "$@"',
          "fi",
        ]
      : []),
    'exec "$BIN" "$@"',
    "",
  ].join("\n");
}

/** One planned file: written when it differs. */
interface Plan {
  path: string;
  content: string;
  mode: number;
  label: string;
  /** Only written when the file is missing. */
  onlyIfMissing?: boolean;
}

async function backupSettings(backupsDir: string, before: string, now: number): Promise<string> {
  await mkdir(backupsDir, { recursive: true });
  const stem = join(backupsDir, `settings.json.pre-t3-instance.${Math.floor(now / 1000)}`);
  let saved = stem;
  for (let n = 1; ; n++) {
    try {
      await writeFile(saved, before, { mode: 0o600, flag: "wx" });
      return saved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || n > 100) throw err;
      saved = `${stem}.${n}`;
    }
  }
}

async function writeSettings(path: string, before: string | undefined, settings: Json, backupsDir: string, now: number): Promise<string | undefined> {
  let backup: string | undefined;
  let mode = 0o600;
  let indent: string | number = 2;
  let newline = true;
  if (before !== undefined) {
    backup = await backupSettings(backupsDir, before, now);
    mode = (await stat(path)).mode & 0o777;
    indent = /^\{\r?\n([ \t]+)"/.exec(before)?.[1] ?? (before.includes("\n") ? 2 : 0);
    newline = before.endsWith("\n");
  } else {
    await mkdir(dirname(path), { recursive: true });
  }
  await writeFileAtomic(path, `${JSON.stringify(settings, null, indent)}${newline ? "\n" : ""}`);
  await chmod(path, mode);
  return backup;
}

/** The gateway profile account uuid, or a reason string when it cannot be read. */
async function fetchProfileUuid(opts: T3InstanceOptions, token: string): Promise<{ uuid: string } | { error: string }> {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await doFetch(`${opts.gatewayUrl.replace(/\/+$/, "")}/api/oauth/profile`, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: ctl.signal,
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const uuid = obj(obj(await res.json())?.account)?.uuid;
    return typeof uuid === "string" && uuid !== "" ? { uuid } : { error: "no account uuid in the response" };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Creates, updates, checks or removes one T3 provider instance. */
export async function applyT3Instance(opts: T3InstanceOptions): Promise<T3InstanceResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(opts.id)) throw new Error(`Instance id "${opts.id}" must be letters, digits, dot, dash or underscore`);
  const home = opts.home ?? homedir();
  const t3Home = t3Paths({ home, ...(opts.env ? { env: opts.env } : {}) }).t3Home;
  const settingsPath = join(t3Home, "userdata", "settings.json");
  const backupsDir = join(t3Home, "backups");
  const folder = join(t3Home, "gateway", opts.id);
  const check = opts.check === true;
  const now = (opts.now ?? Date.now)();

  const beforeText = await readText(settingsPath);
  const settings: Json = beforeText === undefined ? {} : (obj(JSON.parse(beforeText)) ?? (() => { throw new Error(`${settingsPath} is not a JSON object`); })());
  const instances = obj(settings.providerInstances) ?? {};
  const existing = obj(instances[opts.id]);

  if (opts.remove) {
    if (!existing) return { status: "absent", changes: [], folder };
    const changes = [`instance ${opts.id} removed from settings.json`];
    if (check) return { status: "removed", changes, folder };
    delete instances[opts.id];
    settings.providerInstances = instances;
    const backup = await writeSettings(settingsPath, beforeText, settings, backupsDir, now);
    return { status: "removed", changes, ...(backup ? { backup } : {}), folder };
  }

  const token = await readSecretsKey(appTokenKey(opts.app), opts.secretsPath);
  if (!token || !token.startsWith(GATEWAY_TOKEN_PREFIX)) throw new Error(`No gateway token (${GATEWAY_TOKEN_PREFIX}...) for app ${opts.app} in the secrets file`);
  const displayName = opts.name ?? opts.id;
  const models = opts.models ?? [];
  const plans: Plan[] = [{ path: join(folder, "token"), content: `${token}\n`, mode: 0o600, label: "token" }];
  let entry: Json;

  if (opts.driver === "claude") {
    if (!opts.proxyUrl) throw new Error("The CONNECT proxy URL is unknown");
    let like: Json | undefined;
    if (opts.like) {
      like = obj(instances[opts.like]);
      if (!like || like.driver !== "claudeAgent") throw new Error(`--like ${opts.like} is not a claude instance in settings.json`);
    }
    const likeConfig = obj(like?.config);
    const binaryPath = opts.binary ?? (typeof likeConfig?.binaryPath === "string" && likeConfig.binaryPath !== "" ? likeConfig.binaryPath : join(home, ".local", "bin", "claude"));
    const config: Json = { ...obj(existing?.config), binaryPath, homePath: folder };
    if (models.length > 0) config.customModels = models;
    else delete config.customModels;
    entry = { ...existing, driver: "claudeAgent", displayName, enabled: true, config };

    const own = (await readJsonObject(join(folder, "settings.json"))) ?? {};
    const env: Json = { ...obj(own.env) };
    env.ANTHROPIC_BASE_URL = opts.gatewayUrl;
    env.HTTPS_PROXY = opts.proxyUrl;
    if (opts.caPath) env.NODE_EXTRA_CA_CERTS = opts.caPath;
    env.NO_PROXY = withLoopbackNoProxy(env.NO_PROXY ?? env.no_proxy);
    delete env.no_proxy;
    if (models.length > 0) {
      const first = models[0]!;
      Object.assign(env, {
        ANTHROPIC_MODEL: first,
        ANTHROPIC_DEFAULT_OPUS_MODEL: first,
        ANTHROPIC_DEFAULT_SONNET_MODEL: first,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: models[models.length - 1]!,
        CLAUDE_CODE_SUBAGENT_MODEL: first,
      });
    }
    own.env = env;
    if (like) {
      const likeHome = typeof likeConfig?.homePath === "string" ? likeConfig.homePath : undefined;
      const hooks = likeHome ? obj(await readJsonObject(join(likeHome, "settings.json")))?.hooks : undefined;
      if (hooks !== undefined) own.hooks = hooks;
    }
    plans.push({ path: join(folder, "settings.json"), content: `${JSON.stringify(own, null, 2)}\n`, mode: 0o600, label: "settings.json (folder)" });
    plans.push({ path: join(folder, ".credentials.json"), content: gatewayEntryText(token, GATEWAY_ENTRY_SCOPES_WITH_USAGE_PROXY), mode: 0o600, label: ".credentials.json" });
    plans.push({ path: join(folder, ".claude.json"), content: `${JSON.stringify({ hasCompletedOnboarding: true })}\n`, mode: 0o600, label: ".claude.json", onlyIfMissing: true });
  } else if (opts.driver === "pi") {
    if (models.length === 0) throw new Error("--models=a,b is required for the pi driver");
    const binaryPath = opts.binary ?? join(home, ".local", "bin", "pi");
    const config: Json = { ...obj(existing?.config), binaryPath, customModels: models };
    entry = {
      ...existing,
      driver: "pi",
      displayName,
      enabled: true,
      environment: [{ name: "PI_CODING_AGENT_DIR", value: folder, sensitive: false }],
      config,
    };
    const provider = opts.provider ?? opts.app;
    const own = (await readJsonObject(join(folder, "models.json"))) ?? {};
    const providers = { ...obj(own.providers) };
    // The key is read from the token file at run time ("!" runs a shell command), so models.json holds no token.
    providers[provider] = {
      baseUrl: opts.gatewayUrl,
      api: "anthropic-messages",
      apiKey: `!cat ${shQuote(join(folder, "token"))}`,
      models: models.map((id) => ({ id, name: id, contextWindow: 262144, maxTokens: 32768, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    };
    own.providers = providers;
    plans.push({ path: join(folder, "models.json"), content: `${JSON.stringify(own, null, 2)}\n`, mode: 0o600, label: "models.json" });
    const piSettings = (await readJsonObject(join(folder, "settings.json"))) ?? {};
    piSettings.defaultProvider = provider;
    piSettings.defaultModel = models[0]!;
    plans.push({ path: join(folder, "settings.json"), content: `${JSON.stringify(piSettings, null, 2)}\n`, mode: 0o600, label: "settings.json (folder)" });
  } else if (opts.driver === "opencode") {
    let likeBinary: string | undefined;
    if (opts.like) {
      const like = obj(instances[opts.like]);
      if (!like || like.driver !== "opencode") throw new Error(`--like ${opts.like} is not an opencode instance in settings.json`);
      const b = obj(like.config)?.binaryPath;
      if (typeof b === "string" && b !== "") likeBinary = b;
    }
    const config: Json = { ...obj(existing?.config), binaryPath: opts.binary ?? likeBinary ?? (typeof obj(existing?.config)?.binaryPath === "string" ? (obj(existing?.config)!.binaryPath as string) : join(home, ".local", "bin", "opencode")) };
    entry = {
      ...existing,
      driver: "opencode",
      displayName,
      enabled: true,
      environment: [
        { name: "OPENCODE_CONFIG_DIR", value: folder, sensitive: false },
        { name: "XDG_DATA_HOME", value: folder, sensitive: false },
      ],
      config,
    };
    // The folder opencode.json points at the gateway. The usage writer adds disabled_providers and auth.json afterwards,
    // so existing keys (disabled_providers included) are kept and only ours are set.
    const own = (await readJsonObject(join(folder, "opencode.json"))) ?? { $schema: "https://opencode.ai/config.json", permission: { "*": "allow", external_directory: "allow" } };
    const providers = obj(own.provider) ?? {};
    const gw = obj(providers.gateway) ?? {};
    const options: Json = { ...obj(gw.options), baseURL: opts.gatewayUrl, apiKey: "{file:token}", headers: { "x-opencode-session": opts.id } };
    const gwOut: Json = { npm: "@ai-sdk/openai-compatible", name: "OpenCode Go (gateway)", ...gw, options };
    if (models.length > 0) gwOut.models = Object.fromEntries(models.map((m) => [m, { name: m }]));
    own.provider = { ...providers, gateway: gwOut };
    plans.push({ path: join(folder, "opencode.json"), content: `${JSON.stringify(own, null, 2)}\n`, mode: 0o600, label: "opencode.json" });
  } else {
    const launcher = grokLauncherPath(opts.id, { home, ...(opts.env ? { env: opts.env } : {}) });
    const config: Json = { ...obj(existing?.config), binaryPath: launcher };
    if (models.length > 0) config.customModels = models;
    else delete config.customModels;
    entry = {
      ...existing,
      driver: "grok",
      displayName,
      enabled: true,
      environment: [
        { name: "GROK_HOME", value: folder, sensitive: false },
        { name: "GROK_AUTH_PATH", value: join(folder, "cli-auth.json"), sensitive: false },
        { name: "GROK_XAI_API_BASE_URL", value: opts.gatewayUrl, sensitive: false },
      ],
      config,
    };
    plans.push({ path: launcher, content: grokLauncherSource({ ...(opts.binary ? { binary: opts.binary } : {}), t3Home, fallback: join(home, ".local", "bin", "grok"), ais: join(home, ".local", "bin", "ais") }), mode: 0o755, label: "launcher" });
  }

  const warnings: string[] = [];
  if (opts.driver === "claude") {
    // A folder that held an old login keeps a cached oauthAccount of that account; drop it when it is not the gateway account.
    const cjPath = join(folder, ".claude.json");
    const cjText = await readText(cjPath);
    let cj: Json | undefined;
    try {
      cj = cjText === undefined ? undefined : obj(JSON.parse(cjText));
    } catch {
      cj = undefined;
    }
    if (cjText !== undefined && cj && "oauthAccount" in cj) {
      const profile = await fetchProfileUuid(opts, token);
      if ("error" in profile) warnings.push(`could not read the gateway profile (${profile.error}); ${cjPath} left unchanged`);
      else if (obj(cj.oauthAccount)?.accountUuid !== profile.uuid) {
        delete cj.oauthAccount;
        const indent = /^\{\r?\n([ \t]+)"/.exec(cjText)?.[1] ?? (cjText.includes("\n") ? 2 : 0);
        plans.push({ path: cjPath, content: `${JSON.stringify(cj, null, indent)}${cjText.endsWith("\n") ? "\n" : ""}`, mode: 0o600, label: "account" });
      }
    }
  }

  const changes: string[] = [];
  const toWrite: Plan[] = [];
  for (const p of plans) {
    const missing = (await readText(p.path)) === undefined;
    if (p.onlyIfMissing ? missing : !(await fileMatches(p.path, p.content, p.mode))) {
      changes.push(p.label);
      toWrite.push(p);
    }
  }
  const entryChanged = stable(existing) !== stable(entry);
  if (entryChanged) changes.push(`settings.json instance ${opts.id}`);

  let backup: string | undefined;
  if (!check) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await chmod(folder, 0o700);
    for (const p of toWrite) {
      await mkdir(dirname(p.path), { recursive: true });
      await writeFileAtomic(p.path, p.content);
      await chmod(p.path, p.mode);
    }
    if (entryChanged) {
      settings.providerInstances = { ...instances, [opts.id]: entry };
      backup = await writeSettings(settingsPath, beforeText, settings, backupsDir, now);
    }
  }

  let usage: UsageResult[] | undefined;
  // opencode: the usage writer reads the instance from settings.json and the folder opencode.json, so a check with
  // either still to be written has nothing to read yet; the changes list already reports it.
  const usageReady = opts.driver === "grok" || (opts.driver === "opencode" && (!check || (toWrite.length === 0 && !entryChanged)));
  if (usageReady) {
    usage = (await syncT3UsageCredentials({ home, ...(opts.env ? { env: opts.env } : {}), ...(opts.secretsPath ? { secretsPath: opts.secretsPath } : {}), check })).filter((r) => r.id === opts.id);
    for (const r of usage) if (r.status === "updated") changes.push(`usage credential ${r.file}`);
  }
  const status = changes.length === 0 ? "current" : existing ? "updated" : "created";
  return { status, changes, ...(backup ? { backup } : {}), folder, ...(usage ? { usage } : {}), ...(warnings.length > 0 ? { warnings } : {}) };
}
