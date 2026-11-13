import { describeResult, syncT3GatewayModels, type SyncOptions } from "../../identities/t3-gateway-models.ts";
import { boolFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import type { GatewayCliDeps } from "./apps.ts";

/**
 * `ais gateway t3-models [--check]`: makes the model lists of the T3 Code gateway folders (`~/.t3/gateway/*`: kimi-code
 * config.toml, opencode.json) equal to the gateway's `/models` now. The host profile-sync daemon does the same on a timer,
 * so this is for a check or an immediate refresh. `--check` writes nothing and fails when a list is out of date or unreadable.
 */
export async function runT3ModelsCommand(args: string[], flags: ParsedArgs["flags"], deps: GatewayCliDeps, opts: SyncOptions = {}): Promise<void> {
  if (args.length > 0) throw new CliUsageError("Usage: ais gateway t3-models [--check]");
  const check = boolFlag(flags, "check");
  const results = await syncT3GatewayModels({ fetch: deps.fetch, ...opts, check });
  if (results.length === 0) {
    deps.out("t3-models: no T3 gateway folder with a kimi-code or OpenCode model list");
    return;
  }
  for (const r of results) deps.out(describeResult(r, check));
  const failed = results.filter((r) => r.status === "failed").length;
  const stale = check ? results.filter((r) => r.status === "updated").length : 0;
  if (failed + stale > 0) throw new Error(`${failed} failed, ${stale} out of date`);
}
