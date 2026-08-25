import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGrokSessions } from "../../../src/cli/resume/grok-resume.ts";
import type { Identity } from "../../../src/identities/types.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-grok-resume-test-"));
  tempDirs.push(dir);
  return dir;
}

function identity(configDir: string): Identity {
  return { name: "identity-a", label: "Identity A", configDir };
}

const TARGET_CWD = "/Users/t/Projects/AiProfileSwitcher";
const BUCKET_NAME = encodeURIComponent(TARGET_CWD);

async function writeSummary(
  configDir: string,
  sessionId: string,
  summary: Record<string, unknown>,
  bucket = BUCKET_NAME,
): Promise<void> {
  const dir = join(configDir, "sessions", bucket, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "summary.json"), JSON.stringify(summary));
}

describe("readGrokSessions", () => {
  test("no sessions directory at all yields an empty, error-free result", async () => {
    const configDir = await makeConfigDir();
    const result = await readGrokSessions(identity(configDir), TARGET_CWD);
    expect(result).toEqual({ toolName: "grok", identity: identity(configDir), sessions: [] });
  });

  test("uses session_summary as the label when present, and matches by summary.json's own info.cwd", async () => {
    const configDir = await makeConfigDir();
    await writeSummary(configDir, "session-1", {
      info: { id: "session-1", cwd: TARGET_CWD },
      session_summary: "Fix the resume command",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-15T00:00:00.000Z",
    });

    const result = await readGrokSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId: "session-1",
      label: "Fix the resume command",
      lastActiveAt: "2026-07-15T00:00:00.000Z",
    });
  });

  test("falls back to the per-bucket prompt_history.jsonl entry when session_summary is empty", async () => {
    const configDir = await makeConfigDir();
    await writeSummary(configDir, "session-2", {
      info: { id: "session-2", cwd: TARGET_CWD },
      session_summary: "",
      created_at: "2026-07-01T00:00:00.000Z",
    });
    await writeFile(
      join(configDir, "sessions", BUCKET_NAME, "prompt_history.jsonl"),
      `${JSON.stringify({ timestamp: "2026-07-01T00:00:00.000Z", session_id: "session-2", prompt: "please fix the bug" })}\n`,
    );

    const result = await readGrokSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions[0]?.label).toBe("please fix the bug");
  });

  test("falls back to '(no summary)' when nothing at all is available", async () => {
    const configDir = await makeConfigDir();
    await writeSummary(configDir, "session-3", { info: { id: "session-3", cwd: TARGET_CWD }, created_at: "2026-07-01T00:00:00.000Z" });

    const result = await readGrokSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions[0]?.label).toBe("(no summary)");
  });

  test("a session directory whose summary.json records a different cwd is excluded", async () => {
    const configDir = await makeConfigDir();
    await writeSummary(configDir, "session-4", { info: { id: "session-4", cwd: "/Users/t/Projects/Other" }, created_at: "2026-07-01T00:00:00.000Z" });

    const result = await readGrokSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toEqual([]);
  });

  test("a session directory missing summary.json entirely is skipped, not an error", async () => {
    const configDir = await makeConfigDir();
    await mkdir(join(configDir, "sessions", BUCKET_NAME, "session-5"), { recursive: true });

    const result = await readGrokSessions(identity(configDir), TARGET_CWD);
    expect(result).toEqual({ toolName: "grok", identity: identity(configDir), sessions: [] });
  });
});
