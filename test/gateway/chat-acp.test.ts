import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient, AcpError, createLineReader, type AcpHandlers, type AcpIo, type AcpPermission, type AcpUpdate } from "../../src/gateway/chat/acp.ts";

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
  const reader = createLineReader({
    maxBytes: 4096,
    onLine: (line) => {
      for (const cb of lineCbs) cb(line);
    },
    onOverflow: () => {
      for (const cb of closeCbs) cb("line too long");
      proc.kill();
    },
  });
  const out = (async () => {
    for await (const c of proc.stdout) reader.push(c);
  })();
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

/** Run a test body with a stub agent and always kill the agent process. */
async function withAgent(opts: Parameters<typeof setup>[0], fn: (a: ReturnType<typeof setup>) => Promise<void>) {
  const a = setup(opts);
  try {
    await fn(a);
  } finally {
    a.proc.kill();
  }
}

const texts = (us: Array<{ u: AcpUpdate }>) => us.flatMap(({ u }) => (u.kind === "text" ? [u.text] : []));

const NEW = { cwd: "/work", mcpServers: [] };

test("initialize reports http and loadSession", () =>
  withAgent({}, async ({ client }) => {
    expect(await client.initialize()).toEqual({ http: true, loadSession: true });
  }));

test("initialize reports loadSession false when the agent turns it off", () =>
  withAgent({ env: { STUB_ACP_LOAD: "0" } }, async ({ client }) => {
    expect((await client.initialize()).loadSession).toBe(false);
  }));

test("newSession returns the id and a config update", () =>
  withAgent({}, async ({ client, updates }) => {
    await client.initialize();
    const { sessionId } = await client.newSession(NEW);
    expect(sessionId).toStartWith("stub-");
    const cfg = updates.find((x) => x.u.kind === "config");
    expect(cfg?.sessionId).toBe(sessionId);
    expect(cfg?.u).toEqual({ kind: "config", models: [{ id: "stub-fast", name: "Stub Fast" }, { id: "stub-deep", name: "Stub Deep" }], efforts: ["low", "high"], current: { model: "stub-fast", effort: "low" } });
    await client.setConfig(sessionId, { model: "stub-deep", effort: "high" });
  }));

test("say streams two text updates before the prompt resolves with end_turn", () =>
  withAgent({}, async ({ client, updates }) => {
    await client.initialize();
    const { sessionId } = await client.newSession(NEW);
    const r = await client.prompt(sessionId, "say:hello");
    expect(r.stopReason).toBe("end_turn");
    expect(texts(updates)).toEqual(["hel", "lo"]);
  }));

test("tool yields a pending then done update with the same toolCallId", () =>
  withAgent({}, async ({ client, updates }) => {
    await client.initialize();
    const { sessionId } = await client.newSession(NEW);
    await client.prompt(sessionId, "tool");
    const tools = updates.flatMap(({ u }) => (u.kind === "tool" ? [u] : []));
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ toolCallId: "tc1", title: "Read file", status: "pending" });
    expect(tools[1]).toMatchObject({ toolCallId: "tc1", status: "completed", result: "file body" });
  }));

test("ask calls onPermission and sends the chosen option back", () =>
  withAgent({ permission: async () => ({ optionId: "deny" }) }, async ({ client, updates, perms }) => {
    await client.initialize();
    const { sessionId } = await client.newSession(NEW);
    await client.prompt(sessionId, "ask");
    expect(perms).toHaveLength(1);
    expect(perms[0]?.title).toBe("Run command");
    expect(perms[0]?.options.map((o) => o.id)).toEqual(["allow", "deny"]);
    expect(texts(updates)).toEqual(["chose:deny"]);
  }));

test("a handler returning no optionId sends cancelled", () =>
  withAgent({ permission: async () => ({}) }, async ({ client, updates }) => {
    await client.initialize();
    const { sessionId } = await client.newSession(NEW);
    await client.prompt(sessionId, "ask");
    expect(texts(updates)).toEqual(["cancelled"]);
  }));

test("an optionId that is not in the options sends cancelled", () =>
  withAgent({ permission: async () => ({ optionId: "made-up" }) }, async ({ client, updates }) => {
    await client.initialize();
    const { sessionId } = await client.newSession(NEW);
    await client.prompt(sessionId, "ask");
    expect(texts(updates)).toEqual(["cancelled"]);
  }));

test("cancel answers a pending permission with cancelled", () =>
  withAgent({ permission: () => new Promise(() => {}) }, async ({ client, updates, perms }) => {
    await client.initialize();
    const { sessionId } = await client.newSession(NEW);
    const p = client.prompt(sessionId, "ask");
    while (perms.length === 0) await Bun.sleep(5);
    client.cancel(sessionId);
    await p;
    expect(texts(updates)).toEqual(["cancelled"]);
  }));

test("cancel on slow resolves the prompt with cancelled", () =>
  withAgent({}, async ({ client }) => {
    await client.initialize();
    const { sessionId } = await client.newSession(NEW);
    const p = client.prompt(sessionId, "slow");
    client.cancel(sessionId);
    expect((await p).stopReason).toBe("cancelled");
  }));

test("fail rejects with AcpError carrying the code", () =>
  withAgent({}, async ({ client }) => {
    await client.initialize();
    const { sessionId } = await client.newSession(NEW);
    const err = await client.prompt(sessionId, "fail").catch((e) => e);
    expect(err).toBeInstanceOf(AcpError);
    expect(err.code).toBe(-32000);
    expect(err.data).toEqual({ why: "requested" });
  }));

test("exit resolves closed with a reason containing the exit code and prompt rejects", () =>
  withAgent({}, async ({ client }) => {
    await client.initialize();
    const { sessionId } = await client.newSession(NEW);
    const p = client.prompt(sessionId, "exit");
    const reason = await client.closed;
    expect(reason).toContain("3");
    expect(reason).toContain("stub exiting");
    await expect(p).rejects.toThrow();
    await expect(client.prompt(sessionId, "say:x")).rejects.toThrow();
  }));

test("loadSession of an unknown id rejects and of a stored id resolves", () =>
  withAgent({}, async ({ client }) => {
    await client.initialize();
    const { sessionId } = await client.newSession(NEW);
    await expect(client.loadSession({ sessionId: "nope", cwd: "/work", mcpServers: [] })).rejects.toBeInstanceOf(AcpError);
    await client.loadSession({ sessionId, cwd: "/work", mcpServers: [] });
  }));

test("loadSession parses the config, then setConfig effort works", () =>
  withAgent({}, async ({ client, updates }) => {
    await client.initialize();
    const { sessionId } = await client.newSession(NEW);
    // A second client on a fresh agent process has no config ids until it loads the session.
    const b = setup({});
    try {
      await b.client.initialize();
      await expect(b.client.setConfig(sessionId, { effort: "high" })).rejects.toBeInstanceOf(AcpError);
      // The state file is shared, so the second agent knows the id.
      await b.client.loadSession({ sessionId, cwd: "/work", mcpServers: [] });
      expect(b.updates.some((x) => x.u.kind === "config")).toBe(true);
      await b.client.setConfig(sessionId, { effort: "high" });
    } finally {
      b.proc.kill();
    }
    expect(updates.length).toBeGreaterThan(0);
  }));

test("non-JSON lines are ignored", () =>
  withAgent({}, async ({ client, lineCbs }) => {
    await client.initialize();
    for (const cb of lineCbs) {
      cb("not json at all");
      cb("");
      cb("{broken");
      cb("[1,2]");
      cb("null");
    }
    const { sessionId } = await client.newSession(NEW);
    expect(sessionId).toStartWith("stub-");
  }));

// Hostile and edge cases with a scripted connection.
function fake(opts: { requestTimeoutMs?: number; writeThrows?: boolean; updateThrows?: boolean } = {}) {
  const written: any[] = [];
  const lineCbs: Array<(l: string) => void> = [];
  const closeCbs: Array<(r: string) => void> = [];
  const updates: Array<{ sessionId: string; u: AcpUpdate }> = [];
  const state = { writeThrows: opts.writeThrows ?? false };
  const io: AcpIo = {
    write: (l) => {
      if (state.writeThrows) throw new Error("pipe broken");
      written.push(JSON.parse(l));
    },
    onLine: (cb) => void lineCbs.push(cb),
    onClose: (cb) => void closeCbs.push(cb),
  };
  const client = new AcpClient(
    io,
    {
      onUpdate: (sessionId, u) => {
        updates.push({ sessionId, u });
        if (opts.updateThrows) throw new Error("handler broke");
      },
      onPermission: async (_s, p) => ({ optionId: p.options[0]?.id }),
    },
    { requestTimeoutMs: opts.requestTimeoutMs },
  );
  const feed = (o: unknown) => lineCbs.forEach((cb) => cb(JSON.stringify(o)));
  const reply = (id: number, result: unknown) => feed({ jsonrpc: "2.0", id, result });
  const lastId = () => written[written.length - 1].id as number;
  return { client, written, updates, state, feed, reply, lastId, close: (r: string) => closeCbs.forEach((cb) => cb(r)) };
}

async function openSession(f: ReturnType<typeof fake>) {
  const init = f.client.initialize();
  f.reply(f.lastId(), { protocolVersion: 1, agentCapabilities: {} });
  await init;
  const p = f.client.newSession(NEW);
  f.reply(f.lastId(), { sessionId: "s1" });
  return (await p).sessionId;
}

test("a request to an agent that never answers rejects with an AcpError on timeout", async () => {
  const f = fake({ requestTimeoutMs: 30 });
  const err = await f.client.initialize().catch((e) => e);
  expect(err).toBeInstanceOf(AcpError);
  expect(err.message).toContain("timed out");
});

test("a prompt has no timeout", async () => {
  const f = fake({ requestTimeoutMs: 20 });
  const sid = await openSession(f);
  let settled = false;
  const p = f.client.prompt(sid, "x").finally(() => {
    settled = true;
  });
  await Bun.sleep(80);
  expect(settled).toBe(false);
  f.reply(f.lastId(), { stopReason: "end_turn" });
  await p;
});

test("a throwing write closes the client and rejects", async () => {
  const f = fake();
  f.state.writeThrows = true;
  await expect(f.client.initialize()).rejects.toThrow();
  expect(await f.client.closed).toContain("write failed");
});

test("a throwing onUpdate does not stop later lines", async () => {
  const f = fake({ updateThrows: true });
  const sid = await openSession(f);
  const p = f.client.prompt(sid, "x");
  const chunk = (text: string) => f.feed({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  chunk("a");
  chunk("b");
  f.reply(f.lastId(), { stopReason: "end_turn" });
  expect((await p).stopReason).toBe("end_turn");
  expect(f.updates.length).toBe(2);
});

test("a tool update without status or title leaves them out", async () => {
  const f = fake();
  const sid = await openSession(f);
  const upd = (u: object) => f.feed({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: u } });
  upd({ sessionUpdate: "tool_call", toolCallId: "t", title: "T", status: "in_progress" });
  upd({ sessionUpdate: "tool_call_update", toolCallId: "t", content: [{ type: "content", content: { type: "text", text: "partial" } }] });
  const [a, b] = f.updates.map((x) => x.u);
  expect(a).toMatchObject({ status: "in_progress", title: "T" });
  expect(b).toEqual({ kind: "tool", toolCallId: "t", result: "partial" });
});

test("updates for an unknown session are dropped", async () => {
  const f = fake();
  await openSession(f);
  f.feed({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "other", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } } });
  expect(f.updates.filter((x) => x.u.kind === "text")).toEqual([]);
});

test("a permission request for an unknown session is answered cancelled", async () => {
  const f = fake();
  await openSession(f);
  f.feed({ jsonrpc: "2.0", id: "p", method: "session/request_permission", params: { sessionId: "other", options: [{ optionId: "a", name: "A", kind: "allow_once" }] } });
  await Bun.sleep(10);
  expect(f.written.at(-1)).toEqual({ jsonrpc: "2.0", id: "p", result: { outcome: { outcome: "cancelled" } } });
});

test("a malformed error, stopReason or protocolVersion rejects", async () => {
  const f = fake();
  const init = f.client.initialize();
  f.reply(f.lastId(), { protocolVersion: 2 });
  await expect(init).rejects.toBeInstanceOf(AcpError);
  const sid = await openSession(f);
  const p1 = f.client.prompt(sid, "x");
  f.feed({ jsonrpc: "2.0", id: f.lastId(), error: "boom" });
  await expect(p1).rejects.toBeInstanceOf(AcpError);
  const p2 = f.client.prompt(sid, "x");
  f.reply(f.lastId(), { stopReason: 5 });
  await expect(p2).rejects.toBeInstanceOf(AcpError);
});

test("lines after close are not dispatched and close clears state", async () => {
  const f = fake();
  const sid = await openSession(f);
  f.close("gone");
  f.feed({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } } } });
  expect(f.updates.filter((x) => x.u.kind === "text")).toEqual([]);
  expect(await f.client.closed).toBe("gone");
});

test("line reader handles input byte by byte, with CRLF and split UTF-8", () => {
  const lines: string[] = [];
  const r = createLineReader({ onLine: (l) => void lines.push(l), onOverflow: () => lines.push("OVERFLOW") });
  for (const b of new TextEncoder().encode('{"a":"é"}\r\n{"b":2}\n')) r.push(new Uint8Array([b]));
  expect(lines).toEqual(['{"a":"é"}', '{"b":2}']);
});

test("line reader handles three messages in one chunk", () => {
  const lines: string[] = [];
  const r = createLineReader({ onLine: (l) => void lines.push(l), onOverflow: () => {} });
  r.push("a\nb\nc\npart");
  r.push("ial\n");
  expect(lines).toEqual(["a", "b", "c", "partial"]);
});

test("line reader reports a line of cap plus one byte once and stops", () => {
  const lines: string[] = [];
  let overflows = 0;
  const r = createLineReader({ maxBytes: 8, onLine: (l) => void lines.push(l), onOverflow: () => void overflows++ });
  r.push("12345678\n");
  r.push("123456789\n");
  r.push("ok\n");
  expect(lines).toEqual(["12345678"]);
  expect(overflows).toBe(1);
  const r2 = createLineReader({ maxBytes: 8, onLine: () => {}, onOverflow: () => void overflows++ });
  r2.push("123456789");
  expect(overflows).toBe(2);
});

test("an oversized line from the agent closes the client with line too long", () =>
  withAgent({}, async ({ client, lineCbs }) => {
    await client.initialize();
    const p = client.prompt("stub-none", `say:${"x".repeat(10_000)}`);
    const reason = await client.closed;
    expect(reason).toBe("line too long");
    await expect(p).rejects.toThrow();
    expect(lineCbs.length).toBe(1);
  }));

test("a failed loadSession of a live id keeps the session known", async () => {
  const f = fake();
  const sid = await openSession(f);
  const p = f.client.loadSession({ sessionId: sid, cwd: "/work", mcpServers: [] });
  f.feed({ jsonrpc: "2.0", id: f.lastId(), error: { code: -32002, message: "unknown session" } });
  await expect(p).rejects.toBeInstanceOf(AcpError);
  f.feed({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still" } } } });
  expect(f.updates.filter((x) => x.u.kind === "text")).toHaveLength(1);
});

test("an error of null next to a result is a success", async () => {
  const f = fake();
  const init = f.client.initialize();
  f.feed({ jsonrpc: "2.0", id: f.lastId(), error: null, result: { protocolVersion: 1, agentCapabilities: {} } });
  expect(await init).toEqual({ http: false, loadSession: false });
});

test("a duplicate in-flight permission id is answered cancelled and the first waiter stays", async () => {
  const f = fake();
  const sid = await openSession(f);
  const req = () => f.feed({ jsonrpc: "2.0", id: "dup", method: "session/request_permission", params: { sessionId: sid, options: [{ optionId: "a", name: "A", kind: "allow_once" }] } });
  req();
  req();
  await Bun.sleep(10);
  const answers = f.written.filter((w) => w.id === "dup").map((w) => w.result.outcome);
  expect(answers).toHaveLength(2);
  expect(answers[0]).toEqual({ outcome: "cancelled" });
  expect(answers[1]).toEqual({ outcome: "selected", optionId: "a" });
});

test("a CRLF line of exactly the cap does not overflow", () => {
  const lines: string[] = [];
  let overflows = 0;
  const r = createLineReader({ maxBytes: 4, onLine: (l) => void lines.push(l), onOverflow: () => void overflows++ });
  r.push("abcd\r");
  r.push("\n");
  expect(lines).toEqual(["abcd"]);
  expect(overflows).toBe(0);
});

test("the line reader handles a million one-byte pushes in under a second", () => {
  let n = 0;
  const r = createLineReader({ onLine: () => void n++, onOverflow: () => {} });
  const one = new Uint8Array([120]);
  const nl = new Uint8Array([10]);
  const t0 = performance.now();
  for (let i = 0; i < 1_000_000; i++) r.push(i % 1000 === 999 ? nl : one);
  expect(performance.now() - t0).toBeLessThan(1000);
  expect(n).toBe(1000);
});
