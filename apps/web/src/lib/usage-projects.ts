import { withinSince, type SinceDays } from "./usage-period";
import type { UsageProjectRow } from "../types/api";

export type ProjectGrouping = "project" | "repo" | "org";

export interface ProjectFilters {
  provider: string;
  identity: string;
  since: SinceDays;
}

/** Rows the Usage page's provider, identity and period filters let through.
 * Period uses the row's local `date` exactly as applyPeriod does; "All time"
 * keeps every row. */
export function filterProjectRows(rows: UsageProjectRow[], filters: ProjectFilters, nowMs: number = Date.now()): UsageProjectRow[] {
  return rows.filter((row) =>
    (filters.provider === "all" || row.provider === filters.provider) &&
    (filters.identity === "all" || row.identity === filters.identity) &&
    withinSince(row.date, filters.since, nowMs));
}

export interface GroupRow {
  key: string;
  label: string;
  /** Muted second line (full path, host or repo count). */
  sub?: string;
  title?: string;
  noRemote: boolean;
  /** Every underlying directory is gone from this host. */
  missing: boolean;
  turns: number;
  input: number;
  output: number;
  cache: number;
  cost: number;
  lastUsedAt: string | null;
}

function lastSegment(path: string, name?: string): string {
  if (name && path.startsWith("-")) return name; // an undecodable Claude key is not a readable path
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Aggregate rows into the chosen grouping, biggest cost first. */
export function groupProjects(rows: UsageProjectRow[], grouping: ProjectGrouping): GroupRow[] {
  const groups = new Map<string, GroupRow & { paths: Set<string>; repos: Set<string>; present: number; rows: number; lastMs: number }>();
  for (const p of rows) {
    let key: string;
    let label: string;
    let sub: string | undefined;
    let title: string | undefined;
    let noRemote = false;
    if (grouping === "project") {
      key = p.path;
      label = p.path === "" ? "(no working directory)" : lastSegment(p.path, p.name);
      sub = p.path === "" ? undefined : p.repo ? `${p.repo}${p.inferred ? " (inferred from folder name)" : ""} · ${p.path}` : p.path;
      title = p.path || undefined;
    } else if (grouping === "repo") {
      if (p.repo) {
        key = `repo:${p.host ?? ""}/${p.repo}`;
        label = p.repo;
        sub = p.host;
        title = p.host ? `${p.host}/${p.repo}` : p.repo;
      } else {
        key = `path:${p.path}`;
        label = p.path === "" ? "(no working directory)" : lastSegment(p.path, p.name);
        sub = p.path || undefined;
        title = p.path || undefined;
        noRemote = true;
      }
    } else {
      key = p["org"] ? `org:${p["org"]}` : "none";
      label = p["org"] ?? "(no git remote)";
      noRemote = !p["org"];
    }
    let row = groups.get(key);
    if (!row) {
      row = {
        key, label, sub, title, noRemote, missing: false,
        turns: 0, input: 0, output: 0, cache: 0, cost: 0, lastUsedAt: null,
        paths: new Set(), repos: new Set(), present: 0, rows: 0, lastMs: 0,
      };
      groups.set(key, row);
    }
    row.turns += p.messages;
    row.input += p.input;
    row.output += p.output;
    row.cache += p.cacheRead + p.cacheWrite;
    row.cost += p.cost;
    row.lastMs = Math.max(row.lastMs, p.lastMs);
    row.paths.add(p.path);
    if (p.repo) row.repos.add(p.repo);
    row.rows += 1;
    if (p.source !== "missing") row.present += 1;
  }
  const out = [...groups.values()].map((g) => {
    if (grouping === "org" && g.rows > 0) {
      const n = g.repos.size;
      g.sub = n > 0 ? `${n} ${n === 1 ? "repository" : "repositories"}` : `${g.paths.size} ${g.paths.size === 1 ? "directory" : "directories"}`;
    } else if (grouping === "repo" && g.paths.size > 1) {
      g.sub = `${g.sub ? `${g.sub} · ` : ""}${g.paths.size} directories`;
    }
    g.missing = g.present === 0;
    g.lastUsedAt = g.lastMs > 0 ? new Date(g.lastMs).toISOString() : null;
    return g;
  });
  return out.sort((a, b) => b.cost - a.cost || b.turns - a.turns || a.label.localeCompare(b.label));
}

export interface Coverage {
  /** Spend the project rows account for. */
  projectsCost: number;
  /** The Usage page's total for the same filters. */
  usageCost: number;
  /** Usage spend with no session logs behind it (e.g. AWS Bedrock billing); never negative. */
  remainder: number;
}

export function projectCoverage(rows: UsageProjectRow[], usageCost: number): Coverage {
  const projectsCost = rows.reduce((sum, row) => sum + row.cost, 0);
  return { projectsCost, usageCost, remainder: Math.max(0, usageCost - projectsCost) };
}
