import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatNameResolver } from "../../src/browser/chat-name.ts";
import { contextFromEnv } from "../../src/browser/mcp-shim.ts";
import { sessionName } from "../../src/browser/session-label.ts";
import { t3ThreadTitle } from "../../src/browser/t3-thread-title.ts";

let dir: string;
let dbPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ais-t3-title-"));
  dbPath = join(dir, "statev2.sqlite");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function seed(rows: Array<[string, string, string | null]>): void {
  const db = new Database(dbPath);
  db.run("PRAGMA synchronous = OFF");
  db.run("CREATE TABLE IF NOT EXISTS orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL, deleted_at TEXT)");
  for (const r of rows) db.run("INSERT OR REPLACE INTO orchestration_v2_projection_threads (thread_id, title, deleted_at) VALUES (?, ?, ?)", r);
  db.close();
}

const ID = "0a1b2c3d-1111-2222-3333-444455556666";
const env = (extra: Record<string, string> = {}) => ({ T3CODE_THREAD_ID: "thread:one", ...extra }) as NodeJS.ProcessEnv;

test("returns the cleaned title, capped at 60 chars", () => {
  seed([["thread:one", "  Fix   the\n login  ", null], ["thread:long", "x".repeat(100), null]]);
  expect(t3ThreadTitle(env(), dbPath)).toBe("Fix the login");
  expect(t3ThreadTitle({ T3CODE_THREAD_ID: "thread:long" } as NodeJS.ProcessEnv, dbPath)).toHaveLength(60);
});

test("deleted, unknown, missing and unset all give undefined", () => {
  seed([["thread:one", "Gone", "2026-11-01T00:00:00Z"]]);
  expect(t3ThreadTitle(env(), dbPath)).toBeUndefined();
  expect(t3ThreadTitle({ T3CODE_THREAD_ID: "thread:none" } as NodeJS.ProcessEnv, dbPath)).toBeUndefined();
  expect(t3ThreadTitle(env(), join(dir, "missing.sqlite"))).toBeUndefined();
  expect(t3ThreadTitle({} as NodeJS.ProcessEnv, dbPath)).toBeUndefined();
});

test("a changed schema fails soft", () => {
  const db = new Database(dbPath);
  db.run("PRAGMA synchronous = OFF");
  db.run("CREATE TABLE orchestration_v2_projection_threads (id TEXT)");
  db.close();
  expect(t3ThreadTitle(env(), dbPath)).toBeUndefined();
});

test("T3_HOME locates the database", async () => {
  await mkdir(join(dir, "userdata"));
  dbPath = join(dir, "userdata", "statev2.sqlite");
  seed([["thread:one", "From home", null]]);
  expect(t3ThreadTitle(env({ T3CODE_HOME: dir }))).toBe("From home");
});

test("T3 title wins over the transcript title and AIS_SESSION_NAME", async () => {
  seed([["thread:one", "T3 title", null]]);
  const proj = join(dir, "projects", "-work-example");
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, `${ID}.jsonl`), JSON.stringify({ type: "ai-title", aiTitle: "Transcript title" }) + "\n");
  const e = env({ AIS_SESSION_NAME: "Launcher name" });
  const get = chatNameResolver({ tool: "claude", configDirs: [dir], id: ID, t3DbPath: dbPath, now: () => 0 }, e);
  expect(await get()).toBe("T3 title");
  const noT3 = chatNameResolver({ tool: "claude", configDirs: [dir], id: ID, t3DbPath: join(dir, "missing.sqlite"), now: () => 0 }, e);
  expect(await noT3()).toBe("Transcript title");
});

test("deleted thread and missing DB fall back to AIS_SESSION_NAME, then the readable fallback", async () => {
  seed([["thread:one", "Gone", "2026-11-01T00:00:00Z"]]);
  const named = chatNameResolver({ tool: "claude", configDirs: [dir], id: ID, cwd: "/work/example", t3DbPath: dbPath }, env({ AIS_SESSION_NAME: "Launcher name" }));
  expect(await named()).toBe("Launcher name");
  const bare = chatNameResolver({ tool: "claude", configDirs: [dir], id: ID, cwd: "/work/example", t3DbPath: join(dir, "missing.sqlite") }, env());
  expect(await bare()).toBe("Claude in example");
});

test("no session id and no T3 env: readable label, never an id", async () => {
  const claude = chatNameResolver({ tool: "claude", configDirs: [], cwd: "/work/example" }, {});
  expect(await claude()).toBe("Claude in example");
  const agent = chatNameResolver({ configDirs: [], cwd: "/work/example" }, {});
  expect(await agent()).toBe("Agent in example");
  expect(sessionName({}, undefined, "/work/example")).toBe("Agent in example");
});

test("shim label is never the short id or agent-<ppid>", async () => {
  const ctx = contextFromEnv({ CLAUDE_CODE_SESSION_ID: ID, CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv, {});
  expect(ctx.session.id).toBe(ID);
  expect(ctx.session.label).not.toBe(ID.slice(0, 6));
  expect(ctx.session.label).toStartWith("Claude in ");
  const bare = contextFromEnv({} as NodeJS.ProcessEnv, {});
  expect(bare.session.id).toBe(`agent-${process.ppid}`);
  expect(bare.session.label).toStartWith("Agent in ");
  expect(await bare.chatName!()).toStartWith("Agent in ");
});

test("a rename in the database shows after the TTL", async () => {
  seed([["thread:one", "Before", null]]);
  let t = 0;
  const get = chatNameResolver({ configDirs: [], t3DbPath: dbPath, now: () => t }, env());
  expect(await get()).toBe("Before");
  seed([["thread:one", "After", null]]);
  t += 10_000;
  expect(await get()).toBe("Before");
  t += 25_000;
  expect(await get()).toBe("After");
});

test("a failed T3 lookup after a title was found keeps the last T3 title", async () => {
  seed([["thread:one", "Kept title", null]]);
  let t = 0;
  const get = chatNameResolver({ configDirs: [], t3DbPath: dbPath, cwd: "/work/example", now: () => t }, env());
  expect(await get()).toBe("Kept title");
  await rm(dbPath);
  t = 60_000;
  expect(await get()).toBe("Kept title");
});
