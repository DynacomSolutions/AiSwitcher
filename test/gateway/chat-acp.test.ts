import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient, AcpError, type AcpHandlers, type AcpIo, type AcpPermission, type AcpUpdate } from "../../src/gateway/chat/acp.ts";

const root = await mkdtemp(join(tmpdir(), "ais-chat-acp-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const STUB = join(import.meta.dir, "fixtures", "stub-acp-agent.ts");

function spawnIo(env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, STUB], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, STUB_ACP_STATE: join(root, "state"), ...env } });
  const lineCbs: Array<(l: string) => void> = [];
  const closeCbs: Array<(r: string) => void> = [];
  let stderr = "";
  const pump = async (stream: ReadableStream<Uint8Array>, onText: (t: string) => void) => {
    const dec = new TextDecoder();
    for await (const c of stream) onText(dec.decode(c, { stream: true }));
  };
  let buf = "";
  const out = pump(proc.stdout, (t) => {
    buf += t;
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      for (const cb of lineCbs) cb(line);
    }
  });
  const err = pump(proc.stderr, (t) => {
    stderr += t;
  });
  void Promise.all([proc.exited, out, err]).then(([code]) => {
    for (const cb of closeCbs) cb(`exited with code ${code}: ${stderr.trim()}`);
  });
  const io: AcpIo = {
    write: (line) => {
      proc.stdin.write(`${line}\n`);
      proc.stdin.flush();
    },
    onLine: (cb) => void lineCbs.push(cb),
    onClose: (cb) => void closeCbs.push(cb),
  };
  return { io, proc, lineCbs };
}

function setup(opts: { env?: Record<string, string>; permission?: AcpHandlers["onPermission"] } = {}) {
  const updates: Array<{ sessionId: string; u: AcpUpdate }> = [];
  const perms: AcpPermission[] = [];
  const { io, proc, lineCbs } = spawnIo(opts.env);
  const client = new AcpClient(io, {
    onUpdate: (sessionId, u) => void updates.push({ sessionId, u }),
    onPermission: async (_s, p) => {
      perms.push(p);
      return opts.permission ? opts.permission(_s, p) : { optionId: p.options[0]?.id };
    },
  });
  return { client, updates, perms, proc, lineCbs };
}

const texts = (us: Array<{ u: AcpUpdate }>) => us.flatMap(({ u }) => (u.kind === "text" ? [u.text] : []));

test("initialize reports http and loadSession", async () => {
  const { client, proc } = setup();
  expect(await client.initialize()).toEqual({ http: true, loadSession: true });
  proc.kill();
});

test("initialize reports loadSession false when the agent turns it off", async () => {
  const { client, proc } = setup({ env: { STUB_ACP_LOAD: "0" } });
  expect((await client.initialize()).loadSession).toBe(false);
  proc.kill();
});

test("newSession returns the id and a config update", async () => {
  const { client, updates, proc } = setup();
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: "/work", mcpServers: [] });
  expect(sessionId).toStartWith("stub-");
  const cfg = updates.find((x) => x.u.kind === "config");
  expect(cfg?.sessionId).toBe(sessionId);
  expect(cfg?.u).toEqual({ kind: "config", models: [{ id: "stub-fast", name: "Stub Fast" }, { id: "stub-deep", name: "Stub Deep" }], efforts: ["low", "high"], current: { model: "stub-fast", effort: "low" } });
  await client.setConfig(sessionId, { model: "stub-deep", effort: "high" });
  proc.kill();
});

test("say streams two text updates before the prompt resolves with end_turn", async () => {
  const { client, updates, proc } = setup();
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: "/work", mcpServers: [] });
  const r = await client.prompt(sessionId, "say:hello");
  expect(r.stopReason).toBe("end_turn");
  expect(texts(updates)).toEqual(["hel", "lo"]);
  proc.kill();
});

test("tool yields a pending then done update with the same toolCallId", async () => {
  const { client, updates, proc } = setup();
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: "/work", mcpServers: [] });
  await client.prompt(sessionId, "tool");
  const tools = updates.flatMap(({ u }) => (u.kind === "tool" ? [u] : []));
  expect(tools).toHaveLength(2);
  expect(tools[0]).toMatchObject({ toolCallId: "tc1", title: "Read file", status: "pending" });
  expect(tools[1]).toMatchObject({ toolCallId: "tc1", status: "completed", result: "file body" });
  proc.kill();
});

test("ask calls onPermission and sends the chosen option back", async () => {
  const { client, updates, perms, proc } = setup({ permission: async () => ({ optionId: "deny" }) });
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: "/work", mcpServers: [] });
  await client.prompt(sessionId, "ask");
  expect(perms).toHaveLength(1);
  expect(perms[0]?.title).toBe("Run command");
  expect(perms[0]?.options.map((o) => o.id)).toEqual(["allow", "deny"]);
  expect(texts(updates)).toEqual(["chose:deny"]);
  proc.kill();
});

test("a handler returning no optionId sends cancelled", async () => {
  const { client, updates, proc } = setup({ permission: async () => ({}) });
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: "/work", mcpServers: [] });
  await client.prompt(sessionId, "ask");
  expect(texts(updates)).toEqual(["cancelled"]);
  proc.kill();
});

test("cancel on slow resolves the prompt with cancelled", async () => {
  const { client, proc } = setup();
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: "/work", mcpServers: [] });
  const p = client.prompt(sessionId, "slow");
  await Bun.sleep(100);
  client.cancel(sessionId);
  expect((await p).stopReason).toBe("cancelled");
  proc.kill();
});

test("fail rejects with AcpError carrying the code", async () => {
  const { client, proc } = setup();
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: "/work", mcpServers: [] });
  const err = await client.prompt(sessionId, "fail").catch((e) => e);
  expect(err).toBeInstanceOf(AcpError);
  expect(err.code).toBe(-32000);
  expect(err.data).toEqual({ why: "requested" });
  proc.kill();
});

test("exit resolves closed with a reason containing the exit code and prompt rejects", async () => {
  const { client } = setup();
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: "/work", mcpServers: [] });
  const p = client.prompt(sessionId, "exit");
  const reason = await client.closed;
  expect(reason).toContain("3");
  expect(reason).toContain("stub exiting");
  await expect(p).rejects.toThrow();
  await expect(client.prompt(sessionId, "say:x")).rejects.toThrow();
});

test("loadSession of an unknown id rejects and of a stored id resolves", async () => {
  const { client, proc } = setup();
  await client.initialize();
  const { sessionId } = await client.newSession({ cwd: "/work", mcpServers: [] });
  await expect(client.loadSession({ sessionId: "nope", cwd: "/work", mcpServers: [] })).rejects.toBeInstanceOf(AcpError);
  await client.loadSession({ sessionId, cwd: "/work", mcpServers: [] });
  proc.kill();
});

test("non-JSON lines are ignored", async () => {
  const { client, lineCbs, proc } = setup();
  await client.initialize();
  for (const cb of lineCbs) {
    cb("not json at all");
    cb("");
    cb("{broken");
  }
  const { sessionId } = await client.newSession({ cwd: "/work", mcpServers: [] });
  expect(sessionId).toStartWith("stub-");
  proc.kill();
});
