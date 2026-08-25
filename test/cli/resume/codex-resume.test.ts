import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexSessions } from "../../../src/cli/resume/codex-resume.ts";
import type { Identity } from "../../../src/identities/types.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-codex-resume-test-"));
  tempDirs.push(dir);
  return dir;
}

function identity(configDir: string): Identity {
  return { name: "personal", label: "Personal", configDir };
}

const TARGET_CWD = "/Users/t/Projects/AiProfileSwitcher";

async function writeRollout(
  configDir: string,
  relativePath: string,
  lines: Record<string, unknown>[],
): Promise<void> {
  const filePath = join(configDir, "sessions", relativePath);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, lines.map((l) => JSON.stringify(l)).join("\n"));
}

function sessionMeta(id: string, cwd: string, extra: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-07-15T00:00:00.000Z",
    type: "session_meta",
    payload: { session_id: id, id, cwd, thread_source: "user", ...extra },
  };
}

function userMessage(text: string, timestamp: string) {
  return { timestamp, type: "event_msg", payload: { type: "user_message", message: text } };
}

describe("readCodexSessions", () => {
  test("no sessions directory at all yields an empty, error-free result", async () => {
    const configDir = await makeConfigDir();
    const result = await readCodexSessions(identity(configDir), TARGET_CWD);
    expect(result).toEqual({ toolName: "codex", identity: identity(configDir), sessions: [] });
  });

  test("finds a top-level user session nested under sessions/YYYY/MM/DD/, using the first user_message as the label", async () => {
    const configDir = await makeConfigDir();
    await writeRollout(configDir, "2026/07/15/rollout-abc.jsonl", [
      sessionMeta("id-1", TARGET_CWD),
      userMessage("  fix   the bug  ", "2026-07-15T00:05:00.000Z"),
    ]);

    const result = await readCodexSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ sessionId: "id-1", label: "fix the bug", lastActiveAt: "2026-07-15T00:05:00.000Z" });
  });

  test("excludes a subagent thread (has a parent_thread_id) even though it shares the same cwd", async () => {
    const configDir = await makeConfigDir();
    await writeRollout(configDir, "2026/07/15/rollout-guardian.jsonl", [
      sessionMeta("guardian-1", TARGET_CWD, { thread_source: "subagent", parent_thread_id: "id-1" }),
      userMessage("internal safety check", "2026-07-15T00:05:00.000Z"),
    ]);

    const result = await readCodexSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toEqual([]);
  });

  test("includes a session with no thread_source field at all (pre-dates codex stamping that field), not just an explicit 'user'", async () => {
    const configDir = await makeConfigDir();
    await writeRollout(configDir, "2026/07/15/rollout-legacy.jsonl", [
      { timestamp: "2026-07-15T00:00:00.000Z", type: "session_meta", payload: { session_id: "legacy-1", id: "legacy-1", cwd: TARGET_CWD } },
      userMessage("fix the bug", "2026-07-15T00:05:00.000Z"),
    ]);

    const result = await readCodexSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe("legacy-1");
  });

  test("still excludes a subagent thread that has no thread_source field either, as long as it carries a parent_thread_id", async () => {
    const configDir = await makeConfigDir();
    await writeRollout(configDir, "2026/07/15/rollout-legacy-guardian.jsonl", [
      { timestamp: "2026-07-15T00:00:00.000Z", type: "session_meta", payload: { session_id: "legacy-guardian-1", id: "legacy-guardian-1", cwd: TARGET_CWD, parent_thread_id: "legacy-1" } },
    ]);

    const result = await readCodexSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toEqual([]);
  });

  test("excludes a rollout whose recorded cwd doesn't match, without needing a user_message line", async () => {
    const configDir = await makeConfigDir();
    await writeRollout(configDir, "2026/07/15/rollout-other.jsonl", [sessionMeta("id-2", "/Users/t/Projects/Other")]);

    const result = await readCodexSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toEqual([]);
  });

  test("uses an explicit session cwd correction without modifying the rollout", async () => {
    const configDir = await makeConfigDir();
    await writeRollout(configDir, "2026/07/15/rollout-restored.jsonl", [
      sessionMeta("restored-1", "/Users/t/Projects"),
      userMessage("continue restored work", "2026-07-15T00:05:00.000Z"),
    ]);

    const result = await readCodexSessions(identity(configDir), TARGET_CWD, { "restored-1": TARGET_CWD });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ sessionId: "restored-1", cwd: TARGET_CWD });
  });

  test("does not leak a corrected session into its originally recorded cwd", async () => {
    const configDir = await makeConfigDir();
    const recordedCwd = "/Users/t/Projects";
    await writeRollout(configDir, "2026/07/15/rollout-restored.jsonl", [sessionMeta("restored-1", recordedCwd)]);

    const result = await readCodexSessions(identity(configDir), recordedCwd, { "restored-1": TARGET_CWD });
    expect(result.sessions).toEqual([]);
  });

  test("archived_sessions/ is never scanned", async () => {
    const configDir = await makeConfigDir();
    const archivedPath = join(configDir, "archived_sessions", "rollout-old.jsonl");
    await mkdir(join(archivedPath, ".."), { recursive: true });
    await writeFile(archivedPath, JSON.stringify(sessionMeta("id-3", TARGET_CWD)));

    const result = await readCodexSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toEqual([]);
  });

  test("falls back to '(no user message)' when no user_message event is present", async () => {
    const configDir = await makeConfigDir();
    await writeRollout(configDir, "2026/07/15/rollout-empty.jsonl", [sessionMeta("id-4", TARGET_CWD)]);

    const result = await readCodexSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions[0]?.label).toBe("(no user message)");
  });

  test("falls back to the file's mtime for lastActiveAt when no line carries a timestamp", async () => {
    const configDir = await makeConfigDir();
    const filePath = join(configDir, "sessions", "2026", "07", "15", "rollout-no-ts.jsonl");
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ type: "session_meta", payload: { session_id: "id-5", id: "id-5", cwd: TARGET_CWD, thread_source: "user" } }),
    );

    const result = await readCodexSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toHaveLength(1);
    expect(Number.isNaN(new Date(result.sessions[0]!.lastActiveAt).getTime())).toBe(false);
  });
});
