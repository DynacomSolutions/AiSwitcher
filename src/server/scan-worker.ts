import { limitsEnvelope, PollCache, usageEnvelope, breakdownEnvelope, flagsFor } from "./expensive.ts";
import { HttpError } from "./types.ts";
import { collectResumeTargets, runResumeQuery } from "../cli/resume/collect.ts";
import { CliUsageError } from "../cli/errors.ts";
import { isKnownToolName } from "../cli/identities/resolve-tool.ts";
import { hasTreeReader, readSessionTrees } from "../cli/sessions/tree.ts";
import { DEFAULT_TAIL_TURNS, readTranscript } from "../cli/sessions/transcript.ts";

/** The (tool, identity) target list for the tree/transcript scans. The
 * --tool filter is applied AFTER collection, against the injected configs
 * when a caller (test) provided any, so synthetic registries are honoured
 * even when a tool is named; unknown tool names still fail the same way
 * the CLI's flag parsing does. */
async function collectSessionTargets(tool: string | undefined, identity: string | undefined, configs: import("../identities/types.ts").ToolConfig[] | undefined) {
  if (tool !== undefined && !isKnownToolName(tool)) {
    throw new CliUsageError(`Invalid --tool="${tool}"`);
  }
  const targets = await collectResumeTargets(flagsFor(undefined, identity), configs);
  return tool === undefined ? targets : targets.filter((t) => t.toolName === tool);
}

/** Library behind the expensive scan endpoints' isolation. The scans are
 * executed in a SHORT-LIVED CHILD PROCESS (see workers.ts) rather than on
 * the HTTP server's own thread: scans contain work that has repeatedly
 * stalled for tens of seconds or forever (synchronous SQLite opens on
 * project dirs living on a flaky network mount, unbounded bunx warm-ups,
 * slow provider APIs), and anything they block takes the whole console API
 * down with it when run in-process. A child also dies cleanly on deadline:
 * the parent kills it and the next poll starts fresh. */

const cache = new PollCache(45_000);
// Breakdown streams raw JSONL (bigger and slower than the other scans), so
// it gets its own slightly longer TTL instead of sharing the scan cache.
const breakdownCache = new PollCache(60_000);
// Tree scans walk every recent session of every selected identity: heavier
// than /api/sessions, but a tree is navigated, not watched, so a longer
// cache is fine.
const treeCache = new PollCache(15_000);
// Transcript reads exist for a 2-3s WebUI poll of an in-progress chat: a
// short TTL keeps consecutive polls cheap while still reflecting appended
// lines within one poll interval (the reads themselves stream to EOF).
const transcriptCache = new PollCache(4_000);

export type ScanKind = "usage" | "limits" | "sessions" | "breakdown" | "tree" | "transcript";

export interface ScanRequest {
  kind: ScanKind;
  tool?: string;
  identity?: string;
  cwd?: string;
  maxAgeS?: number;
  /** Breakdown and tree: lookback window in days. */
  days?: number;
  /** Transcript only: opaque session id from the tree response. */
  id?: string;
  /** Transcript only: max turns returned (tail-weighted). */
  tail?: number;
  /** Test injection only (never serialised to the real worker child):
   * synthetic registries so tests never touch the live home. */
  configs?: import("../identities/types.ts").ToolConfig[];
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
      case "breakdown": {
        const days = typeof req.days === "number" && Number.isFinite(req.days) ? req.days : 30;
        payload = await breakdownEnvelope(breakdownCache, req.tool, req.identity, days);
        break;
      }
      case "tree": {
        const days = typeof req.days === "number" && Number.isFinite(req.days) ? Math.max(1, req.days) : 30;
        // The registry scope is part of the key: test-injected configs must
        // never collide with the live home's entries.
        const scope = req.configs?.map((c) => c.identitiesJsonPath).join(",") ?? "live";
        const { value, cached } = await treeCache.get(
          `${scope}|${req.tool ?? "*"}|${req.identity ?? "*"}|${days}`,
          async () => {
            const targets = await collectSessionTargets(req.tool, req.identity, req.configs);
            const tools = await Promise.all(targets.map((t) => readSessionTrees(t.toolName, t.identity, { days })));
            // A reader-less tool named explicitly still earns its honest
            // unavailable slice, even when no registry provides identities
            // for it (the WebUI shows "unavailable", not a silent gap).
            if (req.tool !== undefined && !hasTreeReader(req.tool as never) && !tools.some((t) => t.tool === req.tool)) {
              tools.push({
                tool: req.tool as never,
                identity: req.identity ?? "",
                nodes: [],
                unavailable: `no session tree reader implemented for "${req.tool}" yet`,
              });
            }
            return { tools, generatedAt: new Date().toISOString(), days };
          },
        );
        payload = { ...value, cached };
        break;
      }
      case "transcript": {
        if (typeof req.id !== "string" || !req.id) throw new HttpError(400, '"id" is required');
        const targets = await collectSessionTargets(req.tool, req.identity, req.configs);
        if (targets.length === 0) throw new HttpError(404, "no matching identity for transcript read");
        const target = targets[0]!;
        const tail = typeof req.tail === "number" && Number.isFinite(req.tail) ? req.tail : DEFAULT_TAIL_TURNS;
        const scope = req.configs?.map((c) => c.identitiesJsonPath).join(",") ?? "live";
        const { value, cached } = await transcriptCache.get(
          `${scope}|${target.toolName}|${target.identity.name}|${req.id}|${tail}`,
          () => readTranscript(target.toolName, target.identity, req.id!, { tail }).then((t) => t ?? null),
        );
        // transcript === null => session not found (404 at the endpoint)
        payload = { transcript: value, cached };
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
      status: err instanceof HttpError ? err.status : err instanceof CliUsageError ? 400 : 500,
    };
  }
}
