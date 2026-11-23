// Counters of the favourites sync. They are kept in the process, written to a small file for the console /metrics, and can be served by the command itself.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  /** Changes that the gateway refused (full list, or a newer change of the same model). */
  refused: number;
  errors: number;
  /** Unix seconds of the last round that ended without an error, and of the last write. 0 when none yet. */
  lastSuccess: number;
  lastWrite: number;
  /** Unix seconds when the process started. */
  startedAt: number;
}

/** Who runs the sync: the profile-sync daemon, or the `ais t3 favourites sync` command. */
export type FavSyncRole = "daemon" | "cli";

export class FavSyncMetrics {
  readonly s: FavSyncSnapshot;
  private removed = false;
  /** One file per process: `file` names the role and the pid (see `metricsPathOf`), so two processes of one home never overwrite each other. */
  constructor(private readonly file?: string, now: () => number = Date.now, private readonly role: FavSyncRole = "cli", private readonly pid: number = process.pid) {
    this.s = { pulls: 0, pushes: 0, writes: 0, refused: 0, errors: 0, lastSuccess: 0, lastWrite: 0, startedAt: Math.floor(now() / 1000) };
  }
  /** Writes the snapshot to its file (best effort: a metrics file must never stop the sync). */
  persist(): void {
    if (!this.file || this.removed) return;
    try {
      mkdirSync(join(this.file, ".."), { recursive: true });
      const temp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(temp, JSON.stringify(this.s), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch { /* keep syncing */ }
  }
  /** Removes the file. Call it when the process ends clean, so that the console does not serve the counters of a process that is gone. Later `persist` calls do nothing. */
  remove(): void {
    this.removed = true;
    if (!this.file) return;
    try {
      rmSync(this.file, { force: true });
    } catch { /* a metrics file must never stop the exit */ }
  }
  render(home = "own"): string {
    return renderSnapshots([{ home, role: this.role, pid: this.pid, s: this.s }]);
  }
}

const HELP: Array<[keyof FavSyncSnapshot, string, string, string]> = [
  ["pulls", "ais_t3_favourites_sync_pulls_total", "counter", "Reads of the gateway favourites list."],
  ["pushes", "ais_t3_favourites_sync_pushes_total", "counter", "Posts of T3 favourite changes to the gateway."],
  ["writes", "ais_t3_favourites_sync_writes_total", "counter", "Writes of favorites in the T3 settings.json."],
  ["refused", "ais_t3_favourites_sync_refused_total", "counter", "Changes that the gateway refused: the list was full, or a newer change of the same model won."],
  ["errors", "ais_t3_favourites_sync_errors_total", "counter", "Rounds of the favourites sync that failed."],
  ["lastSuccess", "ais_t3_favourites_sync_last_success_timestamp_seconds", "gauge", "Unix time of the last round that ended without an error."],
  ["lastWrite", "ais_t3_favourites_sync_last_write_timestamp_seconds", "gauge", "Unix time of the last write of the T3 settings.json."],
  ["startedAt", "ais_t3_favourites_sync_started_timestamp_seconds", "gauge", "Unix time the sync process started."],
];

/** Prometheus text for one or more T3 homes. `home` is a short hash with an optional label, never a path. */
export function renderSnapshots(entries: Array<{ home: string; role?: string; pid?: number; s: FavSyncSnapshot }>): string {
  if (entries.length === 0) return "";
  const out: string[] = [];
  for (const [key, name, type, help] of HELP) {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const e of entries) {
      const labels = [`home="${e.home.replace(/[^A-Za-z0-9_-]/g, "")}"`, ...(e.role !== undefined ? [`role="${e.role.replace(/[^a-z]/g, "")}"`] : []), ...(e.pid !== undefined ? [`pid="${Math.trunc(e.pid)}"`] : [])];
      out.push(`${name}{${labels.join(",")}} ${e.s[key]}`);
    }
  }
  return `${out.join("\n")}\n`;
}

/** True when a process with this pid exists. A process of another user answers EPERM and counts as alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const SNAPSHOT_FILE = /^([A-Za-z0-9_-]+)\.(daemon|cli)-(\d+)\.metrics\.json$/;

/** Reads every snapshot file in `dir` (`<home hash>.<role>-<pid>.metrics.json`). A missing folder, a bad file or a file of a process that is gone is skipped. */
export function readSnapshots(dir: string): Array<{ home: string; role: FavSyncRole; pid: number; s: FavSyncSnapshot }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ home: string; role: FavSyncRole; pid: number; s: FavSyncSnapshot }> = [];
  for (const n of names.sort()) {
    const m = SNAPSHOT_FILE.exec(n);
    if (!m) continue;
    const pid = Number(m[3]);
    if (!alive(pid)) continue;
    try {
      const v = JSON.parse(readFileSync(join(dir, n), "utf8")) as Partial<FavSyncSnapshot>;
      const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
      out.push({ home: m[1]!, role: m[2] as FavSyncRole, pid, s: { pulls: num(v.pulls), pushes: num(v.pushes), writes: num(v.writes), refused: num(v.refused), errors: num(v.errors), lastSuccess: num(v.lastSuccess), lastWrite: num(v.lastWrite), startedAt: num(v.startedAt) } });
    } catch { /* a half-written file */ }
  }
  return out;
}
