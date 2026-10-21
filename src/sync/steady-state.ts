import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { aisRemoteCacheDir } from "../shared/ais-home.ts";
import { discoverCrushDatabasePaths } from "./sqlite-merge.ts";

/** Cheap change token for the Crush databases: size+mtime of each database and its WAL.
 * Undefined when there are none. Equal tokens mean a sync has nothing to move. */
export async function crushFingerprint(home: string = homedir()): Promise<string | undefined> {
  const databases = await discoverCrushDatabasePaths(home);
  if (databases.length === 0) return undefined;
  const hash = createHash("sha256");
  for (const rel of databases) {
    for (const suffix of ["", "-wal"]) {
      const info = await stat(join(home, rel + suffix)).catch(() => undefined);
      // A missing and an empty WAL are the same state (opening a database can create one).
      hash.update(info && info.size > 0 ? `${rel}${suffix}:${info.size}:${info.mtimeMs}\n` : `${rel}${suffix}:none\n`);
    }
  }
  return hash.digest("hex");
}

interface HostCrushState { local?: string; remote?: string }
export interface SteadyState {
  crush: Record<string, HostCrushState>;
  /** Home-relative paths no user-level sync can write (root-owned); excluded from transfer. */
  ignored: string[];
}

function statePath(home: string): string {
  return join(aisRemoteCacheDir(home), "steady-state.json");
}

export async function loadSteadyState(home: string = homedir()): Promise<SteadyState> {
  try {
    const raw = JSON.parse(await readFile(statePath(home), "utf8")) as Partial<SteadyState>;
    return { crush: raw.crush ?? {}, ignored: Array.isArray(raw.ignored) ? raw.ignored.filter((p) => typeof p === "string") : [] };
  } catch {
    return { crush: {}, ignored: [] };
  }
}

export async function saveSteadyState(state: SteadyState, home: string = homedir()): Promise<void> {
  await mkdir(aisRemoteCacheDir(home), { recursive: true });
  await writeFile(statePath(home), `${JSON.stringify(state)}\n`);
}

/** Rsync exclude filters for paths recorded as unwritable; first match wins, so put them first. */
export function ignoredPathFilters(state: SteadyState): string[] {
  return state.ignored.map((rel) => `--exclude=/${rel.replace(/[*?[\\]/g, "\\$&")}`);
}
