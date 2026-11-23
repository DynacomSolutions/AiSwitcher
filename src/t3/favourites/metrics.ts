// Counters of the favourites sync. They are kept in the process, written to a small file for the console /metrics, and can be served by the command itself.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aisStateDir } from "../../shared/ais-home.ts";

/** The folder of the sync state and metrics files. */
export const favouritesStateDir = (home?: string): string => join(aisStateDir(home), "t3-favourites");

export interface FavSyncSnapshot {
  /** Reads of the gateway list. */
  pulls: number;
  /** Posts of local changes to the gateway. */
  pushes: number;
  /** Writes of settings.json. */
  writes: number;
  errors: number;
  /** Unix seconds of the last round that ended without an error, and of the last write. 0 when none yet. */
  lastSuccess: number;
  lastWrite: number;
  /** Unix seconds when the process started. */
  startedAt: number;
}

export class FavSyncMetrics {
  readonly s: FavSyncSnapshot;
  constructor(private readonly file?: string, now: () => number = Date.now) {
    this.s = { pulls: 0, pushes: 0, writes: 0, errors: 0, lastSuccess: 0, lastWrite: 0, startedAt: Math.floor(now() / 1000) };
  }
  /** Writes the snapshot to its file (best effort: a metrics file must never stop the sync). */
  persist(): void {
    if (!this.file) return;
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      const temp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(temp, JSON.stringify(this.s), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch { /* keep syncing */ }
  }
  render(home = "own"): string {
    return renderSnapshots([{ home, s: this.s }]);
  }
}

const HELP: Array<[keyof FavSyncSnapshot, string, string, string]> = [
  ["pulls", "ais_t3_favourites_sync_pulls_total", "counter", "Reads of the gateway favourites list."],
  ["pushes", "ais_t3_favourites_sync_pushes_total", "counter", "Posts of T3 favourite changes to the gateway."],
  ["writes", "ais_t3_favourites_sync_writes_total", "counter", "Writes of favorites in the T3 settings.json."],
  ["errors", "ais_t3_favourites_sync_errors_total", "counter", "Rounds of the favourites sync that failed."],
  ["lastSuccess", "ais_t3_favourites_sync_last_success_timestamp_seconds", "gauge", "Unix time of the last round that ended without an error."],
  ["lastWrite", "ais_t3_favourites_sync_last_write_timestamp_seconds", "gauge", "Unix time of the last write of the T3 settings.json."],
  ["startedAt", "ais_t3_favourites_sync_started_timestamp_seconds", "gauge", "Unix time the sync process started."],
];

/** Prometheus text for one or more T3 homes. `home` is a short hash, never a path. */
export function renderSnapshots(entries: Array<{ home: string; s: FavSyncSnapshot }>): string {
  if (entries.length === 0) return "";
  const out: string[] = [];
  for (const [key, name, type, help] of HELP) {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const e of entries) out.push(`${name}{home="${e.home.replace(/[^A-Za-z0-9]/g, "")}"} ${e.s[key]}`);
  }
  return `${out.join("\n")}\n`;
}

/** Reads every snapshot file in `dir` (`<home hash>.metrics.json`). A missing folder or a bad file is skipped. */
export function readSnapshots(dir: string): Array<{ home: string; s: FavSyncSnapshot }> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".metrics.json"));
  } catch {
    return [];
  }
  const out: Array<{ home: string; s: FavSyncSnapshot }> = [];
  for (const n of names.sort()) {
    try {
      const v = JSON.parse(readFileSync(join(dir, n), "utf8")) as Partial<FavSyncSnapshot>;
      const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
      out.push({ home: n.replace(/\.metrics\.json$/, ""), s: { pulls: num(v.pulls), pushes: num(v.pushes), writes: num(v.writes), errors: num(v.errors), lastSuccess: num(v.lastSuccess), lastWrite: num(v.lastWrite), startedAt: num(v.startedAt) } });
    } catch { /* a half-written file */ }
  }
  return out;
}
