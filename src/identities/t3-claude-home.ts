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

/** Gateway values of the attribution keys (no tool attribution in commits or PRs). */
export const GATEWAY_ATTRIBUTION: Json = { attribution: { commit: "", pr: "" }, includeCoAuthoredBy: false, gitAttribution: false };

/** Marks a plugin, marketplace, hook or env key that sends session content to a third party. */
const THIRD_PARTY = /(^|[^a-z0-9])(jev|typesafe|telemetry)/i;
export const isThirdPartySender = (text: string): boolean => THIRD_PARTY.test(text);

const SWAP_HOOK = /\bais\s+claude-swap\b/;

export interface T3ClaudeConfigOptions {
  /** Source identity is a restricted identity: nothing that sends to a third party is copied. */
  noThirdParty?: boolean;
}

const clone = <T>(v: T): T => structuredClone(v);

function filterHooks(hooks: unknown, drop: (command: string) => boolean): unknown {
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
        const hooksKept = list.filter((h) => !(typeof obj(h)?.command === "string" && drop(obj(h)!.command as string)));
        return hooksKept.length === 0 ? undefined : { ...group, hooks: hooksKept };
      })
      .filter((g) => g !== undefined);
    if (kept.length > 0) out[event] = kept;
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
  const ownEnv = obj(own.env) ?? {};
  const env: Json = obj(out.env) ? { ...(out.env as Json) } : {};
  for (const key of GATEWAY_ENV_KEYS) {
    delete env[key];
    if (key in ownEnv) env[key] = ownEnv[key];
  }
  out.env = env;
  Object.assign(out, GATEWAY_ATTRIBUTION);
  const hooks = filterHooks(out.hooks, (c) => SWAP_HOOK.test(c) || (opts.noThirdParty === true && isThirdPartySender(c)));
  if (hooks === undefined) delete out.hooks;
  else out.hooks = hooks;
  if (opts.noThirdParty) {
    out.env = filterKeys(out.env, isThirdPartySender);
    for (const key of ["enabledPlugins", "pluginConfigs"]) if (key in out) out[key] = filterKeys(out[key], isThirdPartySender);
    if ("extraKnownMarketplaces" in out) out.extraKnownMarketplaces = filterKeys(out.extraKnownMarketplaces, isThirdPartySender);
  }
  return out;
}

/** The expected plugin JSON files: `installed_plugins.json` and `known_marketplaces.json`. Pure. */
export function composeT3ClaudePluginFiles(installed: Json | undefined, marketplaces: Json | undefined, opts: T3ClaudeConfigOptions = {}): { installed?: Json; marketplaces?: Json } {
  const out: { installed?: Json; marketplaces?: Json } = {};
  if (installed) {
    const copy = clone(installed);
    if (opts.noThirdParty && obj(copy.plugins)) copy.plugins = filterKeys(copy.plugins, isThirdPartySender);
    out.installed = copy;
  }
  if (marketplaces) out.marketplaces = opts.noThirdParty ? (filterKeys(marketplaces, isThirdPartySender) as Json) : clone(marketplaces);
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
}

/** Every file a T3 Claude home must hold, computed from the source folder and the home's current settings. */
export async function planT3ClaudeHome(folder: string, sourceDir: string, opts: T3ClaudeConfigOptions = {}, ownOverride?: Json): Promise<T3ClaudeFile[]> {
  const source = (await readJson(join(sourceDir, "settings.json"))) ?? {};
  const own = ownOverride ?? (await readJson(join(folder, "settings.json"))) ?? {};
  const files: T3ClaudeFile[] = [{ path: join(folder, "settings.json"), content: composeT3ClaudeSettings(source, own, opts), label: "settings.json" }];
  const plugins = composeT3ClaudePluginFiles(await readJson(join(sourceDir, "plugins", "installed_plugins.json")), await readJson(join(sourceDir, "plugins", "known_marketplaces.json")), opts);
  if (plugins.installed) files.push({ path: join(folder, "plugins", "installed_plugins.json"), content: plugins.installed, label: "plugins/installed_plugins.json" });
  if (plugins.marketplaces) files.push({ path: join(folder, "plugins", "known_marketplaces.json"), content: plugins.marketplaces, label: "plugins/known_marketplaces.json" });
  return files;
}

/** What differs between a home and its source, as short labels such as `settings.json: enabledPlugins`. Empty when in step. */
export async function diffT3ClaudeHome(folder: string, sourceDir: string, opts: T3ClaudeConfigOptions = {}): Promise<string[]> {
  const diffs: string[] = [];
  for (const f of await planT3ClaudeHome(folder, sourceDir, opts)) {
    const actual = await readJson(f.path).catch(() => undefined);
    if (!actual) {
      diffs.push(`${f.label}: missing`);
      continue;
    }
    const keys = new Set([...Object.keys(f.content), ...Object.keys(actual)]);
    const bad = [...keys].filter((k) => stable(f.content[k]) !== stable(actual[k])).sort();
    if (bad.length > 0) diffs.push(`${f.label}: ${bad.join(", ")}`);
  }
  return diffs;
}

/** Writes the files that differ. Keeps the file mode (0600 for a new file). Returns the labels written. */
export async function writeT3ClaudeHome(files: T3ClaudeFile[]): Promise<string[]> {
  const written: string[] = [];
  for (const f of files) {
    const actual = await readJson(f.path).catch(() => undefined);
    if (actual && stable(actual) === stable(f.content)) continue;
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
