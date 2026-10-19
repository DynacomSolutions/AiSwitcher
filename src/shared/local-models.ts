/**
 * Local llama.cpp model discovery and start.
 *
 * Discovery rule: a local model is a regular, non-empty `*.gguf` file directly
 * inside a search directory. Search directories: `$AIS_LOCAL_MODELS_DIR` alone
 * when set, else `~/.ais/models` then `/opt/ais/models`. The model name is the
 * file name without `.gguf`; on a name clash the first directory wins. The
 * runner is `$AIS_LLAMA_BIN` when set and executable, else `llama-cli` on
 * `PATH`. A model counts as startable only when a runner is found. No
 * manifest, no download, no model registry.
 *
 * Start command: `<runner> -m <path> -cnv` (interactive conversation mode),
 * exec'd with `execReal` so the terminal belongs to the model.
 */
import { accessSync, constants, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execReal } from "./exec";

export interface LocalModel {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface LocalModelsDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  which?: (name: string) => string | null;
  /** Overrides `localModelDirs` (tests, callers with their own search path). */
  dirs?: string[];
}

export function localModelDirs(deps: LocalModelsDeps = {}): string[] {
  const env = deps.env ?? process.env;
  if (env.AIS_LOCAL_MODELS_DIR) return [env.AIS_LOCAL_MODELS_DIR];
  return [join(deps.home ?? homedir(), ".ais", "models"), "/opt/ais/models"];
}

export async function discoverLocalModels(deps: LocalModelsDeps = {}): Promise<LocalModel[]> {
  const byName = new Map<string, LocalModel>();
  for (const dir of deps.dirs ?? localModelDirs(deps)) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.endsWith(".gguf")) continue;
      const name = entry.name.slice(0, -".gguf".length);
      if (!name || byName.has(name)) continue;
      const path = join(dir, entry.name);
      try {
        // stat follows symlinks: a link to a file counts, a link to a directory does not.
        const info = await stat(path);
        if (info.isFile() && info.size > 0) byName.set(name, { name, path, sizeBytes: info.size });
      } catch {
        // unreadable or dangling: skip silently
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveLlamaRunner(deps: LocalModelsDeps = {}): string | undefined {
  const bin = (deps.env ?? process.env).AIS_LLAMA_BIN;
  if (bin) {
    try {
      accessSync(bin, constants.X_OK);
      if (statSync(bin).isFile()) return bin;
    } catch {
      // not executable: fall back to PATH
    }
  }
  return (deps.which ?? Bun.which)("llama-cli") ?? undefined;
}

export function localModelArgs(model: LocalModel): string[] {
  return ["-m", model.path, "-cnv"];
}

export async function startLocalModel(model: LocalModel, runner: string): Promise<never> {
  return execReal(runner, localModelArgs(model), {});
}
