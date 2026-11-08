import { readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseMetaLine } from "../cli/sessions/codex.ts";
import { readFirstLine } from "../cli/sessions/shared.ts";
import { listRecentFilesAsync } from "../shared/local-spend.ts";

const ROLLOUT = /rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface CodexThreadDeps {
  /** Rollout files the parent process has open (Linux /proc/<pid>/fd). */
  openRollouts?(pid: number): string[];
  /** Seconds the parent has been running, or undefined when unknown. */
  parentAgeSec?(pid: number): number | undefined;
  now?: () => number;
}

function openRollouts(pid: number): string[] {
  try {
    const dir = `/proc/${pid}/fd`;
    return readdirSync(dir).flatMap((fd) => {
      try { const t = readlinkSync(join(dir, fd)); return ROLLOUT.test(t) ? [t] : []; } catch { return []; }
    });
  } catch {
    return [];
  }
}

/** `ps -o etime=` is `[[dd-]hh:]mm:ss` on both Linux and macOS. */
function parentAgeSec(pid: number): number | undefined {
  const out = spawnSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8" }).stdout?.trim();
  const m = out?.match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/**
 * The Codex thread id of the session that started this shim. Codex puts no thread id in the shim's
 * environment, so: the rollout file the parent codex process holds open, else the newest rollout
 * under `<codexHome>/sessions` whose session_meta cwd matches and which was created after the parent started.
 */
export async function findCodexThreadId(codexHome: string, ppid: number, cwd: string, deps: CodexThreadDeps = {}): Promise<string | undefined> {
  const fromFd = (deps.openRollouts ?? openRollouts)(ppid).map((f) => f.match(ROLLOUT)?.[1]).find((id) => !!id);
  if (fromFd) return fromFd;
  const now = (deps.now ?? Date.now)();
  const age = (deps.parentAgeSec ?? parentAgeSec)(ppid);
  if (age === undefined) return undefined;
  const startedMs = now - age * 1000 - 2000;
  const { files } = await listRecentFilesAsync(join(codexHome, "sessions"), new Date(startedMs - 86_400_000), {}, true);
  let best: { id: string; at: number } | undefined;
  for (const f of files) {
    let mtime: number;
    try { mtime = statSync(f).mtimeMs; } catch { continue; }
    if (mtime < startedMs) continue;
    const meta = parseMetaLine(await readFirstLine(f));
    if (!meta?.id || meta.cwd !== cwd || meta.parentThreadId !== undefined) continue;
    const at = meta.startedAt ?? mtime;
    if (at < startedMs) continue;
    if (!best || at > best.at) best = { id: meta.id, at };
  }
  return best?.id;
}
