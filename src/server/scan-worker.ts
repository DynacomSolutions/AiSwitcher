import { limitsEnvelope, PollCache, usageEnvelope, flagsFor } from "./expensive.ts";
import { HttpError } from "./types.ts";
import { runResumeQuery } from "../cli/resume/collect.ts";

/** Library behind the expensive scan endpoints' isolation. The scans are
 * executed in a SHORT-LIVED CHILD PROCESS (see workers.ts) rather than on
 * the HTTP server's own thread: scans contain work that has repeatedly
 * stalled for tens of seconds or forever (synchronous SQLite opens on
 * project dirs living on a flaky network mount, unbounded bunx warm-ups,
 * slow provider APIs), and anything they block takes the whole console API
 * down with it when run in-process. A child also dies cleanly on deadline:
 * the parent kills it and the next poll starts fresh. */

const cache = new PollCache(45_000);

export type ScanKind = "usage" | "limits" | "sessions";

export interface ScanRequest {
  kind: ScanKind;
  tool?: string;
  identity?: string;
  cwd?: string;
  maxAgeS?: number;
}

export interface ScanResult<T = unknown> {
  ok: boolean;
  payload?: T;
  error?: string;
  status?: number;
}

export async function runScan<T>(req: ScanRequest): Promise<ScanResult<T>> {
  try {
    let payload: unknown;
    switch (req.kind) {
      case "usage":
        payload = await usageEnvelope(cache, req.tool, req.identity);
        break;
      case "limits":
        payload = await limitsEnvelope(cache, req.tool, req.identity, req.maxAgeS ?? 45);
        break;
      case "sessions": {
        const flags = flagsFor(req.tool, req.identity);
        const results = await runResumeQuery(flags, req.cwd ?? process.cwd());
        payload = { results };
        break;
      }
      default:
        throw new HttpError(400, `unknown scan kind`);
    }
    return { ok: true, payload: payload as T };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: err instanceof HttpError ? err.status : 500,
    };
  }
}
