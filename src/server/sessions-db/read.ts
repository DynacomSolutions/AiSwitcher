import type { Identity } from "../../identities/types.ts";
import type { WindowOpts } from "../../cli/sessions/shared.ts";
import type { SessionTool, ToolTreeDto, TranscriptDto } from "../../cli/sessions/types.ts";
import { HttpError } from "../types.ts";
import { DB_SESSION_TOOLS, isDbSessionTool, UNASSIGNED_IDENTITY, type DbSessionTool } from "./db-source.ts";
import { sessionsReaderMetrics } from "./metrics.ts";
import { SessionsReadError } from "./part-lines.ts";
import { openSessionsSource, type SessionsSourceHandle } from "./source.ts";

/** A (tool, identity) pair of the registry, as the scan worker collects them. */
export interface SessionTarget {
  toolName: SessionTool;
  identity: Identity;
}

/** True when a request for `tool` (undefined: every tool) can need the database. The scan then opens the source. */
export const requestMayUseDb = (tool: string | undefined): boolean => tool === undefined || isDbSessionTool(tool);

/** Opens the source for one scan, or a files handle when the request never needs the database. */
export async function sourceForScan(env: Record<string, string | undefined>, tool: string | undefined): Promise<SessionsSourceHandle> {
  if (!requestMayUseDb(tool)) return openSessionsSource({ ...env, AIS_SESSIONS_SOURCE: "files" });
  return openSessionsSource(env);
}

const messageOf = (err: unknown): string => (err instanceof SessionsReadError ? err.message : "the sessions database could not be read");

/**
 * The tree slices of one scan, in the order of `targets`. Claude and Codex slices come from the database when the source
 * is `db` (or `auto` with a usable database), every other tool from `filesRead`. In `auto` a failed database read falls
 * back to the files for its slices. In `db` the slices carry the error and no nodes.
 */
export async function readTreeSlices(args: {
  handle: SessionsSourceHandle;
  targets: SessionTarget[];
  /** The tool filter of the request. Unset means every tool. */
  tool: string | undefined;
  /** The identity filter of the request. Unset shows the sessions that have no identity yet too. */
  identity: string | undefined;
  opts: WindowOpts;
  filesRead: (target: SessionTarget) => Promise<ToolTreeDto>;
}): Promise<ToolTreeDto[]> {
  const { handle, targets, filesRead } = args;
  const metrics = sessionsReaderMetrics;
  const db = handle.used === "db" ? handle.db : undefined;
  const fromDb = (t: SessionTarget): boolean => db !== undefined && isDbSessionTool(t.toolName);
  const kinds: DbSessionTool[] = args.tool === undefined ? [...DB_SESSION_TOOLS] : isDbSessionTool(args.tool) ? [args.tool] : [];

  let dbSlices: ToolTreeDto[] | undefined;
  let dbError: unknown;
  if (db && kinds.length > 0) {
    try {
      dbSlices = await db.readTrees({
        kinds,
        targets: targets.filter(fromDb).map((t) => ({ tool: t.toolName, identity: t.identity.name })),
        opts: args.opts,
        includeUnassigned: args.identity === undefined,
      });
    } catch (err) {
      dbError = err;
    }
  }

  const fileTargets = targets.filter((t) => !fromDb(t) || dbSlices === undefined);
  let fellBack = false;
  const out: ToolTreeDto[] = [];
  const dbByKey = new Map((dbSlices ?? []).map((s) => [`${s.tool}|${s.identity}`, s]));
  // Files for the tools the database does not hold, and for the database tools when `auto` fell back.
  const filesSlices = new Map<SessionTarget, ToolTreeDto>();
  await Promise.all(
    fileTargets.map(async (t) => {
      if (fromDb(t) && dbSlices === undefined) {
        if (!handle.fallback) {
          filesSlices.set(t, { tool: t.toolName, identity: t.identity.name, nodes: [], error: messageOf(dbError) });
          return;
        }
        fellBack = true;
      }
      filesSlices.set(t, await filesRead(t));
    }),
  );
  for (const t of targets) {
    const slice = fromDb(t) && dbSlices !== undefined ? dbByKey.get(`${t.toolName}|${t.identity.name}`) : filesSlices.get(t);
    if (slice) out.push(slice);
  }
  for (const s of dbSlices ?? []) if (s.identity === UNASSIGNED_IDENTITY) out.push(s);

  if (targets.some((t) => !fromDb(t))) metrics.request("tree", "files", "ok");
  if (fellBack) metrics.request("tree", "files", "fallback");
  return out;
}

/**
 * One transcript. Returns `undefined` when the session is not found and no other source may answer. `ran` is the files
 * reader: it runs for every tool the database does not hold, in `files` mode, and in `auto` when the database fails or
 * does not hold the session yet (live sessions are in the files before the shipper has sent them).
 */
export async function readTranscriptWithSource(args: {
  handle: SessionsSourceHandle;
  target: SessionTarget;
  /** The identity filter of the request. */
  identity: string | undefined;
  id: string;
  tail: number;
  filesRead: () => Promise<TranscriptDto | undefined>;
}): Promise<TranscriptDto | undefined> {
  const { handle, target } = args;
  const metrics = sessionsReaderMetrics;
  const db = handle.used === "db" ? handle.db : undefined;
  if (db && isDbSessionTool(target.toolName)) {
    try {
      const dto = await db.readTranscript({ tool: target.toolName, id: args.id, tail: args.tail, ...(args.identity !== undefined ? { identity: target.identity.name } : {}) });
      if (dto !== undefined || !handle.fallback) return dto;
    } catch (err) {
      if (!handle.fallback) {
        throw new HttpError(502, messageOf(err));
      }
      // `auto`: the files answer. The error is counted by kind in the database source.
    }
    const fromFiles = await args.filesRead();
    metrics.request("transcript", "files", "fallback");
    return fromFiles;
  }
  const dto = await args.filesRead();
  metrics.request("transcript", "files", "ok");
  return dto;
}
