import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CliUsageError } from "../../../src/cli/errors.ts";
import { readTranscript } from "../../../src/cli/sessions/transcript.ts";
import type { TranscriptTurnDto } from "../../../src/cli/sessions/types.ts";
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
  kimiIndexLine,
  kimiState,
  makeConfigDir,
  writeJson,
  writeJsonl,
} from "./fixtures.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshDir(prefix: string): Promise<string> {
  const dir = await makeConfigDir(prefix);
  tempDirs.push(dir);
  return dir;
}

const OPTS = { now: NOW, tail: 500 };

function texts(turns: TranscriptTurnDto[]): string[] {
  return turns.map((t) => t.text);
}

/* --------------------------------- claude --------------------------------- */

describe("claude transcript", () => {
  async function writeClaudeSession(configDir: string, sessionId: string, lines: Array<Record<string, unknown>>): Promise<void> {
    await writeJsonl(join(configDir, "projects", CLAUDE_ENC, `${sessionId}.jsonl`), lines, FRESH);
  }

  test("normalizes user/assistant/tool turns and fills tool results", async () => {
    const configDir = await freshDir("claude-x");
    await writeClaudeSession(configDir, "x1", [
      { type: "mode", mode: "normal", sessionId: "x1" }, // bookkeeping: skipped
      claudeUserLine("/tmp/proj-a", "SYNTHETIC_FIXTURE please run the tests", "2026-01-12T08:00:00.000Z"),
      { type: "ai-title", aiTitle: "Run the tests", sessionId: "x1" },
      claudeToolUse("call1", "Bash", { command: "bun test" }, "2026-01-12T08:00:05.000Z"),
      claudeToolResult("call1", "42 passing", "2026-01-12T08:00:06.000Z", true),
      claudeAssistantText("SYNTHETIC_FIXTURE all green", "2026-01-12T08:00:07.000Z", 120),
    ]);
    const dto = await readTranscript("claude", identity(configDir), "x1", OPTS);
    expect(dto).toBeDefined();
    expect(dto!.session.title).toBe("Run the tests");
    expect(dto!.session.cwd).toBe("/tmp/proj-a");
    // user prompt, tool_use (result fills the same turn), assistant text.
    // The isMeta tool_result line and the bookkeeping lines are not turns.
    expect(dto!.totalTurns).toBe(3);
    expect(dto!.turns.map((t) => t.role)).toEqual(["user", "tool", "assistant"]);
    const toolTurn = dto!.turns[1]!;
    expect(toolTurn.toolName).toBe("Bash");
    expect(toolTurn.argsPreview).toContain("bun test");
    expect(toolTurn.text).toBe("42 passing"); // filled from the isMeta tool_result
    const assistant = dto!.turns[2]!;
    expect(assistant.tokens).toBe(120);
    expect(assistant.atMs).toBe(Date.parse("2026-01-12T08:00:07.000Z"));
  });

  test("tail keeps the LAST turns and reports honest totals", async () => {
    const configDir = await freshDir("claude-tail");
    const lines = [
      claudeUserLine("/tmp/proj-a", "one", "2026-01-12T08:00:00.000Z"),
      claudeAssistantText("two", "2026-01-12T08:00:01.000Z"),
      claudeUserLine("/tmp/proj-a", "three", "2026-01-12T08:00:02.000Z"),
      claudeAssistantText("four", "2026-01-12T08:00:03.000Z"),
    ];
    await writeClaudeSession(configDir, "x2", lines);
    const dto = await readTranscript("claude", identity(configDir), "x2", { now: NOW, tail: 2 });
    expect(dto!.totalTurns).toBe(4);
    expect(dto!.turns).toHaveLength(2);
    expect(dto!.truncated).toBe(true);
    expect(texts(dto!.turns)).toEqual(["three", "four"]);
  });

  test("meta user lines are skipped entirely (not turns)", async () => {
    const configDir = await freshDir("claude-meta");
    await writeClaudeSession(configDir, "x3", [
      claudeUserLine("/tmp/proj-a", "<command-name>/clear</command-name>", "2026-01-12T08:00:00.000Z", { isMeta: true }),
      claudeUserLine("/tmp/proj-a", "SYNTHETIC_FIXTURE real prompt", "2026-01-12T08:00:01.000Z"),
    ]);
    const dto = await readTranscript("claude", identity(configDir), "x3", OPTS);
    expect(dto!.totalTurns).toBe(1);
    expect(dto!.turns[0]!.role).toBe("user");
  });

  test("subagent ids resolve to the sidecar file; unknown ids are undefined", async () => {
    const configDir = await freshDir("claude-agent");
    await writeJsonl(join(configDir, "projects", CLAUDE_ENC, "p1", "subagents", "agent-ag1.jsonl"), [
      { type: "user", message: { role: "user", content: "SYNTHETIC_FIXTURE agent task" }, agentId: "ag1", sessionId: "p1", cwd: "/tmp/proj-a", timestamp: "2026-01-12T08:00:00.000Z", isSidechain: true, isMeta: false },
    ], FRESH);
    const dto = await readTranscript("claude", identity(configDir), "p1/ag1", OPTS);
    expect(dto).toBeDefined();
    expect(dto!.totalTurns).toBe(1);
    expect(await readTranscript("claude", identity(configDir), "nope", OPTS)).toBeUndefined();
  });
});

/* ---------------------------------- codex ---------------------------------- */

describe("codex transcript", () => {
  test("response_item turns, environment_context skip, function call/output fill", async () => {
    const configDir = await freshDir("codex-x");
    await writeJsonl(join(configDir, "sessions", CODEX_DAY_DIR, "rollout-1-t1.jsonl"), [
      codexSessionMeta({ id: "t1", threadSource: "user", cwd: "/tmp/proj-a", ts: "2026-01-12T08:00:00.000Z" }),
      {
        timestamp: "2026-01-12T08:00:01.000Z", type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>SYNTHETIC_FIXTURE cwd stuff</environment_context>" }] },
      },
      {
        timestamp: "2026-01-12T08:00:02.000Z", type: "event_msg",
        payload: { type: "user_message", message: "SYNTHETIC_FIXTURE codex prompt" },
      },
      {
        timestamp: "2026-01-12T08:00:03.000Z", type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "SYNTHETIC_FIXTURE codex prompt" }] },
      },
      {
        timestamp: "2026-01-12T08:00:04.000Z", type: "response_item",
        payload: { type: "function_call", name: "exec_command", arguments: "{\"cmd\":[\"ls\"]}", call_id: "c1" },
      },
      {
        timestamp: "2026-01-12T08:00:05.000Z", type: "response_item",
        payload: { type: "function_call_output", call_id: "c1", output: "file-a" },
      },
      {
        timestamp: "2026-01-12T08:00:06.000Z", type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "SYNTHETIC_FIXTURE done" }] },
      },
    ], FRESH);
    const dto = await readTranscript("codex", identity(configDir), "t1", OPTS);
    expect(dto).toBeDefined();
    expect(dto!.session.title).toContain("codex prompt");
    // user prompt, function_call (result fills it), assistant answer; the
    // environment_context line and the event_msg duplicate are not turns.
    expect(dto!.totalTurns).toBe(3);
    expect(dto!.turns.map((t) => t.role)).toEqual(["user", "tool", "assistant"]);
    expect(dto!.turns[1]!.text).toBe("file-a");
    expect(dto!.inProgress).toBe(true);
  });
});

/* ------------------------------------ pi ----------------------------------- */

describe("pi transcript", () => {
  test("message entries become turns; toolCall/toolResult pair fills", async () => {
    const configDir = await freshDir("pi-x");
    await writeJsonl(join(configDir, "sessions", "-tmp-proj-a", "2026-01-12T09-00-00-000Z_p1.jsonl"), [
      { type: "session", version: 3, id: "p1", timestamp: "2026-01-12T09:00:00.000Z", cwd: "/tmp/proj-a" },
      { type: "message", timestamp: "2026-01-12T09:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "SYNTHETIC_FIXTURE pi prompt" }] } },
      {
        type: "message", timestamp: "2026-01-12T09:00:02.000Z",
        message: {
          role: "assistant", content: [
            { type: "think", think: "SYNTHETIC_FIXTURE hidden reasoning" },
            { type: "toolCall", id: "pc1", name: "read", arguments: { path: "/tmp/x" } },
            { type: "text", text: "SYNTHETIC_FIXTURE pi answer" },
          ],
          usage: { input: 90, output: 30 },
        },
      },
      { type: "message", timestamp: "2026-01-12T09:00:03.000Z", message: { role: "toolResult", toolCallId: "pc1", toolName: "read", content: [{ type: "text", text: "SYNTHETIC_FIXTURE file body" }] } },
    ]);
    const dto = await readTranscript("pi", identity(configDir), "p1", OPTS);
    expect(dto).toBeDefined();
    expect(dto!.totalTurns).toBe(3); // think block contributes no turn
    expect(dto!.turns.map((t) => t.role)).toEqual(["user", "tool", "assistant"]);
    const toolTurn = dto!.turns[1]!;
    expect(toolTurn.toolName).toBe("read");
    expect(toolTurn.text).toContain("file body");
    const assistant = dto!.turns[2]!;
    expect(assistant.tokens).toBe(120); // input 90 + output 30
    expect(texts(dto!.turns)).not.toContain("SYNTHETIC_FIXTURE hidden reasoning");
  });
});

/* ----------------------------------- grok ---------------------------------- */

describe("grok transcript", () => {
  test("system/user/assistant + tool_calls/tool_result fill; no timestamps", async () => {
    const configDir = await freshDir("grok-x");
    const sessionDir = join(configDir, "sessions", "%2Ftmp%2Fproj-a", "g1");
    await writeJson(join(sessionDir, "summary.json"), { info: { id: "g1", cwd: "/tmp/proj-a" }, created_at: "2026-01-12T09:00:00.000Z" });
    await writeJsonl(join(sessionDir, "chat_history.jsonl"), [
      { type: "system", content: "SYNTHETIC_FIXTURE grok system" },
      { type: "user", content: [{ type: "text", text: "SYNTHETIC_FIXTURE grok prompt" }] },
      { type: "assistant", content: "", tool_calls: [{ id: "gc1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"x\"}" } }] },
      { type: "tool_result", tool_call_id: "gc1", content: "SYNTHETIC_FIXTURE grok result" },
      { type: "assistant", content: "SYNTHETIC_FIXTURE grok answer" },
      { type: "reasoning", content: null },
    ], FRESH);
    const dto = await readTranscript("grok", identity(configDir), "g1", OPTS);
    expect(dto).toBeDefined();
    // system, user, tool (call + result merged), assistant answer; the
    // empty-content assistant line only carries the tool_calls, the result
    // line only fills, reasoning has no content.
    expect(dto!.totalTurns).toBe(4);
    expect(dto!.turns.map((t) => t.role)).toEqual(["system", "user", "tool", "assistant"]);
    const toolTurn = dto!.turns[2]!;
    expect(toolTurn.toolName).toBe("read_file");
    expect(toolTurn.text).toContain("grok result");
    expect(dto!.turns.every((t) => t.atMs === undefined)).toBe(true); // grok records none
  });
});

/* ----------------------------------- kimi ---------------------------------- */

describe("kimi transcript", () => {
  test("wire events become turns; agent namespaces resolve; tool pairs fill", async () => {
    const configDir = await freshDir("kimi-x");
    const sessionDir = join(configDir, "sessions", "wd_proj_1", "session_k1");
    await writeJson(join(sessionDir, "state.json"), kimiState());
    await writeJsonl(join(configDir, "session_index.jsonl"), [kimiIndexLine("session_k1", sessionDir, "/tmp/proj-a")]);
    await writeJsonl(join(sessionDir, "agents", "main", "wire.jsonl"), [
      { type: "metadata", protocol_version: "1.5", created_at: "1768218000000" },
      { type: "turn.prompt", input: [{ type: "text", text: "SYNTHETIC_FIXTURE kimi prompt" }], origin: { kind: "user" }, time: "1768218001000" },
      { type: "context.append_loop_event", event: { type: "content.part", part: { type: "think", think: "SYNTHETIC_FIXTURE hidden" } } },
      { type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "SYNTHETIC_FIXTURE kimi says" } } },
      { type: "context.append_loop_event", event: { type: "tool.call", toolCallId: "kc1", name: "Bash", args: { command: "ls" } } },
      { type: "context.append_loop_event", event: { type: "tool.result", toolCallId: "kc1", result: { output: "SYNTHETIC_FIXTURE kimi output" } } },
    ]);
    const dto = await readTranscript("kimi", identity(configDir), "session_k1", OPTS);
    expect(dto).toBeDefined();
    // user prompt, assistant text part, tool.call (result fills it); the
    // think part contributes nothing.
    expect(dto!.totalTurns).toBe(3);
    expect(dto!.turns.map((t) => t.role)).toEqual(["user", "assistant", "tool"]);
    expect(dto!.turns[2]!.text).toContain("kimi output");
    const kid = await readTranscript("kimi", identity(configDir), "session_k1/agent-0", OPTS);
    expect(kid).toBeUndefined(); // no agent-0 wire written in this fixture
  });
});

/* ------------------------------- crush (zai) ------------------------------- */

describe("crush transcript (zai)", () => {
  async function writeCrushTranscriptDb(): Promise<string> {
    const configDir = await freshDir("crush-x");
    const dataDir = join(configDir, "data", "proj-one");
    await mkdir(dataDir, { recursive: true });
    const db = new Database(join(dataDir, "crush.db"));
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL)");
    db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '[]', provider TEXT, created_at INTEGER NOT NULL)");
    const nowS = Math.floor(NOW / 1000);
    db.prepare("INSERT INTO sessions VALUES ($id, $p, $t, $mc, $u, $c)").run({ $id: "cs1", $p: null, $t: "SYNTHETIC_FIXTURE crush title", $mc: 3, $u: nowS, $c: nowS });
    const ins = db.prepare("INSERT INTO messages VALUES ($id, $s, $r, $parts, $prov, $ts)");
    ins.run({ $id: "cm1", $s: "cs1", $r: "user", $parts: JSON.stringify([{ type: "text", data: { text: "SYNTHETIC_FIXTURE crush prompt" } }]), $prov: "zai", $ts: nowS - 30 });
    ins.run({
      $id: "cm2", $s: "cs1", $r: "assistant",
      $parts: JSON.stringify([
        { type: "reasoning", data: { thinking: "SYNTHETIC_FIXTURE hidden" } },
        { type: "tool_call", data: { id: "call_9", name: "bash", input: "{\"command\":\"ls\"}" } },
      ]),
      $prov: "zai", $ts: nowS - 20,
    });
    ins.run({ $id: "cm3", $s: "cs1", $r: "tool", $parts: JSON.stringify([{ type: "tool_result", data: { tool_call_id: "call_9", content: "SYNTHETIC_FIXTURE crush result" } }]), $prov: null, $ts: nowS - 10 });
    db.close();
    await writeJson(join(configDir, "data", "projects.json"), {
      projects: [{ path: "/tmp/proj-a", data_dir: dataDir, last_accessed: "2026-01-12T09:00:00.000Z" }],
    });
    return configDir;
  }

  test("parts normalize with tool_call/tool_result fill", async () => {
    const configDir = await writeCrushTranscriptDb();
    const dto = await readTranscript("zai", identity(configDir), "cs1", OPTS);
    expect(dto).toBeDefined();
    expect(dto!.session.title).toContain("crush title");
    expect(dto!.session.cwd).toBe("/tmp/proj-a");
    // user text, tool_call (result filled from the tool row); the reasoning
    // part contributes nothing and the tool_result row only fills.
    expect(dto!.totalTurns).toBe(2);
    expect(dto!.turns.map((t) => t.role)).toEqual(["user", "tool"]);
    expect(dto!.turns[1]!.toolName).toBe("bash");
    expect(dto!.turns[1]!.text).toContain("crush result");
    expect(texts(dto!.turns)).not.toContain("SYNTHETIC_FIXTURE hidden");
  });
});

/* ------------------------------- dispatcher -------------------------------- */

describe("readTranscript dispatch", () => {
  test("unknown tool is a 400-shaped usage error; unknown session is undefined", async () => {
    const configDir = await freshDir("dispatch");
    expect(readTranscript("opencode", identity(configDir), "x", OPTS)).rejects.toBeInstanceOf(CliUsageError);
    expect(await readTranscript("claude", identity(configDir), "missing", OPTS)).toBeUndefined();
  });
});
