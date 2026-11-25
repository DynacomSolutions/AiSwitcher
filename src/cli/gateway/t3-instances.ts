import { syncT3InstancesLive } from "../../t3/instances/live.ts";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import type { GatewayCliDeps } from "./apps.ts";

const USAGE = "Usage: ais gateway t3-instances sync [--check] [--flavour=host|pod] [--binary-dir=<dir>] [--token-dir=<dir>] [--only-missing]";

/**
 * `ais gateway t3-instances sync`: reads the gateway app list now and makes T3 Code's provider instances match it
 * (src/t3/instances). No list of pools or identities is kept anywhere: a new pool app gives a new instance on the next run,
 * a revoked app removes its instance. `--check` writes nothing and fails when settings.json differs.
 */
export async function runT3InstancesCommand(args: string[], flags: ParsedArgs["flags"], deps: GatewayCliDeps, opts: { home?: string; env?: Record<string, string | undefined> } = {}): Promise<void> {
  if (args[0] !== "sync" || args.length > 1) throw new CliUsageError(USAGE);
  const check = boolFlag(flags, "check");
  const flavour = stringFlag(flags, "flavour") ?? "host";
  if (flavour !== "host" && flavour !== "pod") throw new CliUsageError(`--flavour must be host or pod. ${USAGE}`);
  const binaryDir = stringFlag(flags, "binary-dir");
  const tokenDir = stringFlag(flags, "token-dir");
  const items = await syncT3InstancesLive(deps, { check, flavour, ...(boolFlag(flags, "only-missing") ? { onlyMissing: true } : {}), ...(binaryDir ? { binaryDir } : {}), ...(tokenDir ? { tokenDir } : {}), ...opts });
  let differs = 0;
  let failed = 0;
  for (const i of items) {
    deps.out(`t3-instances: ${i.id} ${i.status}${i.detail ? ` (${i.detail})` : ""}`);
    if (i.status === "failed") failed += 1;
    else if (check && i.status !== "current" && i.status !== "skipped") differs += 1;
  }
  if (failed > 0) throw new Error(`t3-instances: ${failed} instance(s) failed`);
  if (differs > 0) throw new Error(`t3-instances: ${differs} instance(s) differ from the gateway app list`);
}
