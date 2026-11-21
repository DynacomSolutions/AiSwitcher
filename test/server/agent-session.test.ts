import { describe, expect, test } from "bun:test";
import { readAgentSessionId } from "../../src/server/agent-session.ts";

const SID = "6cc07c23-4501-42cb-ba6e-3c14d864219e";
const OTHER = "01a1ff70-ad7f-7a20-9516-b226a8f39380";
const record = (over: Record<string, unknown> = {}) => JSON.stringify({ pid: 4242, sessionId: SID, procStart: "18627850", ...over });

describe("readAgentSessionId", () => {
  test("Claude Code's session file counts when its process start time equals the live process", async () => {
    const id = await readAgentSessionId(4242, "/cfg", { readFile: async (p) => (p === "/cfg/sessions/4242.json" ? record() : Promise.reject(new Error("nope"))), procStart: async () => "18627850", fdTargets: async () => [] });
    expect(id).toBe(SID);
  });

  test("a stale file left by an earlier process with the same pid is not used", async () => {
    const id = await readAgentSessionId(4242, "/cfg", { readFile: async () => record(), procStart: async () => "99999999", fdTargets: async () => [] });
    expect(id).toBeUndefined();
  });

  test("falls back to the open task folder of Claude Code", async () => {
    const id = await readAgentSessionId(4242, "/cfg", { readFile: async () => Promise.reject(new Error("none")), procStart: async () => "1", fdTargets: async () => ["/dev/null", `/data/tmp/claude-1000/-proj/${SID}/tasks`] });
    expect(id).toBe(SID);
  });

  test("falls back to the open Codex rollout file", async () => {
    const id = await readAgentSessionId(4242, undefined, { fdTargets: async () => [`/srv/synthetic/.codex/sessions/2026/11/22/rollout-2026-11-22T00-36-01-${OTHER}.jsonl`] });
    expect(id).toBe(OTHER);
  });

  test("nothing names a session: undefined, never invented", async () => {
    expect(await readAgentSessionId(4242, "/cfg", { readFile: async () => Promise.reject(new Error("none")), fdTargets: async () => ["/dev/null", "socket:[1]"] })).toBeUndefined();
  });

  test("the real /proc read of a vanished pid is undefined", async () => {
    expect(await readAgentSessionId(2 ** 31 - 2, "/nonexistent-config-dir")).toBeUndefined();
  });
});
