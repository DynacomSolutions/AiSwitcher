import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { readSessionTrees } from "../../../src/cli/sessions/tree.ts";
import type { TreeNodeDto } from "../../../src/cli/sessions/types.ts";
import type { Identity } from "../../../src/identities/types.ts";
import {
  CLAUDE_ENC,
  CODEX_DAY_DIR,
  FRESH,
  OLD,
  NOW,
  claudeUserLine,
  codexSessionMeta,
  identity,
  kimiIndexLine,
  kimiState,
  makeConfigDir,
  writeJson,
  writeJsonl,
} from "./fixtures.ts";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshDir(prefix: string): Promise<string> {
  const dir = await makeConfigDir(prefix);
  tempDirs.push(dir);
  return dir;
}

const OPTS = { now: NOW, days: 30 };

function nodeIds(nodes: TreeNodeDto[]): string[] {
  return nodes.map((n) => n.id);
}

/* --------------------------------- claude --------------------------------- */

describe("claude tree", () => {
  test("links subagent sidecar files to their parent session", async () => {
    const configDir = await freshDir("claude-link");
    const enc = join(configDir, "projects", CLAUDE_ENC);
    await writeJsonl(join(enc, "sess-1.jsonl"), [
      claudeUserLine("/tmp/proj-a", "SYNTHETIC_FIXTURE fix the tree", "2026-01-11T08:00:00.000Z"),
      { type: "ai-title", aiTitle: "Fix the session tree", sessionId: "sess-1" },
    ]);
    await writeJsonl(join(enc, "sess-1", "subagents", "wf1", "agent-agentA.jsonl"), [
      { type: "user", message: { role: "user", content: "SYNTHETIC_FIXTURE agent task" }, agentId: "agentA", sessionId: "sess-1", cwd: "/tmp/proj-a", timestamp: "2026-01-11T08:01:00.000Z", isSidechain: true, isMeta: false },
    ]);

    const tree = await readSessionTrees("claude", identity(configDir), OPTS);
    expect(tree.unavailable).toBeUndefined();
    const root = tree.nodes.find((n) => n.id === "sess-1");
    const child = tree.nodes.find((n) => n.id === "sess-1/agentA");
    expect(root).toBeDefined();
    expect(root!.parentId).toBeUndefined();
    expect(root!.title).toBe("Fix the session tree");
    expect(child).toBeDefined();
    expect(child!.parentId).toBe("sess-1");
    expect(child!.depth).toBe(1);
    expect(child!.agentName).toBe("agentA");
    expect(child!.title).toContain("agent task");
  });

  test("old files drop out of the window; a fresh child of an old parent is an orphan rendered as a root", async () => {
    const configDir = await freshDir("claude-orphan");
    const enc = join(configDir, "projects", CLAUDE_ENC);
    await writeJsonl(join(enc, "old-parent.jsonl"), [
      claudeUserLine("/tmp/proj-a", "SYNTHETIC_FIXTURE old", "2026-01-01T08:00:00.000Z"),
    ], OLD);
    await writeJsonl(join(enc, "old-parent", "subagents", "agent-kid.jsonl"), [
      { type: "user", message: { role: "user", content: "SYNTHETIC_FIXTURE kid task" }, agentId: "kid", sessionId: "old-parent", cwd: "/tmp/proj-a", timestamp: "2026-01-12T08:00:00.000Z", isSidechain: true, isMeta: false },
    ], FRESH);

    const tree = await readSessionTrees("claude", identity(configDir), OPTS);
    expect(nodeIds(tree.nodes)).toContain("old-parent/kid");
    const orphan = tree.nodes.find((n) => n.id === "old-parent/kid")!;
    expect(orphan.parentId).toBe("old-parent"); // kept, though parent is outside the window
    expect(orphan.depth).toBe(0); // renders as a root
    expect(nodeIds(tree.nodes)).not.toContain("old-parent");
  });

  test("fresh mtime marks a session in progress; the days window prunes old files", async () => {
    const configDir = await freshDir("claude-live");
    const enc = join(configDir, "projects", CLAUDE_ENC);
    await writeJsonl(join(enc, "live.jsonl"), [
      claudeUserLine("/tmp/proj-a", "SYNTHETIC_FIXTURE live", "2026-01-12T11:59:50.000Z"),
    ], FRESH);
    await writeJsonl(join(enc, "stale.jsonl"), [
      claudeUserLine("/tmp/proj-a", "SYNTHETIC_FIXTURE stale", "2026-01-01T08:00:00.000Z"),
    ], OLD);

    const tree = await readSessionTrees("claude", identity(configDir), OPTS);
    const live = tree.nodes.find((n) => n.id === "live.jsonl") ?? tree.nodes.find((n) => n.id === "live");
    expect(live).toBeDefined();
    expect(live!.inProgress).toBe(true);
    expect(nodeIds(tree.nodes)).not.toContain("stale");
  });
});

/* ---------------------------------- codex ---------------------------------- */

describe("codex tree", () => {
  async function writeRollout(configDir: string, fileName: string, lines: Array<Record<string, unknown>>, mtimeMs?: number): Promise<void> {
    await writeJsonl(join(configDir, "sessions", CODEX_DAY_DIR, fileName), lines, mtimeMs ?? FRESH);
  }

  test("threads with parent_thread_id become children; nicknames become agentName", async () => {
    const configDir = await freshDir("codex-link");
    await writeRollout(configDir, "rollout-1-threadA.jsonl", [
      codexSessionMeta({ id: "threadA", threadSource: "user", ts: "2026-01-12T08:00:00.000Z" }),
      { timestamp: "2026-01-12T08:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "SYNTHETIC_FIXTURE build the widget" } },
    ]);
    await writeRollout(configDir, "rollout-2-threadB.jsonl", [
      codexSessionMeta({ id: "threadB", parentThreadId: "threadA", threadSource: "subagent", agentNickname: "Franklin" }),
    ]);
    await writeRollout(configDir, "rollout-3-threadC.jsonl", [
      codexSessionMeta({ id: "threadC", parentThreadId: "threadA", threadSource: "guardian_review" }),
    ]);

    const tree = await readSessionTrees("codex", identity(configDir), OPTS);
    const root = tree.nodes.find((n) => n.id === "threadA")!;
    expect(root.parentId).toBeUndefined();
    expect(root.depth).toBe(0);
    expect(root.title).toContain("build the widget");
    const kid = tree.nodes.find((n) => n.id === "threadB")!;
    expect(kid.parentId).toBe("threadA");
    expect(kid.depth).toBe(1);
    expect(kid.agentName).toBe("Franklin");
    const guard = tree.nodes.find((n) => n.id === "threadC")!;
    expect(guard.parentId).toBe("threadA");
    expect(guard.title).toBe("guardian review");
  });

  test("an internal thread with no parent and an exotic thread_source is skipped", async () => {
    const configDir = await freshDir("codex-skip");
    await writeRollout(configDir, "rollout-x.jsonl", [
      codexSessionMeta({ id: "weird", threadSource: "something_else" }),
    ]);
    const tree = await readSessionTrees("codex", identity(configDir), OPTS);
    expect(tree.nodes).toHaveLength(0);
  });

  test("rollouts whose mtime is outside the window drop out", async () => {
    const configDir = await freshDir("codex-window");
    await writeRollout(configDir, "rollout-old.jsonl", [
      codexSessionMeta({ id: "oldThread", threadSource: "user" }),
    ], OLD);
    const tree = await readSessionTrees("codex", identity(configDir), OPTS);
    expect(tree.nodes).toHaveLength(0);
  });
});

/* ------------------------------------ pi ----------------------------------- */

describe("pi tree", () => {
  test("session headers become flat roots with their recorded cwd", async () => {
    const configDir = await freshDir("pi-flat");
    await writeJsonl(join(configDir, "sessions", "-tmp-proj-a", "2026-01-12T09-00-00-000Z_pisess1.jsonl"), [
      { type: "session", version: 3, id: "pisess1", timestamp: "2026-01-12T09:00:00.000Z", cwd: "/tmp/proj-a" },
      { type: "message", timestamp: "2026-01-12T09:00:05.000Z", message: { role: "user", content: [{ type: "text", text: "SYNTHETIC_FIXTURE pi prompt" }] } },
    ]);
    const tree = await readSessionTrees("pi", identity(configDir), OPTS);
    expect(tree.nodes).toHaveLength(1);
    expect(tree.nodes[0]).toMatchObject({ id: "pisess1", cwd: "/tmp/proj-a", depth: 0 });
    expect(tree.nodes[0]!.title).toContain("pi prompt");
  });
});

/* ----------------------------------- grok ---------------------------------- */

describe("grok tree", () => {
  test("summary.json sessions are flat roots; live chat mtime wins for updatedAt/inProgress", async () => {
    const configDir = await freshDir("grok-flat");
    const sessionDir = join(configDir, "sessions", "%2Ftmp%2Fproj-a", "gidsess1");
    await writeJson(join(sessionDir, "summary.json"), {
      info: { id: "gidsess1", cwd: "/tmp/proj-a" },
      session_summary: "SYNTHETIC_FIXTURE grok summary",
      created_at: "2026-01-12T09:00:00.000Z",
    });
    await writeJsonl(join(sessionDir, "chat_history.jsonl"), [
      { type: "system", content: "SYNTHETIC_FIXTURE system prompt" },
      { type: "user", content: [{ type: "text", text: "hi" }] },
    ], FRESH);

    const tree = await readSessionTrees("grok", identity(configDir), OPTS);
    expect(tree.nodes).toHaveLength(1);
    const node = tree.nodes[0]!;
    expect(node).toMatchObject({ id: "gidsess1", cwd: "/tmp/proj-a", inProgress: true, depth: 0 });
    expect(node.title).toContain("grok summary");
  });
});

/* ----------------------------------- kimi ---------------------------------- */

describe("kimi tree", () => {
  test("index sessions are roots and agents/<dir> dirs become namespaced children", async () => {
    const configDir = await freshDir("kimi-agents");
    const sessionDir = join(configDir, "sessions", "wd_proj_1", "session_kimid1");
    await writeJson(join(sessionDir, "state.json"), kimiState());
    await writeJsonl(join(configDir, "session_index.jsonl"), [kimiIndexLine("session_kimid1", sessionDir, "/tmp/proj-a")]);
    await writeJsonl(join(sessionDir, "agents", "main", "wire.jsonl"), [
      { type: "metadata", protocol_version: "1.5", created_at: String(NOW - 60_000) },
      { type: "turn.prompt", input: [{ type: "text", text: "SYNTHETIC_FIXTURE main task" }], origin: { kind: "user" }, time: String(NOW - 50_000) },
    ], FRESH);
    await writeJsonl(join(sessionDir, "agents", "agent-0", "wire.jsonl"), [
      { type: "metadata", protocol_version: "1.5", created_at: String(NOW - 40_000) },
      { type: "turn.prompt", input: [{ type: "text", text: "SYNTHETIC_FIXTURE sub task" }], origin: { kind: "system_trigger", name: "subagent" }, time: String(NOW - 39_000) },
    ], FRESH);

    const tree = await readSessionTrees("kimi", identity(configDir), OPTS);
    const root = tree.nodes.find((n) => n.id === "session_kimid1")!;
    expect(root.parentId).toBeUndefined();
    const kid = tree.nodes.find((n) => n.id === "session_kimid1/agent-0")!;
    expect(kid.parentId).toBe("session_kimid1");
    expect(kid.depth).toBe(1);
    expect(kid.agentName).toBe("agent-0");
    expect(kid.title).toContain("sub task");
  });
});

/* ------------------------------- crush (zai/ali) ---------------------------- */

interface CrushFixture {
  configDir: string;
  rootId: string;
  childId: string;
}

async function writeCrushDb(provider: string): Promise<CrushFixture> {
  const configDir = await freshDir("crush");
  const dataDir = join(configDir, "data", "proj-one");
  await mkdir(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "crush.db"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL)");
  db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '[]', provider TEXT)");
  const nowS = Math.floor(NOW / 1000);
  db.prepare("INSERT INTO sessions VALUES ($id, $p, $t, $mc, $u, $c)").run({ $id: "crushroot", $p: null, $t: "SYNTHETIC_FIXTURE root session", $mc: 4, $u: nowS, $c: nowS - 600 });
  db.prepare("INSERT INTO sessions VALUES ($id, $p, $t, $mc, $u, $c)").run({ $id: "crushkid", $p: "crushroot", $t: "Untitled Session", $mc: 2, $u: nowS, $c: nowS - 300 });
  db.prepare("INSERT INTO messages VALUES ($id, $s, $r, $parts, $prov)").run({
    $id: "m1", $s: "crushroot", $r: "user",
    $parts: JSON.stringify([{ type: "text", data: { text: "SYNTHETIC_FIXTURE hello" } }]),
    $prov: provider,
  });
  db.close();
  await writeJson(join(configDir, "data", "projects.json"), {
    projects: [{ path: "/tmp/proj-a", data_dir: dataDir, last_accessed: "2026-01-12T09:00:00.000Z" }],
  });
  return { configDir, rootId: "crushroot", childId: "crushkid" };
}

describe("crush tree (zai + ali)", () => {
  test("parent/child sessions link and provider scoping keeps foreign sessions out", async () => {
    const { configDir, rootId, childId } = await writeCrushDb("zai");
    const tree = await readSessionTrees("zai", identity(configDir), OPTS);
    const root = tree.nodes.find((n) => n.id === rootId)!;
    const kid = tree.nodes.find((n) => n.id === childId)!;
    expect(root.parentId).toBeUndefined();
    expect(root.cwd).toBe("/tmp/proj-a");
    expect(root.messageCount).toBe(4);
    expect(root.inProgress).toBe(true);
    expect(kid.parentId).toBe(rootId);
    expect(kid.depth).toBe(1);
    expect(kid.title).toBe("(no summary)"); // crush's "Untitled Session" placeholder
  });

  test("sessions whose messages belong to the other provider are not leaked", async () => {
    const { configDir, rootId, childId } = await writeCrushDb("alibaba");
    const zaiTree = await readSessionTrees("zai", identity(configDir), OPTS);
    // The root's only message is tagged alibaba, so zai must not see it.
    // The CHILD has no messages at all: by the shared ownership rule a
    // session with no provider-tagged messages is visible to every
    // provider (a just-started session must stay resumable).
    expect(zaiTree.nodes.map((n) => n.id)).toEqual([childId]);
    const aliTree = await readSessionTrees("ali", identity(configDir), OPTS);
    expect(aliTree.nodes.map((n) => n.id)).toEqual([rootId, childId]);
  });
});

/* ------------------------------ dispatcher ------------------------------- */

describe("readSessionTrees dispatch", () => {
  test("a tool with no reader answers with an honest unavailable note", async () => {
    const configDir = await freshDir("unavailable");
    const tree = await readSessionTrees("opencode", identity(configDir), OPTS);
    expect(tree.nodes).toEqual([]);
    expect(tree.unavailable).toContain("no session tree reader");
  });

  test("a bucket that is a plain file is ignored (no error, no nodes)", async () => {
    const configDir = await freshDir("err");
    await mkdir(join(configDir, "sessions"), { recursive: true });
    await writeFile(join(configDir, "sessions", "bucket"), "not a dir");
    const tree = await readSessionTrees("grok", identity(configDir), OPTS);
    expect(tree.nodes).toEqual([]);
    expect(tree.error).toBeUndefined();
  });
});
