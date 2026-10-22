import { readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Per-phase I/O accounting for `ais sync`. /proc/self/io already includes
 * reaped children (rsync, ssh), so a phase delta covers the transfers it ran.
 * Off unless AIS_SYNC_IO_TRACE=1 (Linux only); then every call is a plain pass-through. */
export interface PhaseIo {
  phase: string;
  rchar: number;
  wchar: number;
  readBytes: number;
  writeBytes: number;
  millis: number;
  note?: string;
}

const phases: PhaseIo[] = [];

export function ioTraceEnabled(): boolean {
  return process.env.AIS_SYNC_IO_TRACE === "1" && process.platform === "linux";
}

function sample(): number[] {
  const io = readFileSync("/proc/self/io", "utf8");
  return ["rchar", "wchar", "read_bytes", "write_bytes"].map((key) => Number(new RegExp(`^${key}: (\\d+)`, "m").exec(io)?.[1] ?? 0));
}

export async function ioPhase<T>(phase: string, run: () => Promise<T>, note?: () => Promise<string | undefined>): Promise<T> {
  if (!ioTraceEnabled()) return run();
  const before = sample();
  const started = Date.now();
  try {
    return await run();
  } finally {
    const after = sample();
    const d = (i: number) => after[i]! - before[i]!;
    phases.push({ phase, rchar: d(0), wchar: d(1), readBytes: d(2), writeBytes: d(3), millis: Date.now() - started, note: await note?.().catch(() => undefined) });
  }
}

/** Phases recorded by this process; remote-side commands relay them in their JSON output. */
export function ioSnapshot(): PhaseIo[] | undefined {
  return ioTraceEnabled() ? [...phases] : undefined;
}

const human = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}G` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : `${n}`);

export function formatIo(label: string, list: PhaseIo[] | undefined): string[] {
  return (list ?? []).map((p) =>
    `AIS sync io ${label} ${p.phase}: rchar=${human(p.rchar)} wchar=${human(p.wchar)} read_bytes=${human(p.readBytes)} write_bytes=${human(p.writeBytes)} ${p.millis}ms${p.note ? ` ${p.note}` : ""}`);
}

export function isPhaseList(value: unknown): value is PhaseIo[] {
  return Array.isArray(value) && value.every((p) => typeof p === "object" && p !== null && typeof (p as PhaseIo).phase === "string");
}

/** What a staging tree holds: file count, bytes and the largest paths, so a re-staged big file is named. */
export async function stagedSummary(root: string): Promise<string> {
  const files: Array<[string, number]> = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push([path.slice(root.length + 1), (await stat(path).catch(() => undefined))?.size ?? 0]);
    }
  };
  await walk(root);
  const total = files.reduce((sum, [, size]) => sum + size, 0);
  const top = files.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, s]) => `${p} (${human(s)})`);
  return `staged=${files.length} files ${human(total)}${top.length ? ` top: ${top.join(", ")}` : ""}`;
}
