import { existsSync } from "node:fs";
import * as clack from "@clack/prompts";
import { PromptCancelledError } from "../identities/errors.ts";
import { promptForIdentity } from "../identities/prompt.ts";
import { activeIdentities } from "../identities/retired.ts";
import type { IdentitiesFile, Identity, ToolConfig } from "../identities/types.ts";
import { isOnline, offlineWarning } from "../shared/connectivity.ts";
import { execReal } from "../shared/exec.ts";
import {
  discoverLocalModels,
  resolveLlamaRunner,
  startLocalModel,
  type LocalModel,
} from "../shared/local-models.ts";
import { resolveRealBinary, shimPath } from "../shared/resolve-binary.ts";
import type { ParsedArgs } from "./args.ts";
import { CliUsageError } from "./errors.ts";
import { TOOL_CONFIGS, loadOne } from "./identities/resolve-tool.ts";

export interface LaunchableTool {
  cfg: ToolConfig;
  file: IdentitiesFile;
}

function binaryResolves(realBinaryName: string): boolean {
  try {
    resolveRealBinary(realBinaryName as Parameters<typeof resolveRealBinary>[0]);
    return true;
  } catch {
    return false;
  }
}

/** Installed (real binary resolves) and configured (at least one active identity). */
export async function listLaunchableTools(
  deps: { configs?: ToolConfig[]; hasBinary?: (realBinaryName: string) => boolean } = {},
): Promise<LaunchableTool[]> {
  const hasBinary = deps.hasBinary ?? binaryResolves;
  const found: LaunchableTool[] = [];
  for (const cfg of deps.configs ?? Object.values(TOOL_CONFIGS)) {
    if (!hasBinary(cfg.realBinaryName)) continue;
    const { file } = await loadOne(cfg).catch(() => ({ file: undefined }));
    if (file && activeIdentities(file.identities).length > 0) found.push({ cfg, file });
  }
  return found;
}

export function shimLaunchArgs(identity: Identity): string[] {
  return identity.swapPool ? [`--pool=${identity.name}`] : [`--identity=${identity.name}`];
}

export interface LaunchEntry {
  value: string;
  label: string;
}

export interface LaunchDeps {
  tools: () => Promise<LaunchableTool[]>;
  online: () => Promise<boolean>;
  localModels: () => Promise<{ models: LocalModel[]; runner?: string }>;
  /** Resolves to the chosen value; throws PromptCancelledError on cancel. */
  selectEntry: (entries: LaunchEntry[], message: string, initialValue?: string) => Promise<string>;
  promptIdentity: typeof promptForIdentity;
  shimExists: (path: string) => boolean;
  exec: (path: string, args: string[]) => Promise<never>;
  startLocal: (model: LocalModel, runner: string) => Promise<never>;
  isTty: () => boolean;
  log: (line: string) => void;
}

const LOCAL = "local";

const defaultDeps: LaunchDeps = {
  tools: () => listLaunchableTools(),
  online: () => isOnline(),
  localModels: async () => ({ models: await discoverLocalModels(), runner: resolveLlamaRunner() }),
  selectEntry: async (options, message, initialValue) => {
    const picked = await clack.select({ message, options, initialValue });
    if (clack.isCancel(picked)) throw new PromptCancelledError("launch");
    return picked as string;
  },
  promptIdentity: promptForIdentity,
  shimExists: existsSync,
  exec: (path, args) => execReal(path, args, {}),
  startLocal: startLocalModel,
  isTty: () => process.stdin.isTTY === true,
  log: (line) => console.error(line),
};

export async function runLaunchCommand(
  rest: string[],
  _flags: ParsedArgs["flags"],
  deps: LaunchDeps = defaultDeps,
): Promise<void> {
  if (rest.length > 0) throw new CliUsageError("Usage: ais launch");
  if (!deps.isTty()) throw new CliUsageError("ais launch is interactive and needs a terminal on stdin.");

  try {
    const tools = await deps.tools();
    const { models, runner } = await deps.localModels();
    const localAvailable = models.length > 0 && runner !== undefined;
    if (tools.length === 0 && !localAvailable) {
      throw new CliUsageError(
        "Nothing to launch: no installed tool has an active identity and no local model is ready. " +
          'Run "ais upgrade" to install tools and "ais identities create" to add an identity.',
      );
    }

    const online = await deps.online();
    if (!online) deps.log(offlineWarning("the selected provider", localAvailable));
    const tag = online ? "" : " (needs internet)";
    const toolEntries = tools.map((t) => ({ value: t.cfg.toolName, label: `${t.cfg.toolName}${tag}` }));
    const localEntry = { value: LOCAL, label: `Local model: ${models[0]?.name}` };
    const entries = !localAvailable ? toolEntries : online ? [...toolEntries, localEntry] : [localEntry, ...toolEntries];
    // Offline pre-selects the local entry; online lists it last, so the first tool leads.
    const choice = await deps.selectEntry(entries, "What do you want to launch?", entries[0]?.value);

    if (choice === LOCAL) {
      let model = models[0]!;
      if (models.length > 1) {
        const name = await deps.selectEntry(
          models.map((m) => ({ value: m.name, label: m.name })),
          "Select a local model",
        );
        model = models.find((m) => m.name === name) ?? model;
      }
      await deps.startLocal(model, runner!);
      return;
    }

    const tool = tools.find((t) => t.cfg.toolName === choice)!;
    const shim = shimPath(tool.cfg.toolName);
    if (!deps.shimExists(shim)) {
      throw new CliUsageError(`The ${tool.cfg.toolName} shim is missing (${shim}). Run "ais update" to install it.`);
    }
    const { identity } = await deps.promptIdentity(
      tool.file, tool.cfg, 60_000, undefined, undefined, `Launch ${tool.cfg.toolName}`,
    );
    await deps.exec(shim, shimLaunchArgs(identity));
  } catch (err) {
    if (err instanceof PromptCancelledError) process.exit(130);
    throw err;
  }
}
