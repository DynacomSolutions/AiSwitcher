import { Database } from "bun:sqlite";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseIdentitiesFile } from "../identities/store.ts";
import { configHomeRoot, CRUSH_BACKED_TOOL_CONFIGS } from "./rsync.ts";

export interface CrushSnapshotManifest {
  version: 1;
  root: string;
  databases: string[];
}

export const CRUSH_SNAPSHOT_MANIFEST = ".ais-crush-snapshot.json";

function slash(path: string): string {
  return path.split(sep).join("/");
}

function expandForHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  return resolve(path);
}

function homeRelative(path: string, home: string): string | undefined {
  const rel = slash(relative(home, path));
  if (!rel || rel === ".." || rel.startsWith("../")) return undefined;
  return rel;
}

function assertSafeRelative(path: string): string {
  if (!path || path.startsWith("/") || path === ".." || path.startsWith("../") || path.includes("/../")) {
    throw new Error(`Unsafe SQLite snapshot path: ${path}`);
  }
  return path;
}

interface ProjectsFile {
  projects?: Array<{ data_dir?: string }>;
}

/** Scans EVERY crush-backed registry (zai, ali; see rsync.ts's
 * CRUSH_BACKED_TOOL_CONFIGS), not just zai's own `.zai/identities.json`.
 * Originally zai-only; generalized when ali was added so both tools'
 * databases participate in the same snapshot/merge protocol without a
 * second, parallel discovery path. */
export async function discoverCrushDatabasePaths(home: string = homedir()): Promise<string[]> {
  const databases = new Set<string>();

  for (const cfg of CRUSH_BACKED_TOOL_CONFIGS) {
    // cfg.identitiesJsonPath is an absolute path built from the REAL
    // homedir() at import time (see identities/tool-configs.ts), which may
    // differ from the `home` parameter a test passes in; configHomeRoot
    // re-derives its path relative to the real home (e.g. ".zai") and this
    // re-joins it under the caller's `home`, the same way the rest of this
    // module already treats `home` as an override.
    const registry = Bun.file(join(home, configHomeRoot(cfg), "identities.json"));
    if (!(await registry.exists())) continue;
    const file = parseIdentitiesFile(await registry.json());

    for (const identity of file.identities) {
      const configDir = expandForHome(identity.configDir, home);
      try {
        const projects = (await Bun.file(join(configDir, "data", "projects.json")).json()) as ProjectsFile;
        for (const project of projects.projects ?? []) {
          if (!project.data_dir) continue;
          const rel = homeRelative(join(project.data_dir, "crush.db"), home);
          if (rel && (await Bun.file(join(home, rel)).exists())) databases.add(rel);
        }
      } catch {
        // A new identity or host may not have a machine-local project index yet.
      }
    }
  }
  return [...databases].sort();
}

function verifySnapshotDatabase(path: string, sourcePath: string): void {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const row = db.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
    if (!row || !Object.values(row).includes("ok")) {
      throw new Error(`SQLite snapshot verification failed for ${sourcePath}`);
    }
  } finally {
    db.close();
  }
}

/** Creates transactionally-consistent, WAL-aware copies through SQLite's
 * own VACUUM INTO operation; rsync never reads a live Crush database directly. */
export async function createCrushSnapshotTree(
  root: string,
  home: string = homedir(),
  databasePaths?: string[],
): Promise<CrushSnapshotManifest> {
  const databases = (databasePaths ?? (await discoverCrushDatabasePaths(home))).map(assertSafeRelative);
  for (const rel of databases) {
    const sourcePath = join(home, rel);
    const destination = join(root, rel);
    await mkdir(dirname(destination), { recursive: true });
    const db = new Database(sourcePath, { readonly: true, strict: true });
    try {
      db.run("PRAGMA busy_timeout = 30000");
      db.run("VACUUM INTO ?", [destination]);
    } finally {
      db.close();
    }
    verifySnapshotDatabase(destination, sourcePath);
  }
  const manifest: CrushSnapshotManifest = { version: 1, root, databases };
  await mkdir(root, { recursive: true });
  await Bun.write(join(root, CRUSH_SNAPSHOT_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function loadCrushSnapshotManifest(root: string): Promise<CrushSnapshotManifest> {
  const raw = (await Bun.file(join(root, CRUSH_SNAPSHOT_MANIFEST)).json()) as Partial<CrushSnapshotManifest>;
  if (raw.version !== 1 || !Array.isArray(raw.databases) || raw.databases.some((path) => typeof path !== "string")) {
    throw new Error(`Invalid Crush snapshot manifest in ${root}`);
  }
  return { version: 1, root, databases: raw.databases.map(assertSafeRelative) };
}

function hasTable(db: Database, schema: string, table: string): boolean {
  const row = db
    .query(`SELECT 1 AS present FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .get(table) as { present?: number } | null;
  return row?.present === 1;
}

function mergeExistingCrushDatabase(destination: string, source: string): void {
  const db = new Database(destination, { readwrite: true, create: false, strict: true });
  let attached = false;
  try {
    db.run("PRAGMA busy_timeout = 30000");
    db.run("PRAGMA foreign_keys = OFF");
    db.run("ATTACH DATABASE ? AS incoming", [source]);
    attached = true;
    for (const table of ["sessions", "messages", "files", "read_files"]) {
      if (!hasTable(db, "main", table) || !hasTable(db, "incoming", table)) {
        throw new Error(`Crush database schema mismatch: missing ${table} in ${destination} or ${source}`);
      }
    }

    db.run("BEGIN IMMEDIATE");
    try {
      db.run(`
        INSERT INTO sessions (
          id, parent_session_id, title, message_count, prompt_tokens, completion_tokens,
          cost, updated_at, created_at, summary_message_id, todos
        )
        SELECT id, parent_session_id, title, message_count, prompt_tokens, completion_tokens,
               cost, updated_at, created_at, summary_message_id, todos
        FROM incoming.sessions WHERE true
        ON CONFLICT(id) DO UPDATE SET
          parent_session_id = CASE WHEN excluded.updated_at >= sessions.updated_at THEN excluded.parent_session_id ELSE sessions.parent_session_id END,
          title = CASE WHEN excluded.updated_at >= sessions.updated_at THEN excluded.title ELSE sessions.title END,
          message_count = MAX(sessions.message_count, excluded.message_count),
          prompt_tokens = MAX(sessions.prompt_tokens, excluded.prompt_tokens),
          completion_tokens = MAX(sessions.completion_tokens, excluded.completion_tokens),
          cost = MAX(sessions.cost, excluded.cost),
          updated_at = MAX(sessions.updated_at, excluded.updated_at),
          created_at = MIN(sessions.created_at, excluded.created_at),
          summary_message_id = CASE WHEN excluded.updated_at >= sessions.updated_at THEN excluded.summary_message_id ELSE sessions.summary_message_id END,
          todos = CASE WHEN excluded.updated_at >= sessions.updated_at THEN excluded.todos ELSE sessions.todos END
      `);
      db.run(`
        INSERT INTO messages (
          id, session_id, role, parts, model, created_at, updated_at, finished_at, provider, is_summary_message
        )
        SELECT id, session_id, role, parts, model, created_at, updated_at, finished_at, provider, is_summary_message
        FROM incoming.messages WHERE true
        ON CONFLICT(id) DO UPDATE SET
          session_id = CASE WHEN excluded.updated_at >= messages.updated_at THEN excluded.session_id ELSE messages.session_id END,
          role = CASE WHEN excluded.updated_at >= messages.updated_at THEN excluded.role ELSE messages.role END,
          parts = CASE WHEN excluded.updated_at >= messages.updated_at THEN excluded.parts ELSE messages.parts END,
          model = CASE WHEN excluded.updated_at >= messages.updated_at THEN excluded.model ELSE messages.model END,
          created_at = MIN(messages.created_at, excluded.created_at),
          updated_at = MAX(messages.updated_at, excluded.updated_at),
          finished_at = CASE WHEN excluded.updated_at >= messages.updated_at THEN excluded.finished_at ELSE messages.finished_at END,
          provider = CASE WHEN excluded.updated_at >= messages.updated_at THEN excluded.provider ELSE messages.provider END,
          is_summary_message = CASE WHEN excluded.updated_at >= messages.updated_at THEN excluded.is_summary_message ELSE messages.is_summary_message END
      `);
      db.run(`
        INSERT INTO files (id, session_id, path, content, version, created_at, updated_at)
        SELECT id, session_id, path, content, version, created_at, updated_at
        FROM incoming.files WHERE true
        ON CONFLICT(id) DO UPDATE SET
          session_id = CASE WHEN excluded.updated_at >= files.updated_at THEN excluded.session_id ELSE files.session_id END,
          path = CASE WHEN excluded.updated_at >= files.updated_at THEN excluded.path ELSE files.path END,
          content = CASE WHEN excluded.updated_at >= files.updated_at THEN excluded.content ELSE files.content END,
          version = MAX(files.version, excluded.version),
          created_at = MIN(files.created_at, excluded.created_at),
          updated_at = MAX(files.updated_at, excluded.updated_at)
      `);
      db.run(`
        INSERT INTO read_files (session_id, path, read_at)
        SELECT session_id, path, read_at FROM incoming.read_files WHERE true
        ON CONFLICT(path, session_id) DO UPDATE SET read_at = MAX(read_files.read_at, excluded.read_at)
      `);
      db.run("COMMIT");
    } catch (error) {
      db.run("ROLLBACK");
      throw error;
    }
    db.run("DETACH DATABASE incoming");
    attached = false;
    const row = db.query("PRAGMA quick_check").get() as Record<string, unknown> | null;
    if (!row || !Object.values(row).includes("ok")) throw new Error(`Merged Crush database failed quick_check: ${destination}`);
  } finally {
    if (attached) {
      try {
        db.run("DETACH DATABASE incoming");
      } catch {
        // A failed transaction may keep the attachment busy until close.
      }
    }
    db.close();
  }
}

export async function mergeCrushSnapshotTree(
  manifest: CrushSnapshotManifest,
  home: string = homedir(),
): Promise<number> {
  if (manifest.version !== 1) throw new Error("Unsupported Crush snapshot manifest version");
  let merged = 0;
  for (const rawRel of manifest.databases) {
    const rel = assertSafeRelative(rawRel);
    const source = join(manifest.root, rel);
    if (!(await Bun.file(source).exists())) throw new Error(`Crush snapshot is missing ${rel}`);
    const destination = join(home, rel);
    await mkdir(dirname(destination), { recursive: true });
    if (!(await Bun.file(destination).exists())) await copyFile(source, destination);
    else mergeExistingCrushDatabase(destination, source);
    merged++;
  }
  return merged;
}
