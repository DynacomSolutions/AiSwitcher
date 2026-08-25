import { describe, expect, test } from "bun:test";
import { flattenSessions, formatResumeTree, groupByToolAndIdentity, toJsonReport } from "../../../src/cli/resume/report.ts";
import type { ResumableSession, ToolResumeResult } from "../../../src/cli/resume/types.ts";
import type { Identity } from "../../../src/identities/types.ts";

// process.stdout.isTTY is false under `bun test` (see test/cli/colors.test.ts),
// so colors.ts's wrap functions are no-ops here: assertions below check
// plain text, not ANSI codes.

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

describe("flattenSessions", () => {
  test("merges every result's sessions and sorts most-recently-active first", () => {
    const older = session({ sessionId: "old", lastActiveAt: "2026-07-01T00:00:00.000Z" });
    const newer = session({ sessionId: "new", lastActiveAt: "2026-07-15T00:00:00.000Z" });
    const flattened = flattenSessions([
      result({ toolName: "claude", sessions: [older] }),
      result({ toolName: "codex", sessions: [newer] }),
    ]);
    expect(flattened.map((s) => s.sessionId)).toEqual(["new", "old"]);
  });
});

describe("groupByToolAndIdentity", () => {
  test("groups by tool then identity, sessions sorted most-recently-active first within an identity", () => {
    const older = session({ sessionId: "old", lastActiveAt: "2026-07-01T00:00:00.000Z" });
    const newer = session({ sessionId: "new", lastActiveAt: "2026-07-15T00:00:00.000Z" });
    const groups = groupByToolAndIdentity([result({ sessions: [older, newer] })]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.toolName).toBe("claude");
    expect(groups[0]!.identityGroups).toHaveLength(1);
    expect(groups[0]!.identityGroups[0]!.sessions.map((s) => s.sessionId)).toEqual(["new", "old"]);
  });

  test("an identity/tool with zero sessions contributes no group at all", () => {
    const groups = groupByToolAndIdentity([result(), result({ toolName: "codex", sessions: [session()] })]);
    expect(groups.map((g) => g.toolName)).toEqual(["codex"]);
  });

  test("preserves each tool's own multiple identities as separate branches", () => {
    const groups = groupByToolAndIdentity([
      result({ identity: identity("identity-a"), sessions: [session({ sessionId: "a" })] }),
      result({ identity: identity("personal"), sessions: [session({ sessionId: "b" })] }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.identityGroups.map((ig) => ig.identity.name)).toEqual(["identity-a", "personal"]);
  });
});

describe("toJsonReport", () => {
  test("sessions attaches a 1-based index matching the flattened/sorted order", () => {
    const older = session({ sessionId: "old", lastActiveAt: "2026-07-01T00:00:00.000Z" });
    const newer = session({ sessionId: "new", lastActiveAt: "2026-07-15T00:00:00.000Z" });
    const report = toJsonReport([result({ sessions: [older, newer] })]);
    expect(report.sessions.map((r) => [r.index, r.sessionId])).toEqual([
      [1, "new"],
      [2, "old"],
    ]);
    expect(report.errors).toEqual([]);
  });

  test("a failed (tool, identity) pair surfaces in errors, not silently dropped", () => {
    const report = toJsonReport([
      result({ sessions: [session()] }),
      result({ toolName: "codex", identity: identity("personal"), error: "permission denied" }),
    ]);
    expect(report.sessions).toHaveLength(1);
    expect(report.errors).toEqual([{ toolName: "codex", identity: "personal", error: "permission denied" }]);
  });
});

describe("formatResumeTree", () => {
  test("no targets scanned at all (e.g. --tool=grok with no grok identities configured)", () => {
    expect(formatResumeTree([], "/Users/t/Projects/AiProfileSwitcher", NOW)).toBe("No matching identities found.");
  });

  test("targets were scanned but none has any sessions for this cwd", () => {
    expect(formatResumeTree([result()], "/Users/t/Projects/AiProfileSwitcher", NOW)).toBe(
      "No resumable sessions found for /Users/t/Projects/AiProfileSwitcher.",
    );
  });

  test("renders a provider header, an identity branch, and an indented session line", () => {
    const output = formatResumeTree(
      [result({ sessions: [session({ lastActiveAt: "2026-07-15T00:00:00.000Z" })] })],
      "/Users/t/Projects/AiProfileSwitcher",
      NOW,
    );
    const lines = output.split("\n");
    expect(lines[0]).toBe("claude (1 identity)");
    expect(lines[1]).toContain("└── ");
    expect(lines[1]).toContain("identity-a");
    expect(lines[2]).toContain("Fix the bug");
    expect(lines[2]).toContain("2h ago");
    expect(lines[2]!.endsWith("session-1")).toBe(true);
    expect(output).toContain("ais resume <session-id>");
  });

  test("the session id is the final column, after last-active", () => {
    const output = formatResumeTree(
      [result({ sessions: [session({ sessionId: "abc-123-uuid" })] })],
      "/Users/t/Projects/AiProfileSwitcher",
      NOW,
    );
    const sessionLine = output.split("\n")[2]!;
    expect(sessionLine.indexOf("abc-123-uuid")).toBeGreaterThan(sessionLine.indexOf("2h ago"));
  });

  test("a tool with more than one identity uses ├── for all but the last branch", () => {
    const output = formatResumeTree(
      [
        result({ identity: identity("identity-a"), sessions: [session({ sessionId: "a" })] }),
        result({ identity: identity("personal"), sessions: [session({ sessionId: "b" })] }),
      ],
      "/Users/t/Projects/AiProfileSwitcher",
      NOW,
    );
    const lines = output.split("\n");
    expect(lines[0]).toBe("claude (2 identities)");
    expect(lines.find((l) => l.includes("identity-a"))).toContain("├── ");
    expect(lines.find((l) => l.includes("personal"))).toContain("└── ");
  });

  test("multiple tools render as separate sections, blank-line separated", () => {
    const output = formatResumeTree(
      [result({ toolName: "claude", sessions: [session()] }), result({ toolName: "codex", sessions: [session()] })],
      "/Users/t/Projects/AiProfileSwitcher",
      NOW,
    );
    const lines = output.split("\n");
    const claudeIdx = lines.indexOf("claude (1 identity)");
    const codexIdx = lines.indexOf("codex (1 identity)");
    expect(claudeIdx).toBeGreaterThanOrEqual(0);
    expect(codexIdx).toBeGreaterThan(claudeIdx);
    expect(lines[codexIdx - 1]).toBe("");
  });

  test("a failed (tool, identity) pair contributes a trailing Errors line, not a fabricated branch", () => {
    const output = formatResumeTree(
      [
        result({ sessions: [session()] }),
        result({ toolName: "codex", identity: identity("personal"), error: "permission denied" }),
      ],
      "/Users/t/Projects/AiProfileSwitcher",
      NOW,
    );
    expect(output).toContain("Errors:");
    expect(output).toContain("codex/personal");
    expect(output).toContain("permission denied");
  });

  test("errors alone (no sessions anywhere) still surface, even though the tree is empty", () => {
    const output = formatResumeTree([result({ error: "boom" })], "/Users/t/Projects/AiProfileSwitcher", NOW);
    expect(output).toContain("No resumable sessions found");
    expect(output).toContain("Errors:");
    expect(output).toContain("boom");
  });
});
