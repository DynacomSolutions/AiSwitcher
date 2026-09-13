import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Identity } from "../../identities/types.ts";
import { truncateLabel } from "../resume/label.ts";
import { type TranscriptDto, type TranscriptTurnDto, type TreeNodeDto } from "./types.ts";
import {
  argsPreviewFrom,
  clampText,
  findFirstLine,
  forEachLine,
  isoOrEpoch,
  isInProgress,
  parseTimestampMs,
  safeJsonParse,
  textFromBlocks,
  windowCutoffMs,
  type TranscriptOpts,
  type WindowOpts,
} from "./shared.ts";
import { TurnCollector } from "./turn-collector.ts";

/**
 * Kimi Code session trees + normalized transcripts.
 *
 * Storage (mirrors cli/resume/kimi-resume.ts): `<configDir>/
 * session_index.jsonl` is the authoritative index ({sessionId, sessionDir,
 * workDir}); each sessionDir carries state.json plus an `agents/` directory
 * with one `wire.jsonl` per agent — `agents/main/` is the session itself,
 * `agents/agent-N/` are spawned subagents (their first `turn.prompt` line
 * carries origin {kind: "system_trigger", name: "subagent"}, confirming the
 * spawn relationship live on this machine).
 *
 * Tree links: sessions are roots; every agent-<N> dir is a CHILD of its
 * session. Subagent node ids are namespaced "<sessionId>/<agentDir>"
 * because agent dir names are only unique within their session.
 *
 * Transcript normalization from the wire protocol: `turn.prompt` -> user
 * turns (input blocks' text; steers included, they are user input);
 * `content.part` events type "text" -> assistant turns ("think" parts are
 * skipped); `tool.call`/`tool.result` pairs merge into tool turns via
 * toolCallId. Per-entry times exist only on turn.prompt lines, so tool
 * turns have no atMs; per-step token totals are step-scoped rather than
 * turn-scoped, so tokens are unavailable.
 */

interface StateJson {
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  isCustomTitle?: boolean;
  workDir?: string;
}

interface IndexEntry {
  sessionId?: string;
  sessionDir?: string;
  workDir?: string;
}

const PLACEHOLDER_TITLE = "New Session";

function titleFromState(state: StateJson | undefined): string {
  const title = state?.title?.trim();
  if (!title || title === PLACEHOLDER_TITLE) return "(no summary)";
  return truncateLabel(title);
}

interface ParsedIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

async function readIndex(configDir: string): Promise<ParsedIndexEntry[]> {
  let text: string;
  try {
    text = await Bun.file(join(configDir, "session_index.jsonl")).text();
  } catch {
    return [];
  }
  const out: ParsedIndexEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const entry = safeJsonParse(line);
    if (!entry) continue;
    const rec = entry as unknown as Partial<IndexEntry>;
    if (rec.sessionId && rec.sessionDir && rec.workDir) {
      out.push({ sessionId: rec.sessionId, sessionDir: rec.sessionDir, workDir: rec.workDir });
    }
  }
  return out;
}

/** Bounded read of a wire.jsonl for the tree: the first user-originated
 * turn.prompt input text is the best title a wire carries. */
async function wireFirstPrompt(wirePath: string): Promise<string | undefined> {
  const line = await findFirstLine(wirePath, (candidate) => {
    const entry = safeJsonParse(candidate);
    if (!entry || entry.type !== "turn.prompt") return false;
    return textFromBlocks(entry.input) !== undefined;
  });
  if (!line) return undefined;
  const entry = safeJsonParse(line);
  return entry ? textFromBlocks(entry.input) : undefined;
}

async function newestWireMtimeMs(sessionDir: string): Promise<number | undefined> {
  const agentsDir = join(sessionDir, "agents");
  let names: string[];
  try {
    names = await readdir(agentsDir);
  } catch {
    return undefined;
  }
  let newest: number | undefined;
  for (const name of names) {
    try {
      const info = await stat(join(agentsDir, name, "wire.jsonl"));
      newest = newest === undefined ? info.mtimeMs : Math.max(newest, info.mtimeMs);
    } catch {
      continue;
    }
  }
  return newest;
}

async function listAgentDirs(sessionDir: string): Promise<string[]> {
  const agentsDir = join(sessionDir, "agents");
  let entries;
  try {
    entries = await readdir(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

export async function readKimiTree(identity: Identity, opts: WindowOpts = {}): Promise<TreeNodeDto[]> {
  const cutoffMs = windowCutoffMs(opts);
  const nodes: TreeNodeDto[] = [];
  for (const entry of await readIndex(identity.configDir)) {
    let liveMtimeMs: number | undefined;
    try {
      liveMtimeMs = (await stat(join(entry.sessionDir, "state.json"))).mtimeMs;
    } catch {
      continue; // session vanished between index and read
    }
    const wireMtimeMs = await newestWireMtimeMs(entry.sessionDir);
    const updatedAtMs = wireMtimeMs ?? liveMtimeMs;
    if (updatedAtMs !== undefined && updatedAtMs < cutoffMs) continue;

    let state: StateJson | undefined;
    try {
      state = JSON.parse(await Bun.file(join(entry.sessionDir, "state.json")).text()) as StateJson;
    } catch {
      // index-only node (same convention as kimi-resume.ts)
    }
    nodes.push({
      id: entry.sessionId,
      tool: "kimi",
      identity: identity.name,
      title: titleFromState(state),
      cwd: state?.workDir ?? entry.workDir,
      startedAt: isoOrEpoch(parseTimestampMs(state?.createdAt)),
      updatedAt: isoOrEpoch(updatedAtMs),
      inProgress: wireMtimeMs !== undefined && isInProgress(wireMtimeMs, opts),
      depth: 0,
    });
    // Subagents: one child node per agents/<dir> other than main.
    for (const agentDir of await listAgentDirs(entry.sessionDir)) {
      if (agentDir === "main") continue;
      const wirePath = join(entry.sessionDir, "agents", agentDir, "wire.jsonl");
      let agentMtimeMs: number;
      try {
        agentMtimeMs = (await stat(wirePath)).mtimeMs;
      } catch {
        continue; // agent dir without a wire yet (or vanished)
      }
      if (agentMtimeMs < cutoffMs) continue;
      const task = await wireFirstPrompt(wirePath);
      const metaLine = await wireCreatedAt(wirePath);
      nodes.push({
        id: `${entry.sessionId}/${agentDir}`,
        parentId: entry.sessionId,
        tool: "kimi",
        identity: identity.name,
        title: truncateLabel(task ?? agentDir),
        cwd: state?.workDir ?? entry.workDir,
        startedAt: isoOrEpoch(metaLine ?? agentMtimeMs),
        updatedAt: isoOrEpoch(agentMtimeMs),
        inProgress: isInProgress(agentMtimeMs, opts),
        depth: 0,
        agentName: agentDir,
      });
    }
  }
  return nodes;
}

async function wireCreatedAt(wirePath: string): Promise<number | undefined> {
  const line = await findFirstLine(wirePath, (candidate) => {
    const entry = safeJsonParse(candidate);
    return entry?.type === "metadata";
  });
  if (!line) return undefined;
  const entry = safeJsonParse(line);
  if (!entry) return undefined;
  return parseTimestampMs(typeof entry.created_at === "string" ? Number(entry.created_at) : entry.created_at);
}

/* ------------------------------- transcript ------------------------------- */

function pushKimiWire(collector: TurnCollector, entry: Record<string, unknown>): void {
  const type = entry.type;
  if (type === "turn.prompt") {
    const text = textFromBlocks(entry.input);
    if (text?.trim()) {
      const atMs = parseTimestampMs(typeof entry.time === "string" ? Number(entry.time) : entry.time);
      collector.push({ role: "user", text: clampText(text), ...(atMs !== undefined ? { atMs } : {}) });
    }
    return;
  }
  if (type === "context.append_loop_event") {
    const event = entry.event as Record<string, unknown> | undefined;
    if (!event) return;
    if (event.type === "content.part") {
      const part = event.part as Record<string, unknown> | undefined;
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        collector.push({ role: "assistant", text: clampText(part.text) });
      }
      return;
    }
    if (event.type === "tool.call" && typeof event.name === "string") {
      const turn: TranscriptTurnDto = {
        role: "tool",
        text: "",
        toolName: event.name,
        argsPreview: argsPreviewFrom(event.args),
      };
      collector.push(turn);
      if (typeof event.toolCallId === "string") collector.track(event.toolCallId, turn);
      return;
    }
    if (event.type === "tool.result") {
      if (typeof event.toolCallId === "string") {
        const result = event.result as Record<string, unknown> | undefined;
        collector.fill(event.toolCallId, typeof result?.output === "string" ? result.output : "");
      }
    }
  }
}

async function locateKimiWire(configDir: string, id: string): Promise<string | undefined> {
  const slashAt = id.indexOf("/");
  const sessionId = slashAt === -1 ? id : id.slice(0, slashAt);
  const agentDir = slashAt === -1 ? "main" : id.slice(slashAt + 1);
  for (const entry of await readIndex(configDir)) {
    if (entry.sessionId !== sessionId) continue;
    const wirePath = join(entry.sessionDir, "agents", agentDir, "wire.jsonl");
    if (await Bun.file(wirePath).exists()) return wirePath;
    // A session without agents/main/wire.jsonl still existed once; nothing
    // else to read for it.
    return undefined;
  }
  return undefined;
}

export async function readKimiTranscript(
  identity: Identity,
  id: string,
  opts: TranscriptOpts & WindowOpts = {},
): Promise<TranscriptDto | undefined> {
  const wirePath = await locateKimiWire(identity.configDir, id);
  if (!wirePath) return undefined;

  const slashAt = id.indexOf("/");
  const sessionId = slashAt === -1 ? id : id.slice(0, slashAt);

  let state: StateJson | undefined;
  const sessionEntry = (await readIndex(identity.configDir)).find((e) => e.sessionId === sessionId);
  if (sessionEntry) {
    try {
      state = JSON.parse(await Bun.file(join(sessionEntry.sessionDir, "state.json")).text()) as StateJson;
    } catch {
      // index-only meta
    }
  }

  const collector = new TurnCollector(opts.tail);
  let wireCreated: number | undefined;
  await forEachLine(wirePath, (line) => {
    const entry = safeJsonParse(line);
    if (!entry) return;
    if (entry.type === "metadata" && wireCreated === undefined) {
      wireCreated = parseTimestampMs(typeof entry.created_at === "string" ? Number(entry.created_at) : entry.created_at);
      return;
    }
    pushKimiWire(collector, entry);
  });

  let mtimeMs: number | undefined;
  try {
    mtimeMs = (await stat(wirePath)).mtimeMs;
  } catch {
    // vanished mid-read
  }

  const title = titleFromState(state);
  return {
    session: {
      id,
      tool: "kimi",
      identity: identity.name,
      ...(title !== "(no summary)" ? { title } : {}),
      ...(state?.workDir !== undefined ? { cwd: state.workDir } : {}),
      ...(wireCreated !== undefined ? { startedAt: new Date(wireCreated).toISOString() } : {}),
      ...(mtimeMs !== undefined ? { updatedAt: isoOrEpoch(mtimeMs) } : {}),
    },
    turns: collector.turns,
    totalTurns: collector.total,
    truncated: collector.truncated,
    inProgress: mtimeMs !== undefined && isInProgress(mtimeMs, opts),
  };
}
