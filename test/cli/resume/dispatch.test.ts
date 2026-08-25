import { describe, expect, test } from "bun:test";
import { resolveSelector } from "../../../src/cli/resume/dispatch.ts";
import { CliUsageError } from "../../../src/cli/errors.ts";
import type { ResumableSession } from "../../../src/cli/resume/types.ts";
import type { Identity } from "../../../src/identities/types.ts";

function identity(name: string): Identity {
  return { name, label: name, configDir: `/tmp/does-not-exist/${name}` };
}

function session(sessionId: string): ResumableSession {
  return {
    toolName: "claude",
    identity: identity("identity-a"),
    sessionId,
    cwd: "/Users/t/Projects/AiProfileSwitcher",
    label: "Fix the bug",
    lastActiveAt: "2026-07-15T00:00:00.000Z",
  };
}

describe("resolveSelector", () => {
  const sessions = [session("aaa-1"), session("bbb-2"), session("ccc-3")];

  test("resolves an exact session id match", () => {
    expect(resolveSelector("bbb-2", sessions)).toBe(sessions[1]);
  });

  test("rejects a selector that matches no session id, even one that looks like an index", () => {
    expect(() => resolveSelector("1", sessions)).toThrow(CliUsageError);
    expect(() => resolveSelector("0", sessions)).toThrow(CliUsageError);
  });

  test("rejects a non-matching selector", () => {
    expect(() => resolveSelector("ghost", sessions)).toThrow(CliUsageError);
  });
});
