import { readdir, readFile, stat, chmod } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { expandPath } from "./match.ts";
import { writeFileAtomic } from "./pool/fs.ts";
import { loadIdentitiesFile } from "./store.ts";
import { CODEX_CONFIG } from "./tool-configs.ts";
import { t3Paths } from "./t3-anthropic-proxy.ts";

/**
 * Codex 0.167 sends analytics events, Sentry feedback and Statsig metrics unless config.toml turns them off (owner order,
 * 25 Nov 2026). These keys are enforced in every Codex home that ais manages. Other keys and comments stay as they are.
 */
export const CODEX_TELEMETRY_OFF: Readonly<Record<string, Readonly<Record<string, string | boolean>>>> = {
  analytics: { enabled: false },
  feedback: { enabled: false },
  otel: { exporter: "none", trace_exporter: "none", metrics_exporter: "none" },
};

const HEADER = /^\s*\[\s*([^\][]*?)\s*\]\s*(?:#.*)?$/;
const ARRAY_HEADER = /^\s*\[\[/;
const tomlValue = (v: string | boolean): string => (typeof v === "boolean" ? String(v) : JSON.stringify(v));

type Table = Record<string, unknown>;

/** Telemetry settings of a config.toml text that are missing or wrong, as "table.key". Empty when telemetry is off. */
export function codexTelemetryProblems(text: string): string[] {
  let parsed: Table;
  try {
    parsed = parseToml(text) as Table;
  } catch {
    return ["config.toml is not valid TOML"];
  }
  const bad: string[] = [];
  for (const [table, keys] of Object.entries(CODEX_TELEMETRY_OFF)) {
    const t = parsed[table];
    const have = typeof t === "object" && t !== null && !Array.isArray(t) ? (t as Table) : {};
    for (const [k, v] of Object.entries(keys)) if (have[k] !== v) bad.push(`${table}.${k}`);
  }
  return bad;
}

/** Pure: the config.toml text with the telemetry keys set. Idempotent. Throws when the result still does not parse to the wanted values. */
export function applyCodexTelemetryOff(text: string): string {
  if (codexTelemetryProblems(text).length === 0) return text;
  let lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const [table, keys] of Object.entries(CODEX_TELEMETRY_OFF)) {
    const todo = new Map(Object.entries(keys));
    let section: string | undefined;
    let headerAt = -1;
    const out: string[] = [];
    for (const line of lines) {
      const m = ARRAY_HEADER.test(line) ? undefined : HEADER.exec(line);
      if (m || ARRAY_HEADER.test(line)) {
        section = m ? m[1]!.replace(/\s*\.\s*/g, ".").replace(/"/g, "") : "[[array]]";
        if (section === table) headerAt = out.length;
        out.push(line);
        continue;
      }
      const kv = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (section === table && kv && todo.has(kv[1]!)) {
        const k = kv[1]!;
        out.push(`${k} = ${tomlValue(todo.get(k)!)}`);
        todo.delete(k);
        continue;
      }
      if (section === table && kv && Object.hasOwn(keys, kv[1]!)) continue; // a duplicate of a key already set
      out.push(line);
    }
    if (headerAt >= 0) out.splice(headerAt + 1, 0, ...[...todo].map(([k, v]) => `${k} = ${tomlValue(v)}`));
    else if (todo.size > 0) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      out.push(`[${table}]`, ...[...todo].map(([k, v]) => `${k} = ${tomlValue(v)}`));
    }
    lines = out;
  }
  const next = `${lines.join("\n")}\n`;
  const left = codexTelemetryProblems(next);
  if (left.length > 0) throw new Error(`cannot set ${left.join(", ")} in config.toml (set by hand, for example as an inline table)`);
  return next;
}

export interface CodexTelemetryResult {
  dir: string;
  status: "current" | "drift" | "updated" | "failed";
  changes: string[];
  error?: string;
}

export interface CodexTelemetryOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  /** Codex identity folders (from the Codex registry). Injectable for tests. */
  identityDirs?: string[];
  check?: boolean;
}

async function codexIdentityDirs(): Promise<string[]> {
  try {
    return (await loadIdentitiesFile(CODEX_CONFIG.identitiesJsonPath)).identities.filter((i) => !i.retired).map((i) => expandPath(i.configDir));
  } catch {
    return []; // no registry
  }
}

/** Codex homes ais manages: the given identity folders and every `t3-codex-*` and `codex-pool*` folder in the T3 gateway folder. */
export async function listCodexHomes(opts: CodexTelemetryOptions = {}): Promise<string[]> {
  const homes = [...(opts.identityDirs ?? (await codexIdentityDirs()))];
  const gateway = join(t3Paths({ ...(opts.home ? { home: opts.home } : {}), ...(opts.env ? { env: opts.env } : {}) }).t3Home, "gateway");
  try {
    for (const name of await readdir(gateway)) if (/^(?:t3-codex-|codex-pool)/.test(name)) homes.push(join(gateway, name));
  } catch {
    /* no T3 gateway folder */
  }
  return [...new Set(homes)].sort();
}

/** Sets (or with `check` only reports) the telemetry keys in the config.toml of every Codex home that exists with a config.toml. */
export async function syncCodexTelemetry(opts: CodexTelemetryOptions = {}): Promise<CodexTelemetryResult[]> {
  const results: CodexTelemetryResult[] = [];
  for (const dir of await listCodexHomes(opts)) {
    const path = join(dir, "config.toml");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // not a Codex home with a config; never create one
      results.push({ dir, status: "failed", changes: [], error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const changes = codexTelemetryProblems(text);
    if (changes.length === 0) {
      results.push({ dir, status: "current", changes: [] });
      continue;
    }
    if (opts.check) {
      results.push({ dir, status: "drift", changes });
      continue;
    }
    try {
      const mode = (await stat(path)).mode & 0o777;
      await writeFileAtomic(path, applyCodexTelemetryOff(text));
      await chmod(path, mode);
      results.push({ dir, status: "updated", changes });
    } catch (e) {
      results.push({ dir, status: "failed", changes: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

export const describeCodexTelemetryResult = (r: CodexTelemetryResult): string =>
  `${r.dir}: ${r.status}${r.changes.length > 0 ? ` [${r.changes.join(", ")}]` : ""}${r.error ? ` ${r.error}` : ""}`;
