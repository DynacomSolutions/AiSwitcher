import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Hono } from "hono";
import { BROWSER_TOOLS } from "../../src/browser/protocol.ts";
import { BROWSER_INSTRUCTIONS, handleRpc, STOPPED_BY_USER_NOTE, type ShimContext } from "../../src/browser/mcp-shim.ts";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES, validateToolArgs } from "../../src/browser/tool-args.ts";

let seen: { auth: string | null; body: any }[] = [];
let reply: unknown = {};
const app = new Hono();
app.post("/browser/call", async (c) => {
  seen.push({ auth: c.req.header("authorization") ?? null, body: await c.req.json() });
  return c.json(reply as object);
});
const ctx = (url = "http://gw.test/"): ShimContext => ({
  gatewayUrl: async () => url,
  token: async () => "tok",
  session: { id: "abcdef123", identity: "work", label: "work / abcdef" },
  fetch: ((u: string, init: RequestInit) => app.request(u, init)) as unknown as typeof fetch,
});
afterEach(() => { seen = []; });

const call = (name: string, args: object = {}) => handleRpc({ id: 1, method: "tools/call", params: { name, arguments: args } }, ctx()) as Promise<any>;

test("initialize and notification", async () => {
  const r: any = await handleRpc({ id: 1, method: "initialize" }, ctx());
  expect(r.result.serverInfo.name).toBe("ais-browser");
  expect(r.result.instructions).toBe(BROWSER_INSTRUCTIONS);
  expect(r.result.instructions).toContain("close_tab");
  expect(await handleRpc({ method: "notifications/initialized" }, ctx())).toBeUndefined();
});

test("tools/list returns every tool; browser prop on all but list_browsers", async () => {
  const r: any = await handleRpc({ id: 2, method: "tools/list" }, ctx());
  expect(r.result.tools.map((t: any) => t.name)).toEqual([...BROWSER_TOOLS]);
  // The agent names files on its own machine (`paths`); the content field the shim sends on (`files`) is not offered to it.
  const upload = r.result.tools.find((t: any) => t.name === "upload_file");
  expect(Object.keys(upload.inputSchema.properties).sort()).toEqual(["browser", "coordinate", "paths", "ref", "tabId"]);
  expect(upload.inputSchema.required).toEqual(["tabId", "paths"]);
  for (const t of r.result.tools) {
    expect(t.inputSchema.properties.browser !== undefined).toBe(t.name !== "list_browsers");
  }
});

test("tools/list tells the agent not to close a tab while the user must act in it", async () => {
  const r: any = await handleRpc({ id: 2, method: "tools/list" }, ctx());
  const desc = (n: string) => r.result.tools.find((t: any) => t.name === n).description as string;
  expect(desc("close_tab")).toContain("never while a step in it waits for the user");
  expect(desc("tabs_create")).toContain("close_tab");
});

test("tools/call posts to the gateway and maps image content", async () => {
  reply = { id: "x", ok: true, content: [{ type: "text", text: "hi" }, { type: "image", mimeType: "image/jpeg", data: "QQ==" }] };
  const r = await call("screenshot", { tabId: 3, browser: "b1" });
  expect(r.result.content).toEqual([{ type: "text", text: "hi" }, { type: "image", data: "QQ==", mimeType: "image/jpeg" }]);
  expect(r.result.isError).toBeUndefined();
  expect(seen[0]).toEqual({ auth: "Bearer tok", body: { browser: "b1", session: { id: "abcdef123", identity: "work", label: "work / abcdef" }, tool: "screenshot", args: { tabId: 3 } } });
});

test("upload_file reads the files on the agent's machine and sends their content, never a path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ais-upload-"));
  try {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 7]);
    await writeFile(join(dir, "logo.png"), bytes);
    await writeFile(join(dir, "notes.txt"), "hello");
    await writeFile(join(dir, "blob"), "x");
    reply = { id: "x", ok: true, content: [{ type: "text", text: "Uploaded logo.png." }] };
    const r = await call("upload_file", { tabId: 3, ref: "ref_1", browser: "b1", paths: [join(dir, "logo.png"), join(dir, "notes.txt"), join(dir, "blob")] });
    expect(r.result.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body.args).toEqual({
      tabId: 3,
      ref: "ref_1",
      files: [
        { name: "logo.png", mimeType: "image/png", data: Buffer.from(bytes).toString("base64") },
        { name: "notes.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") },
        { name: "blob", mimeType: "application/octet-stream", data: "eA==" },
      ],
    });
    expect(JSON.stringify(seen[0]!.body)).not.toContain(dir);
    expect(validateToolArgs("upload_file", seen[0]!.body.args)).toBeUndefined();

    // Refused on the agent's machine: nothing is sent to the gateway.
    seen = [];
    const text = async (paths: unknown) => (await call("upload_file", { tabId: 3, ref: "ref_1", paths })).result.content[0].text as string;
    expect(await text([join(dir, "missing.png")])).toBe(`bad_args: ${join(dir, "missing.png")} is not a file on this machine`);
    expect(await text([dir])).toBe(`bad_args: ${dir} is not a file on this machine`);
    expect(await text([])).toBe("bad_args: paths must be a list of file paths");
    expect(await text("logo.png")).toBe("bad_args: paths must be a list of file paths");
    expect(await text(Array.from({ length: MAX_UPLOAD_FILES + 1 }, () => join(dir, "blob")))).toBe(`bad_args: paths allows at most ${MAX_UPLOAD_FILES} files`);
    await writeFile(join(dir, "big.bin"), new Uint8Array(MAX_UPLOAD_BYTES));
    expect(await text([join(dir, "big.bin"), join(dir, "blob")])).toBe(`bad_args: files are ${MAX_UPLOAD_BYTES + 1} bytes in total; the limit is ${MAX_UPLOAD_BYTES} bytes`);
    expect(seen).toHaveLength(0);
    // Exactly at the limit is allowed.
    expect((await call("upload_file", { tabId: 3, ref: "ref_1", paths: [join(dir, "big.bin")] })).result.isError).toBeUndefined();
    expect(validateToolArgs("upload_file", seen[0]!.body.args)).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a gateway base with a path prefix keeps the prefix on /browser/call", async () => {
  reply = { id: "x", ok: true, content: [{ type: "text", text: "hi" }] };
  const urls: string[] = [];
  const base = ctx("https://gw.example.com/gateway/");
  const spy = { ...base, fetch: ((u: string, init: RequestInit) => { urls.push(u); return app.request(u, init); }) as unknown as typeof fetch };
  await handleRpc({ id: 1, method: "tools/call", params: { name: "tabs_context", arguments: {} } }, spy);
  expect(urls).toEqual(["https://gw.example.com/gateway/browser/call"]);
});

test("error codes become isError text; stopped_by_user adds the sentence", async () => {
  reply = { id: "x", ok: false, error: "no_browser", message: "none" };
  expect((await call("tabs_context")).result).toEqual({ isError: true, content: [{ type: "text", text: "no_browser: none" }] });
  reply = { id: "x", ok: false, error: "stopped_by_user", message: "stopped" };
  expect((await call("tabs_context")).result.content[0].text).toBe(`stopped_by_user: stopped ${STOPPED_BY_USER_NOTE}`);
});

test("HTTP failure and missing token are tool errors", async () => {
  const r: any = await handleRpc({ id: 1, method: "tools/call", params: { name: "tabs_context" } }, { ...ctx(), token: async () => undefined });
  expect(r.result.isError).toBe(true);
  expect(seen).toEqual([]);
});

import { parseShimArgs, runMcpShim } from "../../src/browser/mcp-shim.ts";
import { Readable } from "node:stream";

async function stdio(lines: string[], c: ShimContext = ctx()): Promise<any[]> {
  const out: string[] = [];
  await runMcpShim(c, Readable.from(lines.map((l) => `${l}\n`)), (l) => out.push(l));
  return out.map((l) => JSON.parse(l));
}

test("stdio: malformed, non-object, unknown tool, responses ignored", async () => {
  const r = await stdio([
    "{nope",
    "[1]",
    "42",
    JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } }),
    JSON.stringify({ jsonrpc: "2.0", id: 6, method: "bogus" }),
  ]);
  expect(r.map((x) => x.error?.code ?? null)).toEqual([-32700, -32600, -32600, null, -32601]);
  expect(r[3].result.isError).toBe(true);
  expect(r[3].result.content[0].text).toContain("unknown tool");
});

test("stdio: gateway non-200 is an isError result", async () => {
  const c = ctx();
  c.fetch = (async () => new Response(JSON.stringify({ error: "unauthorised" }), { status: 401 })) as unknown as typeof fetch;
  const r = await stdio([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tabs_context", arguments: {} } })], c);
  expect(r[0].result.isError).toBe(true);
  expect(r[0].result.content[0].text).toContain("401");
});

test("initialize echoes known protocol versions, else latest", async () => {
  const v = async (p?: string): Promise<string> => ((await handleRpc({ id: 1, method: "initialize", params: p ? { protocolVersion: p } : {} }, ctx())) as any).result.protocolVersion;
  expect(await v("2025-03-26")).toBe("2025-03-26");
  expect(await v("2024-11-05")).toBe("2024-11-05");
  expect(await v("1999-01-01")).toBe("2025-06-18");
  expect(await v()).toBe("2025-06-18");
});

test("notifications/cancelled aborts the in-flight fetch", async () => {
  const c = ctx();
  c.inflight = new Map();
  c.fetch = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
  const p = handleRpc({ id: 7, method: "tools/call", params: { name: "wait", arguments: { seconds: 5 } } }, c) as Promise<any>;
  await new Promise((r) => setTimeout(r, 20));
  await handleRpc({ method: "notifications/cancelled", params: { requestId: 7 } }, c);
  expect((await p).result.isError).toBe(true);
});

test("token read from --config-dir without env", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { contextFromEnv } = await import("../../src/browser/mcp-shim.ts");
  const d = mkdtempSync(join(tmpdir(), "ais-shim-"));
  writeFileSync(join(d, "ais-browser-token"), "tok-from-file\n");
  const c = contextFromEnv({}, parseShimArgs(["browser", "mcp", "--config-dir", d, "--identity", "work", "--gateway", "http://gw"]));
  expect(await c.token()).toBe("tok-from-file");
  expect(await c.gatewayUrl()).toBe("http://gw");
  expect(c.session.label).not.toContain("work"); // no identity in the label
  expect(contextFromEnv({ CLAUDE_SESSION_ID: "sess-123456", AIS_SESSION_NAME: "  Fix   login  " }, parseShimArgs(["browser", "mcp", "--identity", "work"])).session.label).toBe("Fix login");
  rmSync(d, { recursive: true });
});

test("pool mode resolves the active member per call, stable session id, clear missing-token error", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { contextFromEnv } = await import("../../src/browser/mcp-shim.ts");
  const root = mkdtempSync(join(tmpdir(), "ais-shim-pool-"));
  for (const n of ["a", "b", "c"]) mkdirSync(join(root, n));
  writeFileSync(join(root, "a", "ais-browser-token"), "tok-a\n");
  writeFileSync(join(root, "b", "ais-browser-token"), "tok-b\n");
  const registry = join(root, "identities.json");
  const write = (active: string) => writeFileSync(registry, JSON.stringify({ version: 1, identities: [
    ...["a", "b", "c"].map((n) => ({ name: n, label: n, configDir: join(root, n) })),
    { name: "pool", label: "pool", configDir: join(root, "pool"), swapPool: { accounts: ["a", "b", "c"], active } },
  ] }));
  write("a");
  reply = { id: "x", ok: true, content: [{ type: "text", text: "ok" }] };
  const base = contextFromEnv({ CLAUDE_SESSION_ID: "sess-123456" }, { pool: "pool", tool: "claude", registryPath: registry });
  const c: ShimContext = { ...base, gatewayUrl: async () => "http://gw.test/", fetch: ((u: string, init: RequestInit) => app.request(u, init)) as unknown as typeof fetch };
  const go = () => handleRpc({ id: 1, method: "tools/call", params: { name: "tabs_context" } }, c) as Promise<any>;
  await go();
  write("b");
  await go();
  expect(seen.map((s) => s.auth)).toEqual(["Bearer tok-a", "Bearer tok-b"]);
  expect(seen.map((s) => s.body.session)).toEqual([
    { id: "sess-123456", identity: "a", label: `Claude in ${basename(process.cwd())}` },
    { id: "sess-123456", identity: "b", label: `Claude in ${basename(process.cwd())}` },
  ]);
  write("c");
  const r = await go();
  expect(r.result.isError).toBe(true);
  expect(r.result.content[0].text).toBe("no AIS Browser agent token for identity c; run ais browser agent-token c");
  expect(seen.length).toBe(2);
  mkdirSync(join(root, "d"));
  writeFileSync(join(root, "d", "ais-browser-token"), "tok-d\n");
  writeFileSync(registry, JSON.stringify({ version: 1, identities: [
    ...["a", "d"].map((n) => ({ name: n, label: n, configDir: join(root, n) })),
    { name: "pool", label: "pool", configDir: join(root, "pool"), swapPool: { accounts: ["a", "d"], disallowed: ["d"], active: "d" } },
  ] }));
  expect((await go()).result.content[0].text).toBe("active pool member d is not allowed in pool pool");
  writeFileSync(registry, JSON.stringify({ version: 1, identities: [
    { name: "a", label: "a", configDir: join(root, "a") },
    { name: "pool", label: "pool", configDir: join(root, "pool"), swapPool: { accounts: ["a", "ghost"], active: "ghost" } },
  ] }));
  expect((await go()).result.content[0].text).toContain("is not a known identity");
  expect(seen.length).toBe(2);
  rmSync(root, { recursive: true });
});

test("parseShimArgs reads --pool and --tool", () => {
  expect(parseShimArgs(["browser", "mcp", "--pool", "p", "--tool=codex"])).toEqual({ pool: "p", tool: "codex" });
});

test("session label is readable and never the session id", async () => {
  const { contextFromEnv } = await import("../../src/browser/mcp-shim.ts");
  const dirName = basename(process.cwd());
  const uuid = "3f2a9c1e-1111-4222-8333-444455556666";
  expect(contextFromEnv({ CLAUDE_SESSION_ID: uuid }, { identity: "work" }).session.label).toBe(`Claude in ${dirName}`);
  expect(contextFromEnv({ CLAUDE_SESSION_ID: "live-proof" }, { identity: "work" }).session.label).toBe(`Claude in ${dirName}`);
  expect(contextFromEnv({ CODEX_SESSION_ID: "live-proof" }, { identity: "work" }).session.label).toBe(`Codex in ${dirName}`);
  expect(contextFromEnv({ CLAUDE_SESSION_ID: uuid, AIS_SESSION_NAME: "My chat" }, { identity: "work" }).session.label).toBe("My chat");
});

test("without an agent session id the session id is stable across shim respawns", async () => {
  const { contextFromEnv } = await import("../../src/browser/mcp-shim.ts");
  const a = contextFromEnv({}, { identity: "work" }).session.id;
  expect(contextFromEnv({}, { identity: "work" }).session.id).toBe(a);
  expect(contextFromEnv({ CLAUDE_SESSION_ID: "abc" }, { identity: "work" }).session.id).toBe("abc");
});

test("stdin close sends one session_end with the session id, only after a browser call", async () => {
  await stdio([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })]);
  expect(seen).toEqual([]); // a shim that never made a browser call stays silent
  reply = { id: "x", ok: true, content: [{ type: "text", text: "[]" }] };
  await stdio([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tabs_context", arguments: {} } })]);
  expect(seen.map((s) => s.body.tool)).toEqual(["tabs_context", "session_end"]);
  expect(seen[1]!.body.session.id).toBe("abcdef123");
  expect(seen[1]!.auth).toBe("Bearer tok");
});

test("session_end is not exposed as an MCP tool and cannot be called through tools/call", async () => {
  const list: any = await handleRpc({ id: 1, method: "tools/list" }, ctx());
  expect(list.result.tools.map((t: any) => t.name)).not.toContain("session_end");
  const r: any = await handleRpc({ id: 2, method: "tools/call", params: { name: "session_end" } }, ctx());
  expect(r.result.isError).toBe(true);
});
