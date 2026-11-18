import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appTokenKey, readSecretsKey } from "../cli/gateway/secrets-file.ts";
import { GATEWAY_ENTRY_SCOPES_WITH_USAGE_PROXY, GATEWAY_TOKEN_PREFIX, gatewayEntryText } from "./claude-gateway-entry.ts";
import { writeFileAtomic } from "./pool/fs.ts";
import { t3Paths } from "./t3-anthropic-proxy.ts";
import { syncT3UsageCredentials, type UsageResult } from "./t3-usage-credentials.ts";

/**
 * Creates or updates one T3 Code provider instance (claude or grok) whose folder holds only the gateway app token,
 * never a provider key. T3 watches settings.json and applies the change by itself.
 */

export type InstanceDriver = "claude" | "grok";

export interface T3InstanceOptions {
  id: string;
  driver: InstanceDriver;
  app: string;
  /** Full gateway URL for the app, e.g. https://<host>/gateway/<app> (resolved by the caller). */
  gatewayUrl: string;
  name?: string;
  models?: string[];
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

export function grokLauncherSource(binary: string): string {
  return [
    "#!/bin/sh",
    "# Written by `ais gateway t3-instance`; do not edit. Starts grok with the gateway token of this instance folder.",
    'if [ -z "$GROK_HOME" ] || [ ! -r "$GROK_HOME/token" ]; then',
    '  echo "grok launcher: cannot read the gateway token at \\$GROK_HOME/token (GROK_HOME=${GROK_HOME:-unset})" >&2',
    "  exit 1",
    "fi",
    `GROK_CODE_XAI_API_KEY=$(tr -d '\\r\\n' < "$GROK_HOME/token")`,
    "export GROK_CODE_XAI_API_KEY",
    "unset XAI_API_KEY",
    `exec ${shQuote(binary)} "$@"`,
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
    env.NO_PROXY = "127.0.0.1,localhost,::1";
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
  } else {
    const launcher = grokLauncherPath(opts.id, { home, ...(opts.env ? { env: opts.env } : {}) });
    const binary = opts.binary ?? join(home, ".local", "bin", "grok");
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
    plans.push({ path: launcher, content: grokLauncherSource(binary), mode: 0o755, label: "launcher" });
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
  if (opts.driver === "grok") {
    usage = (await syncT3UsageCredentials({ home, ...(opts.env ? { env: opts.env } : {}), ...(opts.secretsPath ? { secretsPath: opts.secretsPath } : {}), check })).filter((r) => r.id === opts.id);
    for (const r of usage) if (r.status === "updated") changes.push(`usage credential ${r.file}`);
  }
  const status = changes.length === 0 ? "current" : existing ? "updated" : "created";
  return { status, changes, ...(backup ? { backup } : {}), folder, ...(usage ? { usage } : {}) };
}
