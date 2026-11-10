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
  // Today's folder: findCodexThreadId prunes day folders older than the parent's start (minus a day), so a fixed date ages out.
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const day = join(dir, "sessions", String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  await mkdir(day, { recursive: true });
  const f = join(day, `rollout-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T10-00-00-${id}.jsonl`);
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
  // Pin the clock to the rollouts' day folder (2026/11/08): the lookup only scans folders from the day before the parent started.
  const deps = { openRollouts: () => [], parentAgeSec: () => 3600, now: () => Date.parse("2026-11-08T11:00:00Z") };
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

test("session_end never waits for chat-name lookups and reuses the last label", async () => {
  const bodies: any[] = [];
  let hang = false;
  const c: ShimContext = {
    gatewayUrl: async () => "http://gw.test",
    token: async () => "tok",
    session: { id: "s1", identity: "work", label: "fallback" },
    chatName: () => (hang ? new Promise<string>(() => {}) : Promise.resolve("my chat")),
    fetch: (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return Response.json({ id: "x", ok: true, content: [{ type: "text", text: "ok" }] }); }) as unknown as typeof fetch,
  };
  await handleRpc({ id: 1, method: "tools/call", params: { name: "list_browsers", arguments: {} } }, c);
  hang = true;
  const { sendSessionEnd } = await import("../../src/browser/mcp-shim.ts");
  const t = performance.now();
  await sendSessionEnd(c);
  expect(performance.now() - t).toBeLessThan(500);
  expect(bodies.map((b) => b.tool)).toEqual(["list_browsers", "session_end"]);
  expect(bodies[1].session.label).toBe("my chat");
});

test("a slow chat-name lookup does not hold a normal call up for long", async () => {
  const bodies: any[] = [];
  const c: ShimContext = {
    gatewayUrl: async () => "http://gw.test",
    token: async () => "tok",
    session: { id: "s2", identity: "work", label: "fallback" },
    chatName: () => new Promise<string>(() => {}),
    fetch: (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return Response.json({ id: "x", ok: true, content: [{ type: "text", text: "ok" }] }); }) as unknown as typeof fetch,
  };
  const t = performance.now();
  await handleRpc({ id: 1, method: "tools/call", params: { name: "list_browsers", arguments: {} } }, c);
  expect(performance.now() - t).toBeLessThan(3000);
  expect(bodies[0].session.label).toBe("fallback");
});

test("codex: title from a large rollout among many others is found by file name without a full scan", async () => {
  const day = join(dir, "sessions", "2026", "11", "09");
  await mkdir(day, { recursive: true });
  const meta = (id: string) => ({ type: "session_meta", payload: { id, cwd: "/work/example", timestamp: "2026-11-09T10:00:00Z" } });
  for (let i = 0; i < 100; i++) {
    const other = `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
    await writeFile(join(day, `rollout-2026-11-09T10-00-00-${other}.jsonl`), jl(meta(other)));
  }
  const filler = JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(1_000_000) } }) + "\n";
  await writeFile(join(day, `rollout-2026-11-09T10-00-00-${ID}.jsonl`), jl(meta(ID), { type: "event_msg", payload: { type: "user_message", message: "fix the example.com login" } }) + filler.repeat(20));
  const get = chatNameResolver({ tool: "codex", configDirs: [dir], id: ID, now: () => 0 });
  const t = performance.now();
  expect(await get()).toBe("fix the example.com login");
  expect(performance.now() - t).toBeLessThan(1000);
});

test("codex: non-object JSON lines in session_index.jsonl do not throw", async () => {
  await writeFile(join(dir, "session_index.jsonl"), `null\n42\n"str"\n[1]\n${JSON.stringify({ id: ID, thread_name: "renamed chat" })}\n`);
  const get = chatNameResolver({ tool: "codex", configDirs: [dir], id: ID, now: () => 0 });
  expect(await get()).toBe("renamed chat");
  // An empty id used to match the missing id of an unparsable line and throw on `entry.thread_name`.
  const { codexSessionTitle } = await import("../../src/cli/sessions/codex.ts");
  expect(await codexSessionTitle(dir, "")).toBeUndefined();
});
