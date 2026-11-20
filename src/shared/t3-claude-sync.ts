import { homedir } from "node:os";
import { join } from "node:path";
import { listT3ClaudeHomes, planT3ClaudeHome, writeT3ClaudeHome } from "../identities/t3-claude-home.ts";
import { t3Paths } from "../identities/t3-anthropic-proxy.ts";
import { loadClaudeIdentities, noThirdPartyNames, t3ClaudeSource } from "./t3-claude-source.ts";

export interface T3ClaudeSyncOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  /** Path of the Claude identities registry. Injectable for tests. */
  registryPath?: string;
  /** Report only. */
  check?: boolean;
}

export interface T3ClaudeSyncResult {
  folder: string;
  /** Source identity name, or undefined when the home maps to no identity (skipped). */
  source?: string;
  status: "current" | "drift" | "updated" | "skipped" | "failed";
  /** Differences found (check) or files written (apply). */
  changes: string[];
  error?: string;
  /** Info lines (not drift). */
  notes?: string[];
}

/** Brings every mapped T3 Claude home in step with its source identity, or reports the drift with `check`. */
export async function syncT3ClaudeHomes(opts: T3ClaudeSyncOptions = {}): Promise<T3ClaudeSyncResult[]> {
  const home = opts.home ?? homedir();
  const t3Home = t3Paths({ home, ...(opts.env ? { env: opts.env } : {}) }).t3Home;
  const gateway = join(t3Home, "gateway");
  const registry = await loadClaudeIdentities(opts.registryPath ?? join(home, ".claude", "identities.json"));
  const restricted = noThirdPartyNames({ home, ...(opts.env ? { env: opts.env } : {}) });
  const results: T3ClaudeSyncResult[] = [];
  for (const name of await listT3ClaudeHomes(gateway)) {
    const folder = join(gateway, name);
    const source = t3ClaudeSource(registry, folder, t3Home, restricted);
    if (!source) {
      results.push({ folder, status: "skipped", changes: [] });
      continue;
    }
    try {
      const plan = await planT3ClaudeHome(folder, source.dir, { noThirdParty: source.noThirdParty, ...(source.modelHome ? { modelHome: true } : {}) });
      const diffs = plan.filter((f) => f.diffs.length > 0).map((f) => `${f.label}: ${f.diffs.join(", ")}`);
      const behind = plan.flatMap((f) => f.sourceBehind ?? []);
      const notes = [...plan.flatMap((f) => f.notes), ...behind.map((b) => `source behind: ${b}`)];
      if (opts.check && diffs.length === 0 && behind.length > 0) results.push({ folder, source: source.name, status: "drift", changes: behind, notes });
      else if (diffs.length === 0) results.push({ folder, source: source.name, status: "current", changes: [], notes });
      else if (opts.check) results.push({ folder, source: source.name, status: "drift", changes: diffs, notes });
      else results.push({ folder, source: source.name, status: "updated", changes: await writeT3ClaudeHome(plan), notes });
    } catch (err) {
      results.push({ folder, source: source.name, status: "failed", changes: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

export const describeT3ClaudeResult = (r: T3ClaudeSyncResult): string =>
  `${r.folder} (${r.source ?? "no source"}): ${r.status}${r.changes.length > 0 ? ` [${r.changes.join("; ")}]` : ""}${r.error ? ` ${r.error}` : ""}`;
