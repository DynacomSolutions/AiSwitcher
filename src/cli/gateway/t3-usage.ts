import { describeUsageResult, isUsageTrouble, syncT3UsageCredentials, type UsageOptions } from "../../identities/t3-usage-credentials.ts";
import { boolFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import type { GatewayCliDeps } from "./apps.ts";

/**
 * `ais gateway t3-usage [--check]`: gives T3 Code's OpenCode and Grok instances a usage credential that is only the
 * gateway app token. The host profile-sync daemon does the same every 10 minutes. `--check` writes nothing and fails
 * when a file is out of date, failed or has a problem. Token values are never printed.
 */
export async function runT3UsageCommand(args: string[], flags: ParsedArgs["flags"], deps: GatewayCliDeps, opts: UsageOptions = {}): Promise<void> {
  if (args.length > 0) throw new CliUsageError("Usage: ais gateway t3-usage [--check]");
  const check = boolFlag(flags, "check");
  const results = await syncT3UsageCredentials({ secretsPath: deps.secretsPath, ...opts, check });
  if (results.length === 0) {
    deps.out("t3-usage: no T3 OpenCode or Grok provider instance");
    return;
  }
  for (const r of results) deps.out(describeUsageResult(r, check));
  const bad = results.filter((r) => isUsageTrouble(r, check)).length;
  if (bad > 0) throw new Error(`${bad} file(s) failed, out of date or with a problem`);
}
