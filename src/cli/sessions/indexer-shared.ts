import { truncateLabel } from "../resume/label.ts";

/**
 * Shared types for the incremental session indexers (Claude and Codex).
 *
 * An indexer is a pure function: previous state + new lines in, new state out. It does no I/O. The state is
 * flat JSON (strings, numbers, booleans), so it fits the `scan_state` column. Feeding a file in any number of
 * chunks, each cut at a line end and fed in order, gives the same state as one pass over the whole file.
 */

/** New lines of one session file. `lines` hold no "\n". A chunk is cut at line ends. */
export interface IndexChunk {
  /** Byte offset of the first line. Must equal the end of the previous chunk (0 for the first one). */
  startOffset: number;
  /** Byte offset after the last line, including its "\n". The caller knows it from the part range. */
  endOffset: number;
  lines: Iterable<string>;
}

/** The index fields the design names. Times are epoch milliseconds, as in `SessionTreeRow`. */
export interface SessionIndexFields {
  /** Tree node id. For Claude subagents `<parent>/<agentId>`. */
  sessionRef: string;
  parentRef: string | null;
  agentName: string | null;
  /** At most 72 characters, plain text. Null while the file holds no title source. */
  title: string | null;
  cwd: string | null;
  /** `org/repo` of the working folder, null when the folder is not a repository folder. */
  project: string | null;
  model: string | null;
  startedAt: number | null;
  /** Time of the last record. Null when no record has a time: the caller then uses the ingest time. */
  updatedAt: number | null;
  messageCount: number;
  /** Bytes the state covers. Goes to `indexed_bytes`. */
  indexedBytes: number;
  indexedLines: number;
}

/** A chunk does not continue the state: the writer must resend from `expected`. */
export class IndexOffsetError extends Error {
  constructor(
    readonly expected: number,
    readonly got: number,
  ) {
    super(`index chunk starts at byte ${got}, the state ends at byte ${expected}`);
    this.name = "IndexOffsetError";
  }
}

export function checkChunk(covered: number, chunk: IndexChunk): void {
  if (chunk.startOffset !== covered) throw new IndexOffsetError(covered, chunk.startOffset);
  if (!Number.isSafeInteger(chunk.endOffset) || chunk.endOffset < chunk.startOffset) {
    throw new RangeError("index chunk endOffset must be a whole number, not before startOffset");
  }
}

/** A label as the tree shows it: one line, at most 72 characters. Empty text gives "". */
export const label = truncateLabel;

/**
 * `org/repo` from a working folder of the repository layout: a task worktree
 * (`.../.worktrees/<org>/<task>/<repo>`, also `.base`) or a mirror or clone
 * (`.../repositories/<org>/<repo>`). Anything deeper inside the repository still names it.
 */
export function projectFromCwd(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter((part) => part !== "");
  const wt = parts.indexOf(".worktrees");
  if (wt !== -1) {
    const org = parts[wt + 1];
    const repo = parts[wt + 3];
    return org && repo ? `${org}/${repo}` : null;
  }
  const repos = parts.indexOf("repositories");
  if (repos !== -1) {
    const org = parts[repos + 1];
    const repo = parts[repos + 2];
    return org && repo && !org.startsWith(".") ? `${org}/${repo}` : null;
  }
  return null;
}
