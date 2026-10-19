import { boolFlag, type ParsedArgs } from "../args.ts";
import { CliUsageError } from "../errors.ts";
import {
  discoverLocalModels,
  localModelDirs,
  resolveLlamaRunner,
  startLocalModel,
  type LocalModel,
} from "../../shared/local-models.ts";

export interface LocalDeps {
  discover: () => Promise<LocalModel[]>;
  runner: () => string | undefined;
  dirs: () => string[];
  start: (m: LocalModel, runner: string) => Promise<never>;
  log: (line: string) => void;
}

const defaultDeps: LocalDeps = {
  discover: () => discoverLocalModels(),
  runner: () => resolveLlamaRunner(),
  dirs: () => localModelDirs(),
  start: startLocalModel,
  log: (line) => console.log(line),
};

const USAGE = "Usage: ais local [list [--json] | start [name]]";

export function formatLocalModels(models: LocalModel[], runner: string | undefined, dirs: string[]): string[] {
  const lines: string[] = [];
  if (models.length === 0) lines.push(`No local model found. Looked in: ${dirs.join(", ")}.`);
  for (const m of models) {
    lines.push(`${m.name}  ${Math.round(m.sizeBytes / (1024 * 1024))} MiB  ${m.path}`);
  }
  lines.push(runner ? `Runner: ${runner}` : "Runner: runner missing (install llama-cli or set AIS_LLAMA_BIN)");
  return lines;
}

export async function runLocalCommand(
  rest: string[],
  flags: ParsedArgs["flags"],
  deps: LocalDeps = defaultDeps,
): Promise<void> {
  const [sub = "list", name, ...extra] = rest;
  if (sub === "list" && name === undefined) {
    const models = await deps.discover();
    const runner = deps.runner();
    if (boolFlag(flags, "json")) deps.log(JSON.stringify({ runner: runner ?? null, models }, null, 2));
    else for (const line of formatLocalModels(models, runner, deps.dirs())) deps.log(line);
    return;
  }
  if (sub !== "start" || extra.length > 0) throw new CliUsageError(USAGE);

  const models = await deps.discover();
  if (models.length === 0) {
    throw new CliUsageError(`No local model found. Looked in: ${deps.dirs().join(", ")}.`);
  }
  const names = models.map((m) => m.name).join(", ");
  let model: LocalModel | undefined;
  if (name === undefined) {
    if (models.length > 1) throw new CliUsageError(`Several local models found. Choose one of: ${names}.`);
    model = models[0];
  } else {
    model = models.find((m) => m.name === name);
    if (!model) throw new CliUsageError(`Unknown local model "${name}". Choose one of: ${names}.`);
  }
  const runner = deps.runner();
  if (!runner) {
    throw new CliUsageError("No llama.cpp runner found. Install llama-cli on PATH or set AIS_LLAMA_BIN.");
  }
  await deps.start(model, runner);
}
