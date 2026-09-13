import type { Identity } from "../../identities/types.ts";
import { CliUsageError } from "../errors.ts";
import { readClaudeTranscript } from "./claude.ts";
import { readCodexTranscript } from "./codex.ts";
import { readCrushTranscript } from "./crush.ts";
import { readGrokTranscript } from "./grok.ts";
import { readKimiTranscript } from "./kimi.ts";
import { readPiTranscript } from "./pi.ts";
import { DEFAULT_TAIL_TURNS, DEFAULT_TREE_DAYS, MAX_TAIL_TURNS, type TranscriptOpts, type WindowOpts } from "./shared.ts";
import type { SessionTool, TranscriptDto } from "./types.ts";

/**
 * Dispatcher behind GET /api/sessions/transcript (and `readTranscript`).
 * `id` is the opaque node id from the tree response (claude/kimi subagent
 * ids are namespaced "<sessionId>/<agent>"; every other tool uses its
 * native session id).
 *
 * Returns undefined when the session does not exist (the server maps that
 * to 404). Throws CliUsageError for a tool with no reader (400). Reads are
 * always full streaming passes over the session's transcript, so the
 * result reflects lines appended after the previous poll: the transcript
 * is live by construction, the server-side cache just bounds re-read cost.
 */

export { DEFAULT_TAIL_TURNS, MAX_TAIL_TURNS };

type TranscriptReader = (
  identity: Identity,
  id: string,
  opts: TranscriptOpts & WindowOpts,
) => Promise<TranscriptDto | undefined>;

const READERS: Partial<Record<SessionTool, TranscriptReader>> = {
  claude: readClaudeTranscript,
  codex: readCodexTranscript,
  pi: readPiTranscript,
  grok: readGrokTranscript,
  kimi: readKimiTranscript,
  zai: (identity, id, opts) => readCrushTranscript("zai", identity, "data", "zai", id, opts),
  ali: (identity, id, opts) => readCrushTranscript("ali", identity, "data", "alibaba", id, opts),
};

export function hasTranscriptReader(tool: SessionTool): boolean {
  return tool in READERS;
}

export interface ReadTranscriptOpts extends TranscriptOpts, WindowOpts {}

export async function readTranscript(
  tool: SessionTool,
  identity: Identity,
  sessionId: string,
  opts: ReadTranscriptOpts = {},
): Promise<TranscriptDto | undefined> {
  const reader = READERS[tool];
  if (!reader) {
    throw new CliUsageError(`no session transcript reader implemented for "${tool}" yet`);
  }
  const tail = opts.tail ?? DEFAULT_TAIL_TURNS;
  return reader(identity, sessionId, { ...opts, tail: Math.min(Math.max(1, tail), MAX_TAIL_TURNS), days: opts.days ?? DEFAULT_TREE_DAYS });
}
