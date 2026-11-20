import { resolve } from "node:path";
import { CLAUDE_ACCOUNT_PRELOAD_PATH, CLAUDE_ACCOUNT_PRELOAD_SOURCE, installClaudeAccountPreloadAt } from "../../identities/claude-account-preload.ts";
import { expandPath } from "../../identities/match.ts";
import { boolFlag, stringFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import type { GatewayCliDeps } from "./apps.ts";

/**
 * `ais gateway claude-preload --print | --install[=<path>]`: gives a Claude process that runs without the ais launcher
 * (for example a cluster agent pod) the account preload file. The launcher env is not set here: see docs/agents/gateway.md.
 */
export async function runClaudePreloadCommand(flags: ParsedArgs["flags"], deps: GatewayCliDeps): Promise<void> {
  if (boolFlag(flags, "print")) {
    deps.out(CLAUDE_ACCOUNT_PRELOAD_SOURCE.replace(/\n$/, ""));
    return;
  }
  const install = flags.install;
  if (install === undefined) throw new CliUsageError("Usage: ais gateway claude-preload --print | --install[=<path>]");
  const target = install === true ? CLAUDE_ACCOUNT_PRELOAD_PATH() : resolve(expandPath(stringFlag(flags, "install") ?? ""));
  const path = await installClaudeAccountPreloadAt(target);
  deps.out(path);
}
