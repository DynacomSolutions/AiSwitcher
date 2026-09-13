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
  windowCutoffMs,
  type TranscriptOpts,
  type WindowOpts,
} from "./shared.ts";
import { TurnCollector } from "./turn-collector.ts";

/**
 * Claude Code session trees + normalized transcripts.
 *
 * Storage (mirrors cli/resume/claude-resume.ts, which is the authoritative
 * discovery write-up): `<configDir>/projects/<encoded-cwd>/<session>.jsonl`
 * per top-level session, plus per-session sidecar directories holding the
 * subagent transcripts at
 * `<encoded-cwd>/<sessionId>/subagents/<any-depth>/agent-<agentId>.jsonl`
 * (every line in those files carries `isSidechain: true`, a `sessionId`
 * equal to the parent session's id and an `agentId` unique to the agent).
 *
 * Tree links: a subagent file is a CHILD of its parent session (parentId =
 * the sessionId on its lines / the sidecar directory's name). Claude has no
 * deeper nesting on this machine: agents spawn via the parent session only,
 * so the tree is roots + one agent level.
 *
 * Transcript normalization: `user` entries render as user turns (or fill a
 * pending tool turn when they only carry tool_result blocks),
 * `assistant` entries render their text blocks as assistant turns and their
 * tool_use blocks as tool turns (result filled from the matching
 * tool_result via tool_use_id), `system` entries with string content render
 * as system turns. thinking blocks, attachments and every bookkeeping entry
 * type (mode/queue-operation/ai-title/...) are skipped.
 */

interface ClaudeScan {
  cwd?: string;
  firstTs?: number;
  lastTs?: number;
  aiTitle?: string;
  firstUser?: string;
  messageCount: number;
}

/** One streaming pass over a session JSONL collecting everything the tree
 * node (and the transcript's session meta) needs. */
async function scanSessionFile(filePath: string): Promise<ClaudeScan> {
  const scan: ClaudeScan = { messageCount: 0 };
  await forEachLine(filePath, (line) => {
    const entry = safeJsonParse(line);
    if (!entry) return;
    const type = entry.type;
    if (type === "user" && entry.isMeta !== true) {
      const message = entry.message as Record<string, unknown> | undefined;
      const text = typeof message?.content === "string" ? message.content : textFromBlocks(message?.content);
      if (text && scan.firstUser === undefined && text.trim()) scan.firstUser = text;
    }
    if (type === "ai-title" && typeof entry.aiTitle === "string") scan.aiTitle = entry.aiTitle;
    if (scan.cwd === undefined && typeof entry.cwd === "string") scan.cwd = entry.cwd;
    if (type === "user" || type === "assistant") scan.messageCount += 1;
    const ts = parseTimestampMs(entry.timestamp);
    if (ts !== undefined) {
      if (scan.firstTs === undefined) scan.firstTs = ts;
      scan.lastTs = ts;
    }
  });
  return scan;
}

/** Bounded pass over a subagent transcript: the header line (always line 1)
 * carries agentId/cwd/firstTs, and its first real user line is the task
 * prompt the tree uses as the node title. Both reads stop at their match,
 * so only the first few lines of the file are ever touched. */
async function scanAgentFile(filePath: string): Promise<{ agentId?: string; cwd?: string; firstTs?: number; firstUser?: string }> {
  const header = safeJsonParse((await findFirstLine(filePath, (line) => line.trim() !== "")) ?? "");
  const userLine = safeJsonParse(
    (await findFirstLine(filePath, (line) => {
      const entry = safeJsonParse(line);
      if (!entry || entry.type !== "user" || entry.isMeta === true) return false;
      const message = entry.message as Record<string, unknown> | undefined;
      const text = typeof message?.content === "string" ? message.content : textFromBlocks(message?.content);
      return text !== undefined && text.trim() !== "";
    })) ?? "",
  );
  const result: { agentId?: string; cwd?: string; firstTs?: number; firstUser?: string } = {};
  if (header) {
    if (typeof header.agentId === "string") result.agentId = header.agentId;
    if (typeof header.cwd === "string") result.cwd = header.cwd;
    const ts = parseTimestampMs(header.timestamp);
    if (ts !== undefined) result.firstTs = ts;
  }
  if (userLine) {
    const message = userLine.message as Record<string, unknown> | undefined;
    const text = typeof message?.content === "string" ? message.content : textFromBlocks(message?.content);
    if (text?.trim()) result.firstUser = text;
  }
  return result;
}

function titleFor(aiTitle: string | undefined, firstUser: string | undefined): string {
  if (aiTitle?.trim()) return truncateLabel(aiTitle);
  if (firstUser?.trim()) return truncateLabel(firstUser);
  return "(no user message)";
}

export async function readClaudeTree(identity: Identity, opts: WindowOpts = {}): Promise<TreeNodeDto[]> {
  const cutoffMs = windowCutoffMs(opts);
  const projectsDir = join(identity.configDir, "projects");
  let encDirs: string[];
  try {
    encDirs = await listSubdirs(projectsDir);
  } catch {
    return [];
  }

  const nodes: TreeNodeDto[] = [];
  // Per-project-dir parallelism; files inside a dir sequential (the heavy
  // streaming scans stay orderly and the worker deadline bounds the total).
  await Promise.all(
    encDirs.map(async (encDir) => {
      const dirPath = join(projectsDir, encDir);
      let entries;
      try {
        entries = await readdir(dirPath, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          let mtimeMs: number;
          try {
            mtimeMs = (await stat(entryPath)).mtimeMs;
          } catch {
            continue;
          }
          if (mtimeMs < cutoffMs) continue; // outside the window: no node at all
          const scan = await scanSessionFile(entryPath);
          nodes.push({
            id: entry.name.slice(0, -".jsonl".length),
            tool: "claude",
            identity: identity.name,
            title: titleFor(scan.aiTitle, scan.firstUser),
            cwd: scan.cwd ?? null,
            startedAt: isoOrEpoch(scan.firstTs),
            updatedAt: isoOrEpoch(scan.lastTs ?? mtimeMs),
            inProgress: isInProgress(mtimeMs, opts),
            ...(scan.messageCount > 0 ? { messageCount: scan.messageCount } : {}),
            depth: 0, // recomputed by the tree dispatcher
          });
        } else if (entry.isDirectory() && entry.name !== "memory") {
          // Session sidecar dir: subagent transcripts hang off the session.
          const subagentsDir = join(entryPath, "subagents");
          const agentFiles = await walkAgentFiles(subagentsDir);
          for (const agentFile of agentFiles) {
            let mtimeMs: number;
            try {
              mtimeMs = (await stat(agentFile)).mtimeMs;
            } catch {
              continue;
            }
            if (mtimeMs < cutoffMs) continue;
            const scan = await scanAgentFile(agentFile);
            const agentId = scan.agentId ?? agentFile.split("/").pop()?.slice("agent-".length, -".jsonl".length);
            if (!agentId) continue;
            nodes.push({
              id: `${entry.name}/${agentId}`,
              parentId: entry.name,
              tool: "claude",
              identity: identity.name,
              title: truncateLabel(scan.firstUser ?? agentId),
              cwd: scan.cwd ?? null,
              startedAt: isoOrEpoch(scan.firstTs),
              updatedAt: isoOrEpoch(mtimeMs),
              inProgress: isInProgress(mtimeMs, opts),
              depth: 0,
              agentName: agentId,
            });
          }
        }
      }
    }),
  );
  return nodes;
}

async function walkAgentFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl")) out.push(full);
    }
  }
  await walk(dir, 0);
  return out;
}

/* ------------------------------- transcript ------------------------------- */

function pushClaudeEntry(collector: TurnCollector, entry: Record<string, unknown>): void {
  const type = entry.type;
  const atMs = parseTimestampMs(entry.timestamp);
  const message = entry.message as Record<string, unknown> | undefined;
  const content = message?.content;

  if (type === "system") {
    if (typeof entry.content === "string" && entry.content.trim()) {
      collector.push({ role: "system", text: clampText(entry.content), ...(atMs !== undefined ? { atMs } : {}) });
    }
    return;
  }
  if (type !== "user" && type !== "assistant") return;

    if (type === "user") {
      if (typeof content === "string") {
        if (entry.isMeta !== true && content.trim()) {
          collector.push({ role: "user", text: clampText(content), ...(atMs !== undefined ? { atMs } : {}) });
        }
        return;
      }
      if (Array.isArray(content)) {
        const userTexts: string[] = [];
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) userTexts.push(b.text);
          else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
            collector.fill(b.tool_use_id, toolResultText(b.content));
          }
        }
        if (userTexts.length && entry.isMeta !== true) {
          collector.push({ role: "user", text: clampText(userTexts.join("\n")), ...(atMs !== undefined ? { atMs } : {}) });
        }
      }
      return;
    }

  // assistant
  if (!Array.isArray(content)) return;
  let entryTokens: number | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (usage) {
    const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    entryTokens = input + output;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      collector.push({
        role: "assistant",
        text: clampText(b.text),
        ...(atMs !== undefined ? { atMs } : {}),
        ...(entryTokens !== undefined ? { tokens: entryTokens } : {}),
      });
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      const turn: TranscriptTurnDto = {
        role: "tool",
        text: "",
        toolName: b.name,
        argsPreview: argsPreviewFrom(b.input),
        ...(atMs !== undefined ? { atMs } : {}),
      };
      collector.push(turn);
      if (typeof b.id === "string") collector.track(b.id, turn);
    }
    // thinking blocks: deliberately skipped (noise for a chat view)
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

/** Locates a claude session/agent transcript file by node id: plain ids are
 * `<uuid>.jsonl` directly under a project dir; subagent ids are
 * `<sessionId>/<agentId>` (see readClaudeTree). */
export async function locateClaudeTranscript(configDir: string, id: string): Promise<string | undefined> {
  const projectsDir = join(configDir, "projects");
  let encDirs: string[];
  try {
    encDirs = await listSubdirs(projectsDir);
  } catch {
    return undefined;
  }
  const slashAt = id.indexOf("/");
  if (slashAt === -1) {
    for (const encDir of encDirs) {
      const candidate = join(projectsDir, encDir, `${id}.jsonl`);
      if (await Bun.file(candidate).exists()) return candidate;
    }
    return undefined;
  }
  const sessionId = id.slice(0, slashAt);
  const agentId = id.slice(slashAt + 1);
  for (const encDir of encDirs) {
    const sessionDir = join(projectsDir, encDir, sessionId);
    const files = await walkAgentFiles(join(sessionDir, "subagents"));
    const match = files.find((f) => {
      const base = f.split("/").pop() ?? "";
      return base === `agent-${agentId}.jsonl`;
    });
    if (match) return match;
  }
  return undefined;
}

export async function readClaudeTranscript(
  identity: Identity,
  id: string,
  opts: TranscriptOpts & WindowOpts = {},
): Promise<TranscriptDto | undefined> {
  const filePath = await locateClaudeTranscript(identity.configDir, id);
  if (!filePath) return undefined;

  const meta: ClaudeScan = { messageCount: 0 };
  const collector = new TurnCollector(opts.tail);
  await forEachLine(filePath, (line) => {
    const entry = safeJsonParse(line);
    if (!entry) return;
    // Same accumulation the tree scan does, folded into the transcript pass
    // so one read yields both turns and session meta.
    if (entry.type === "user" && entry.isMeta !== true) {
      const text = textFromBlocks((entry.message as Record<string, unknown> | undefined)?.content) ??
        (typeof (entry.message as Record<string, unknown> | undefined)?.content === "string"
          ? ((entry.message as Record<string, unknown>).content as string)
          : undefined);
      if (text && meta.firstUser === undefined && text.trim()) meta.firstUser = text;
    }
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") meta.aiTitle = entry.aiTitle;
    if (meta.cwd === undefined && typeof entry.cwd === "string") meta.cwd = entry.cwd;
    if (entry.type === "user" || entry.type === "assistant") meta.messageCount += 1;
    const ts = parseTimestampMs(entry.timestamp);
    if (ts !== undefined) {
      if (meta.firstTs === undefined) meta.firstTs = ts;
      meta.lastTs = ts;
    }
    pushClaudeEntry(collector, entry);
  });

  let mtimeMs: number | undefined;
  try {
    mtimeMs = (await stat(filePath)).mtimeMs;
  } catch {
    // vanished mid-read: the turns we streamed are still valid
  }

  return {
    session: {
      id,
      tool: "claude",
      identity: identity.name,
      ...(meta.aiTitle || meta.firstUser ? { title: titleFor(meta.aiTitle, meta.firstUser) } : {}),
      ...(meta.cwd !== undefined ? { cwd: meta.cwd } : {}),
      ...(meta.firstTs !== undefined ? { startedAt: new Date(meta.firstTs).toISOString() } : {}),
      ...(meta.lastTs !== undefined || mtimeMs !== undefined
        ? { updatedAt: isoOrEpoch(meta.lastTs ?? mtimeMs) }
        : {}),
    },
    turns: collector.turns,
    totalTurns: collector.total,
    truncated: collector.truncated,
    inProgress: mtimeMs !== undefined ? isInProgress(mtimeMs, opts) : false,
  };
}
