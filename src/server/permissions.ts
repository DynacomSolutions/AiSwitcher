import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { loadAll, TOOL_CONFIGS } from "../cli/identities/resolve-tool.ts";
import { translateHostPath } from "../identities/match.ts";
import { isRetired } from "../identities/retired.ts";
import type { ToolConfig } from "../identities/types.ts";
import { aisHome } from "../shared/ais-home.ts";
import type {
  PermissionCacheStatsDto,
  PermissionCountsDto,
  PermissionIdentityNode,
  PermissionRepoNode,
  PermissionRulesDto,
  PermissionSourceDto,
  PermissionsDto,
  PermissionToolNode,
  PermissionWorktreeNode,
} from "./types.ts";

/** Read-only permissions tree: tool -> identity -> repo -> worktree -> rules.
 * Every permission file read is cached (keyed by absolute path, validated by
 * mtime + size) in ~/.ais/state/permissions-cache.json, which doubles as an
 * index of the identities, repos and worktrees seen. Nothing here writes a
 * permission file. */

const CACHE_VERSION = 1;
// Sibling of the user's home (the host keeps repos on a shared storage mount).
// Override with AIS_REPOS_ROOT wherever that layout differs.
const DEFAULT_REPOS_ROOT = join(homedir(), "..", "Storage", "Projects", "repositories");

export interface CachedFileEntry {
  mtimeMs: number;
  size: number;
  sha256: string;
  parsedAt: string;
  rules: PermissionRulesDto;
  error?: string;
}

export interface PermissionsCacheFile {
  version: number;
  files: Record<string, CachedFileEntry>;
  identities: Record<string, { tool: string; name: string; configDir: string; seenAt: string }>;
  repos: Record<string, { owner: string; repo: string; seenAt: string }>;
  worktrees: Record<string, { owner: string; repo: string; kind: "base" | "task"; task?: string; seenAt: string }>;
}

export interface PermissionsDeps {
  configs?: ToolConfig[];
  reposRoot?: string;
  cachePath?: string;
  refresh?: boolean;
  env?: Record<string, string | undefined>;
  localHome?: string;
  now?: () => Date;
}

type Parser = (text: string) => PermissionRulesDto;

const emptyRules = (): PermissionRulesDto => ({ allow: [], ask: [], deny: [] });

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Claude Code: `permissions.{allow,ask,deny}` string arrays. */
export const parseClaudeSettings: Parser = (text) => {
  const doc: unknown = JSON.parse(text);
  const perms = isRecord(doc) ? doc.permissions : undefined;
  if (!isRecord(perms)) return emptyRules();
  return { allow: strings(perms.allow), ask: strings(perms.ask), deny: strings(perms.deny) };
};

/** Codex: `approval_policy` and `sandbox_mode` in config.toml. "never" asks
 * nothing (allow), other policies prompt (ask); a read-only sandbox denies
 * writes, workspace-write asks, full access allows. */
export const parseCodexConfig: Parser = (text) => {
  const doc = parseToml(text) as Record<string, unknown>;
  const rules = emptyRules();
  const policy = doc.approval_policy;
  if (typeof policy === "string") (policy === "never" ? rules.allow : rules.ask).push(`approval_policy = ${policy}`);
  const sandbox = doc.sandbox_mode;
  if (typeof sandbox === "string") {
    const group = sandbox === "danger-full-access" ? rules.allow : sandbox === "read-only" ? rules.deny : rules.ask;
    group.push(`sandbox_mode = ${sandbox}`);
  }
  return rules;
};

/** Crush (zai, ali): `permissions.allowed_tools` is an allow list. */
export const parseCrushConfig: Parser = (text) => {
  const doc: unknown = JSON.parse(text);
  const perms = isRecord(doc) ? doc.permissions : undefined;
  return { ...emptyRules(), allow: isRecord(perms) ? strings(perms.allowed_tools) : [] };
};

/** OpenCode: `permission` is either one action or a tool -> action | pattern map. */
export const parseOpencodeConfig: Parser = (text) => {
  const doc: unknown = JSON.parse(text);
  const rules = emptyRules();
  const perm = isRecord(doc) ? doc.permission : undefined;
  const put = (label: string, action: unknown): void => {
    if (action === "allow" || action === "ask" || action === "deny") rules[action].push(label);
  };
  if (typeof perm === "string") put("*", perm);
  else if (isRecord(perm)) {
    for (const [tool, value] of Object.entries(perm)) {
      if (isRecord(value)) for (const [pattern, action] of Object.entries(value)) put(`${tool}: ${pattern}`, action);
      else put(tool, value);
    }
  }
  return rules;
};

interface IdentitySourceSpec {
  file: string;
  parser: Parser;
}

/** Per-tool identity-level permission file; null (+ reason) when the tool has
 * no permission concept AIS can read, instead of guessing. */
function identitySpec(tool: string): { spec: IdentitySourceSpec } | { reason: string } {
  switch (tool) {
    case "claude":
      return { spec: { file: "settings.json", parser: parseClaudeSettings } };
    case "codex":
      return { spec: { file: "config.toml", parser: parseCodexConfig } };
    case "zai":
    case "ali":
      return { spec: { file: "crush.json", parser: parseCrushConfig } };
    case "opencode":
      return { spec: { file: "opencode.json", parser: parseOpencodeConfig } };
    case "grok":
      return { reason: "grok has no permission or approval settings AIS reads" };
    case "kimi":
      return { reason: "kimi has no permission or approval settings AIS reads" };
    case "pi":
      return { reason: "pi has no permission concept (it runs tools without approval prompts)" };
    default:
      return { reason: `no permission model known for ${tool}` };
  }
}

export function defaultPermissionsCachePath(home: string = homedir()): string {
  return join(aisHome(home), "state", "permissions-cache.json");
}

async function loadCache(path: string): Promise<PermissionsCacheFile> {
  const fresh = (): PermissionsCacheFile => ({ version: CACHE_VERSION, files: {}, identities: {}, repos: {}, worktrees: {} });
  try {
    const doc: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(doc) || doc.version !== CACHE_VERSION) return fresh();
    return {
      version: CACHE_VERSION,
      files: isRecord(doc.files) ? (doc.files as PermissionsCacheFile["files"]) : {},
      identities: isRecord(doc.identities) ? (doc.identities as PermissionsCacheFile["identities"]) : {},
      repos: isRecord(doc.repos) ? (doc.repos as PermissionsCacheFile["repos"]) : {},
      worktrees: isRecord(doc.worktrees) ? (doc.worktrees as PermissionsCacheFile["worktrees"]) : {},
    };
  } catch {
    return fresh();
  }
}

async function saveCache(path: string, cache: PermissionsCacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

const sum = (rules: PermissionRulesDto): PermissionCountsDto => ({
  allow: rules.allow.length,
  ask: rules.ask.length,
  deny: rules.deny.length,
  total: rules.allow.length + rules.ask.length + rules.deny.length,
});

function addCounts(items: { counts: PermissionCountsDto }[]): PermissionCountsDto {
  const out = { allow: 0, ask: 0, deny: 0, total: 0 };
  for (const { counts } of items) {
    out.allow += counts.allow;
    out.ask += counts.ask;
    out.deny += counts.deny;
    out.total += counts.total;
  }
  return out;
}

function addCache(items: { cache: PermissionCacheStatsDto }[]): PermissionCacheStatsDto {
  return { hits: items.reduce((n, i) => n + i.cache.hits, 0), misses: items.reduce((n, i) => n + i.cache.misses, 0) };
}

function mergeRules(sources: PermissionSourceDto[]): PermissionRulesDto {
  const out = emptyRules();
  for (const s of sources) {
    out.allow.push(...s.rules.allow);
    out.ask.push(...s.rules.ask);
    out.deny.push(...s.rules.deny);
  }
  return out;
}

function sourceCache(sources: PermissionSourceDto[]): PermissionCacheStatsDto {
  return {
    hits: sources.filter((s) => s.cache === "hit").length,
    misses: sources.filter((s) => s.cache === "miss").length,
  };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listDirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

interface WorktreeRef {
  owner: string;
  repo: string;
  path: string;
  kind: "base" | "task";
  task?: string;
}

/** Same layout git-base uses: <root>/.worktrees/<owner>/.base/<repo> and
 * <root>/.worktrees/<owner>/<task>/<repo>. Base checkouts come first. */
export async function enumerateWorktrees(reposRoot: string): Promise<WorktreeRef[]> {
  const wt = join(reposRoot, ".worktrees");
  const out: WorktreeRef[] = [];
  for (const owner of await listDirs(wt)) {
    const orgDir = join(wt, owner);
    for (const repo of await listDirs(join(orgDir, ".base"))) {
      out.push({ owner, repo, path: join(orgDir, ".base", repo), kind: "base" });
    }
    for (const task of await listDirs(orgDir)) {
      if (task === ".base" || task.startsWith("mirror-quarantine-")) continue;
      for (const repo of await listDirs(join(orgDir, task))) {
        const path = join(orgDir, task, repo);
        if (await Bun.file(join(path, ".git")).exists() || (await isDir(join(path, ".git")))) {
          out.push({ owner, repo, path, kind: "task", task });
        }
      }
    }
  }
  return out;
}

export async function buildPermissions(deps: PermissionsDeps = {}): Promise<PermissionsDto> {
  const configs = deps.configs ?? Object.values(TOOL_CONFIGS);
  const env = deps.env ?? process.env;
  const reposRoot = deps.reposRoot ?? env.AIS_REPOS_ROOT ?? DEFAULT_REPOS_ROOT;
  const cachePath = deps.cachePath ?? defaultPermissionsCachePath();
  const refresh = deps.refresh === true;
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const cache = await loadCache(cachePath);
  let dirty = false;

  const inflight = new Map<string, Promise<PermissionSourceDto>>();
  const readSource = (path: string, label: string, parser: Parser): Promise<PermissionSourceDto> => {
    const existing = inflight.get(path);
    if (existing) return existing.then((s) => ({ ...s, label }));
    const task = (async (): Promise<PermissionSourceDto> => {
      let info;
      try {
        info = await stat(path);
        if (!info.isFile()) throw new Error("not a file");
      } catch {
        return { path, label, exists: false, rules: emptyRules() };
      }
      const cached = cache.files[path];
      if (!refresh && cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        return { path, label, exists: true, cache: "hit", rules: cached.rules, ...(cached.error ? { error: cached.error } : {}) };
      }
      const text = await readFile(path, "utf8");
      let rules = emptyRules();
      let error: string | undefined;
      try {
        rules = parser(text);
      } catch (e) {
        error = `unparsable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
      }
      cache.files[path] = {
        mtimeMs: info.mtimeMs,
        size: info.size,
        sha256: createHash("sha256").update(text).digest("hex"),
        parsedAt: nowIso,
        rules,
        ...(error ? { error } : {}),
      };
      dirty = true;
      return { path, label, exists: true, cache: "miss", rules, ...(error ? { error } : {}) };
    })();
    inflight.set(path, task);
    return task;
  };

  // Repo / worktree level (claude settings files), built once and shared.
  const worktrees = await enumerateWorktrees(reposRoot);
  const repoMap = new Map<string, PermissionRepoNode>();
  for (const ref of worktrees) {
    const sources = await Promise.all([
      readSource(join(ref.path, ".claude", "settings.json"), ".claude/settings.json", parseClaudeSettings),
      readSource(join(ref.path, ".claude", "settings.local.json"), ".claude/settings.local.json", parseClaudeSettings),
    ]);
    const rules = mergeRules(sources);
    const node: PermissionWorktreeNode = {
      path: ref.path,
      kind: ref.kind,
      ...(ref.task !== undefined ? { task: ref.task } : {}),
      sources,
      rules,
      counts: sum(rules),
      cache: sourceCache(sources),
    };
    const key = `${ref.owner}/${ref.repo}`;
    let repo = repoMap.get(key);
    if (!repo) {
      repo = { owner: ref.owner, repo: ref.repo, worktrees: [], counts: sum(emptyRules()), cache: { hits: 0, misses: 0 } };
      repoMap.set(key, repo);
      cache.repos[key] = { owner: ref.owner, repo: ref.repo, seenAt: nowIso };
    }
    repo.worktrees.push(node);
    cache.worktrees[ref.path] = {
      owner: ref.owner,
      repo: ref.repo,
      kind: ref.kind,
      ...(ref.task !== undefined ? { task: ref.task } : {}),
      seenAt: nowIso,
    };
    dirty = true;
  }
  for (const repo of repoMap.values()) {
    repo.counts = addCounts(repo.worktrees);
    repo.cache = addCache(repo.worktrees);
  }
  const repoNodes = [...repoMap.values()];

  const loaded = await loadAll(configs);
  const tools: PermissionToolNode[] = [];
  for (const { cfg, file } of loaded) {
    const identities: PermissionIdentityNode[] = [];
    for (const identity of file.identities) {
      const configDir = translateHostPath(identity.configDir, env, deps.localHome);
      const spec = identitySpec(cfg.toolName);
      const sources = "spec" in spec ? [await readSource(join(configDir, spec.spec.file), spec.spec.file, spec.spec.parser)] : [];
      const rules = mergeRules(sources);
      // Repo files are Claude Code's; other tools show no repo level.
      const repos = cfg.toolName === "claude" ? repoNodes : [];
      const own = sum(rules);
      const counts = addCounts([{ counts: own }, ...repos]);
      cache.identities[`${cfg.toolName}/${identity.name}`] = {
        tool: cfg.toolName,
        name: identity.name,
        configDir: identity.configDir,
        seenAt: nowIso,
      };
      dirty = true;
      identities.push({
        name: identity.name,
        label: identity.label,
        configDir: identity.configDir,
        ...(isRetired(identity) ? { retired: true as const } : {}),
        sources,
        rules,
        ...("reason" in spec ? { reason: spec.reason } : {}),
        repos,
        counts,
        cache: addCache([{ cache: sourceCache(sources) }, ...repos]),
      });
    }
    tools.push({ toolName: cfg.toolName, identities, counts: addCounts(identities), cache: addCache(identities) });
  }

  if (dirty) await saveCache(cachePath, cache).catch(() => undefined);

  return {
    generatedAt: nowIso,
    refreshed: refresh,
    cachePath,
    reposRoot,
    counts: addCounts(tools),
    cache: addCache(tools),
    tools,
  };
}
