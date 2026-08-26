import { basename, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ToolConfig } from "../identities/types.ts";
import { REPRODUCIBLE_JUNK_DIR_NAMES } from "../shared/reproducible-paths.ts";
import { loadAll, TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { aisHome } from "../shared/ais-home.ts";
import { HttpError, type FileContentDto, type FileRootDto, type FileTreeDto } from "./types.ts";

/** Whitelisted file browsing/editing over the trees AIS legitimately owns:
 * the shared ~/.ais tree, each tool's home container (skills/agents/plugins/
 * hooks/rules/memory live there), and every registered identity's configDir.
 * Everything else is unreachable through this API by construction: both the
 * lexical path and its final symlink-resolved target must stay inside one
 * whitelisted root. */

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const FILE_BACKUPS_SUBDIR = "web/file-backups";

interface RootDef {
  id: string;
  label: string;
  base: string;
}

/** Same test-injection convention as registries.ts/collectLimitTargets:
 * defaults to the real TOOL_CONFIGS; tests pass synthetic registries under a
 * temp dir so these endpoints can never touch the live home. */
async function collectRoots(configs: ToolConfig[]): Promise<RootDef[]> {
  const home = homedir();
  const roots: RootDef[] = [{ id: "ais", label: "~/.ais (shared)", base: aisHome() }];
  const containers: Array<[string, string]> = [
    ["claude", ".claude"],
    ["codex", ".codex"],
    ["grok", ".grok"],
    ["kimi", ".kimi-code"],
    ["zai", ".zai"],
    ["ali", ".ali"],
  ];
  for (const [id, rel] of containers) {
    roots.push({ id, label: `~/${rel}`, base: join(home, rel) });
  }
  try {
    const loaded = await loadAll(configs);
    for (const { cfg, file } of loaded) {
      for (const identity of file.identities) {
        roots.push({
          id: `id:${cfg.toolName}:${identity.name}`,
          label: `${cfg.toolName}/${identity.name} configDir`,
          base: identity.configDir,
        });
      }
    }
  } catch {
    // A broken registry must not take the whole files API down.
  }
  return roots;
}

export async function listRoots(configs: ToolConfig[] = Object.values(TOOL_CONFIGS)): Promise<FileRootDto[]> {
  const roots = await collectRoots(configs);
  const home = homedir();
  return Promise.all(
    roots.map(async (root) => ({
      root: root.id,
      label: root.label,
      exists: await stat(root.base).then(
        () => true,
        () => false,
      ),
      path: root.base.replace(home, "~"),
    })),
  );
}

async function requireRoot(rootId: string, configs: ToolConfig[]): Promise<RootDef> {
  const root = (await collectRoots(configs)).find((r) => r.id === rootId);
  if (!root) throw new HttpError(404, `unknown file root "${rootId}"`);
  return root;
}

/** The core traversal guard. Returns the absolute real path of `relPath`
 * inside `root`, or throws. Two checks on purpose: the lexical resolution
 * catches ../ walks before touching disk; the realpath check catches a
 * symlink INSIDE the tree pointing OUTSIDE it. */
async function safeResolve(base: string, relPath: string | undefined): Promise<{ abs: string; real: string }> {
  const rootReal = await realpath(base);
  // Deliberately NOT expandPath(): that helper resolves bare relative paths
  // against process.cwd() (registry-storage semantics). Here a relative path
  // always means "relative to the chosen root".
  const abs = resolve(rootReal, relPath === undefined || relPath === "" ? "." : relPath);
  if (relative(rootReal, abs).startsWith("..")) {
    throw new HttpError(403, "path escapes the whitelisted root");
  }
  let real = abs;
  try {
    real = await realpath(abs);
  } catch {
    // Target may not exist yet (new-file write); the parent is checked on use.
  }
  // Catches a symlink INSIDE the tree whose target lives OUTSIDE it.
  if (relative(rootReal, real).startsWith("..")) {
    throw new HttpError(403, "symlink escapes the whitelisted root");
  }
  return { abs, real };
}

export async function tree(rootId: string, relPath: string | undefined, configs: ToolConfig[] = Object.values(TOOL_CONFIGS)): Promise<FileTreeDto> {
  const root = await requireRoot(rootId, configs);
  const { abs, real } = await safeResolve(root.base, relPath);
  let dirents;
  try {
    dirents = await readdir(real, { withFileTypes: true });
  } catch (err) {
    throw new HttpError(404, err instanceof Error ? err.message : "cannot read directory");
  }
  const entries = await Promise.all(
    dirents
      .filter((d) => !(d.isDirectory() && (REPRODUCIBLE_JUNK_DIR_NAMES as readonly string[]).includes(d.name)))
      .map(async (d) => {
        const childAbs = join(abs, d.name);
        try {
          const info = await stat(childAbs);
          return {
            name: d.name,
            kind: d.isDirectory() ? ("directory" as const) : ("file" as const),
            ...(d.isFile() ? { size: info.size } : {}),
            mtime: info.mtime.toISOString(),
          };
        } catch {
          return { name: d.name, kind: d.isDirectory() ? ("directory" as const) : ("file" as const) };
        }
      }),
  );
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
  return { path: abs.replace(homedir(), "~"), entries };
}

function looksBinary(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, 8192);
  return probe.includes(0);
}

export async function readTextFile(rootId: string, relPath: string, configs: ToolConfig[] = Object.values(TOOL_CONFIGS)): Promise<FileContentDto> {
  const root = await requireRoot(rootId, configs);
  const { abs, real } = await safeResolve(root.base, relPath);
  const info = await stat(real).catch(() => {
    throw new HttpError(404, "file not found");
  });
  if (info.size > MAX_FILE_BYTES) throw new HttpError(413, "file exceeds the 2 MB editor limit");
  const bytes = await readFile(real);
  const binary = looksBinary(new Uint8Array(bytes));
  return {
    path: abs.replace(homedir(), "~"),
    content: binary ? "" : new TextDecoder().decode(bytes),
    size: info.size,
    mtime: info.mtime.toISOString(),
    binary,
  };
}

export async function writeTextFile(
  rootId: string,
  relPath: string,
  content: string,
  configs: ToolConfig[] = Object.values(TOOL_CONFIGS),
): Promise<{ ok: true; backedUpTo?: string }> {
  const root = await requireRoot(rootId, configs);
  if (content.length > MAX_FILE_BYTES) throw new HttpError(413, "content exceeds the 2 MB editor limit");
  const { abs, real } = await safeResolve(root.base, relPath);
  const parent = dirname(abs);
  const parentReal = await realpath(parent).catch(() => {
    throw new HttpError(400, "parent directory does not exist");
  });
  const rootReal = await realpath(root.base);
  if (relative(rootReal, parentReal).startsWith("..")) throw new HttpError(403, "parent escapes the whitelisted root");

  // Keep the previous bytes under ~/.ais/web/file-backups before replacing.
  let backedUpTo: string | undefined;
  const existing = await stat(real).catch(() => undefined);
  if (existing?.isFile()) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(aisHome(), FILE_BACKUPS_SUBDIR, `${stamp}-${basename(abs)}`);
    await mkdir(dirname(backupPath), { recursive: true });
    await Bun.write(backupPath, new Uint8Array(await readFile(real)));
    backedUpTo = backupPath.replace(homedir(), "~");
  }

  const tmp = `${parent}/.${randomUUID()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, real === abs ? abs : real);
  return { ok: true, ...(backedUpTo ? { backedUpTo } : {}) };
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}
