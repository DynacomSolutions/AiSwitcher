import { describeT3ClaudeResult, syncT3ClaudeHomes } from "../../shared/t3-claude-sync.ts";
import { boolFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import type { GatewayCliDeps } from "./apps.ts";

/**
 * `ais gateway t3-claude-sync [--check]`: makes every T3 Claude home (`~/.t3/gateway/pool-home`, `t3-claude-*`) carry the
 * full config and plugins of its source identity. Only the gateway auth and routing env keys and the attribution keys differ.
 * `--check` only reports and exits non-zero on drift.
 */
export async function runT3ClaudeSyncCommand(args: string[], flags: ParsedArgs["flags"], deps: GatewayCliDeps): Promise<void> {
  if (args.length > 0) throw new CliUsageError("Usage: ais gateway t3-claude-sync [--check]");
  const check = boolFlag(flags, "check");
  const results = await syncT3ClaudeHomes({ check });
  let drift = false;
  for (const r of results) {
    if (r.status === "skipped") continue;
    deps.out(`t3-claude-sync: ${describeT3ClaudeResult(r)}`);
    if (r.status === "drift" || r.status === "failed") drift = true;
  }
  if (drift) throw new Error(check ? "t3-claude-sync: a T3 Claude home differs from its source identity" : "t3-claude-sync: a T3 Claude home failed");
}
