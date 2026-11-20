import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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

export const runClaudeCli: ClaudeCliRunner = (args, configDir) =>
  new Promise((resolve) => {
    execFile("claude", args, { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}`.trim() });
    });
  });

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

/**
 * Updates every marketplace and plugin of one folder to the latest version, through the Claude CLI. A restricted folder
 * never updates a third-party sender. One failure does not stop the rest.
 */
export async function updateFolderPlugins(folder: string, kind: string, restricted: boolean, run: ClaudeCliRunner): Promise<PluginUpdateResult> {
  const result: PluginUpdateResult = { folder, kind, marketplaces: [], plugins: [], skipped: [], failures: [] };
  const markets = await readKeys(join(folder, "plugins", "known_marketplaces.json"), (j) => j);
  const plugins = await readKeys(join(folder, "plugins", "installed_plugins.json"), (j) => j.plugins);
  const step = async (list: string[], args: (name: string) => string[], done: string[]) => {
    for (const name of list) {
      if (restricted && isThirdPartySender(name)) {
        result.skipped.push(name);
        continue;
      }
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
