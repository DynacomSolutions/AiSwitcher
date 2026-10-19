import { boolFlag } from "../args.ts";
import type { ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import { isOnline } from "../../shared/connectivity.ts";
import { discoverLocalModels, resolveLlamaRunner } from "../../shared/local-models.ts";

export interface LiveNetCheckDeps {
  online: (refresh: boolean) => Promise<boolean>;
  discover: () => ReturnType<typeof discoverLocalModels>;
  runner: () => string | undefined;
  write: (line: string) => void;
}

const realDeps: LiveNetCheckDeps = {
  online: (refresh) => isOnline({ refresh }),
  discover: () => discoverLocalModels(),
  runner: () => resolveLlamaRunner(),
  write: (line) => console.log(line),
};

export async function runLiveCommand(
  args: string[],
  flags: ParsedArgs["flags"],
  deps: LiveNetCheckDeps = realDeps,
): Promise<void> {
  const [subcommand] = args;
  if (subcommand !== "net-check" || args.length > 1) {
    throw new CliUsageError('Usage: ais live net-check [--json] [--fresh]');
  }
  const online = await deps.online(boolFlag(flags, "fresh"));
  const localModel = deps.runner() !== undefined && (await deps.discover()).length > 0;
  if (boolFlag(flags, "json")) deps.write(JSON.stringify({ online, localModel }));
  else deps.write(`Internet: ${online ? "available" : "unavailable"}; local model: ${localModel ? "available" : "unavailable"}`);
  if (!online) process.exitCode = 1;
}
