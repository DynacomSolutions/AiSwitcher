import { describeT3ClaudeResult, syncT3ClaudeHomes } from "../../shared/t3-claude-sync.ts";
import { describePluginUpdate, updateAllClaudePlugins } from "../../shared/claude-plugin-update.ts";
import { boolFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import type { GatewayCliDeps } from "./apps.ts";

/**
 * `ais gateway t3-claude-sync [--check|--update]`: makes every T3 Claude home (`~/.t3/gateway/pool-home`, `t3-claude-*`) carry the
 * full config and plugins of its source identity. Only the gateway auth and routing env keys and the attribution keys differ.
 * `--check` only reports and exits non-zero on drift, also when a home runs an older plugin version than its source, or a
 * newer one (the source needs an update). `--update` first updates every marketplace and plugin to the latest version in
 * every Claude identity folder and every T3 Claude home (through the Claude CLI), then repairs the homes.
 */
export async function runT3ClaudeSyncCommand(args: string[], flags: ParsedArgs["flags"], deps: GatewayCliDeps): Promise<void> {
  if (args.length > 0) throw new CliUsageError("Usage: ais gateway t3-claude-sync [--check]");
  const check = boolFlag(flags, "check");
  const update = boolFlag(flags, "update");
  if (check && update) throw new CliUsageError("--check and --update cannot be used together");
  let updateFailed = false;
  if (update) {
    for (const r of await updateAllClaudePlugins()) {
      deps.out(`t3-claude-sync: update: ${describePluginUpdate(r)}`);
      if (r.failures.length > 0) updateFailed = true;
    }
  }
  const results = await syncT3ClaudeHomes({ check });
  let drift = false;
  for (const r of results) {
    if (r.status === "skipped") continue;
    deps.out(`t3-claude-sync: ${describeT3ClaudeResult(r)}`);
    for (const n of r.notes ?? []) deps.out(`t3-claude-sync: info: ${r.folder}: ${n}`);
    if (r.status === "drift" || r.status === "failed") drift = true;
  }
  if (updateFailed) throw new Error("t3-claude-sync: a plugin update failed");
  if (drift) throw new Error(check ? "t3-claude-sync: a T3 Claude home differs from its source identity" : "t3-claude-sync: a T3 Claude home failed");
}
