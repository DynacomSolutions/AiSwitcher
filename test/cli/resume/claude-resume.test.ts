import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeSessions } from "../../../src/cli/resume/claude-resume.ts";
import type { Identity } from "../../../src/identities/types.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-claude-resume-test-"));
  tempDirs.push(dir);
  return dir;
}

function identity(configDir: string): Identity {
  return { name: "personal", label: "Personal", configDir };
}

const TARGET_CWD = "/Users/t/Projects/AiProfileSwitcher";
const ENCODED_DIR = "-Users-t-Projects-AiProfileSwitcher";

async function writeSession(
  configDir: string,
  sessionId: string,
  lines: Record<string, unknown>[],
  encodedDir = ENCODED_DIR,
): Promise<void> {
  const dir = join(configDir, "projects", encodedDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
}

function userLine(cwd: string, content: string, extra: Record<string, unknown> = {}) {
  return { type: "user", message: { role: "user", content }, cwd, timestamp: "2026-07-15T05:56:05.000Z", ...extra };
}

describe("readClaudeSessions", () => {
  test("no projects directory at all yields an empty, error-free result", async () => {
    const configDir = await makeConfigDir();
    const result = await readClaudeSessions(identity(configDir), TARGET_CWD);
    expect(result).toEqual({ toolName: "claude", identity: identity(configDir), sessions: [] });
  });

  test("prefers the ai-title line over the first user message as the label", async () => {
    const configDir = await makeConfigDir();
    await writeSession(configDir, "session-1", [
      { type: "mode", mode: "normal", sessionId: "session-1" },
      userLine(TARGET_CWD, "fix the thing"),
      { type: "ai-title", aiTitle: "Fix the CLI resume bug", sessionId: "session-1" },
    ]);

    const result = await readClaudeSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.label).toBe("Fix the CLI resume bug");
    expect(result.sessions[0]?.sessionId).toBe("session-1");
  });

  test("falls back to the first non-meta user message when there is no ai-title", async () => {
    const configDir = await makeConfigDir();
    await writeSession(configDir, "session-2", [
      userLine(TARGET_CWD, "<local-command-caveat>ignore me</local-command-caveat>", { isMeta: true }),
      userLine(TARGET_CWD, "  please   fix the   bug  "),
    ]);

    const result = await readClaudeSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions[0]?.label).toBe("please fix the bug");
  });

  test("a session whose own recorded cwd differs is excluded even from the matching directory", async () => {
    const configDir = await makeConfigDir();
    // Placed under the TARGET_CWD-encoded directory, but every line records a
    // DIFFERENT cwd, simulating the lossy forward-only encoding colliding.
    await writeSession(configDir, "session-3", [userLine("/Users/t/Projects/Other-Repo", "hello")]);

    const result = await readClaudeSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toEqual([]);
  });

  test("non-.jsonl sibling entries (sidecar dirs, memory/) are ignored, not treated as sessions", async () => {
    const configDir = await makeConfigDir();
    await writeSession(configDir, "session-4", [userLine(TARGET_CWD, "real session")]);
    await mkdir(join(configDir, "projects", ENCODED_DIR, "session-4"), { recursive: true });
    await mkdir(join(configDir, "projects", ENCODED_DIR, "memory"), { recursive: true });

    const result = await readClaudeSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe("session-4");
  });

  test("last timestamp across the file wins as lastActiveAt", async () => {
    const configDir = await makeConfigDir();
    await writeSession(configDir, "session-5", [
      { ...userLine(TARGET_CWD, "first"), timestamp: "2026-07-01T00:00:00.000Z" },
      { ...userLine(TARGET_CWD, "second"), timestamp: "2026-07-15T00:00:00.000Z" },
    ]);

    const result = await readClaudeSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions[0]?.lastActiveAt).toBe("2026-07-15T00:00:00.000Z");
  });
});
