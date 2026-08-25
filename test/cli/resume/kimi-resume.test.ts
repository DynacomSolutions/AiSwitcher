import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readKimiSessions } from "../../../src/cli/resume/kimi-resume.ts";
import type { Identity } from "../../../src/identities/types.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ais-kimi-resume-test-"));
  tempDirs.push(dir);
  return dir;
}

function identity(configDir: string): Identity {
  return { name: "personal", label: "Personal", configDir };
}

const TARGET_CWD = "/Users/t/Projects/AiProfileSwitcher";

/** Creates one session directory in kimi's real layout
 * (`sessions/wd_<slug>_<hash>/session_<uuid>/`, with an optional state.json
 * inside) and returns the values a session_index.jsonl line needs to point
 * at it. The bucket name here is deliberately opaque-looking, since the
 * whole point of reading the index is that bucket names are NOT decoded. */
async function makeSessionDir(
  configDir: string,
  uuid: string,
  state?: Record<string, unknown>,
): Promise<{ sessionId: string; sessionDir: string }> {
  const sessionId = `session_${uuid}`;
  const sessionDir = join(configDir, "sessions", "wd_users-t-projects-aiprofileswitcher_9f2ab1c4", sessionId);
  await mkdir(sessionDir, { recursive: true });
  if (state !== undefined) {
    await writeFile(join(sessionDir, "state.json"), JSON.stringify(state));
  }
  return { sessionId, sessionDir };
}

function indexLine(sessionId: string, sessionDir: string, workDir: string): string {
  return JSON.stringify({ sessionId, sessionDir, workDir });
}

async function writeIndex(configDir: string, lines: string[]): Promise<void> {
  await writeFile(join(configDir, "session_index.jsonl"), `${lines.join("\n")}\n`);
}

describe("readKimiSessions", () => {
  test("no session_index.jsonl at all yields an empty, error-free result", async () => {
    const configDir = await makeConfigDir();
    const result = await readKimiSessions(identity(configDir), TARGET_CWD);
    expect(result).toEqual({ toolName: "kimi", identity: identity(configDir), sessions: [] });
  });

  test("a matching index entry uses state.json's title as the label and updatedAt as lastActiveAt", async () => {
    const configDir = await makeConfigDir();
    const { sessionId, sessionDir } = await makeSessionDir(configDir, "11111111-1111-1111-1111-111111111111", {
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      title: "Wire up the kimi resume adapter",
      isCustomTitle: false,
      workDir: TARGET_CWD,
    });
    await writeIndex(configDir, [indexLine(sessionId, sessionDir, TARGET_CWD)]);

    const result = await readKimiSessions(identity(configDir), TARGET_CWD);
    expect(result.error).toBeUndefined();
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId,
      cwd: TARGET_CWD,
      label: "Wire up the kimi resume adapter",
      lastActiveAt: "2026-07-15T00:00:00.000Z",
    });
  });

  test("state.json's placeholder title 'New Session' counts as no label", async () => {
    const configDir = await makeConfigDir();
    const { sessionId, sessionDir } = await makeSessionDir(configDir, "22222222-2222-2222-2222-222222222222", {
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
      title: "New Session",
      isCustomTitle: false,
      workDir: TARGET_CWD,
    });
    await writeIndex(configDir, [indexLine(sessionId, sessionDir, TARGET_CWD)]);

    const result = await readKimiSessions(identity(configDir), TARGET_CWD);
    expect(result.sessions[0]?.label).toBe("(no summary)");
    expect(result.sessions[0]?.lastActiveAt).toBe("2026-07-12T00:00:00.000Z");
  });

  test("an index entry whose workDir is a different directory is excluded", async () => {
    const configDir = await makeConfigDir();
    const { sessionId, sessionDir } = await makeSessionDir(configDir, "33333333-3333-3333-3333-333333333333", {
      createdAt: "2026-07-01T00:00:00.000Z",
      title: "Unrelated work",
    });
    await writeIndex(configDir, [indexLine(sessionId, sessionDir, "/Users/t/Projects/Other")]);

    const result = await readKimiSessions(identity(configDir), TARGET_CWD);
    expect(result).toEqual({ toolName: "kimi", identity: identity(configDir), sessions: [] });
  });

  test("a malformed JSONL line is skipped while valid entries are still returned", async () => {
    const configDir = await makeConfigDir();
    const { sessionId, sessionDir } = await makeSessionDir(configDir, "44444444-4444-4444-4444-444444444444", {
      createdAt: "2026-07-01T00:00:00.000Z",
      title: "Survives a corrupt sibling line",
    });
    await writeIndex(configDir, ["{not valid json", indexLine(sessionId, sessionDir, TARGET_CWD)]);

    const result = await readKimiSessions(identity(configDir), TARGET_CWD);
    expect(result.error).toBeUndefined();
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.label).toBe("Survives a corrupt sibling line");
  });

  test("an index entry whose sessionDir has no state.json still yields the session from index data", async () => {
    const configDir = await makeConfigDir();
    const { sessionId, sessionDir } = await makeSessionDir(configDir, "55555555-5555-5555-5555-555555555555");
    await writeIndex(configDir, [indexLine(sessionId, sessionDir, TARGET_CWD)]);

    const result = await readKimiSessions(identity(configDir), TARGET_CWD);
    expect(result.error).toBeUndefined();
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      sessionId,
      cwd: TARGET_CWD,
      label: "(no summary)",
      lastActiveAt: new Date(0).toISOString(),
    });
  });
});
