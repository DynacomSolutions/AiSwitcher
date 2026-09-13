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
  listSubdirs,
  parseTimestampMs,
  safeJsonParse,
  textFromBlocks,
  walkJsonlFiles,
  windowCutoffMs,
  type TranscriptOpts,
  type WindowOpts,
} from "./shared.ts";
import { TurnCollector } from "./turn-collector.ts";

/**
 * Pi (pi-mono coding agent) session trees + normalized transcripts.
 *
 * Storage: `<configDir>/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`.
 * Line 1 is a `session` header carrying the session id, start timestamp and
 * cwd; every later `message` entry wraps a provider message
 * (role user / assistant / toolResult, content = string or typed blocks,
 * per-message usage on assistant messages). There is NO native parent/
 * child link: pi sessions are FLAT nodes (its extension-level subagent
 * machinery spawns other tools' CLIs rather than nested pi sessions), so
 * the tree is all roots.
 *
 * Transcript normalization: user messages render from their text blocks;
 * assistant messages render text blocks as assistant turns and toolCall
 * blocks as tool turns (result filled from the matching `toolResult`
 * message via toolCallId); thinking blocks are skipped. tokens come from
 * the assistant message's own usage (input+output).
 */

interface PiHeader {
  id?: string;
  cwd?: string;
  startedAt?: number;
}

function parseHeader(line: string | undefined): PiHeader | undefined {
  if (!line) return undefined;
  const entry = safeJsonParse(line);
  if (!entry || entry.type !== "session") return undefined;
  return {
    ...(typeof entry.id === "string" ? { id: entry.id } : {}),
    ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
    ...(parseTimestampMs(entry.timestamp) !== undefined ? { startedAt: parseTimestampMs(entry.timestamp) } : {}),
  };
}

/** Bounded scan for the first user message (the title source). */
async function firstUserText(filePath: string): Promise<string | undefined> {
  const line = await findFirstLine(filePath, (candidate) => {
    const entry = safeJsonParse(candidate);
    if (!entry || entry.type !== "message") return false;
    const message = entry.message as Record<string, unknown> | undefined;
    if (message?.role !== "user") return false;
    const content = message.content;
    const text = typeof content === "string" ? content : textFromBlocks(content);
    return text !== undefined && text.trim() !== "";
  });
  if (!line) return undefined;
  const entry = safeJsonParse(line);
  const message = entry?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return typeof content === "string" ? content : textFromBlocks(content);
}

export async function readPiTree(identity: Identity, opts: WindowOpts = {}): Promise<TreeNodeDto[]> {
  const cutoffMs = windowCutoffMs(opts);
  const sessionsRoot = join(identity.configDir, "sessions");
  const files = await walkJsonlFiles(sessionsRoot);
  const nodes: TreeNodeDto[] = [];
  for (const filePath of files) {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < cutoffMs) continue;
    const header = parseHeader(await readHeaderLine(filePath));
    if (!header?.id) continue;
    const title = (await firstUserText(filePath)) ?? "(no user message)";
    nodes.push({
      id: header.id,
      tool: "pi",
      identity: identity.name,
      title: truncateLabel(title),
      cwd: header.cwd ?? null,
      startedAt: isoOrEpoch(header.startedAt ?? mtimeMs),
      updatedAt: isoOrEpoch(mtimeMs),
      inProgress: isInProgress(mtimeMs, opts),
      depth: 0,
    });
  }
  return nodes;
}

async function readHeaderLine(filePath: string): Promise<string | undefined> {
  return findFirstLine(filePath, (line) => line.trim() !== "");
}

/* ------------------------------- transcript ------------------------------- */

function pushPiMessage(collector: TurnCollector, message: Record<string, unknown>, atMs: number | undefined): void {
  const role = message.role;
  const content = message.content;
  if (role === "user") {
    const text = typeof content === "string" ? content : textFromBlocks(content);
    if (text?.trim()) collector.push({ role: "user", text: clampText(text), ...(atMs !== undefined ? { atMs } : {}) });
    return;
  }
  if (role === "assistant") {
    if (!Array.isArray(content)) return;
    const usage = message.usage as Record<string, unknown> | undefined;
    let tokens: number | undefined;
    if (usage) {
      const input = typeof usage.input === "number" ? usage.input : 0;
      const output = typeof usage.output === "number" ? usage.output : 0;
      tokens = input + output;
    }
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        collector.push({
          role: "assistant",
          text: clampText(b.text),
          ...(atMs !== undefined ? { atMs } : {}),
          ...(tokens !== undefined ? { tokens } : {}),
        });
      } else if (b.type === "toolCall" && typeof b.name === "string") {
        const turn: TranscriptTurnDto = {
          role: "tool",
          text: "",
          toolName: b.name,
          argsPreview: argsPreviewFrom(b.arguments),
          ...(atMs !== undefined ? { atMs } : {}),
        };
        collector.push(turn);
        if (typeof b.id === "string") collector.track(b.id, turn);
      }
    }
    return;
  }
  if (role === "toolResult") {
    if (typeof message.toolCallId === "string") {
      collector.fill(message.toolCallId, toolResultText(content));
    }
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
        parts.push((block as Record<string, unknown>).text as string);
      }
    }
    return parts.join("\n");
  }
  return "";
}

async function locatePiTranscript(configDir: string, id: string): Promise<string | undefined> {
  // Filenames are <timestamp>_<id>.jsonl under one bucket dir each.
  const buckets = await listSubdirs(join(configDir, "sessions"));
  for (const bucket of buckets) {
    let names: string[];
    try {
      names = await readdir(join(configDir, "sessions", bucket));
    } catch {
      continue;
    }
    const match = names.find((name) => name === `${id}.jsonl` || name.endsWith(`_${id}.jsonl`));
    if (match) return join(configDir, "sessions", bucket, match);
  }
  return undefined;
}

export async function readPiTranscript(
  identity: Identity,
  id: string,
  opts: TranscriptOpts & WindowOpts = {},
): Promise<TranscriptDto | undefined> {
  const filePath = await locatePiTranscript(identity.configDir, id);
  if (!filePath) return undefined;

  let header = parseHeader(await readHeaderLine(filePath));
  const collector = new TurnCollector(opts.tail);
  let title: string | undefined;
  let lastTs: number | undefined;
  await forEachLine(filePath, (line) => {
    const entry = safeJsonParse(line);
    if (!entry) return;
    if (header === undefined && entry.type === "session") header = parseHeader(line);
    const atMs = parseTimestampMs(entry.timestamp);
    if (atMs !== undefined) lastTs = atMs;
    if (entry.type !== "message") return;
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) return;
    if (message.role === "user" && title === undefined) {
      const content = message.content;
      const text = typeof content === "string" ? content : textFromBlocks(content);
      if (text?.trim()) title = text;
    }
    pushPiMessage(collector, message, atMs);
  });

  let mtimeMs: number | undefined;
  try {
    mtimeMs = (await stat(filePath)).mtimeMs;
  } catch {
    // vanished mid-read
  }

  return {
    session: {
      id,
      tool: "pi",
      identity: identity.name,
      ...(title ? { title: truncateLabel(title) } : {}),
      ...(header?.cwd !== undefined ? { cwd: header.cwd } : {}),
      ...(header?.startedAt !== undefined ? { startedAt: new Date(header.startedAt).toISOString() } : {}),
      ...(lastTs !== undefined || mtimeMs !== undefined ? { updatedAt: isoOrEpoch(lastTs ?? mtimeMs) } : {}),
    },
    turns: collector.turns,
    totalTurns: collector.total,
    truncated: collector.truncated,
    inProgress: mtimeMs !== undefined ? isInProgress(mtimeMs, opts) : false,
  };
}
