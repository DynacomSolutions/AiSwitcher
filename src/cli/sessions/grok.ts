import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Identity } from "../../identities/types.ts";
import { truncateLabel } from "../resume/label.ts";
import { type TranscriptDto, type TranscriptTurnDto, type TreeNodeDto } from "./types.ts";
import {
  argsPreviewFrom,
  clampText,
  forEachLine,
  isoOrEpoch,
  isInProgress,
  listSubdirs,
  parseTimestampMs,
  safeJsonParse,
  textFromBlocks,
  windowCutoffMs,
  type TranscriptOpts,
  type WindowOpts,
} from "./shared.ts";
import { TurnCollector } from "./turn-collector.ts";

/**
 * Grok session trees + normalized transcripts.
 *
 * Storage (mirrors cli/resume/grok-resume.ts): `<configDir>/sessions/
 * <percent-encoded-cwd>/<session-uuid>/` with a `summary.json` index card
 * (info.id/info.cwd, session_summary, generated_title, timestamps) and the
 * full transcript in `chat_history.jsonl` (live-appended while a session
 * runs — it is the in-progress signal, since summary.json is only written
 * at summary time).
 *
 * Tree links: NONE. Grok records no parent/child notion (its Agent-style
 * runs leave no child session records), so every grok session is a flat
 * root. This is the honest "flat-only" case of the tree matrix.
 *
 * Transcript normalization: `system` (the single leading system prompt) as
 * a system turn; `user` (string or text blocks) as user turns;
 * `assistant` (plain string content) as assistant turns with their
 * OpenAI-style `tool_calls` entries as tool turns, results filled from
 * `tool_result` lines via tool_call_id. `reasoning` lines carry no content
 * and are skipped. Grok records NO per-entry timestamps, so turns have no
 * atMs and tokens are unavailable.
 */

interface GrokSummary {
  info?: { id?: string; cwd?: string };
  session_summary?: string;
  generated_title?: string;
  created_at?: string;
  updated_at?: string;
  last_active_at?: string;
}

function summaryMs(summary: GrokSummary, key: "created_at" | "updated_at" | "last_active_at"): number | undefined {
  return parseTimestampMs(summary[key]);
}

export async function readGrokTree(identity: Identity, opts: WindowOpts = {}): Promise<{ nodes: TreeNodeDto[]; error?: string }> {
  const cutoffMs = windowCutoffMs(opts);
  const sessionsRoot = join(identity.configDir, "sessions");
  let bucketDirs: string[];
  try {
    bucketDirs = await listSubdirs(sessionsRoot);
  } catch (err) {
    return { nodes: [], error: err instanceof Error ? err.message : String(err) };
  }

  const nodes: TreeNodeDto[] = [];
  let bucketError: string | undefined;
  for (const bucket of bucketDirs) {
    const bucketDir = join(sessionsRoot, bucket);
    let sessionDirs: string[];
    try {
      sessionDirs = await listSubdirs(bucketDir);
    } catch (err) {
      bucketError ??= err instanceof Error ? err.message : String(err);
      continue;
    }
    for (const sessionDirName of sessionDirs) {
      const sessionDir = join(bucketDir, sessionDirName);
      let summary: GrokSummary;
      try {
        summary = (await Bun.file(join(sessionDir, "summary.json")).json()) as GrokSummary;
      } catch {
        continue; // no summary.json: not a real session directory (or mid-write)
      }
      if (!summary.info?.cwd) continue;

      // updatedAt: the live transcript file wins over the summary card (a
      // running session appends to chat_history.jsonl without touching it).
      let liveMtimeMs: number | undefined;
      try {
        liveMtimeMs = (await stat(join(sessionDir, "chat_history.jsonl"))).mtimeMs;
      } catch {
        // no transcript yet: a summary-only session is still a node
      }
      const updatedMs = liveMtimeMs ?? summaryMs(summary, "last_active_at") ?? summaryMs(summary, "updated_at") ?? summaryMs(summary, "created_at");
      if (updatedMs !== undefined && updatedMs < cutoffMs) continue;
      const startedMs = summaryMs(summary, "created_at");

      const generatedLabel = summary.session_summary?.trim() || summary.generated_title?.trim();
      nodes.push({
        id: summary.info.id ?? sessionDirName,
        tool: "grok",
        identity: identity.name,
        title: generatedLabel ? truncateLabel(generatedLabel) : "(no summary)",
        cwd: summary.info.cwd,
        startedAt: isoOrEpoch(startedMs),
        updatedAt: isoOrEpoch(updatedMs),
        inProgress: liveMtimeMs !== undefined && isInProgress(liveMtimeMs, opts),
        depth: 0,
      });
    }
  }
  return bucketError ? { nodes, error: bucketError } : { nodes };
}

/* ------------------------------- transcript ------------------------------- */

async function locateGrokSessionDir(configDir: string, id: string): Promise<string | undefined> {
  const sessionsRoot = join(configDir, "sessions");
  const buckets = await listSubdirs(sessionsRoot);
  for (const bucket of buckets) {
    const sessionNames = await listSubdirs(join(sessionsRoot, bucket));
    for (const name of sessionNames) {
      if (name !== id) continue;
      const summaryPath = join(sessionsRoot, bucket, name, "summary.json");
      try {
        const summary = (await Bun.file(summaryPath).json()) as GrokSummary;
        // A directory may share the id's name only coincidentally: the
        // summary's own info.id stays authoritative when present.
        if (!summary.info?.id || summary.info.id === id) return join(sessionsRoot, bucket, name);
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export async function readGrokTranscript(
  identity: Identity,
  id: string,
  opts: TranscriptOpts & WindowOpts = {},
): Promise<TranscriptDto | undefined> {
  const sessionDir = await locateGrokSessionDir(identity.configDir, id);
  if (!sessionDir) return undefined;
  const chatPath = join(sessionDir, "chat_history.jsonl");
  if (!(await Bun.file(chatPath).exists())) return undefined;

  let summary: GrokSummary | undefined;
  try {
    summary = (await Bun.file(join(sessionDir, "summary.json")).json()) as GrokSummary;
  } catch {
    // transcript without a summary card still reads
  }

  const collector = new TurnCollector(opts.tail);
  let liveMtimeMs: number | undefined;
  await forEachLine(chatPath, (line) => {
    const entry = safeJsonParse(line);
    if (!entry) return;
    const type = entry.type;
    const content = entry.content;
    if (type === "system") {
      if (typeof content === "string" && content.trim()) collector.push({ role: "system", text: clampText(content) });
      return;
    }
    if (type === "user") {
      const text = typeof content === "string" ? content : textFromBlocks(content);
      if (text?.trim()) collector.push({ role: "user", text: clampText(text) });
      return;
    }
    if (type === "assistant") {
      if (typeof content === "string" && content.trim()) {
        collector.push({ role: "assistant", text: clampText(content) });
      }
      const toolCalls = entry.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          if (!call || typeof call !== "object") continue;
          const c = call as Record<string, unknown>;
          const fn = (c.function ?? {}) as Record<string, unknown>;
          if (typeof fn.name !== "string") continue;
          const turn: TranscriptTurnDto = {
            role: "tool",
            text: "",
            toolName: fn.name,
            argsPreview: argsPreviewFrom(fn.arguments),
          };
          collector.push(turn);
          if (typeof c.id === "string") collector.track(c.id, turn);
        }
      }
      return;
    }
    if (type === "tool_result") {
      if (typeof entry.tool_call_id === "string") {
        collector.fill(entry.tool_call_id, typeof content === "string" ? content : "");
      }
    }
    // reasoning lines (no content) and anything else: skipped
  });
  try {
    liveMtimeMs = (await stat(chatPath)).mtimeMs;
  } catch {
    // vanished mid-read
  }

  const generatedLabel = summary?.session_summary?.trim() || summary?.generated_title?.trim();
  const updatedMs = liveMtimeMs ?? summaryMs(summary ?? {}, "last_active_at") ?? summaryMs(summary ?? {}, "updated_at");
  return {
    session: {
      id,
      tool: "grok",
      identity: identity.name,
      ...(generatedLabel ? { title: truncateLabel(generatedLabel) } : {}),
      ...(summary?.info?.cwd !== undefined ? { cwd: summary.info.cwd } : {}),
      ...(summaryMs(summary ?? {}, "created_at") !== undefined
        ? { startedAt: new Date(summaryMs(summary ?? {}, "created_at")!).toISOString() }
        : {}),
      ...(updatedMs !== undefined ? { updatedAt: new Date(updatedMs).toISOString() } : {}),
    },
    turns: collector.turns,
    totalTurns: collector.total,
    truncated: collector.truncated,
    inProgress: liveMtimeMs !== undefined && isInProgress(liveMtimeMs, opts),
  };
}
