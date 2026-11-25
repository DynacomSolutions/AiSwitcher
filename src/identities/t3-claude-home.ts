import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./pool/fs.ts";
import { CLAUDE_PROXY_ENV_KEYS } from "./claude-usage-proxy.ts";

/**
 * A T3 Claude home (`<T3 home>/gateway/pool-home`, `t3-claude-<id>`) is a full copy of the config of its source
 * identity (settings.json, enabled plugins, plugin configs, marketplaces, hooks, retention). Only the gateway auth and
 * routing env keys and the attribution keys differ, and the local-login swap hook is dropped.
 *
 * Plugin trees (`plugins/cache`, `plugins/marketplaces`) are not copied. The two plugin JSON files keep their absolute
 * paths, so the home reads the plugin files of the source identity and stays in step with it.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);

/** Env keys that carry gateway auth, routing or the model choice. They come from the T3 home, never from the source. */
export const GATEWAY_ENV_KEYS: readonly string[] = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  ...CLAUDE_PROXY_ENV_KEYS,
];

/** Env keys that may differ between a home and its source: gateway auth, routing, proxy and CA settings. */
export const isAuthEnvKey = (key: string): boolean =>
  key.startsWith("ANTHROPIC_") || GATEWAY_ENV_KEYS.includes(key) || /^(CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH|CLAUDE_CODE_API_KEY|AWS_|GOOGLE_APPLICATION|VERTEX|OPENAI_)/.test(key);
export const isAllowedEnvKey = (key: string): boolean => isAuthEnvKey(key) || key === "NODE_EXTRA_CA_CERTS" || /^no_proxy$/i.test(key) || key in TELEMETRY_OFF_ENV;

/** Top-level settings keys that hold login or credential routing. They are never copied from the source: the home keeps its own. */
export const AUTH_SETTINGS_KEYS: readonly string[] = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "forceLoginMethod", "forceLoginOrgUUID", "otelHeadersHelper"];

/**
 * Telemetry opt-outs forced into every T3 Claude home (owner order, 25 Nov 2026). They stop sends, so they are exempt from
 * the third-party filter. CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is not set: it also stops model listing and auth fetches.
 */
export const TELEMETRY_OFF_ENV: Readonly<Record<string, string>> = { DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DO_NOT_TRACK: "1" };
const isTelemetryOffKey = (key: string): boolean => key in TELEMETRY_OFF_ENV;
/** Telemetry opt-out keys of an env that are missing or have a wrong value. */
export const missingTelemetryOff = (env: unknown): string[] => Object.entries(TELEMETRY_OFF_ENV).filter(([k, v]) => obj(env)?.[k] !== v).map(([k]) => k);

/** Gateway values of the attribution keys (no tool attribution in commits or PRs). */
export const GATEWAY_ATTRIBUTION: Json = { attribution: { commit: "", pr: "" }, includeCoAuthoredBy: false, gitAttribution: false };

/** Marks a plugin, marketplace, hook or env key that sends session content to a third party. */
const THIRD_PARTY = /jev|typesafe|compaction|telemetry|otel[-_./:=]|[-_./:]otel/i;
export const isThirdPartySender = (text: string): boolean => THIRD_PARTY.test(text);
/** An env value, hook, status line or other value that names a third-party sender anywhere in its text. */
const sendsThirdParty = (v: unknown): boolean => isThirdPartySender(typeof v === "string" ? v : JSON.stringify(v) ?? "");
const hookText = (h: unknown): string => `${obj(h)?.command ?? ""} ${obj(h)?.url ?? ""}`;
const isAisGatewayUrl = (v: unknown): boolean => typeof v === "string" && /\/gateway\//.test(v);

/** Top-level settings keys that choose the model. A home that routes to another model keeps its own and never copies the source's. */
export const MODEL_SETTINGS_KEYS: readonly string[] = ["model", "modelSettings", "effortLevel", "switchModelsOnFlag"];
/** Env keys that choose the model or its effort. */
export const isModelEnvKey = (key: string): boolean => /MODEL/.test(key) || key === "CLAUDE_CODE_EFFORT_LEVEL";

const SWAP_HOOK = /\bais\s+claude-swap\b/;

export interface T3ClaudeConfigOptions {
  /** Source identity is a restricted identity: nothing that sends to a third party is copied. */
  noThirdParty?: boolean;
  /** The home routes to other models (Kimi, Z.ai): its own model keys stay and the source's model keys are never copied. */
  modelHome?: boolean;
}

const clone = <T>(v: T): T => structuredClone(v);

function filterHooks(hooks: unknown, drop: (hookText: string) => boolean): unknown {
  const events = obj(hooks);
  if (!events) return hooks;
  const out: Json = {};
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = groups
      .map((g) => {
        const group = obj(g);
        const list = group?.hooks;
        if (!group || !Array.isArray(list)) return g;
        const hooksKept = list.filter((h) => !drop(hookText(h)));
        return hooksKept.length === 0 ? undefined : { ...group, hooks: hooksKept };
      })
      .filter((g) => g !== undefined);
    if (kept.length > 0) out[event] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One "event\tmatcher\tcommand" string per hook command. Order and duplicates do not count. */
export function hookKeys(hooks: unknown): string[] {
  const events = obj(hooks);
  if (!events) return [];
  const out = new Set<string>();
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const group = obj(g);
      const list = group?.hooks;
      if (!Array.isArray(list)) continue;
      for (const h of list) {
        const text = hookText(h).trim();
        if (text) out.add(`${event}\t${typeof group!.matcher === "string" ? group!.matcher : ""}\t${text}`);
      }
    }
  }
  return [...out].sort();
}

/** Adds the hook commands of `extra` that `have` does not hold yet. */
function mergeHooks(base: unknown, extra: unknown, have: Set<string>): unknown {
  const events = obj(extra);
  if (!events) return base;
  const out: Json = { ...obj(base) };
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const group = obj(g);
      const list = group?.hooks;
      if (!group || !Array.isArray(list)) continue;
      const matcher = typeof group.matcher === "string" ? group.matcher : "";
      const fresh = list.filter((h) => hookText(h).trim() !== "" && !have.has(`${event}\t${matcher}\t${hookText(h).trim()}`));
      if (fresh.length === 0) continue;
      for (const h of fresh) have.add(`${event}\t${matcher}\t${hookText(h).trim()}`);
      out[event] = [...(Array.isArray(out[event]) ? (out[event] as unknown[]) : []), { ...group, hooks: fresh }];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function filterKeys(record: unknown, drop: (key: string) => boolean): unknown {
  const o = obj(record);
  return o ? Object.fromEntries(Object.entries(o).filter(([k]) => !drop(k))) : record;
}

/**
 * The expected settings.json of a T3 Claude home: the source settings with the gateway keys of `own` (the home's current
 * settings) and the gateway attribution values. Pure.
 */
export function composeT3ClaudeSettings(source: Json, own: Json, opts: T3ClaudeConfigOptions = {}): Json {
  const out: Json = clone(source);
  const restricted = opts.noThirdParty === true;
  const ownEnv = obj(own.env) ?? {};
  const env: Json = obj(out.env) ? { ...(out.env as Json) } : {};
  // Source auth and routing keys are never copied. The home keeps its own values of every allowed key.
  for (const key of Object.keys(env)) if (isAuthEnvKey(key)) delete env[key];
  for (const key of Object.keys(ownEnv)) if (isAllowedEnvKey(key)) env[key] = ownEnv[key];
  if (opts.modelHome) {
    for (const key of Object.keys(env)) if (isModelEnvKey(key)) delete env[key];
    for (const key of Object.keys(ownEnv)) if (isModelEnvKey(key)) env[key] = ownEnv[key];
    for (const key of MODEL_SETTINGS_KEYS) {
      delete out[key];
      if (key in own) out[key] = own[key];
    }
  }
  out.env = env;
  for (const key of AUTH_SETTINGS_KEYS) {
    delete out[key];
    if (key in own) out[key] = own[key];
  }
  Object.assign(out, GATEWAY_ATTRIBUTION);
  const drop = (text: string) => SWAP_HOOK.test(text) || (restricted && isThirdPartySender(text));
  let hooks = filterHooks(out.hooks, drop);
  // Hooks that only the home has (for example the ones the agent-guard installer adds) stay.
  hooks = mergeHooks(hooks, filterHooks(own.hooks, drop), new Set(hookKeys(hooks)));
  if (hooks === undefined) delete out.hooks;
  else out.hooks = hooks;
  // Entries that only the home has stay, except third-party senders in a restricted home.
  for (const key of ["enabledPlugins", "pluginConfigs", "extraKnownMarketplaces"]) {
    const ownMap = obj(own[key]);
    if (!ownMap) continue;
    const merged: Json = { ...obj(out[key]) };
    for (const [k, v] of Object.entries(ownMap)) if (!(k in merged) && !(restricted && isThirdPartySender(k))) merged[k] = v;
    out[key] = merged;
  }
  if (restricted) {
    out.env = Object.fromEntries(Object.entries(out.env as Json).filter(([k, v]) => isTelemetryOffKey(k) || (!isThirdPartySender(k) && !sendsThirdParty(v))));
    for (const key of ["enabledPlugins", "pluginConfigs", "extraKnownMarketplaces"]) if (key in out) out[key] = filterKeys(out[key], isThirdPartySender);
    if (out.statusLine !== undefined && sendsThirdParty(out.statusLine)) delete out.statusLine;
  }
  out.env = { ...(out.env as Json), ...TELEMETRY_OFF_ENV };
  return out;
}

/** The version of an installed plugin entry (`installed_plugins.json` holds a list of installs per plugin id). */
export function pluginVersion(entry: unknown): string | undefined {
  const list = Array.isArray(entry) ? entry : [entry];
  for (const e of list) {
    const v = obj(e)?.version;
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. Versions that are not dotted numbers and differ count as older. */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  const num = (v: string) => (/^v?\d+(?:\.\d+)*(?:[-+].*)?$/.test(v) ? v.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map(Number) : undefined);
  const x = num(a);
  const y = num(b);
  if (!x || !y) return -1;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Plugins where the home runs an older version than the source (the repair installs the source version), and where the source is behind. */
function pluginVersionGaps(expected: Json | undefined, home: Json | undefined): { older: string[]; sourceBehind: string[] } {
  const older: string[] = [];
  const sourceBehind: string[] = [];
  const e = obj(expected?.plugins) ?? {};
  const h = obj(home?.plugins) ?? {};
  for (const [id, entry] of Object.entries(e)) {
    const want = pluginVersion(entry);
    const have = pluginVersion(h[id]);
    if (!want || !have) continue;
    const c = compareVersions(have, want);
    if (c < 0) older.push(`${id} ${have} -> ${want}`);
    else if (c > 0) sourceBehind.push(`${id}: home ${have} is ahead of source ${want}, the source needs an update`);
  }
  return { older, sourceBehind };
}

/**
 * The expected plugin JSON files. A plugin the home already has keeps its own entry (own install path, own cache), so a
 * home with its own plugin cache is in step. Missing plugins and marketplaces come from the source. Pure.
 */
export function composeT3ClaudePluginFiles(installed: Json | undefined, marketplaces: Json | undefined, opts: T3ClaudeConfigOptions = {}, own: { installed?: Json; marketplaces?: Json } = {}, exists: (path: string) => boolean = existsSync): { installed?: Json; marketplaces?: Json; skipped?: string[] } {
  const out: { installed?: Json; marketplaces?: Json; skipped?: string[] } = {};
  if (installed) {
    const copy = clone(installed);
    let plugins = obj(copy.plugins) ?? {};
    if (opts.noThirdParty) plugins = filterKeys(plugins, isThirdPartySender) as Json;
    const ownPlugins = obj(own.installed?.plugins) ?? {};
    // A plugin whose home version is older than the source version takes the source entry (the source version is installed).
    const merged = Object.fromEntries(Object.entries(plugins).map(([id, v]) => {
      if (!(id in ownPlugins)) return [id, v];
      const want = pluginVersion(v);
      const have = pluginVersion(ownPlugins[id]);
      return [id, want && have && compareVersions(have, want) < 0 ? v : ownPlugins[id]];
    }));
    // Plugins only the home has stay, except third-party senders in a restricted home.
    for (const [id, v] of Object.entries(ownPlugins)) if (!(id in merged) && !(opts.noThirdParty && isThirdPartySender(id))) merged[id] = v;
    copy.plugins = merged;
    out.installed = copy;
  }
  if (marketplaces) {
    let m = opts.noThirdParty ? (filterKeys(marketplaces, isThirdPartySender) as Json) : clone(marketplaces);
    // A directory source whose path is missing on this host cannot be installed: skip it.
    out.skipped = [];
    m = Object.fromEntries(Object.entries(m).filter(([name, v]) => {
      const src = obj(obj(v)?.source);
      if (src?.source === "directory" && typeof src.path === "string" && !exists(src.path)) {
        out.skipped!.push(`${name} (${src.path})`);
        return false;
      }
      return true;
    }));
    const merged = Object.fromEntries(Object.entries(m).map(([name, v]) => [name, own.marketplaces && stable(obj(own.marketplaces[name])?.source) === stable(obj(v)?.source) ? own.marketplaces[name] : v]));
    for (const [name, v] of Object.entries(own.marketplaces ?? {})) if (!(name in merged) && !(opts.noThirdParty && isThirdPartySender(name))) merged[name] = v;
    out.marketplaces = merged;
  }
  return out;
}

async function readJson(path: string): Promise<Json | undefined> {
  try {
    return obj(JSON.parse(await readFile(path, "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Stable text, so key order never counts as a difference. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = obj(v);
  if (o) return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export interface T3ClaudeFile {
  path: string;
  content: Json;
  /** Short name used in reports. */
  label: string;
  /** What differs semantically from the file on disk. Empty when the file is in step. */
  diffs: string[];
  /** Info lines, for example a source marketplace skipped because its directory is missing. */
  notes: string[];
  /** Plugins where the home is ahead of the source. A repair cannot fix these: the source needs an update. */
  sourceBehind?: string[];
}

const keysOf = (v: unknown): string[] => Object.keys(obj(v) ?? {});

const MAP_KEYS = ["enabledPlugins", "pluginConfigs", "extraKnownMarketplaces"];

function diffSettings(expected: Json, actual: Json, restricted: boolean, modelHome = false): string[] {
  const bad: string[] = [];
  for (const k of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (modelHome && MODEL_SETTINGS_KEYS.includes(k)) continue;
    if (k === "env") {
      const strip = (e: unknown) => Object.fromEntries(Object.entries(obj(e) ?? {}).filter(([n]) => !isAllowedEnvKey(n) && !(modelHome && isModelEnvKey(n))));
      const actualEnv = obj(actual.env) ?? {};
      if (stable(strip(expected.env)) !== stable(strip(actual.env))) bad.push("env");
      else if (missingTelemetryOff(actualEnv).length > 0) bad.push("env");
      else if (restricted && Object.entries(actualEnv).some(([n, v]) => !isTelemetryOffKey(n) && (isThirdPartySender(n) || sendsThirdParty(v)))) bad.push("env");
      else if (restricted && "ANTHROPIC_BASE_URL" in actualEnv && !isAisGatewayUrl(actualEnv.ANTHROPIC_BASE_URL)) bad.push("env");
    } else if (k === "hooks") {
      const have = hookKeys(actual.hooks);
      const haveSet = new Set(have);
      if (hookKeys(expected.hooks).some((h) => !haveSet.has(h)) || (restricted && have.some(isThirdPartySender))) bad.push("hooks");
    } else if (MAP_KEYS.includes(k)) {
      const e = obj(expected[k]) ?? {};
      const a = obj(actual[k]) ?? {};
      if (Object.keys(e).some((n) => stable(e[n]) !== stable(a[n])) || (restricted && Object.keys(a).some(isThirdPartySender))) bad.push(k);
    } else if (stable(expected[k]) !== stable(actual[k])) bad.push(k);
  }
  return bad.sort();
}

/** Plugin ids and marketplace sources, never install paths. */
function diffInstalled(expected: Json, actual: Json, noThirdParty: boolean): string[] {
  const a = keysOf(actual.plugins);
  const e = keysOf(expected.plugins);
  return [...pluginVersionGaps(expected, actual).older.map((v) => `version ${v}`), ...e.filter((id) => !a.includes(id)).map((id) => `missing ${id}`), ...a.filter((id) => !e.includes(id) && noThirdParty && isThirdPartySender(id)).map((id) => `extra ${id}`)].sort();
}

function diffMarketplaces(expected: Json, actual: Json, noThirdParty: boolean): string[] {
  const bad: string[] = [];
  for (const name of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (!(name in expected)) {
      if (noThirdParty && isThirdPartySender(name)) bad.push(name);
      continue;
    }
    if (stable(obj(expected[name])?.source) !== stable(obj(actual[name])?.source)) bad.push(name);
  }
  return bad.sort();
}

/** Every file a T3 Claude home must hold, computed from the source folder and the home's current files. */
export async function planT3ClaudeHome(folder: string, sourceDir: string, opts: T3ClaudeConfigOptions = {}, ownOverride?: Json): Promise<T3ClaudeFile[]> {
  const source = await readJson(join(sourceDir, "settings.json"));
  if (!source) throw new Error(`source settings.json is missing in ${sourceDir}; nothing was changed`);
  // A read or parse error of a home file throws: a repair never builds output from a file it could not read.
  const actualSettings = await readJson(join(folder, "settings.json"));
  const own = ownOverride ?? actualSettings ?? {};
  const settings = composeT3ClaudeSettings(source, own, opts);
  const files: T3ClaudeFile[] = [{ path: join(folder, "settings.json"), content: settings, label: "settings.json", diffs: actualSettings ? diffSettings(settings, actualSettings, opts.noThirdParty === true, opts.modelHome === true) : ["missing"], notes: [] }];
  const ownInstalled = await readJson(join(folder, "plugins", "installed_plugins.json"));
  const ownMarkets = await readJson(join(folder, "plugins", "known_marketplaces.json"));
  const plugins = composeT3ClaudePluginFiles(await readJson(join(sourceDir, "plugins", "installed_plugins.json")), await readJson(join(sourceDir, "plugins", "known_marketplaces.json")), opts, { installed: ownInstalled, marketplaces: ownMarkets });
  if (plugins.installed) {
    const sourceInstalled = await readJson(join(sourceDir, "plugins", "installed_plugins.json"));
    const sourceBehind = ownInstalled ? pluginVersionGaps(sourceInstalled, ownInstalled).sourceBehind.filter((l) => !(opts.noThirdParty && isThirdPartySender(l))) : [];
    files.push({ path: join(folder, "plugins", "installed_plugins.json"), content: plugins.installed, label: "plugins/installed_plugins.json", diffs: ownInstalled ? diffInstalled(plugins.installed, ownInstalled, opts.noThirdParty === true) : ["missing"], notes: [], ...(sourceBehind.length > 0 ? { sourceBehind } : {}) });
  }
  if (plugins.marketplaces) files.push({ path: join(folder, "plugins", "known_marketplaces.json"), content: plugins.marketplaces, label: "plugins/known_marketplaces.json", diffs: ownMarkets ? diffMarketplaces(plugins.marketplaces, ownMarkets, opts.noThirdParty === true) : ["missing"], notes: (plugins.skipped ?? []).map((n) => `source marketplace ${n} skipped: directory missing on this host`) });
  return files;
}

/** What differs between a home and its source, as short labels. Empty when in step. */
export async function diffT3ClaudeHome(folder: string, sourceDir: string, opts: T3ClaudeConfigOptions = {}): Promise<string[]> {
  return (await planT3ClaudeHome(folder, sourceDir, opts)).filter((f) => f.diffs.length > 0).map((f) => `${f.label}: ${f.diffs.join(", ")}`);
}

/** Writes only the files that differ semantically; a home that is in step is not touched. Returns the labels written. */
export async function writeT3ClaudeHome(files: T3ClaudeFile[]): Promise<string[]> {
  const written: string[] = [];
  for (const f of files) {
    if (f.diffs.length === 0) continue;
    let mode = 0o600;
    try {
      mode = (await stat(f.path)).mode & 0o777;
    } catch {
      await mkdir(dirname(f.path), { recursive: true });
    }
    await writeFileAtomic(f.path, `${JSON.stringify(f.content, null, 2)}\n`);
    await chmod(f.path, mode);
    written.push(f.label);
  }
  return written;
}

/** Folder names in `<T3 home>/gateway` that are Claude homes with their own settings.json. */
export async function listT3ClaudeHomes(gatewayDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(gatewayDir);
  } catch {
    return [];
  }
  return names.filter((n) => /^(?:t3-)?claude-/.test(n)).sort();
}
