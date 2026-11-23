import { describe, expect, test } from "bun:test";
import { scanAgentFile, scanSessionFile } from "../../../src/cli/sessions/claude.ts";
import { firstUserMessage, parseMetaLine } from "../../../src/cli/sessions/codex.ts";
import {
  IndexOffsetError,
  advanceSessionIndex,
  claudeRefsFromPath,
  codexRefFromPath,
  isUsableIndexState,
  projectFromCwd,
  type IndexedKind,
  type SessionIndexFields,
  type SessionIndexState,
} from "../../../src/cli/sessions/indexer.ts";
import { truncateLabel } from "../../../src/cli/resume/label.ts";

/**
 * Property tests for the incremental indexers. The property: for a file of N lines, every way to cut it at
 * line ends and feed the parts in order (with the state stored as JSON between the parts) gives the same
 * state and fields as one pass over the whole file. A second check compares the one-pass result with the
 * existing tree readers (the oracle). All data is synthetic.
 */

const enc = new TextEncoder();
const WT = "/srv/repos/.worktrees/org-a/task-1/repo-x";
const SID = "11111111-2222-4333-8444-555555555555";
const AGENT_ID = "a1b2c3d4e5f60718";

function jsonl(records: Array<Record<string, unknown> | string>): string[] {
  return records.map((r) => (typeof r === "string" ? r : JSON.stringify(r)));
}

const claudeMain = jsonl([
  { type: "permission-mode", permissionMode: "default", sessionId: SID },
  { type: "queue-operation", operation: "enqueue", timestamp: "2026-03-01T09:00:00.000Z", sessionId: SID },
  { type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat: plumbing</local-command-caveat>" }, cwd: WT, timestamp: "2026-03-01T09:00:01.000Z", sessionId: SID },
  { type: "user", message: { role: "user", content: "<command-name>/model</command-name>" }, cwd: WT, timestamp: "2026-03-01T09:00:02.000Z", sessionId: SID },
  "",
  { type: "user", message: { role: "user", content: "  Add a retry to the sync   job\nplease  " }, cwd: `${WT}/src`, timestamp: "2026-03-01T09:00:05.000Z", sessionId: SID },
  "not json at all {",
  { type: "assistant", message: { role: "assistant", model: "model-a-1", content: [{ type: "text", text: "Looking now. ✓ ünïcode" }], usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: "2026-03-01T09:00:09.000Z", sessionId: SID },
  { type: "assistant", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "No response" }] }, timestamp: "2026-03-01T09:00:10.000Z", sessionId: SID },
  { type: "ai-title", aiTitle: "Retry for the sync job", sessionId: SID },
  { type: "assistant", message: { role: "assistant", model: "model-b-2", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] }, timestamp: "2026-03-01T09:01:00.000Z", sessionId: SID },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "a\nb" }] }, timestamp: "2026-03-01T09:01:02.000Z", sessionId: SID },
  { type: "system", content: "compacted", timestamp: "2026-03-01T09:02:00.000Z", sessionId: SID },
  { type: "ai-title", aiTitle: "Retry sync job with back-off", sessionId: SID },
  { type: "custom-title", customTitle: "  ", sessionId: SID },
  { type: "custom-title", customTitle: "Sync retry (renamed)", sessionId: SID },
  { type: "assistant", message: { role: "assistant", model: "model-b-2", content: [{ type: "text", text: "Done." }] }, timestamp: "2026-03-01T09:05:00.000Z", sessionId: SID },
  { type: "last-prompt", lastPrompt: "x", sessionId: SID },
]);

// Same file with no rename: the title comes from the last ai-title, then from the first prompt.
const claudeNoRename = claudeMain.filter((l) => !l.includes("custom-title"));
const claudeNoTitles = claudeNoRename.filter((l) => !l.includes("ai-title"));
const claudeBlankAiTitle = [...claudeNoTitles, JSON.stringify({ type: "ai-title", aiTitle: "   " })];

const claudeAgent = jsonl([
  { type: "user", isSidechain: true, agentId: AGENT_ID, sessionId: SID, cwd: WT, timestamp: "2026-03-01T09:01:00.000Z", message: { role: "user", content: "Search the repo for the retry helper" } },
  { type: "assistant", isSidechain: true, agentId: AGENT_ID, sessionId: SID, cwd: `${WT}/other`, timestamp: "2026-03-01T09:01:30.000Z", message: { role: "assistant", model: "model-c-3", content: [{ type: "text", text: "Found it." }] } },
]);
const claudeAgentNoPrompt = jsonl([
  { type: "assistant", isSidechain: true, agentId: AGENT_ID, sessionId: SID, timestamp: "2026-03-01T09:01:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "Hi" }] } },
]);

const codexMain = jsonl([
  { timestamp: "2026-03-02T08:00:00.000Z", type: "session_meta", payload: { id: SID, cwd: WT, timestamp: "2026-03-02T07:59:58.000Z", originator: "cli", cli_version: "0.0.0", model_provider: "provider-a" } },
  { timestamp: "2026-03-02T08:00:00.100Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>" }] } },
  { timestamp: "2026-03-02T08:00:00.200Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /x\n..." }] } },
  { timestamp: "2026-03-02T08:00:00.300Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/x</cwd>" }] } },
  { timestamp: "2026-03-02T08:00:01.000Z", type: "turn_context", payload: { cwd: WT, model: "model-x-1", effort: "high" } },
  { timestamp: "2026-03-02T08:00:01.100Z", type: "event_msg", payload: { type: "user_message", message: "Rename the helper to withRetry" } },
  { timestamp: "2026-03-02T08:00:01.200Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Rename the helper to withRetry" }] } },
  "{ broken",
  { timestamp: "2026-03-02T08:00:03.000Z", type: "response_item", payload: { type: "reasoning", summary: [] } },
  { timestamp: "2026-03-02T08:00:04.000Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{\"command\":[\"ls\"]}", call_id: "c1" } },
  { timestamp: "2026-03-02T08:00:05.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "a" } },
  { timestamp: "2026-03-02T08:00:06.000Z", type: "event_msg", payload: { type: "token_count", info: null } },
  { timestamp: "2026-03-02T08:00:30.000Z", type: "turn_context", payload: { cwd: WT, model: "model-x-2" } },
  { timestamp: "2026-03-02T08:00:31.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Renamed. ✓" }] } },
]);

const codexChild = jsonl([
  { timestamp: "2026-03-02T08:01:00.000Z", type: "session_meta", payload: { id: "99999999-aaaa-4bbb-8ccc-dddddddddddd", cwd: WT, parent_thread_id: SID, thread_source: "subagent", agent_nickname: "Nickname-One" } },
  { timestamp: "2026-03-02T08:01:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Check the tests" }] } },
]);
const codexGuardian = jsonl([
  { timestamp: "2026-03-02T08:01:00.000Z", type: "session_meta", payload: { id: "88888888-aaaa-4bbb-8ccc-dddddddddddd", cwd: "/tmp/elsewhere", parent_thread_id: SID, thread_source: "guardian_review" } },
]);
const codexOtherSource = jsonl([
  { timestamp: "2026-03-02T08:01:00.000Z", type: "session_meta", payload: { id: "77777777-aaaa-4bbb-8ccc-dddddddddddd", parent_thread_id: SID, thread_source: "review" } },
]);
const codexNoMetaFirst = jsonl([
  { timestamp: "2026-03-02T08:01:00.000Z", type: "turn_context", payload: { model: "model-x-1" } },
  { timestamp: "2026-03-02T08:01:01.000Z", type: "session_meta", payload: { id: "66666666-aaaa-4bbb-8ccc-dddddddddddd", cwd: "/tmp/late" } },
]);

interface Case {
  name: string;
  kind: IndexedKind;
  relPath: string;
  lines: string[];
}

const CASES: Case[] = [
  { name: "claude session", kind: "claude", relPath: `-srv-p/${SID}.jsonl`, lines: claudeMain },
  { name: "claude session without rename", kind: "claude", relPath: `-srv-p/${SID}.jsonl`, lines: claudeNoRename },
  { name: "claude session without titles", kind: "claude", relPath: `-srv-p/${SID}.jsonl`, lines: claudeNoTitles },
  { name: "claude session with a blank ai title", kind: "claude", relPath: `-srv-p/${SID}.jsonl`, lines: claudeBlankAiTitle },
  { name: "claude subagent", kind: "claude", relPath: `-srv-p/${SID}/subagents/agent-${AGENT_ID}.jsonl`, lines: claudeAgent },
  { name: "claude subagent without prompt", kind: "claude", relPath: `-srv-p/${SID}/subagents/deep/agent-${AGENT_ID}.jsonl`, lines: claudeAgentNoPrompt },
  { name: "codex session", kind: "codex", relPath: `2026/03/02/rollout-2026-03-02T08-00-00-${SID}.jsonl`, lines: codexMain },
  { name: "codex subagent", kind: "codex", relPath: "2026/03/02/rollout-x-99999999-aaaa-4bbb-8ccc-dddddddddddd.jsonl", lines: codexChild },
  { name: "codex guardian review", kind: "codex", relPath: "2026/03/02/rollout-x-88888888-aaaa-4bbb-8ccc-dddddddddddd.jsonl", lines: codexGuardian },
  { name: "codex other child source", kind: "codex", relPath: "2026/03/02/rollout-x-77777777-aaaa-4bbb-8ccc-dddddddddddd.jsonl", lines: codexOtherSource },
  { name: "codex without a first-line meta", kind: "codex", relPath: "2026/03/02/rollout-x-66666666-aaaa-4bbb-8ccc-dddddddddddd.jsonl", lines: codexNoMetaFirst },
];

/** Byte offsets after each line, for lines that end in "\n". */
function offsetsOf(lines: string[]): number[] {
  const out = [0];
  for (const line of lines) out.push(out[out.length - 1]! + enc.encode(line).length + 1);
  return out;
}

/** Feeds `lines` in the parts that end at `cuts` (line counts, ascending). The state goes through JSON between the parts. */
function feed(c: Case, cuts: number[]): { state: SessionIndexState; fields: SessionIndexFields } {
  const offsets = offsetsOf(c.lines);
  let prev: SessionIndexState | null = null;
  let from = 0;
  let last: { state: SessionIndexState; fields: SessionIndexFields } | undefined;
  for (const to of [...cuts, c.lines.length]) {
    if (to === from) continue;
    const stored: unknown = prev === null ? null : JSON.parse(JSON.stringify(prev));
    const usable: SessionIndexState | null = stored !== null && isUsableIndexState(stored, c.kind, c.relPath) ? stored : null;
    expect(usable === null).toBe(prev === null);
    last = advanceSessionIndex(c.kind, usable, { startOffset: offsets[from]!, endOffset: offsets[to]!, lines: c.lines.slice(from, to) }, c.relPath);
    prev = last.state;
    from = to;
  }
  return last!;
}

/** A small deterministic generator, so a failure repeats. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

describe("incremental indexers equal a full scan", () => {
  for (const c of CASES) {
    describe(c.name, () => {
      const full = feed(c, []);

      test("every split at one line boundary", () => {
        for (let k = 1; k < c.lines.length; k++) {
          const split = feed(c, [k]);
          expect(split.state).toEqual(full.state);
          expect(split.fields).toEqual(full.fields);
        }
      });

      test("one line at a time", () => {
        const cuts = Array.from({ length: c.lines.length - 1 }, (_, i) => i + 1);
        const split = feed(c, cuts);
        expect(split.state).toEqual(full.state);
        expect(split.fields).toEqual(full.fields);
      });

      test("random multi-part splits", () => {
        const next = rng(7);
        for (let round = 0; round < 40; round++) {
          const cuts = [...new Set(Array.from({ length: 1 + Math.floor(next() * 5) }, () => 1 + Math.floor(next() * (c.lines.length - 1))))].sort((a, b) => a - b);
          expect(feed(c, cuts).state).toEqual(full.state);
        }
      });

      test("covers every byte and line", () => {
        expect(full.fields.indexedBytes).toBe(offsetsOf(c.lines)[c.lines.length]!);
        expect(full.fields.indexedLines).toBe(c.lines.length);
      });

      test("every prefix equals a full scan of that prefix", () => {
        for (let k = 1; k < c.lines.length; k++) {
          const prefix: Case = { ...c, lines: c.lines.slice(0, k) };
          const whole = feed(prefix, []);
          const split = feed(prefix, k > 1 ? [Math.floor(k / 2) || 1] : []);
          expect(split.fields).toEqual(whole.fields);
        }
      });
    });
  }
});

describe("the one-pass result matches the tree readers", () => {
  test("claude session: title, cwd, times, count", async () => {
    for (const lines of [claudeMain, claudeNoRename, claudeNoTitles, claudeBlankAiTitle]) {
      const c: Case = { name: "", kind: "claude", relPath: `-srv-p/${SID}.jsonl`, lines };
      const { fields } = feed(c, []);
      const scan = await scanSessionFile(lines);
      const named = scan.customTitle ?? scan.aiTitle;
      const treeTitle = named?.trim() ? truncateLabel(named) : scan.firstUser?.trim() ? truncateLabel(scan.firstUser) : null;
      expect(fields.title).toBe(treeTitle);
      expect(fields.cwd).toBe(scan.cwd ?? null);
      expect(fields.startedAt).toBe(scan.firstTs ?? null);
      expect(fields.updatedAt).toBe(scan.lastTs ?? null);
      expect(fields.messageCount).toBe(scan.messageCount);
      expect(fields.sessionRef).toBe(SID);
      expect(fields.parentRef).toBeNull();
    }
  });

  test("claude session: values read from the fixture", () => {
    const { fields } = feed(CASES[0]!, []);
    expect(fields).toMatchObject({
      title: "Sync retry (renamed)",
      cwd: WT,
      project: "org-a/repo-x",
      model: "model-b-2",
      startedAt: Date.parse("2026-03-01T09:00:00.000Z"),
      updatedAt: Date.parse("2026-03-01T09:05:00.000Z"),
      messageCount: 8,
    });
    expect(feed(CASES[2]!, []).fields.title).toBe("Add a retry to the sync job please");
    expect(feed(CASES[1]!, []).fields.title).toBe("Retry sync job with back-off");
    expect(feed(CASES[3]!, []).fields.title).toBe("Add a retry to the sync job please");
  });

  test("claude subagent: id, parent, title, cwd, start", async () => {
    for (const lines of [claudeAgent, claudeAgentNoPrompt]) {
      const relPath = `-srv-p/${SID}/subagents/agent-${AGENT_ID}.jsonl`;
      const { fields } = feed({ name: "", kind: "claude", relPath, lines }, []);
      const scan = await scanAgentFile(lines);
      expect(fields.sessionRef).toBe(`${SID}/${scan.agentId ?? AGENT_ID}`);
      expect(fields.parentRef).toBe(SID);
      expect(fields.agentName).toBe(AGENT_ID);
      expect(fields.title).toBe(truncateLabel(scan.firstUser ?? AGENT_ID));
      expect(fields.cwd).toBe(scan.cwd ?? null);
      expect(fields.startedAt).toBe(scan.firstTs ?? null);
    }
  });

  test("codex: id, parent, title, cwd, start", async () => {
    for (const c of CASES.filter((x) => x.kind === "codex")) {
      const { fields } = feed(c, []);
      const meta = parseMetaLine(c.lines[0]);
      const first = await firstUserMessage(c.lines);
      expect(fields.sessionRef).toBe(meta?.id ?? codexRefFromPath(c.relPath));
      expect(fields.parentRef).toBe(meta?.parentThreadId ?? null);
      expect(fields.cwd).toBe(meta?.cwd ?? null);
      const isChild = meta?.parentThreadId !== undefined;
      const expected = isChild
        ? (meta?.agentNickname ?? (meta?.threadSource === "guardian_review" ? "guardian review" : undefined) ?? first ?? meta?.threadSource)
        : first;
      expect(fields.title).toBe(expected === undefined ? null : truncateLabel(expected));
      if (meta?.startedAt !== undefined) expect(fields.startedAt).toBe(meta.startedAt);
    }
  });

  test("codex session: values read from the fixture", () => {
    expect(feed(CASES[6]!, []).fields).toMatchObject({
      sessionRef: SID,
      parentRef: null,
      title: "Rename the helper to withRetry",
      cwd: WT,
      project: "org-a/repo-x",
      model: "model-x-2",
      startedAt: Date.parse("2026-03-02T07:59:58.000Z"),
      updatedAt: Date.parse("2026-03-02T08:00:31.000Z"),
      messageCount: 2,
    });
    expect(feed(CASES[7]!, []).fields).toMatchObject({ parentRef: SID, agentName: "Nickname-One", title: "Nickname-One" });
    expect(feed(CASES[8]!, []).fields).toMatchObject({ title: "guardian review", project: null });
    expect(feed(CASES[9]!, []).fields.title).toBe("review");
    // The meta record counts only on line 1.
    expect(feed(CASES[10]!, []).fields).toMatchObject({ cwd: null, sessionRef: "66666666-aaaa-4bbb-8ccc-dddddddddddd", model: "model-x-1" });
  });
});

describe("state and offsets", () => {
  const c = CASES[0]!;
  const offsets = offsetsOf(c.lines);

  test("a chunk that does not continue the state is refused", () => {
    const first = advanceSessionIndex("claude", null, { startOffset: 0, endOffset: offsets[3]!, lines: c.lines.slice(0, 3) }, c.relPath);
    expect(() => advanceSessionIndex("claude", first.state, { startOffset: offsets[4]!, endOffset: offsets[5]!, lines: [c.lines[4]!] }, c.relPath)).toThrow(IndexOffsetError);
    expect(() => advanceSessionIndex("claude", null, { startOffset: 5, endOffset: 9, lines: ["{}"] }, c.relPath)).toThrow(IndexOffsetError);
    expect(() => advanceSessionIndex("codex", null, { startOffset: 0, endOffset: -1, lines: [] }, "x.jsonl")).toThrow(RangeError);
  });

  test("a repeated chunk is refused, not counted twice", () => {
    const chunk = { startOffset: 0, endOffset: offsets[3]!, lines: c.lines.slice(0, 3) };
    const first = advanceSessionIndex("claude", null, chunk, c.relPath);
    expect(() => advanceSessionIndex("claude", first.state, chunk, c.relPath)).toThrow(IndexOffsetError);
  });

  test("the previous state is not changed", () => {
    const first = advanceSessionIndex("claude", null, { startOffset: 0, endOffset: offsets[8]!, lines: c.lines.slice(0, 8) }, c.relPath);
    const before = JSON.stringify(first.state);
    advanceSessionIndex("claude", first.state, { startOffset: offsets[8]!, endOffset: offsets[17]!, lines: c.lines.slice(8) }, c.relPath);
    expect(JSON.stringify(first.state)).toBe(before);
  });

  test("a state of another file or kind is not usable", () => {
    const { state } = feed(c, []);
    expect(isUsableIndexState(state, "claude", c.relPath)).toBe(true);
    expect(isUsableIndexState(state, "codex", c.relPath)).toBe(false);
    expect(isUsableIndexState(state, "claude", "other.jsonl")).toBe(false);
    expect(isUsableIndexState({ v: 2 }, "claude", c.relPath)).toBe(false);
    expect(isUsableIndexState(null, "claude", c.relPath)).toBe(false);
  });

  test("the state holds no prompt text beyond the title length", () => {
    const long = JSON.stringify({ type: "user", message: { role: "user", content: "word ".repeat(5000) }, timestamp: "2026-03-01T09:00:00.000Z" });
    const { state } = advanceSessionIndex("claude", null, { startOffset: 0, endOffset: enc.encode(long).length + 1, lines: [long] }, "p/x.jsonl");
    expect(JSON.stringify(state).length).toBeLessThan(600);
  });
});

describe("paths and projects", () => {
  test("projectFromCwd", () => {
    expect(projectFromCwd("/srv/repos/.worktrees/org-a/task-1/repo-x/src/deep")).toBe("org-a/repo-x");
    expect(projectFromCwd("/srv/repos/.worktrees/org-a/.base/repo-x")).toBe("org-a/repo-x");
    expect(projectFromCwd("/srv/repos/org-a/repo-x")).toBe("org-a/repo-x");
    expect(projectFromCwd("/srv/repos/.data/org-a/repo-x")).toBeNull();
    expect(projectFromCwd("/srv/repos/.worktrees/org-a/task-1")).toBeNull();
    expect(projectFromCwd("/tmp/scratch")).toBeNull();
    expect(projectFromCwd(undefined)).toBeNull();
  });

  test("refs from the path alone", () => {
    expect(claudeRefsFromPath(`-p/${SID}.jsonl`)).toEqual({ sessionRef: SID, parentRef: null, fileAgentId: null });
    expect(claudeRefsFromPath(`-p/${SID}/subagents/a/b/agent-${AGENT_ID}.jsonl`)).toEqual({ sessionRef: `${SID}/${AGENT_ID}`, parentRef: SID, fileAgentId: AGENT_ID });
    expect(codexRefFromPath(`2026/03/02/rollout-2026-03-02T08-00-00-${SID}.jsonl`)).toBe(SID);
    expect(codexRefFromPath("2026/03/02/odd-name.jsonl")).toBe("odd-name");
  });
});
