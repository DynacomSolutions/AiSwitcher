import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * The session id of a running agent: the same id the tool sends to the gateway with each request (see `gateway/session-key.ts`).
 * Sources, in this order (read-only, same user):
 *   1. Claude Code's own registry: `<config dir>/sessions/<pid>.json` holds `sessionId` and `procStart`. The file stays behind
 *      after an exit and a pid can come back, so it counts only when `procStart` equals the start time of the live process.
 *   2. A file the process holds open: a Claude Code task folder `.../<session id>/tasks`, or a Codex rollout file
 *      `rollout-<time>-<session id>.jsonl`. Nothing in a process environment is read.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TASKS_DIR = new RegExp(`/(${UUID})/tasks(?:/|$)`);
const ROLLOUT = new RegExp(`/rollout-[0-9T-]+-(${UUID})\\.jsonl$`);

export interface SessionIdDeps {
  readFile?: (path: string) => Promise<string>;
  /** The start time of a live process in clock ticks (field 22 of `/proc/<pid>/stat`), or undefined. */
  procStart?: (pid: number) => Promise<string | undefined>;
  /** The targets of the symbolic links in `/proc/<pid>/fd`, or an empty list when unreadable. */
  fdTargets?: (pid: number) => Promise<string[]>;
}

async function defaultProcStart(pid: number): Promise<string | undefined> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    // Field 2 (comm) may hold spaces and brackets: count from the last ")". Field 22 is the 20th after it.
    return text.slice(text.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

async function defaultFdTargets(pid: number): Promise<string[]> {
  try {
    const names = await readdir(`/proc/${pid}/fd`);
    const out: string[] = [];
    for (const n of names) {
      try {
        out.push(await readlink(`/proc/${pid}/fd/${n}`));
      } catch {
        // the descriptor closed meanwhile
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** The session id of the agent with this pid, or undefined when no source names one. `configDir` is the tool's config folder as this process can read it. */
export async function readAgentSessionId(pid: number, configDir: string | undefined, deps: SessionIdDeps = {}): Promise<string | undefined> {
  const read = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
  const start = deps.procStart ?? defaultProcStart;
  if (configDir) {
    try {
      const rec = JSON.parse(await read(join(configDir, "sessions", `${pid}.json`))) as { sessionId?: unknown; procStart?: unknown; pid?: unknown };
      const live = await start(pid);
      if (typeof rec.sessionId === "string" && rec.sessionId !== "" && rec.pid === pid && live !== undefined && String(rec.procStart) === live) return rec.sessionId;
    } catch {
      // no registry file for this pid: try the open files
    }
  }
  for (const target of await (deps.fdTargets ?? defaultFdTargets)(pid)) {
    const m = TASKS_DIR.exec(target) ?? ROLLOUT.exec(target);
    if (m?.[1]) return m[1];
  }
  return undefined;
}
