import { afterEach, describe, expect, test } from "bun:test";
import { readSessionTrees } from "../../src/cli/sessions/tree.ts";
import type { Identity } from "../../src/identities/types.ts";
import { COMPARED_FIELDS, compareTreeNodes, equalShare } from "../../src/server/sessions-db/compare.ts";
import { cleanTemps, makeFixture, T0, tempDir, type FixtureFile } from "./sessions-db-kit.ts";

/**
 * Tree equivalence (design 20261123, section 6, proof 5): the file scan and the database tree, on the same sessions,
 * must agree on id, parentId, title, cwd, startedAt, updatedAt and messageCount. Any difference fails the test and is
 * listed in the failure message. All data is synthetic.
 */

afterEach(cleanTemps);

const DAYS = 400; // the fixtures are dated March 2026
const iso = (sec: number): string => new Date(T0 + sec * 1000).toISOString();
const CWD = "/srv/repositories/example-org/example-repo";
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const agentId = (n: number): string => `a${String(n).padStart(16, "0")}`;
const rollId = (n: number): string => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;

interface Made extends FixtureFile {
  /** Seconds after T0 of the last write: the host file mtime. */
  lastSec: number;
}

const user = (sec: number, content: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: "user", message: { role: "user", content }, timestamp: iso(sec), ...extra });
const assistant = (sec: number, text: string): string =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", model: "model-a-1", content: [{ type: "text", text }] }, timestamp: iso(sec) });

/** A Claude session of `turns` prompt/answer pairs starting `startSec` after T0, one minute apart. */
function claude(n: number, turns: number, startSec: number, opts: { prompt?: string; extraFirst?: string[]; cwd?: string | null; title?: string } = {}): Made {
  const lines: string[] = [...(opts.extraFirst ?? [])];
  for (let i = 0; i < turns; i++) {
    const t = startSec + i * 60;
    const cwd = i === 0 && opts.cwd !== null ? { cwd: opts.cwd ?? CWD } : {};
    lines.push(user(t, i === 0 ? (opts.prompt ?? `Prompt ${n}`) : `Follow-up ${i} of ${n}`, cwd));
    lines.push(assistant(t + 30, `Answer ${i} of ${n}`));
  }
  if (opts.title) lines.push(JSON.stringify({ type: "ai-title", aiTitle: opts.title }));
  const lastSec = startSec + (turns - 1) * 60 + 30;
  return { kind: "claude", relPath: `projects/-srv-example-${n % 3}/${uuid(n)}.jsonl`, identity: "testa", lines, lastSec };
}

function claudeAgentOf(parent: number, k: number, startSec: number): Made {
  const aid = agentId(parent * 10 + k);
  const lines = [
    JSON.stringify({ type: "user", isSidechain: true, sessionId: uuid(parent), agentId: aid, cwd: CWD, message: { role: "user", content: `Task ${k} for ${parent}` }, timestamp: iso(startSec) }),
    JSON.stringify({ type: "assistant", isSidechain: true, sessionId: uuid(parent), agentId: aid, message: { role: "assistant", content: [{ type: "text", text: `Done ${k}` }] }, timestamp: iso(startSec + 20) }),
  ];
  return { kind: "claude", relPath: `projects/-srv-example-${parent % 3}/${uuid(parent)}/subagents/agent-${aid}.jsonl`, identity: "testa", lines, lastSec: startSec + 20 };
}

function codex(n: number, startSec: number, opts: { prompt?: string; cwd?: string | null; parent?: number; nickname?: string; noPrompt?: boolean } = {}): Made {
  const id = rollId(n);
  const msg = (role: string, type: string, text: string) => ({ type: "message", role, content: [{ type, text }] });
  const meta = {
    id,
    timestamp: iso(startSec),
    ...(opts.cwd === null ? {} : { cwd: opts.cwd ?? CWD }),
    ...(opts.parent !== undefined ? { parent_thread_id: rollId(opts.parent), thread_source: "subagent" } : {}),
    ...(opts.nickname ? { agent_nickname: opts.nickname } : {}),
  };
  const lines = [JSON.stringify({ type: "session_meta", timestamp: iso(startSec), payload: meta })];
  if (!opts.noPrompt) lines.push(JSON.stringify({ type: "response_item", timestamp: iso(startSec + 1), payload: msg("user", "input_text", opts.prompt ?? `Codex prompt ${n}`) }));
  lines.push(JSON.stringify({ type: "response_item", timestamp: iso(startSec + 2), payload: msg("assistant", "output_text", `Codex answer ${n}`) }));
  lines.push(JSON.stringify({ type: "response_item", timestamp: iso(startSec + 3), payload: { type: "function_call", name: "shell", call_id: `c${n}`, arguments: "{\"cmd\":\"ls\"}" } }));
  lines.push(JSON.stringify({ type: "response_item", timestamp: iso(startSec + 4), payload: { type: "function_call_output", call_id: `c${n}`, output: "files" } }));
  const d = new Date(T0 + startSec * 1000);
  const p = (x: number): string => String(x).padStart(2, "0");
  const relPath = `sessions/${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/rollout-${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}-${id}.jsonl`;
  return { kind: "codex", relPath, identity: "testa", lines, lastSec: startSec + 4 };
}

/** About thirty sessions of the shapes the readers handle. */
function fixtureSessions(): Made[] {
  const out: Made[] = [];
  let sec = 0;
  const next = (gap = 5000): number => (sec += gap);
  // Plain Claude sessions of different lengths.
  for (let n = 1; n <= 8; n++) out.push(claude(n, n * 2, next()));
  // Claude with subagents, with an AI title, with a long multi-line prompt, with no cwd.
  out.push(claude(20, 4, next()));
  out.push(claudeAgentOf(20, 1, out.at(-1)!.lastSec + 10), claudeAgentOf(20, 2, out.at(-1)!.lastSec + 100));
  out.push(claude(21, 3, next(), { title: "A named session" }));
  out.push(claude(22, 2, next(), { prompt: `A long prompt\nover several lines ${"word ".repeat(40)}` }));
  out.push(claude(23, 2, next(), { cwd: null }));
  // Claude session that starts with non-message lines and has a session, then nothing from the user.
  out.push({ kind: "claude", relPath: `projects/-srv-example-0/${uuid(24)}.jsonl`, identity: "testa", lines: [JSON.stringify({ type: "mode", mode: "plan" }), assistant(next(), "Only an answer")], lastSec: sec });
  // Codex rollouts: plain, long prompt, no prompt, no cwd, with a child thread.
  for (let n = 1; n <= 5; n++) out.push(codex(n, next()));
  out.push(codex(10, next(), { prompt: `Long codex prompt ${"text ".repeat(40)}` }));
  out.push(codex(11, next(), { noPrompt: true }));
  out.push(codex(12, next(), { cwd: null }));
  out.push(codex(13, next()));
  out.push(codex(14, next(), { parent: 13, nickname: "reviewer" }));
  return out;
}

async function seed(perPart: number) {
  const f = await makeFixture();
  const configDir = await tempDir();
  const sessions = fixtureSessions();
  for (const s of sessions) {
    await f.writeFile(configDir, s, T0 + s.lastSec * 1000);
    await f.add(s, perPart);
  }
  return { f, configDir, identity: { name: "testa", configDir } as Identity, sessions };
}

const describeDiffs = (diffs: unknown[]): string => JSON.stringify(diffs, null, 1);

describe("tree equivalence: files scan against database tree", () => {
  for (const perPart of [2, 7, 1000]) {
    test(`all ${COMPARED_FIELDS.length} fields equal for every fixture session (${perPart} lines per stored part)`, async () => {
      const { f, identity, sessions } = await seed(perPart);
      const opts = { days: DAYS };
      const targets = [{ tool: "claude" as const, identity: "testa" }, { tool: "codex" as const, identity: "testa" }];
      const slices = await f.db.readTrees({ kinds: ["claude", "codex"], targets, opts });
      for (const tool of ["claude", "codex"] as const) {
        const files = await readSessionTrees(tool, identity, opts);
        const db = slices.find((s) => s.tool === tool)!;
        const cmp = compareTreeNodes(files.nodes, db.nodes);
        expect(cmp.filesNodes).toBe(sessions.filter((s) => s.kind === tool).length);
        // The test fails on any difference and prints each one.
        expect(describeDiffs(cmp.diffs)).toBe("[]");
        expect(cmp.equal).toBe(cmp.filesNodes);
        expect(equalShare(cmp)).toBe(1);
      }
    });
  }

  test("the fixture covers subagents, a codex child, titles of every kind and a missing cwd", async () => {
    const { identity } = await seed(5);
    const claudeNodes = (await readSessionTrees("claude", identity, { days: DAYS })).nodes;
    const codexNodes = (await readSessionTrees("codex", identity, { days: DAYS })).nodes;
    expect(claudeNodes.filter((n) => n.parentId !== undefined).length).toBe(2);
    expect(codexNodes.filter((n) => n.parentId !== undefined).length).toBe(1);
    expect(claudeNodes.some((n) => n.title === "A named session")).toBe(true);
    expect(claudeNodes.some((n) => n.title === "(no user message)")).toBe(true);
    expect(codexNodes.some((n) => n.title === "(no summary)")).toBe(true);
    expect(claudeNodes.some((n) => n.cwd === null)).toBe(true);
    expect(codexNodes.some((n) => n.cwd === null)).toBe(true);
  });

  test("a difference in any compared field is found and listed", async () => {
    const { f, identity } = await seed(4);
    const opts = { days: DAYS };
    const files = await readSessionTrees("claude", identity, opts);
    // Change one stored row per field, one at a time, and expect exactly that field to differ.
    const base = (await f.db.readTrees({ kinds: ["claude"], targets: [{ tool: "claude", identity: "testa" }], opts }))[0]!.nodes;
    expect(compareTreeNodes(files.nodes, base).diffs).toEqual([]);
    const changes: [string, (n: (typeof base)[number]) => void][] = [
      ["title", (n) => (n.title = "other")],
      ["cwd", (n) => (n.cwd = "/other")],
      ["startedAt", (n) => (n.startedAt = iso(1))],
      ["updatedAt", (n) => (n.updatedAt = iso(2))],
      ["messageCount", (n) => (n.messageCount = (n.messageCount ?? 0) + 1)],
    ];
    for (const [field, change] of changes) {
      const copy = base.map((n) => ({ ...n }));
      change(copy.find((n) => n.parentId === undefined && n.messageCount !== undefined)!);
      const d = compareTreeNodes(files.nodes, copy).diffs;
      expect(d.length).toBe(1);
      expect(d[0]).toMatchObject({ kind: "field", field });
    }
    // A parent changed on one child.
    const child = base.map((n) => ({ ...n }));
    const kid = child.find((n) => n.parentId !== undefined)!;
    kid.parentId = "elsewhere";
    expect(compareTreeNodes(files.nodes, child).diffs).toEqual([expect.objectContaining({ kind: "field", field: "parentId" })]);
    // A node missing on either side, or with another id.
    expect(compareTreeNodes(files.nodes, base.slice(1)).diffs.map((d) => d.kind)).toEqual(["only-files"]);
    expect(compareTreeNodes(files.nodes.slice(1), base).diffs.map((d) => d.kind)).toEqual(["only-db"]);
  });
});
