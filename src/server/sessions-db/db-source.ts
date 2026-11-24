import type { Identity } from "../../identities/types.ts";
import { truncateLabel } from "../../cli/resume/label.ts";
import { claudeTranscriptFromLines } from "../../cli/sessions/claude.ts";
import { codexTranscriptFromLines } from "../../cli/sessions/codex.ts";
import { DEFAULT_TAIL_TURNS, isInProgress, isoOrEpoch, MAX_TAIL_TURNS, windowCutoffMs, type WindowOpts } from "../../cli/sessions/shared.ts";
import { computeDepths } from "../../cli/sessions/tree.ts";
import type { SessionTool, ToolTreeDto, TranscriptDto, TreeNodeDto } from "../../cli/sessions/types.ts";
import type { SessionPartRow, SessionTreeQuery, SessionTreeRow } from "../../gateway/sessions/session-store.ts";
import type { SessionsReaderMetrics } from "./metrics.ts";
import { PartLoader, readErrorKind, SessionsReadError } from "./part-lines.ts";

/** The part of `SessionStore` the reader needs. A test gives a fake. */
export interface SessionsReadStore {
  tree(q?: SessionTreeQuery): Promise<SessionTreeRow[]>;
  filesOfSession(kind: string, sessionRef: string): Promise<SessionTreeRow[]>;
  tailParts(fileId: number, windowBytes: number): Promise<SessionPartRow[]>;
  ping(): Promise<void>;
}

/** Tools whose sessions the database holds in v1 (the kinds the shipper ships). Every other tool reads files. */
export const DB_SESSION_TOOLS = ["claude", "codex"] as const;
export type DbSessionTool = (typeof DB_SESSION_TOOLS)[number];
export const isDbSessionTool = (tool: string): tool is DbSessionTool => (DB_SESSION_TOOLS as readonly string[]).includes(tool);

/**
 * Identity name of the slice that holds sessions the gateway has not matched to a registry identity yet (the `identity`
 * column stays null until the leader resolves it). They are shown, not dropped.
 */
export const UNASSIGNED_IDENTITY = "(unassigned)";

/** The most rows one tree read takes (the store maximum). */
const TREE_LIMIT = 50_000;

export interface DbTreeTarget {
  tool: SessionTool;
  /** Registry identity name. */
  identity: string;
}

export interface DbSourceOptions {
  store: SessionsReadStore;
  loader: PartLoader;
  metrics: SessionsReaderMetrics;
  /** Plain bytes of the transcript tail to decode (default 4 MiB). */
  windowBytes: number;
}

/**
 * The console Sessions page, read from the database. The tree is one indexed query. A transcript takes the last parts
 * of the session from object storage (age decrypt, gunzip, SHA-256 check) and runs the same normalisers as the file
 * reader, so the page output has the same shape and the same text.
 */
export class SessionsDbSource {
  constructor(private readonly o: DbSourceOptions) {}

  /** The database answers. Throws `SessionsReadError("store")` when it does not. */
  async ping(): Promise<void> {
    try {
      await this.o.store.ping();
    } catch {
      throw new SessionsReadError("store", "the sessions database did not answer");
    }
  }

  /**
   * The tree slices for `targets` (database tools only), in the order of `targets`, then one unassigned slice per tool
   * when `includeUnassigned` is set and some row has no identity. One query per tool.
   */
  async readTrees(args: { kinds: DbSessionTool[]; targets: DbTreeTarget[]; opts?: WindowOpts; includeUnassigned?: boolean }): Promise<ToolTreeDto[]> {
    const opts = args.opts ?? {};
    const sinceMs = windowCutoffMs(opts);
    const byKind = new Map<string, SessionTreeRow[]>();
    try {
      for (const kind of args.kinds) {
        byKind.set(kind, await this.o.store.tree({ kind, sinceMs, limit: TREE_LIMIT }));
      }
    } catch (err) {
      this.o.metrics.request("tree", "db", "error");
      this.o.metrics.error("store");
      throw err instanceof SessionsReadError ? err : new SessionsReadError("store", "the sessions database could not be read");
    }
    this.o.metrics.request("tree", "db", "ok");

    const slices: ToolTreeDto[] = [];
    for (const t of args.targets) {
      if (!isDbSessionTool(t.tool)) continue;
      const rows = (byKind.get(t.tool) ?? []).filter((r) => r.identity === t.identity);
      slices.push({ tool: t.tool, identity: t.identity, nodes: computeDepths(rows.map((r) => nodeOf(r, t.tool as DbSessionTool, t.identity, opts))) });
    }
    if (args.includeUnassigned) {
      for (const kind of args.kinds) {
        const rows = (byKind.get(kind) ?? []).filter((r) => r.identity === null);
        if (rows.length === 0) continue;
        slices.push({ tool: kind, identity: UNASSIGNED_IDENTITY, nodes: computeDepths(rows.map((r) => nodeOf(r, kind, UNASSIGNED_IDENTITY, opts))) });
      }
    }
    return slices;
  }

  /**
   * One transcript, or undefined when the database does not hold the session. `identity` is the registry identity the
   * caller asked for: a session of another identity is not found. Without it any identity matches. The reader decodes the
   * last `windowBytes` of the session. A session that is larger has `truncated: true` and takes its title, folder and
   * times from the index.
   */
  async readTranscript(args: { tool: DbSessionTool; identity?: string; id: string; tail?: number; now?: number }): Promise<TranscriptDto | undefined> {
    const m = this.o.metrics;
    try {
      let rows: SessionTreeRow[];
      try {
        rows = await this.o.store.filesOfSession(args.tool, args.id);
      } catch {
        throw new SessionsReadError("store", "the sessions database could not be read");
      }
      const row = args.identity === undefined ? rows[0] : (rows.find((r) => r.identity === args.identity) ?? rows.find((r) => r.identity === null));
      if (!row) {
        m.request("transcript", "db", "ok");
        return undefined;
      }
      let parts: SessionPartRow[];
      try {
        parts = await this.o.store.tailParts(row.fileId, this.o.windowBytes);
      } catch {
        throw new SessionsReadError("store", "the sessions database could not be read");
      }
      if (parts.length === 0) {
        m.request("transcript", "db", "ok");
        return undefined;
      }
      const windowed = parts[0]!.startOffset > 0;
      const identity = { name: row.identity ?? args.identity ?? UNASSIGNED_IDENTITY } as Identity;
      const tail = Math.min(Math.max(1, args.tail ?? DEFAULT_TAIL_TURNS), MAX_TAIL_TURNS);
      const lines = this.o.loader.lines(parts);
      const mtime = async (): Promise<number | undefined> => row.updatedAt ?? undefined;
      const opts = { tail, ...(args.now !== undefined ? { now: args.now } : {}) };
      const dto =
        args.tool === "claude"
          ? await claudeTranscriptFromLines(identity, args.id, lines, mtime, opts)
          : await codexTranscriptFromLines(identity, args.id, lines, mtime, opts);
      if (windowed) {
        // The window starts inside the session: what the reader found for title, folder and start is not the session's own.
        dto.session = {
          id: args.id,
          tool: args.tool,
          identity: identity.name,
          ...(row.title ? { title: row.title } : {}),
          ...(row.cwd ? { cwd: row.cwd } : {}),
          ...(row.startedAt !== null ? { startedAt: new Date(row.startedAt).toISOString() } : {}),
          ...(row.updatedAt !== null ? { updatedAt: new Date(row.updatedAt).toISOString() } : {}),
        };
        dto.truncated = true;
      }
      m.request("transcript", "db", "ok");
      return dto;
    } catch (err) {
      m.request("transcript", "db", "error");
      m.error(readErrorKind(err));
      throw err;
    }
  }
}

/**
 * A tree node from an index row. The rules follow the file readers so that the page shows the same: Claude counts its
 * messages for sessions only (not subagents), Codex shows no count, a Codex thread with no start record starts at its
 * last write, and a title that is not known yet gets the reader's placeholder.
 */
function nodeOf(row: SessionTreeRow, kind: DbSessionTool, identity: string, opts: WindowOpts): TreeNodeDto {
  const isChild = row.parentRef !== null;
  const title = row.title ?? (kind === "claude" ? (isChild ? truncateLabel(row.agentName ?? row.sessionRef) : "(no user message)") : "(no summary)");
  const startedMs = row.startedAt ?? (kind === "codex" ? row.updatedAt : null);
  return {
    id: row.sessionRef,
    ...(isChild ? { parentId: row.parentRef! } : {}),
    tool: kind,
    identity,
    title,
    cwd: row.cwd,
    startedAt: isoOrEpoch(startedMs ?? undefined),
    updatedAt: isoOrEpoch(row.updatedAt ?? undefined),
    inProgress: row.updatedAt !== null && isInProgress(row.updatedAt, opts),
    ...(kind === "claude" && !isChild && row.messageCount !== null && row.messageCount > 0 ? { messageCount: row.messageCount } : {}),
    depth: 0, // recomputed with the slice
    ...(row.agentName !== null ? { agentName: row.agentName } : {}),
  };
}
