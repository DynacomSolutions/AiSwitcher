import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSessionFile } from "../../../src/cli/resume/claude-resume.ts";
import { parseRestOfFile } from "../../../src/cli/resume/codex-resume.ts";
import {
  claudeTranscriptFromLines,
  scanAgentFile,
  scanSessionFile,
} from "../../../src/cli/sessions/claude.ts";
import { codexTranscriptFromLines, firstUserMessage } from "../../../src/cli/sessions/codex.ts";
import { fileLines, linesOfText } from "../../../src/cli/sessions/lines.ts";
import { findFirstLine, forEachLine, readFirstLine } from "../../../src/cli/sessions/shared.ts";
import {
  CLAUDE_ENC,
  CODEX_DAY_DIR,
  FRESH,
  NOW,
  claudeAssistantText,
  claudeToolResult,
  claudeToolUse,
  claudeUserLine,
  codexSessionMeta,
  identity,
  makeConfigDir,
  writeJsonl,
} from "./fixtures.ts";

/**
 * The session readers take a LineSource (a path or any line iterable). The
 * same fixture through the file adapter and through an in-memory line
 * iterable must give equal results.
 */

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshDir(prefix: string): Promise<string> {
  const dir = await makeConfigDir(prefix);
  tempDirs.push(dir);
  return dir;
}

async function collect(source: AsyncIterable<string> | Iterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of source) out.push(line);
  return out;
}

/** An async iterable that is not a file and not an array. */
async function* asyncLines(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) {
    await Promise.resolve();
    yield line;
  }
}

const CLAUDE_LINES: Array<Record<string, unknown>> = [
  { type: "mode", mode: "normal", sessionId: "x1" },
  claudeUserLine("/tmp/proj-a", "SYNTHETIC_FIXTURE please run the tests", "2026-01-12T08:00:00.000Z"),
  { type: "ai-title", aiTitle: "Run the tests", sessionId: "x1" },
  claudeToolUse("call1", "Bash", { command: "bun test" }, "2026-01-12T08:00:05.000Z"),
  claudeToolResult("call1", "42 passing", "2026-01-12T08:00:06.000Z", true),
  claudeAssistantText("SYNTHETIC_FIXTURE all green", "2026-01-12T08:00:07.000Z", 120),
];

const CODEX_LINES: Array<Record<string, unknown>> = [
  codexSessionMeta({ id: "t1", threadSource: "user", cwd: "/tmp/proj-a", ts: "2026-01-12T08:00:00.000Z" }),
  {
    timestamp: "2026-01-12T08:00:01.000Z", type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>SYNTHETIC_FIXTURE cwd</environment_context>" }] },
  },
  { timestamp: "2026-01-12T08:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "SYNTHETIC_FIXTURE codex prompt" } },
  {
    timestamp: "2026-01-12T08:00:03.000Z", type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "SYNTHETIC_FIXTURE codex prompt" }] },
  },
  {
    timestamp: "2026-01-12T08:00:04.000Z", type: "response_item",
    payload: { type: "function_call", name: "exec_command", arguments: "{\"cmd\":[\"ls\"]}", call_id: "c1" },
  },
  { timestamp: "2026-01-12T08:00:05.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "file-a" } },
  {
    timestamp: "2026-01-12T08:00:06.000Z", type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "SYNTHETIC_FIXTURE done" }] },
  },
];

const AGENT_LINES: Array<Record<string, unknown>> = [
  { type: "user", agentId: "a1", cwd: "/tmp/proj-a", timestamp: "2026-01-12T08:00:00.000Z", isMeta: true, message: { role: "user", content: "meta" } },
  claudeUserLine("/tmp/proj-a", "SYNTHETIC_FIXTURE agent task prompt", "2026-01-12T08:00:01.000Z"),
  claudeAssistantText("SYNTHETIC_FIXTURE agent answer", "2026-01-12T08:00:02.000Z"),
];

function jsonl(lines: Array<Record<string, unknown>>): string[] {
  return lines.map((l) => JSON.stringify(l));
}

describe("file adapter", () => {
  test("yields the same lines as the text split, including a torn last line", async () => {
    const dir = await freshDir("adapter");
    const path = join(dir, "a.jsonl");
    for (const text of ["", "one\n", "one\ntwo\n", "one\ntwo", "one\n\nthree\n", "é\n日本\n"]) {
      await writeFile(path, text);
      const fromFile = await collect(fileLines(path));
      expect(fromFile).toEqual([...linesOfText(text)]);
    }
  });

  test("keeps lines apart across the stream chunk size", async () => {
    const dir = await freshDir("adapter-big");
    const path = join(dir, "big.jsonl");
    const lines = Array.from({ length: 4000 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(300) }));
    await writeFile(path, lines.join("\n") + "\n");
    expect(await collect(fileLines(path))).toEqual(lines);
  });

  test("forEachLine, findFirstLine and readFirstLine agree for a path, an array and an async iterable", async () => {
    const dir = await freshDir("shared");
    const path = join(dir, "s.jsonl");
    const lines = ["", "alpha", "beta", "gamma"];
    await writeFile(path, lines.join("\n") + "\n");
    const sources = [path, lines, asyncLines(lines)];
    const visited: string[][] = [];
    for (const source of sources) {
      const seen: string[] = [];
      await forEachLine(source, (line) => seen.push(line));
      visited.push(seen);
    }
    expect(visited[0]).toEqual(lines);
    expect(visited[1]).toEqual(lines);
    expect(visited[2]).toEqual(lines);

    for (const source of [path, lines, asyncLines(lines)]) {
      expect(await findFirstLine(source, (line) => line.startsWith("b"))).toBe("beta");
    }
    expect(await findFirstLine(path, () => false)).toBeUndefined();
    expect(await findFirstLine(lines, () => false)).toBeUndefined();
    expect(await readFirstLine(["head", "tail"])).toBe("head");
    expect(await readFirstLine(asyncLines(["head", "tail"]))).toBe("head");
    expect(await readFirstLine([])).toBeUndefined();
    await writeFile(path, "head\ntail\n");
    expect(await readFirstLine(path)).toBe("head");
  });

  test("a source that throws gives undefined for readFirstLine", async () => {
    async function* broken(): AsyncGenerator<string> {
      throw new Error("boom");
      yield "never";
    }
    expect(await readFirstLine(broken())).toBeUndefined();
  });
});

describe("claude readers: file adapter equals in-memory lines", () => {
  test("scanSessionFile", async () => {
    const dir = await freshDir("claude-scan");
    const path = join(dir, "x1.jsonl");
    await writeJsonl(path, CLAUDE_LINES);
    const fromFile = await scanSessionFile(path);
    expect(await scanSessionFile(jsonl(CLAUDE_LINES))).toEqual(fromFile);
    expect(await scanSessionFile(asyncLines(jsonl(CLAUDE_LINES)))).toEqual(fromFile);
    expect(fromFile.aiTitle).toBe("Run the tests");
    expect(fromFile.messageCount).toBe(4);
  });

  test("scanAgentFile reads header and task prompt in one pass", async () => {
    const dir = await freshDir("claude-agent");
    const path = join(dir, "agent-a1.jsonl");
    await writeJsonl(path, AGENT_LINES);
    const fromFile = await scanAgentFile(path);
    expect(await scanAgentFile(jsonl(AGENT_LINES))).toEqual(fromFile);
    expect(await scanAgentFile(asyncLines(jsonl(AGENT_LINES)))).toEqual(fromFile);
    expect(fromFile.agentId).toBe("a1");
    expect(fromFile.cwd).toBe("/tmp/proj-a");
    expect(fromFile.firstUser).toBe("SYNTHETIC_FIXTURE agent task prompt");
  });

  test("claudeTranscriptFromLines", async () => {
    const dir = await freshDir("claude-transcript");
    const path = join(dir, "projects", CLAUDE_ENC, "x1.jsonl");
    await writeJsonl(path, CLAUDE_LINES, FRESH);
    const ident = identity(dir);
    const opts = { now: NOW, tail: 500 };
    const mtime = async () => FRESH;
    const fromFile = await claudeTranscriptFromLines(ident, "x1", path, mtime, opts);
    expect(await claudeTranscriptFromLines(ident, "x1", jsonl(CLAUDE_LINES), mtime, opts)).toEqual(fromFile);
    expect(await claudeTranscriptFromLines(ident, "x1", asyncLines(jsonl(CLAUDE_LINES)), mtime, opts)).toEqual(fromFile);
    expect(fromFile.totalTurns).toBe(3);
    expect(fromFile.inProgress).toBe(true);
  });

  test("resume parseSessionFile", async () => {
    const dir = await freshDir("claude-resume");
    const path = join(dir, "x1.jsonl");
    await writeJsonl(path, CLAUDE_LINES);
    const fromFile = await parseSessionFile(path);
    expect(await parseSessionFile(jsonl(CLAUDE_LINES))).toEqual(fromFile);
    expect(await parseSessionFile(asyncLines(jsonl(CLAUDE_LINES)))).toEqual(fromFile);
    expect(fromFile.aiTitle).toBe("Run the tests");
    expect(fromFile.cwd).toBe("/tmp/proj-a");
  });
});

describe("codex readers: file adapter equals in-memory lines", () => {
  test("codexTranscriptFromLines", async () => {
    const dir = await freshDir("codex-transcript");
    const path = join(dir, "sessions", CODEX_DAY_DIR, "rollout-1-t1.jsonl");
    await writeJsonl(path, CODEX_LINES, FRESH);
    const ident = identity(dir);
    const opts = { now: NOW, tail: 500 };
    const mtime = async () => FRESH;
    const fromFile = await codexTranscriptFromLines(ident, "t1", path, mtime, opts);
    expect(await codexTranscriptFromLines(ident, "t1", jsonl(CODEX_LINES), mtime, opts)).toEqual(fromFile);
    expect(await codexTranscriptFromLines(ident, "t1", asyncLines(jsonl(CODEX_LINES)), mtime, opts)).toEqual(fromFile);
    expect(fromFile.session.cwd).toBe("/tmp/proj-a");
    expect(fromFile.totalTurns).toBe(3);
  });

  test("session_meta on a later line is still found", async () => {
    const dir = await freshDir("codex-late-meta");
    const lines = [{ timestamp: "2026-01-12T07:59:00.000Z", type: "turn_context", payload: {} }, ...CODEX_LINES];
    const path = join(dir, "r.jsonl");
    await writeJsonl(path, lines, FRESH);
    const ident = identity(dir);
    const mtime = async () => undefined;
    const fromFile = await codexTranscriptFromLines(ident, "t1", path, mtime, { now: NOW });
    expect(await codexTranscriptFromLines(ident, "t1", jsonl(lines), mtime, { now: NOW })).toEqual(fromFile);
    expect(fromFile.session.cwd).toBe("/tmp/proj-a");
  });

  test("firstUserMessage", async () => {
    const dir = await freshDir("codex-first");
    const path = join(dir, "r.jsonl");
    await writeJsonl(path, CODEX_LINES);
    expect(await firstUserMessage(path)).toBe("SYNTHETIC_FIXTURE codex prompt");
    expect(await firstUserMessage(jsonl(CODEX_LINES))).toBe("SYNTHETIC_FIXTURE codex prompt");
    expect(await firstUserMessage(asyncLines(jsonl(CODEX_LINES)))).toBe("SYNTHETIC_FIXTURE codex prompt");
  });

  test("resume parseRestOfFile", async () => {
    const dir = await freshDir("codex-resume");
    const path = join(dir, "r.jsonl");
    await mkdir(dir, { recursive: true });
    await writeJsonl(path, CODEX_LINES);
    const fromFile = await parseRestOfFile(path);
    expect(await parseRestOfFile(jsonl(CODEX_LINES))).toEqual(fromFile);
    expect(await parseRestOfFile(asyncLines(jsonl(CODEX_LINES)))).toEqual(fromFile);
    expect(fromFile.label).toBe("SYNTHETIC_FIXTURE codex prompt");
    expect(fromFile.lastTimestamp).toBe("2026-01-12T08:00:06.000Z");
  });
});
