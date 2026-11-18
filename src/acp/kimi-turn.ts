/**
 * How a kimi-code turn ended, from the agent's own session log.
 *
 * kimi-code writes every turn to `<KIMI_CODE_HOME>/sessions/<work dir>/<session id>/agents/main/wire.jsonl`. A turn
 * ends with a `turn.ended` line: `reason` is `completed`, `cancelled`, `failed` or `blocked`, and a failed one carries
 * `error: { code, message, retryable, details: { statusCode } }`. Its ACP server answers a failed turn `end_turn`
 * (relay.ts), so this log is the only place the reason is kept. Only the end of the file is read.
 */
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RelayAdapter, TurnFailure } from "./relay.ts";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The end of the log that is read: a turn's last lines are small, the lines before them can be large. */
const TAIL_BYTES = 1024 * 1024;
/** How long to wait for the `turn.ended` line of this turn: the answer can reach the client before the log is written. */
const WAIT_MS = 600;
const STEP_MS = 40;

export const kimiHome = (env: Record<string, string | undefined> = process.env, home = homedir()): string => env.KIMI_CODE_HOME || join(home, ".kimi-code");

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);

interface TurnEnd {
  timeMs: number;
  reason: string;
  error?: Json;
}

/** The last `turn.ended` line in the last TAIL_BYTES of `path`. */
async function lastTurnEnd(path: string): Promise<TurnEnd | undefined> {
  const size = (await stat(path)).size;
  const length = Math.min(size, TAIL_BYTES);
  const file = await open(path, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(length);
    await file.read(buf, 0, length, size - length);
    text = buf.toString("utf8");
  } finally {
    await file.close();
  }
  const lines = text.split("\n");
  // The first line of a tail that does not start at the file's start may be cut.
  const first = size > length ? 1 : 0;
  for (let i = lines.length - 1; i >= first; i--) {
    const line = lines[i] as string;
    if (!line.includes('"turn.ended"')) continue;
    let o: Json | undefined;
    try {
      o = obj(JSON.parse(line));
    } catch {
      continue;
    }
    if (!o || o.type !== "turn.ended" || typeof o.time !== "number" || typeof o.reason !== "string") continue;
    const error = obj(o.error);
    return { timeMs: o.time, reason: o.reason, ...(error ? { error } : {}) };
  }
  return undefined;
}

export interface KimiTurnOptions {
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function kimiAdapter(home: string, opts: KimiTurnOptions = {}): RelayAdapter {
  const waitMs = opts.waitMs ?? WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const logs = new Map<string, string>();

  const logOf = async (sessionId: string): Promise<string | undefined> => {
    const known = logs.get(sessionId);
    if (known) return known;
    if (!SESSION_ID.test(sessionId)) return undefined;
    const root = join(home, "sessions");
    let dirs: string[];
    try {
      dirs = await readdir(root);
    } catch {
      return undefined;
    }
    for (const dir of dirs) {
      const path = join(root, dir, sessionId, "agents", "main", "wire.jsonl");
      try {
        if ((await stat(path)).isFile()) {
          logs.set(sessionId, path);
          return path;
        }
      } catch {
        // not in this work dir
      }
    }
    return undefined;
  };

  return {
    async turnFailure(sessionId: string, startedAtMs: number): Promise<TurnFailure | undefined> {
      for (let waited = 0; ; waited += STEP_MS) {
        const path = await logOf(sessionId);
        const end = path ? await lastTurnEnd(path).catch(() => undefined) : undefined;
        // Both times are this host's clock: the end of this turn is never before the prompt was seen.
        if (end && end.timeMs >= startedAtMs) {
          if (end.reason !== "failed") return undefined;
          const e = end.error ?? {};
          const status = obj(e.details)?.statusCode;
          return {
            message: typeof e.message === "string" && e.message.trim() !== "" ? e.message.trim() : "the provider request failed",
            ...(typeof e.code === "string" ? { code: e.code } : {}),
            ...(typeof status === "number" ? { status } : {}),
            ...(typeof e.retryable === "boolean" ? { retryable: e.retryable } : {}),
          };
        }
        if (waited >= waitMs) return undefined;
        await sleep(STEP_MS);
      }
    },
  };
}
