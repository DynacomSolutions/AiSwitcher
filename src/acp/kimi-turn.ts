/**
 * How a kimi-code turn ended, from the agent's own session log.
 *
 * kimi-code writes every turn to `<KIMI_CODE_HOME>/sessions/<work dir>/<session id>/agents/main/wire.jsonl`. A turn
 * ends with a `turn.ended` line: `reason` is `completed`, `cancelled`, `failed` or `blocked`, and a failed one carries
 * `error: { code, message, retryable, details: { statusCode } }`. Its ACP server answers a failed turn `end_turn`
 * (relay.ts), so this log is the only place the reason is kept.
 *
 * Which line belongs to which prompt is decided by position, not by clocks: the size of the log is noted before the
 * prompt reaches the agent, and only a `turn.ended` written after that point is the end of this turn. Only the end of
 * the file is read.
 */
import { readdirSync, statSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resetFromText } from "./limit-snooze.ts";
import type { RelayAdapter, TurnFailure, TurnOutcome } from "./relay.ts";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The end of the log that is read: a turn's last lines are small, the lines before them can be large. */
const TAIL_BYTES = 1024 * 1024;
/** How long to wait for the `turn.ended` line of this turn: the answer can reach the client before the log is written. */
const WAIT_MS = 600;
const STEP_MS = 40;
/** A reset at least this far away is a long usage-limit sleep, not a short burst retry. Two minutes. */
export const IN_TURN_LIMIT_MIN_MS = 120_000;

export const kimiHome = (env: Record<string, string | undefined> = process.env, home = homedir()): string => env.KIMI_CODE_HOME || join(home, ".kimi-code");

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);

interface TurnEnd {
  reason: string;
  error?: Json;
}

/** The log lines at or after byte `from`, looking at the last TAIL_BYTES only. A cut first line is dropped. */
async function tailLines(path: string, from: number): Promise<string[]> {
  const size = (await stat(path)).size;
  // A log shorter than at the prompt was replaced (a rollback of the session): all of it is new.
  const since = size < from ? 0 : from;
  const start = Math.max(since, size - TAIL_BYTES);
  if (size <= start) return [];
  const file = await open(path, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(size - start);
    await file.read(buf, 0, buf.length, start);
    text = buf.toString("utf8");
  } finally {
    await file.close();
  }
  const lines = text.split("\n");
  // A read that starts inside the part to look at (the tail limit) may start in the middle of a line.
  const first = start > since ? 1 : 0;
  return lines.slice(first);
}

/** The last `turn.ended` line of `path` that starts at or after byte `from`. */
async function lastTurnEnd(path: string, from: number): Promise<TurnEnd | undefined> {
  const lines = await tailLines(path, from);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (!line.includes('"turn.ended"')) continue;
    let o: Json | undefined;
    try {
      o = obj(JSON.parse(line));
    } catch {
      continue;
    }
    if (!o || o.type !== "turn.ended" || typeof o.reason !== "string") continue;
    const error = obj(o.error);
    return { reason: o.reason, ...(error ? { error } : {}) };
  }
  return undefined;
}

/** The newest `turn.step.retrying` line of `path` at or after byte `from`, as a parsed object. */
async function lastStepRetry(path: string, from: number): Promise<Json | undefined> {
  const lines = await tailLines(path, from);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (!line.includes('"turn.step.retrying"')) continue;
    let o: Json | undefined;
    try {
      o = obj(JSON.parse(line));
    } catch {
      continue;
    }
    if (o && o.type === "turn.step.retrying") return o;
  }
  return undefined;
}

export interface KimiTurnOptions {
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** The clock, for the in-turn limit horizon. Default Date.now. */
  now?: () => number;
}

/** Where a prompt starts in the session log. */
interface Mark {
  size: number;
}

export function kimiAdapter(home: string, opts: KimiTurnOptions = {}): RelayAdapter {
  const waitMs = opts.waitMs ?? WAIT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const logs = new Map<string, string>();

  // Synchronous, because the size must be read before the prompt is passed to the agent. The folder is small.
  const logOf = (sessionId: string): string | undefined => {
    const known = logs.get(sessionId);
    if (known) return known;
    if (!SESSION_ID.test(sessionId)) return undefined;
    const root = join(home, "sessions");
    let dirs: string[];
    try {
      dirs = readdirSync(root);
    } catch {
      return undefined;
    }
    for (const dir of dirs) {
      const path = join(root, dir, sessionId, "agents", "main", "wire.jsonl");
      try {
        if (statSync(path).isFile()) {
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
    promptStarting(sessionId: string): Mark {
      const path = logOf(sessionId);
      try {
        return { size: path ? statSync(path).size : 0 };
      } catch {
        return { size: 0 };
      }
    },
    async turnOutcome(sessionId: string, mark: unknown): Promise<TurnOutcome> {
      const from = typeof (mark as Mark | undefined)?.size === "number" ? (mark as Mark).size : 0;
      for (let waited = 0; ; waited += STEP_MS) {
        const path = logOf(sessionId);
        const end = path ? await lastTurnEnd(path, from).catch(() => undefined) : undefined;
        if (end) {
          if (end.reason !== "failed") return "ok";
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
    async inTurnLimit(sessionId: string, mark: unknown): Promise<TurnFailure | undefined> {
      const from = typeof (mark as Mark | undefined)?.size === "number" ? (mark as Mark).size : 0;
      const path = logOf(sessionId);
      const retry = path ? await lastStepRetry(path, from).catch(() => undefined) : undefined;
      if (!retry) return undefined;
      const status = typeof retry.statusCode === "number" ? retry.statusCode : undefined;
      const name = typeof retry.errorName === "string" ? retry.errorName : undefined;
      const message = typeof retry.errorMessage === "string" && retry.errorMessage.trim() !== "" ? retry.errorMessage.trim() : "";
      // Only a 429 or a rate-limit error name is a usage-limit retry. Other step errors retry on their own.
      if (status !== 429 && !(name !== undefined && /rate.?limit/i.test(name))) return undefined;
      const nowMs = now();
      const reset = resetFromText(message, nowMs);
      // A reset under the horizon away is a short burst: the agent retries soon, so no snooze.
      if (!reset || reset.getTime() - nowMs <= IN_TURN_LIMIT_MIN_MS) return undefined;
      return {
        message,
        ...(name !== undefined ? { code: name } : {}),
        ...(status !== undefined ? { status } : {}),
      };
    },
  };
}
