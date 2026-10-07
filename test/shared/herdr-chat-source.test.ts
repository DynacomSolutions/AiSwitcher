import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readHerdrChatTitle } from "../../src/shared/herdr-chat-source.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ais-herdr-title-"));
  roots.push(root);
  return root;
}

function binding(agent: string, value: string, kind: "id" | "path" = "id") {
  return { agent, kind, value } as const;
}

describe("readHerdrChatTitle", () => {
  test("reads the exact Claude session tail and skips synthetic/short prompts", async () => {
    const config = await fixture();
    const dir = join(config, "projects", "-tmp-project");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "claude-id.jsonl"), [
      JSON.stringify({ type: "user", message: { content: "SYNTHETIC_FIXTURE update the account settings screen" } }),
      JSON.stringify({ type: "user", message: { content: "yes" } }),
      JSON.stringify({ type: "user", message: { content: "SYNTHETIC_FIXTURE fix the account settings screen layout" } }),
    ].join("\n"));
    expect(await readHerdrChatTitle("claude", config, "/tmp/project", binding("claude", "claude-id"))).toBe("SYNTHETIC_FIXTURE update the account settings screen");
  });

  async function claudeTitle(rows: unknown[]): Promise<string | null> {
    const config = await fixture();
    const dir = join(config, "projects", "-tmp-project");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "claude-id.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));
    return readHerdrChatTitle("claude", config, "/tmp/project", binding("claude", "claude-id"));
  }
  const human = (text: string) => ({ type: "user", origin: { kind: "human" }, promptSource: "typed", message: { content: text } });

  test("Claude ignores task-notification rows", async () => {
    expect(await claudeTitle([
      human("SYNTHETIC_FIXTURE refactor the billing module"),
      { type: "user", origin: { kind: "task-notification" }, promptSource: "system", message: { content: "<task-notification>\n<task-id>bimc2nhpm</task-id>\n<tool-use-id>toolu_01U4</tool-use-id>\n<output-file>/tmp/x</output-file>" } },
      { type: "user", message: { content: "<task-notification>\n<task-id>abc</task-id>" } },
    ])).toBe("SYNTHETIC_FIXTURE refactor the billing module");
  });

  test("Claude ignores command, bash and local-command rows", async () => {
    expect(await claudeTitle([
      human("SYNTHETIC_FIXTURE refactor the billing module"),
      { type: "user", message: { content: "<command-message>deploy</command-message>\n<command-name>/deploy</command-name>" } },
      { type: "user", message: { content: "<bash-input>ls -la /srv</bash-input>" } },
      { type: "user", message: { content: "<bash-stdout>total 4</bash-stdout><bash-stderr></bash-stderr>" } },
      { type: "user", message: { content: "<local-command-stdout>done it</local-command-stdout>" } },
      { type: "user", message: { content: "<system-reminder>remember things</system-reminder>" } },
    ])).toBe("SYNTHETIC_FIXTURE refactor the billing module");
  });

  test("Claude prefers the newest ai-title over a later human prompt", async () => {
    expect(await claudeTitle([
      human("SYNTHETIC_FIXTURE first real prompt here"),
      { type: "ai-title", aiTitle: "Old generated title" },
      { type: "ai-title", aiTitle: "Newest generated title" },
      human("SYNTHETIC_FIXTURE etas? hurry up please"),
    ])).toBe("Newest generated title");
  });

  test("Claude falls back to the first human prompt when no ai-title exists", async () => {
    expect(await claudeTitle([
      human("SYNTHETIC_FIXTURE first real prompt here"),
      human("SYNTHETIC_FIXTURE etas? hurry up please"),
    ])).toBe("SYNTHETIC_FIXTURE first real prompt here");
  });

  test("uses only the matching Codex rollout and ignores environment injection", async () => {
    const config = await fixture();
    const dir = join(config, "sessions", "2026", "10", "06");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "000-unrelated.txt"), "not a rollout");
    await writeFile(join(dir, "rollout-20261006-SYNTHETIC_FIXTURE-codex-id.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "SYNTHETIC_FIXTURE-codex-id" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>hidden synthetic context" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "SYNTHETIC_FIXTURE explain the build failure clearly" }] } }),
    ].join("\n"));
    expect(await readHerdrChatTitle("codex", config, "/tmp/project", binding("codex", "SYNTHETIC_FIXTURE-codex-id"))).toBe("SYNTHETIC_FIXTURE explain the build failure clearly");
  });

  test("reads Grok chat history and prefers the latest meaningful prompt", async () => {
    const config = await fixture();
    const dir = join(config, "sessions", encodeURIComponent("/tmp/project"), "grok-id");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "summary.json"), JSON.stringify({ session_summary: "SYNTHETIC_FIXTURE native Grok session title" }));
    await writeFile(join(dir, "chat_history.jsonl"), JSON.stringify({ type: "user", content: "SYNTHETIC_FIXTURE a recent user prompt worth showing" }));
    expect(await readHerdrChatTitle("grok", config, "/tmp/project", binding("grok", "grok-id"))).toBe("SYNTHETIC_FIXTURE a recent user prompt worth showing");
  });

  test("reads Kimi's exact indexed wire and ignores system-trigger prompts", async () => {
    const config = await fixture();
    const dir = join(config, "sessions", "wd_project", "kimi-id");
    await mkdir(join(dir, "agents", "main"), { recursive: true });
    await writeFile(join(config, "session_index.jsonl"), JSON.stringify({ sessionId: "kimi-id", sessionDir: dir, workDir: "/tmp/project" }));
    await writeFile(join(dir, "state.json"), JSON.stringify({ title: "New Session" }));
    await writeFile(join(dir, "agents", "main", "wire.jsonl"), [
      JSON.stringify({ type: "turn.prompt", origin: { kind: "system_trigger" }, input: [{ type: "text", text: "SYNTHETIC_FIXTURE internal spawn task prompt" }] }),
      JSON.stringify({ type: "turn.prompt", input: [{ type: "text", text: "SYNTHETIC_FIXTURE investigate the slow startup path" }] }),
    ].join("\n"));
    expect(await readHerdrChatTitle("kimi", config, "/tmp/project", binding("kimi", "kimi-id"))).toBe("SYNTHETIC_FIXTURE investigate the slow startup path");
  });

  test("accepts Herdr's Crush alias and reads its exact provider-owned SQLite session", async () => {
    const config = await fixture();
    const dataDir = join(config, "project-data");
    await mkdir(join(config, "data"), { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(config, "data", "projects.json"), JSON.stringify({ projects: [{ path: "/tmp/project", data_dir: dataDir }] }));
    const db = new Database(join(dataDir, "crush.db"));
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE messages (session_id TEXT, provider TEXT, role TEXT, parts TEXT, created_at INTEGER)");
    db.query("INSERT INTO sessions VALUES (?, ?)").run("SYNTHETIC_FIXTURE-crush-id", "Untitled Session");
    db.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?)").run("SYNTHETIC_FIXTURE-crush-id", null, "user", JSON.stringify([{ type: "text", data: { text: "SYNTHETIC_FIXTURE improve the search results panel" } }]), 10);
    db.query("INSERT INTO messages VALUES (?, ?, ?, ?, ?)").run("SYNTHETIC_FIXTURE-crush-id", "zai", "assistant", "[]", 11);
    db.close();
    expect(await readHerdrChatTitle("zai", config, "/tmp/project", binding("crush", "SYNTHETIC_FIXTURE-crush-id"))).toBe("SYNTHETIC_FIXTURE improve the search results panel");
    expect(await readHerdrChatTitle("ali", config, "/tmp/project", binding("crush", "SYNTHETIC_FIXTURE-crush-id"))).toBeNull();
  });

  test("reads the installed OpenCode message and text-part schema by exact session id", async () => {
    const config = await fixture();
    const dbPath = join(config, "data", "opencode", "opencode.db");
    await mkdir(join(config, "data", "opencode"), { recursive: true });
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
    db.query("INSERT INTO session VALUES (?, ?)").run("SYNTHETIC_FIXTURE-opencode-id", "SYNTHETIC_FIXTURE Review the new settings flow");
    db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("message-1", "SYNTHETIC_FIXTURE-opencode-id", 10, 10, JSON.stringify({ role: "user" }));
    db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("part-1", "message-1", "SYNTHETIC_FIXTURE-opencode-id", 10, 10, JSON.stringify({ type: "text", text: "SYNTHETIC_FIXTURE explain the latest settings issue" }));
    db.close();
    expect(await readHerdrChatTitle("opencode", config, "/tmp/project", binding("opencode", "SYNTHETIC_FIXTURE-opencode-id"))).toBe("SYNTHETIC_FIXTURE explain the latest settings issue");
  });

  test("re-reads a changed exact OpenCode source so the topic can evolve", async () => {
    const config = await fixture();
    const dbPath = join(config, "data", "opencode", "opencode.db");
    await mkdir(join(config, "data", "opencode"), { recursive: true });
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)");
    db.query("INSERT INTO session VALUES (?, ?)").run("SYNTHETIC_FIXTURE-opencode-changing", "SYNTHETIC_FIXTURE static generated title");
    db.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("message-1", "SYNTHETIC_FIXTURE-opencode-changing", 10, 10, JSON.stringify({ role: "user" }));
    db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("part-1", "message-1", "SYNTHETIC_FIXTURE-opencode-changing", 10, 10, JSON.stringify({ type: "text", text: "SYNTHETIC_FIXTURE first user topic" }));
    db.close();
    const session = binding("opencode", "SYNTHETIC_FIXTURE-opencode-changing");
    expect(await readHerdrChatTitle("opencode", config, "/tmp/project", session)).toBe("SYNTHETIC_FIXTURE first user topic");
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    const update = new Database(dbPath);
    update.query("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("message-2", "SYNTHETIC_FIXTURE-opencode-changing", 20, 20, JSON.stringify({ role: "user" }));
    update.query("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run("part-2", "message-2", "SYNTHETIC_FIXTURE-opencode-changing", 20, 20, JSON.stringify({ type: "text", text: "SYNTHETIC_FIXTURE second, newer user topic" }));
    update.close();
    expect(await readHerdrChatTitle("opencode", config, "/tmp/project", session)).toBe("SYNTHETIC_FIXTURE second, newer user topic");
  });

  test("supports an explicit session file path and refuses an agent mismatch", async () => {
    const config = await fixture();
    const path = join(config, "chat.jsonl");
    await writeFile(path, JSON.stringify({ type: "user", message: { content: "SYNTHETIC_FIXTURE repair this exact pane session" } }));
    expect(await readHerdrChatTitle("claude", config, "/tmp/project", binding("claude", path, "path"))).toBe("SYNTHETIC_FIXTURE repair this exact pane session");
    expect(await readHerdrChatTitle("claude", config, "/tmp/project", binding("codex", path, "path"))).toBeNull();
  });
});
