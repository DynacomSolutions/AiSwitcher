import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, appendFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatNameResolver } from "../../src/browser/chat-name.ts";
import { handleRpc, type ShimContext } from "../../src/browser/mcp-shim.ts";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "ais-chat-name-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const ID = "0a1b2c3d-1111-2222-3333-444455556666";
const jl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
async function claudeFile(...rows: object[]): Promise<string> {
  const proj = join(dir, "projects", "-work-example");
  await mkdir(proj, { recursive: true });
  const f = join(proj, `${ID}.jsonl`);
  await writeFile(f, jl(...rows));
  return f;
}
const userRow = { type: "user", cwd: "/work/example", timestamp: "2026-11-08T10:00:00Z", message: { content: "please look at example.com login" } };

test("claude: auto title, then /rename title wins", async () => {
  const f = await claudeFile(userRow, { type: "ai-title", aiTitle: "Login refactor" });
  let t = 0;
  const get = chatNameResolver({ tool: "claude", configDirs: [dir], id: ID, now: () => t });
  expect(await get()).toBe("Login refactor");
  await appendFile(f, jl({ type: "custom-title", customTitle: "refactor login" }));
  t += 10_000;
  expect(await get()).toBe("Login refactor"); // cached
  t += 25_000;
  expect(await get()).toBe("refactor login");
});

test("claude: first prompt when no title; short id while there is no transcript", async () => {
  const get = chatNameResolver({ tool: "claude", configDirs: [dir], id: ID, now: () => 0, ttlMs: 0 });
  expect(await get()).toBe("0a1b2c");
  await claudeFile(userRow);
  expect(await get()).toBe("please look at example.com login");
});

test("codex: thread name from the index, else first prompt, else short id", async () => {
  const day = join(dir, "sessions", "2026", "11", "08");
  await mkdir(day, { recursive: true });
  const get = chatNameResolver({ tool: "codex", configDirs: [dir], id: ID, now: () => 0, ttlMs: 0 });
  expect(await get()).toBe("0a1b2c");
  await writeFile(join(day, `rollout-2026-11-08T10-00-00-${ID}.jsonl`), jl(
    { type: "session_meta", payload: { id: ID, cwd: "/work/example", timestamp: "2026-11-08T10:00:00Z" } },
    { type: "event_msg", payload: { type: "user_message", message: "fix the example.com checkout" } },
  ));
  expect(await get()).toBe("fix the example.com checkout");
  await writeFile(join(dir, "session_index.jsonl"), jl({ id: "other", thread_name: "nope" }, { id: ID, thread_name: "checkout fix" }));
  expect(await get()).toBe("checkout fix");
});

test("the identity is never used as the name", async () => {
  const get = chatNameResolver({ tool: "claude", configDirs: [dir], id: ID, now: () => 0 }, {});
  expect(await get()).not.toContain("work");
});

test("shim sends the current chat name as session.label; an older shim without chatName still works", async () => {
  const bodies: any[] = [];
  const fetchFn = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return Response.json({ id: "x", ok: true, content: [{ type: "text", text: "ok" }] }); }) as unknown as typeof fetch;
  let name = "abcdef";
  const base: ShimContext = { gatewayUrl: async () => "http://gw.test", token: async () => "tok", session: { id: "abcdef123", identity: "work", label: "abcdef" }, fetch: fetchFn };
  const withName: ShimContext = { ...base, chatName: async () => name };
  const call = (c: ShimContext) => handleRpc({ id: 1, method: "tools/call", params: { name: "tabs_context", arguments: {} } }, c);
  await call(withName);
  name = "refactor login";
  await call(withName);
  await call(base);
  expect(bodies.map((b) => b.session.label)).toEqual(["abcdef", "refactor login", "abcdef"]);
  expect(bodies[1].session.identity).toBe("work");
});

import { findCodexThreadId } from "../../src/browser/codex-thread.ts";
import { contextFromEnv } from "../../src/browser/mcp-shim.ts";

test("claude: CLAUDE_CODE_SESSION_ID is the session key and drives the name; CLAUDE_SESSION_ID is the fallback", async () => {
  await claudeFile(userRow, { type: "ai-title", aiTitle: "Login refactor", sessionId: ID });
  const env = { CLAUDE_CODE_SESSION_ID: ID, CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
  const ctx = contextFromEnv(env, {});
  expect(ctx.session.id).toBe(ID);
  expect(await ctx.chatName!()).toBe("Login refactor");
  expect(contextFromEnv({ CLAUDE_SESSION_ID: "legacy-1", CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv, {}).session.id).toBe("legacy-1");
});

async function rollout(cwd: string, id = ID, extra: object = {}) {
  const day = join(dir, "sessions", "2026", "11", "08");
  await mkdir(day, { recursive: true });
  const f = join(day, `rollout-2026-11-08T10-00-00-${id}.jsonl`);
  await writeFile(f, jl({ type: "session_meta", payload: { id, cwd, timestamp: new Date().toISOString(), ...extra } }));
  return f;
}

test("codex thread id: from the parent's open rollout file", async () => {
  const f = await rollout("/work/example");
  expect(await findCodexThreadId(dir, 1234, "/elsewhere", { openRollouts: () => [f] })).toBe(ID);
});

test("codex thread id: newest rollout with the same cwd created after the parent started", async () => {
  const other = "99999999-aaaa-bbbb-cccc-000000000000";
  await rollout("/work/example", other, { thread_source: "user" });
  await rollout("/work/other", "11111111-aaaa-bbbb-cccc-000000000000");
  const deps = { openRollouts: () => [], parentAgeSec: () => 3600 };
  expect(await findCodexThreadId(dir, 1234, "/work/example", deps)).toBe(other);
  expect(await findCodexThreadId(dir, 1234, "/work/none", deps)).toBeUndefined();
  // A rollout older than the parent is not its thread.
  const old = await rollout("/work/old", "22222222-aaaa-bbbb-cccc-000000000000", { timestamp: "2026-11-08T00:00:01Z" });
  await utimes(old, new Date("2026-11-08T00:00:01Z"), new Date("2026-11-08T00:00:01Z"));
  expect(await findCodexThreadId(dir, 1234, "/work/old", deps)).toBeUndefined();
});

test("codex shim with no id in env: key stays agent-<ppid>, name comes from the derived thread", async () => {
  await rollout(process.cwd());
  await writeFile(join(dir, "session_index.jsonl"), jl({ id: ID, thread_name: "checkout fix" }));
  const ctx = contextFromEnv({ CODEX_HOME: dir, AI_PROFILE_SWITCHER_SESSION: "x" } as NodeJS.ProcessEnv, { tool: "codex" });
  expect(ctx.session.id).toBe(`agent-${process.ppid}`);
  expect(ctx.chatName).toBeDefined();
});
