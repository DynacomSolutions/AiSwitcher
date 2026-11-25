import { chmod, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { expandPath } from "./match.ts";
import { fsyncDir } from "./pool/fs.ts";
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

const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** A parsed config without the telemetry keys ais manages (and without tables that this leaves empty). */
function withoutManaged(parsed: Table): Table {
  const copy = structuredClone(parsed);
  for (const [table, keys] of Object.entries(CODEX_TELEMETRY_OFF)) {
    const t = copy[table];
    if (!isTable(t)) continue;
    for (const k of Object.keys(keys)) delete t[k];
    if (Object.keys(t).length === 0) delete copy[table];
  }
  return copy;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && String(a) === String(b) && a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (isTable(a) || isTable(b)) {
    if (!isTable(a) || !isTable(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]));
  }
  return Object.is(a, b);
}

/** Pure: the config.toml text with the telemetry keys set. Idempotent. Throws when the result does not parse to the wanted values, or differs from the input in any other key. */
export function applyCodexTelemetryOff(text: string): string {
  let before: Table;
  try {
    before = parseToml(text) as Table;
  } catch {
    throw new Error("config.toml is not valid TOML; left unchanged");
  }
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
  if (left.length > 0) throw new Error(`cannot set ${left.join(", ")}: edit config.toml by hand (for example when a key is an inline table)`);
  if (!sameValue(withoutManaged(before), withoutManaged(parseToml(next) as Table))) throw new Error("refused to edit config.toml: the edit would change other keys; left unchanged");
  return next;
}

/**
 * Writes config.toml with a backup of the old text, a flushed temp file and a re-read check. Aborts when the file changed
 * since `before` was read. The temp file is removed when the rename fails.
 */
export async function writeCodexConfig(path: string, before: string, next: string, now: number = Date.now()): Promise<void> {
  const mode = (await stat(path)).mode & 0o777;
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const handle = await open(temp, "w", 0o600);
    try {
      await handle.writeFile(next);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temp, mode);
    if ((await readFile(path, "utf8")) !== before) throw new Error("config.toml changed while it was edited; left unchanged");
    await writeFile(`${path}.pre-telemetry-off.${Math.floor(now / 1000)}`, before, { mode: 0o600 });
    await rename(temp, path);
  } catch (e) {
    await unlink(temp).catch(() => undefined);
    throw e;
  }
  await fsyncDir(join(path, ".."));
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
      await writeCodexConfig(path, text, applyCodexTelemetryOff(text));
      results.push({ dir, status: "updated", changes });
    } catch (e) {
      results.push({ dir, status: "failed", changes: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

export const describeCodexTelemetryResult = (r: CodexTelemetryResult): string =>
  `${r.dir}: ${r.status}${r.changes.length > 0 ? ` [${r.changes.join(", ")}]` : ""}${r.error ? ` ${r.error}` : ""}`;
