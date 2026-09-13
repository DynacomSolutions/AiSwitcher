import { mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Identity, ToolConfig } from "../../../src/identities/types.ts";

/**
 * Synthetic per-tool session fixtures for the sessions tree/transcript
 * tests. Everything under a per-test mkdtemp dir; identity names and
 * content are SYNTHETIC_FIXTURE data with no resemblance to any real
 * registry. File timestamps are set explicitly (utimes) so window and
 * in-progress behaviour is deterministic.
 */

export const NOW = Date.parse("2026-09-01T12:00:00.000Z"); // fixed scan time
export const DAY = 86_400_000;
export const FRESH = NOW - 10_000; // 10s ago: in-progress
export const OLD = NOW - 40 * DAY; // outside the default 30d window

/** codex's sessions/YYYY/MM/DD path-date layout for NOW: inside the 30d
 * window ending at NOW, so path-date pruning keeps these fixtures. */
export const CODEX_DAY_DIR = new Date(NOW).toISOString().slice(0, 10).split("-").join("/");

export async function makeConfigDir(prefix: string): Promise<string> {
  return mkdtempFor(prefix);
}

async function mkdtempFor(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), `ais-sessions-${prefix}-`));
  return dir;
}

export function identity(configDir: string, name = "testa"): Identity {
  return { name, label: `Test ${name}`, configDir };
}

export function fakeConfig(toolName: ToolConfig["toolName"], registryPath: string): ToolConfig {
  const base: ToolConfig = {
    toolName,
    realBinaryName: toolName === "zai" || toolName === "ali" ? "crush" : toolName,
    envVarName:
      toolName === "claude" ? "CLAUDE_CONFIG_DIR"
      : toolName === "codex" ? "CODEX_HOME"
      : toolName === "grok" ? "GROK_HOME"
      : toolName === "kimi" ? "KIMI_CODE_HOME"
      : toolName === "zai" ? "CRUSH_GLOBAL_CONFIG"
      : toolName === "ali" ? "ALI_CONFIG_DIR"
      : toolName === "pi" ? "PI_CODING_AGENT_DIR"
      : "OPENCODE_CONFIG_DIR",
    identitiesJsonPath: registryPath,
    identitiesRootDir: join(registryPath, "..", "identities"),
    globalMemoryProjection:
      toolName === "claude" ? "claude-append-file"
      : toolName === "codex" ? "codex-developer-instructions"
      : toolName === "zai" || toolName === "ali" ? "crush-global-context"
      : toolName === "kimi" ? "kimi-global-agents"
      : toolName === "pi" ? "pi-append-file"
      : "opencode-config-content",
  };
  return base;
}

export async function writeJsonl(path: string, lines: Array<Record<string, unknown>>, mtimeMs = NOW): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
}

export async function writeJson(path: string, data: unknown, mtimeMs = NOW): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(data));
  await utimes(path, new Date(mtimeMs), new Date(mtimeMs));
}

/* --------------------------------- claude --------------------------------- */

export const CLAUDE_ENC = "-tmp-proj-a";

export function claudeUserLine(cwd: string, text: string, ts: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "user", message: { role: "user", content: text }, cwd, timestamp: ts, isMeta: false, isSidechain: false, ...extra };
}

export function claudeAssistantText(text: string, ts: string, tokens = 100): Record<string, unknown> {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: tokens - 40, output_tokens: 40 } },
    timestamp: ts,
    isSidechain: false,
  };
}

export function claudeToolUse(id: string, name: string, input: unknown, ts: string): Record<string, unknown> {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    timestamp: ts,
    isSidechain: false,
  };
}

export function claudeToolResult(id: string, text: string, ts: string, meta = false): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
    timestamp: ts,
    isMeta: meta,
    isSidechain: false,
  };
}

/* ---------------------------------- codex --------------------------------- */

export function codexSessionMeta(opts: {
  id: string;
  cwd?: string;
  parentThreadId?: string;
  threadSource?: string;
  agentNickname?: string;
  ts?: string;
}): Record<string, unknown> {
  return {
    timestamp: opts.ts ?? "2026-01-10T08:00:00.000Z",
    type: "session_meta",
    payload: {
      id: opts.id,
      cwd: opts.cwd ?? "/tmp/proj-a",
      ...(opts.parentThreadId ? { parent_thread_id: opts.parentThreadId } : {}),
      ...(opts.threadSource ? { thread_source: opts.threadSource } : {}),
      ...(opts.agentNickname ? { agent_nickname: opts.agentNickname } : {}),
    },
  };
}

/* ----------------------------------- kimi ---------------------------------- */

export function kimiIndexLine(sessionId: string, sessionDir: string, workDir: string): Record<string, unknown> {
  return { sessionId, sessionDir, workDir };
}

export function kimiState(overrides: Partial<StateLike> = {}): StateLike {
  return {
    createdAt: "2026-01-12T09:00:00.000Z",
    updatedAt: "2026-01-12T10:00:00.000Z",
    title: "SYNTHETIC_FIXTURE kimi session",
    isCustomTitle: false,
    workDir: "/tmp/proj-a",
    ...overrides,
  };
}

export interface StateLike {
  createdAt?: string;
  updatedAt?: string;
  title?: string;
  isCustomTitle?: boolean;
  workDir?: string;
}
