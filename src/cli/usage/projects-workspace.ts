import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inferMissingRepos, resolveProjectFromFs, type BreakdownProject, type BreakdownResult, type ResolvedProject } from "./breakdown.ts";

/** Claude's project directory name for a working directory: every
 * non-alphanumeric character becomes "-". The mapping is lossy ("/" and "-"
 * and "." all collapse), so decoding walks the real filesystem. */
export function encodeClaudeProjectKey(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

export interface DecodeDeps {
  readdir?: (path: string) => Array<{ name: string; dir: boolean }>;
  /** Upper bound on directory listings and candidate visits for one key. */
  budget?: number;
}

function defaultReaddir(path: string): Array<{ name: string; dir: boolean }> {
  const out: Array<{ name: string; dir: boolean }> = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    let dir = entry.isDirectory();
    if (!dir && entry.isSymbolicLink()) {
      try { dir = statSync(join(path, entry.name)).isDirectory(); } catch { dir = false; }
    }
    if (dir) out.push({ name: entry.name, dir });
  }
  return out;
}

export interface DecodedClaudeKey {
  /** Longest existing directory the key's leading runs resolved to. */
  path: string;
  /** Unresolved remainder of the key (empty on a full match). */
  rest: string;
  /** Number of path components matched. */
  depth: number;
}

/** Decode a Claude-encoded project directory name by walking the filesystem
 * from "/": at each directory, a child whose encoded name equals the next run
 * of the key (followed by "-" or the end) is a candidate. Longer names are
 * tried first (fewer path components), the search is depth-first and bounded,
 * and the first full match wins. With no full match the deepest partial match
 * is returned so a deleted worktree still lands under its existing parent. */
export function decodeClaudeProjectKey(key: string, deps: DecodeDeps = {}): DecodedClaudeKey {
  const readdir = deps.readdir ?? defaultReaddir;
  let budget = deps.budget ?? 4000;
  let best: DecodedClaudeKey = { path: "/", rest: key.replace(/^-/, ""), depth: 0 };
  const listings = new Map<string, Array<{ name: string; enc: string }>>();
  const children = (dir: string) => {
    let hit = listings.get(dir);
    if (!hit) {
      budget -= 1;
      try { hit = readdir(dir).map((e) => ({ name: e.name, enc: encodeClaudeProjectKey(e.name) })); } catch { hit = []; }
      listings.set(dir, hit);
    }
    return hit;
  };
  if (!key.startsWith("-")) return best;
  const walk = (dir: string, rest: string, depth: number): boolean => {
    if (depth > best.depth) best = { path: dir, rest, depth };
    if (rest === "") return true;
    if (budget <= 0) return false;
    const candidates = children(dir)
      .filter((c) => rest === c.enc || (rest.startsWith(c.enc) && rest[c.enc.length] === "-"))
      .sort((a, b) => b.enc.length - a.enc.length || a.name.localeCompare(b.name));
    for (const candidate of candidates) {
      budget -= 1;
      const next = rest === candidate.enc ? "" : rest.slice(candidate.enc.length + 1);
      if (walk(join(dir, candidate.name), next, depth + 1)) return true;
      if (budget <= 0) return false;
    }
    return false;
  };
  walk("/", key.slice(1), 0);
  return best;
}

export interface WorkspaceEntry extends ResolvedProject {
  inferred?: true;
  /** Short display name: the inferred repository's name, else the workspace label. */
  name?: string;
}

interface CachedWorkspace {
  /** Decoded or expanded absolute path, before git resolution. */
  path: string;
  /** True when the path existed on this host at `checkedAt`. */
  exists: boolean;
  checkedAt: number;
}

interface WorkspaceCacheFile {
  schemaVersion: 1;
  entries: Record<string, CachedWorkspace>;
}

/** A path that is gone is looked up again after this long; one that exists is
 * re-checked with a single stat on every run. */
export const WORKSPACE_MISSING_RECHECK_MS = 60 * 60_000;

function readWorkspaceCache(path: string): WorkspaceCacheFile {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as WorkspaceCacheFile;
    if (value.schemaVersion === 1 && value.entries && typeof value.entries === "object") return value;
  } catch { /* first run or unreadable: start empty */ }
  return { schemaVersion: 1, entries: {} };
}

function writeWorkspaceCache(path: string, cache: WorkspaceCacheFile): void {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* nothing left */ }
    throw error;
  }
}

export interface WorkspaceResolverDeps {
  cachePath: string;
  now?: () => number;
  home?: string;
  decode?: (key: string) => DecodedClaudeKey;
  resolveProject?: (cwd: string) => ResolvedProject;
}

/** Resolve distinct workspace keys (with a display label each) to projects.
 * Decoded paths are persisted per key; the git/remote lookup is pure file
 * reads, memoised per run, then repository names are inferred for folders
 * that are gone (as the transcript breakdown does). */
export function resolveWorkspaces(keys: Map<string, string>, deps: WorkspaceResolverDeps): Record<string, WorkspaceEntry> {
  const now = (deps.now ?? Date.now)();
  const home = deps.home ?? homedir();
  const decode = deps.decode ?? decodeClaudeProjectKey;
  const fromFs = deps.resolveProject ?? resolveProjectFromFs;
  const cache = readWorkspaceCache(deps.cachePath);
  let dirty = false;
  const memo = new Map<string, ResolvedProject>();
  const resolveFs = (path: string) => {
    let hit = memo.get(path);
    if (!hit) memo.set(path, (hit = fromFs(path)));
    return hit;
  };

  const out: Record<string, WorkspaceEntry> = {};
  const projects: BreakdownProject[] = [];
  const projectKeys: string[] = [];
  for (const [key, label] of keys) {
    const name = label || key;
    if (key === "") {
      out[key] = { path: "", source: "unknown" };
      continue;
    }
    let absolute: string | undefined;
    if (key === "~" || key.startsWith("~/")) absolute = join(home, key.slice(1));
    else if (key.startsWith("/")) absolute = key;
    if (absolute !== undefined) {
      const entry = resolveFs(absolute);
      out[key] = entry;
      projects.push({ ...entry, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, lastUsedAt: null });
      projectKeys.push(key);
      continue;
    }
    if (!key.startsWith("-")) {
      out[key] = { path: key, source: "missing" };
      continue;
    }
    let cached = cache.entries[key];
    const fresh = cached && (cached.exists ? existsSync(cached.path) : now - cached.checkedAt < WORKSPACE_MISSING_RECHECK_MS);
    if (!cached || !fresh) {
      const decoded = decode(key);
      if (decoded.rest === "") cached = { path: decoded.path, exists: true, checkedAt: now };
      else if (decoded.depth >= 1) cached = { path: join(decoded.path, decoded.rest), exists: false, checkedAt: now };
      else cached = { path: key, exists: false, checkedAt: now };
      cache.entries[key] = cached;
      dirty = true;
    }
    const entry: WorkspaceEntry = cached.exists ? resolveFs(cached.path) : { path: cached.path, source: "missing" };
    out[key] = entry;
    projects.push({ ...entry, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, lastUsedAt: null });
    projectKeys.push(key);
  }

  const result = { projects } as BreakdownResult;
  inferMissingRepos([result]);
  projects.forEach((project, index) => {
    if (project.inferred) out[projectKeys[index]!] = { ...out[projectKeys[index]!]!, repo: project.repo, org: project.org, ...(project.host ? { host: project.host } : {}), inferred: true };
  });

  // Folders that are gone from this host (other machine, old layout) and whose
  // key still names a repository resolved in this run.
  const known = new Map<string, { repo: string; org?: string; host?: string }>();
  for (const entry of Object.values(out)) {
    if (!entry.repo || entry.inferred) continue;
    known.set(entry.repo, { repo: entry.repo, ...(entry.org ? { org: entry.org } : {}), ...(entry.host ? { host: entry.host } : {}) });
  }
  const orgs = new Map<string, { org: string; host?: string }>();
  for (const entry of Object.values(out)) {
    if (!entry.org || entry.inferred) continue;
    orgs.set(entry.org.toLowerCase(), { org: entry.org, ...(entry.host ? { host: entry.host } : {}) });
  }
  const names = [...known.values()].map((remote) => ({ remote, name: remote.repo.slice(remote.repo.lastIndexOf("/") + 1).toLowerCase() })).filter((n) => n.name !== "");
  for (const [key, entry] of Object.entries(out)) {
    const label = keys.get(key) ?? "";
    if (entry.source === "missing" && !entry.repo && names.length > 0) {
      const claudeKey = key.startsWith("-");
      const subject = claudeKey ? key.toLowerCase() : entry.path.replace(/\/+$/, "").split("/").pop()!.toLowerCase();
      let longest = 0;
      let matches = new Set<string>();
      for (const { remote, name } of names) {
        const hit = claudeKey ? subject.endsWith(`-${encodeClaudeProjectKey(name)}`) : subject === name;
        if (!hit || name.length < longest) continue;
        if (name.length > longest) { longest = name.length; matches = new Set(); }
        matches.add(remote.repo);
      }
      if (matches.size === 1) {
        const remote = known.get([...matches][0]!)!;
        out[key] = { ...entry, ...remote, inferred: true, name: remote.repo.slice(remote.repo.lastIndexOf("/") + 1) };
        continue;
      }
    }
    // A gone org folder (`<org>` of a `<org>/<repo>` layout): its name is an owner seen this run.
    if (entry.source === "missing" && !entry.repo && !entry.org && orgs.size > 0) {
      const claudeKey = key.startsWith("-");
      const subject = claudeKey ? key.toLowerCase() : entry.path.replace(/\/+$/, "").split("/").pop()!.toLowerCase();
      let hit: { org: string; host?: string } | undefined;
      let longest = 0;
      for (const [lower, owner] of orgs) {
        const compact = lower.replace(/[^a-z0-9]/g, "");
        const match = claudeKey
          ? subject.endsWith(`-${encodeClaudeProjectKey(lower)}`) || subject.slice(subject.lastIndexOf("-") + 1) === compact
          : subject.replace(/[^a-z0-9]/g, "") === compact;
        if (match && lower.length > longest) { longest = lower.length; hit = owner; }
      }
      if (hit) {
        out[key] = { ...entry, org: hit.org, ...(hit.host ? { host: hit.host } : {}), inferred: true, name: label || entry.path.replace(/\/+$/, "").split("/").pop() || entry.path };
        continue;
      }
    }
    const display = out[key]!;
    if (!display.name) {
      const fallback = label || display.path.replace(/\/+$/, "").split("/").pop() || display.path;
      if (fallback) out[key] = { ...display, name: fallback };
    }
  }

  // Keys no longer seen drop out of the persisted cache.
  for (const key of Object.keys(cache.entries)) if (!keys.has(key)) { delete cache.entries[key]; dirty = true; }
  if (dirty) {
    try { writeWorkspaceCache(deps.cachePath, cache); } catch { /* advisory cache */ }
  }
  return out;
}
