import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { kimiAdapter } from "../../src/acp/kimi-turn.ts";
import { adapterFor, runAcpRelay } from "../../src/acp/relay-process.ts";
import { EMPTY_TURN_NOTICE, TURN_FAILED_CODE } from "../../src/acp/relay.ts";

const root = await mkdtemp(join(tmpdir(), "ais-acp-relay-"));
afterAll(() => rm(root, { recursive: true, force: true }));

/**
 * A stand-in ACP agent. It answers `initialize` and `session/new`, and each `session/prompt` by the prompt's text:
 * - "fail": writes a failed `turn.ended` line to its session log as kimi-code does, then answers `end_turn`;
 * - "ok": sends a message chunk, writes a completed `turn.ended`, answers `end_turn`;
 * - "empty": answers `end_turn` with no output and no log line;
 * - "rpc": answers a JSON-RPC error with a generic message and the reason in `data`.
 * It writes the arguments and one environment variable it got to stderr-free files, so the test can check them.
 */
const AGENT = `
const fs = require("node:fs");
const path = require("node:path");
const log = process.env.FAKE_WIRE_LOG;
fs.writeFileSync(process.env.FAKE_SEEN, JSON.stringify({ args: process.argv.slice(2), marker: process.env.FAKE_MARKER }));
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const ended = (reason, error) => fs.appendFileSync(log, JSON.stringify({ type: "turn.ended", time: 1, reason, ...(error ? { error } : {}) }) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  for (let nl = buf.indexOf("\\n"); nl !== -1; nl = buf.indexOf("\\n")) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim() === "") continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "session_fake" } });
    else if (m.method === "session/prompt") {
      const text = m.params.prompt[0].text;
      if (text === "fail") { ended("failed", { code: "provider.api_error", message: "Invalid request Error", retryable: false, details: { statusCode: 400 } }); send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } }); }
      else if (text === "ok") { send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session_fake", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } }); ended("completed"); send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } }); }
      else if (text === "empty") send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
      else if (text === "rpc") send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "Internal error", data: { details: "API error (status 500): upstream down" } } });
      else if (text === "exit") process.exit(7);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

async function start(name: string) {
  const dir = join(root, name);
  const home = join(dir, "kimi-home");
  const logDir = join(home, "sessions", "wd_synthetic", "session_fake", "agents", "main");
  await mkdir(logDir, { recursive: true });
  const wire = join(logDir, "wire.jsonl");
  await writeFile(wire, "");
  const script = join(dir, "agent.cjs");
  await writeFile(script, AGENT);
  const seen = join(dir, "seen.json");
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: string[] = [];
  let pending = "";
  let wake: (() => void) | undefined;
  stdout.on("data", (d: Buffer) => {
    pending += d.toString("utf8");
    for (let nl = pending.indexOf("\n"); nl !== -1; nl = pending.indexOf("\n")) {
      lines.push(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
    }
    wake?.();
  });
  const notes: string[] = [];
  const exit = runAcpRelay({
    command: process.execPath,
    args: [script, "acp", "--flag=value with space"],
    env: { ...process.env, FAKE_WIRE_LOG: wire, FAKE_SEEN: seen, FAKE_MARKER: "SYNTHETIC_FIXTURE_env" },
    adapter: kimiAdapter(home),
    stdin,
    stdout,
    log: (l) => notes.push(l),
  });
  let read = 0;
  /** The next `count` lines the client gets. */
  const next = async (count: number): Promise<Array<Record<string, any>>> => {
    const deadline = Date.now() + 10_000;
    while (lines.length < read + count) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} line(s); have ${lines.slice(read).join(" | ")}`);
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 50);
      });
    }
    const out = lines.slice(read, read + count).map((l) => JSON.parse(l) as Record<string, any>);
    read += count;
    return out;
  };
  const send = (o: unknown) => stdin.write(`${JSON.stringify(o)}\n`);
  const prompt = (id: number, text: string) => send({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: "session_fake", prompt: [{ type: "text", text }] } });
  return { stdin, send, prompt, next, exit, notes, seen, lines };
}

test("a client talks to the agent through the relay: failed, good, empty and error turns", async () => {
  const a = await start("turns");
  a.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } });
  expect(await a.next(1)).toEqual([{ jsonrpc: "2.0", id: 0, result: { protocolVersion: 1, agentCapabilities: {} } }]);
  a.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/x", mcpServers: [] } });
  expect((await a.next(1))[0]!.result).toEqual({ sessionId: "session_fake" });

  // The wedge as T3 Code saw it: the agent answers end_turn for a turn its own log says failed.
  a.prompt(2, "fail");
  const [failed] = await a.next(1);
  expect(failed).toEqual({
    jsonrpc: "2.0",
    id: 2,
    error: { code: TURN_FAILED_CODE, message: "Turn failed: Invalid request Error (HTTP 400, provider.api_error)", data: { source: "ais-acp-relay", code: "provider.api_error", status: 400, retryable: false } },
  });

  a.prompt(3, "ok");
  const good = await a.next(2);
  expect(good[0]!.params.update.content.text).toBe("hello");
  expect(good[1]).toEqual({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });

  a.prompt(4, "empty");
  const empty = await a.next(2);
  expect(empty[0]!.params.update).toEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: EMPTY_TURN_NOTICE } });
  expect(empty[1]).toEqual({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } });

  a.prompt(5, "rpc");
  expect((await a.next(1))[0]!.error).toEqual({ code: -32603, message: "API error (status 500): upstream down", data: { details: "API error (status 500): upstream down" } });

  a.stdin.end();
  expect(await a.exit).toBe(0);
  expect(JSON.parse(await Bun.file(a.seen).text())).toEqual({ args: ["acp", "--flag=value with space"], marker: "SYNTHETIC_FIXTURE_env" });
  expect(a.notes).toEqual([
    "acp-relay: failed turn reported as an error (provider.api_error, HTTP 400)",
    "acp-relay: empty turn, notice added",
    "acp-relay: prompt error given its reason (code -32603)",
  ]);
}, 30_000);

test("output the client has not read yet is not lost when the agent exits", async () => {
  // An agent that prints 4 MiB in 64 lines and exits at once; the client starts to read 500 ms later.
  const dir = join(root, "flush");
  await mkdir(dir, { recursive: true });
  const script = join(dir, "big.cjs");
  await writeFile(script, 'const line = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { x: "a".repeat(65536 - 60) } }) + "\\n"; for (let i = 0; i < 64; i++) process.stdout.write(line); process.stdout.write("tail-without-newline");');
  const stdout = new PassThrough({ highWaterMark: 1024 });
  stdout.pause();
  let bytes = 0;
  let last = "";
  setTimeout(() => {
    stdout.on("data", (d: Buffer) => {
      bytes += d.length;
      last = (last + d.toString("utf8")).slice(-20);
    });
    stdout.resume();
  }, 500);
  const code = await runAcpRelay({ command: process.execPath, args: [script], stdin: new PassThrough(), stdout, log: () => {} });
  expect(code).toBe(0);
  const one = JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { x: "a".repeat(65536 - 60) } }).length + 1;
  expect(bytes).toBe(64 * one + "tail-without-newline".length);
  expect(last).toBe("tail-without-newline");
}, 30_000);

test("the relay ends with the agent's exit code", async () => {
  const a = await start("exit");
  a.prompt(1, "exit");
  expect(await a.exit).toBe(7);
}, 30_000);

test("an agent that cannot start gives 127 and a note", async () => {
  const notes: string[] = [];
  const code = await runAcpRelay({ command: join(root, "no-such-agent"), args: [], stdin: new PassThrough(), stdout: new PassThrough(), log: (l) => notes.push(l) });
  expect(code).toBe(127);
  expect(notes[0]).toContain("acp-relay: cannot start");
}, 30_000);

test("adapterFor: kimi-code reads its session log, other agents have no adapter", () => {
  expect(adapterFor("kimi-code", { KIMI_CODE_HOME: join(root, "h") })?.turnOutcome).toBeDefined();
  expect(adapterFor("grok-build", {})).toBeUndefined();
  expect(adapterFor("glm-acp-agent", {})).toBeUndefined();
});
