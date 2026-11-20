import { execFile } from "node:child_process";
import { cp, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { writeFileAtomic } from "../identities/pool/fs.ts";
import { resolveRealBinary } from "./resolve-binary.ts";
import { expandPath } from "../identities/match.ts";
import { isRetired } from "../identities/retired.ts";
import { isThirdPartySender, listT3ClaudeHomes } from "../identities/t3-claude-home.ts";
import { t3Paths } from "../identities/t3-anthropic-proxy.ts";
import { isNoThirdParty, loadClaudeIdentities, noThirdPartyNames, t3ClaudeSource } from "./t3-claude-source.ts";

export interface ClaudeCliResult {
  code: number;
  output: string;
}

/** Runs `claude <args>` with `CLAUDE_CONFIG_DIR` set to one folder. Injectable for tests. */
export type ClaudeCliRunner = (args: string[], configDir: string) => Promise<ClaudeCliResult>;

type Exec = (file: string, args: string[], env: NodeJS.ProcessEnv, cb: (err: Error | null, stdout: string, stderr: string) => void) => void;
const defaultExec: Exec = (file, args, env, cb) => {
  execFile(file, args, { env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => cb(err, String(stdout), String(stderr)));
};

/**
 * A runner for the real Claude binary. `claude` on PATH can be a wrapper in ~/.local/bin that ignores CLAUDE_CONFIG_DIR, so
 * the binary comes from `resolveRealBinary`. With no real binary the runner fails every call.
 */
export function createClaudeCliRunner(resolveBinary: () => string = () => resolveRealBinary("claude"), exec: Exec = defaultExec): ClaudeCliRunner {
  return (args, configDir) =>
    new Promise((resolvePromise) => {
      let binary: string;
      try {
        binary = resolveBinary();
      } catch (err) {
        resolvePromise({ code: 127, output: `no real claude binary: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      exec(binary, args, { ...process.env, CLAUDE_CONFIG_DIR: configDir }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as unknown as { code: number }).code : 1) : 0;
        resolvePromise({ code, output: `${stdout}${stderr}`.trim() });
      });
    });
}

export const runClaudeCli: ClaudeCliRunner = createClaudeCliRunner();

export interface PluginUpdateOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  registryPath?: string;
  run?: ClaudeCliRunner;
}

export interface PluginUpdateResult {
  folder: string;
  /** Identity name, or "t3-home" for a T3 Claude home. */
  kind: string;
  marketplaces: string[];
  plugins: string[];
  /** Third-party entries left alone in a restricted folder. */
  skipped: string[];
  failures: string[];
}

async function readKeys(path: string, pick: (json: Record<string, unknown>) => unknown): Promise<string[]> {
  try {
    const json = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const v = pick(json);
    return typeof v === "object" && v !== null ? Object.keys(v) : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);
const inside = (dir: string, path: string): boolean => resolve(path).startsWith(`${resolve(dir)}${sep}`);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyInto(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: false, errorOnExist: false });
}

/**
 * Makes the plugin entries of a folder point into the folder itself, so `plugin update` never replaces or deletes files
 * of another identity. A plugin cache or marketplace outside the folder is copied in and the entry is rewritten. Returns
 * the names that could not be made local and must not be updated, with the reason.
 */
export async function localisePluginPaths(folder: string): Promise<Map<string, string>> {
  const blocked = new Map<string, string>();
  const cacheRoot = join(folder, "plugins", "cache");
  const installedPath = join(folder, "plugins", "installed_plugins.json");
  const installedText = await readFile(installedPath, "utf8").catch(() => undefined);
  if (installedText) {
    const json = JSON.parse(installedText) as Json;
    let changed = false;
    for (const [id, list] of Object.entries(obj(json.plugins) ?? {})) {
      for (const entry of Array.isArray(list) ? list : []) {
        const e = obj(entry);
        const path = e?.installPath;
        if (!e || typeof path !== "string" || inside(cacheRoot, path)) continue;
        const rel = path.includes(`${sep}plugins${sep}cache${sep}`) ? path.slice(path.indexOf(`${sep}plugins${sep}cache${sep}`) + `${sep}plugins${sep}cache${sep}`.length) : join("external", id, path.split(sep).filter(Boolean).slice(-1)[0] ?? "x");
        const dest = join(cacheRoot, rel);
        try {
          if (!(await exists(path))) throw new Error(`install path ${path} is missing`);
          if (!inside(cacheRoot, dest)) throw new Error("unsafe cache path");
          await copyInto(path, dest);
          e.installPath = dest;
          changed = true;
        } catch (err) {
          blocked.set(id, `${id}: shared plugin cache outside the folder, not updated (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }
    if (changed) await writeFileAtomic(installedPath, `${JSON.stringify(json, null, 2)}\n`);
  }
  const marketsPath = join(folder, "plugins", "known_marketplaces.json");
  const marketsText = await readFile(marketsPath, "utf8").catch(() => undefined);
  if (marketsText) {
    const json = JSON.parse(marketsText) as Json;
    const root = join(folder, "plugins", "marketplaces");
    let changed = false;
    for (const [name, v] of Object.entries(json)) {
      const m = obj(v);
      const path = m?.installLocation;
      // A directory source is the user's own folder, not a copy: it is never moved.
      if (!m || typeof path !== "string" || obj(m.source)?.source === "directory" || inside(root, path)) continue;
      const dest = join(root, name);
      try {
        if (!(await exists(path))) throw new Error(`install location ${path} is missing`);
        if (!inside(root, dest)) throw new Error("unsafe marketplace path");
        await copyInto(path, dest);
        m.installLocation = dest;
        changed = true;
      } catch (err) {
        blocked.set(name, `${name}: shared marketplace outside the folder, not updated (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    if (changed) await writeFileAtomic(marketsPath, `${JSON.stringify(json, null, 2)}\n`);
  }
  return blocked;
}

/**
 * Updates every marketplace and plugin of one folder to the latest version, through the Claude CLI. A restricted folder
 * never updates a third-party sender. One failure does not stop the rest.
 */
export async function updateFolderPlugins(folder: string, kind: string, restricted: boolean, run: ClaudeCliRunner): Promise<PluginUpdateResult> {
  const result: PluginUpdateResult = { folder, kind, marketplaces: [], plugins: [], skipped: [], failures: [] };
  const markets = await readKeys(join(folder, "plugins", "known_marketplaces.json"), (j) => j);
  const plugins = await readKeys(join(folder, "plugins", "installed_plugins.json"), (j) => j.plugins);
  const blocked = await localisePluginPaths(folder);
  result.failures.push(...blocked.values());
  const step = async (list: string[], args: (name: string) => string[], done: string[]) => {
    for (const name of list) {
      if (restricted && isThirdPartySender(name)) {
        result.skipped.push(name);
        continue;
      }
      if (blocked.has(name)) continue;
      const r = await run(args(name), folder);
      if (r.code === 0) done.push(name);
      else result.failures.push(`${name}: ${r.output.split("\n").pop() ?? "failed"}`);
    }
  };
  // Marketplaces first, so the plugin updates see the latest catalogue.
  await step(markets, (n) => ["plugin", "marketplace", "update", n], result.marketplaces);
  await step(plugins, (n) => ["plugin", "update", n], result.plugins);
  return result;
}

/** Updates all marketplaces and plugins in every live Claude identity folder and every T3 Claude home. */
export async function updateAllClaudePlugins(opts: PluginUpdateOptions = {}): Promise<PluginUpdateResult[]> {
  const home = opts.home ?? homedir();
  const envOpt = opts.env ? { env: opts.env } : {};
  const t3Home = t3Paths({ home, ...envOpt }).t3Home;
  const gateway = join(t3Home, "gateway");
  const registry = await loadClaudeIdentities(opts.registryPath ?? join(home, ".claude", "identities.json"));
  const restricted = noThirdPartyNames({ home, ...envOpt });
  // Fail the whole run when no real Claude binary resolves, so a missing binary never reports success.
  if (!opts.run) resolveRealBinary("claude");
  const run = opts.run ?? runClaudeCli;
  const seen = new Set<string>();
  const out: PluginUpdateResult[] = [];
  for (const identity of registry.identities.filter((i) => !isRetired(i))) {
    const dir = expandPath(identity.configDir);
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(await updateFolderPlugins(dir, identity.name, isNoThirdParty(identity, restricted), run));
  }
  for (const name of await listT3ClaudeHomes(gateway)) {
    const folder = join(gateway, name);
    if (seen.has(folder)) continue;
    seen.add(folder);
    // A home with no source identity fails closed: it counts as restricted.
    const source = t3ClaudeSource(registry, folder, t3Home, restricted);
    out.push(await updateFolderPlugins(folder, "t3-home", source ? source.noThirdParty : true, run));
  }
  return out;
}

export const describePluginUpdate = (r: PluginUpdateResult): string =>
  `${r.folder} (${r.kind}): ${r.marketplaces.length} marketplaces, ${r.plugins.length} plugins updated${r.skipped.length > 0 ? `, skipped third-party: ${r.skipped.join(", ")}` : ""}${r.failures.length > 0 ? `; failed: ${r.failures.join("; ")}` : ""}`;
