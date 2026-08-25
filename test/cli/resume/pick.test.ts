import { describe, expect, test } from "bun:test";
import { buildPickOptions } from "../../../src/cli/resume/pick.ts";
import type { ResumableSession, ToolResumeResult } from "../../../src/cli/resume/types.ts";
import type { Identity } from "../../../src/identities/types.ts";

function identity(name: string): Identity {
  return { name, label: name, configDir: `/tmp/does-not-exist/${name}` };
}

function session(overrides: Partial<ResumableSession> = {}): ResumableSession {
  return {
    toolName: "claude",
    identity: identity("identity-a"),
    sessionId: "session-1",
    cwd: "/Users/t/Projects/AiProfileSwitcher",
    label: "Fix the bug",
    lastActiveAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

function result(overrides: Partial<ToolResumeResult> = {}): ToolResumeResult {
  return { toolName: "claude", identity: identity("identity-a"), sessions: [], ...overrides };
}

const NOW = new Date("2026-07-15T02:00:00.000Z");

describe("buildPickOptions", () => {
  test("a tool header and identity header are both disabled (unselectable, cursor-skipped)", () => {
    const options = buildPickOptions([result({ sessions: [session()] })], NOW);
    const headers = options.filter((o) => o.disabled);
    expect(headers).toHaveLength(2);
    expect(headers[0]!.label).toContain("claude");
    expect(headers[1]!.label).toContain("identity-a");
  });

  test("only the session itself is a real, selectable option carrying the session as its value", () => {
    const s = session();
    const options = buildPickOptions([result({ sessions: [s] })], NOW);
    const real = options.filter((o) => !o.disabled);
    expect(real).toHaveLength(1);
    expect(real[0]!.value).toBe(s);
    expect(real[0]!.label).toContain("Fix the bug");
  });

  test("a session's label ends in its own session id, for reference/copying", () => {
    const s = session({ sessionId: "abc-123-uuid" });
    const options = buildPickOptions([result({ sessions: [s] })], NOW);
    const real = options.find((o) => !o.disabled)!;
    expect(real.label.endsWith("abc-123-uuid")).toBe(true);
  });

  test("returns an empty list when there is nothing to resume", () => {
    expect(buildPickOptions([result()], NOW)).toEqual([]);
  });

  test("preserves the same tool/identity grouping and recency order as the static tree", () => {
    const older = session({ sessionId: "old", lastActiveAt: "2026-07-01T00:00:00.000Z" });
    const newer = session({ sessionId: "new", lastActiveAt: "2026-07-15T00:00:00.000Z" });
    const options = buildPickOptions(
      [
        result({ toolName: "claude", sessions: [older, newer] }),
        result({ toolName: "codex", identity: identity("personal"), sessions: [session({ sessionId: "c" })] }),
      ],
      NOW,
    );
    const sessionIds = options.filter((o) => !o.disabled).map((o) => (o.value as ResumableSession).sessionId);
    expect(sessionIds).toEqual(["new", "old", "c"]);
  });
});
