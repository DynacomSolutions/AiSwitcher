import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { kimiAdapter } from "../../src/acp/kimi-turn.ts";
import { adapterFor, agentEndMessage, END_MESSAGE_MAX, runAcpRelay, type RelayProcessOptions } from "../../src/acp/relay-process.ts";
import { EMPTY_TURN_NOTICE, TURN_FAILED_CODE } from "../../src/acp/relay.ts";
import { LimitSnoozer, type McpCaller, type McpEndpoint } from "../../src/acp/limit-snooze.ts";

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
const retrying = (reset) => fs.appendFileSync(log, JSON.stringify({ type: "turn.step.retrying", agentId: "main", turnId: 0, step: 1, failedAttempt: 1, nextAttempt: 2, maxAttempts: 10, delayMs: 256304000, errorName: "APIProviderRateLimitError", errorMessage: "You've hit your usage limit (SYNTHETIC_FIXTURE). Resets at " + reset + ".", statusCode: 429, time: 5000 }) + "\\n");
let openPrompt = null;
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
      else if (text === "limit") { openPrompt = m.id; retrying(process.env.FAKE_RESET); } // sleeps until cancelled
      else if (text === "burst") { openPrompt = m.id; retrying(process.env.FAKE_BURST_RESET); } // short reset, no snooze
      else if (text === "rpc") send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "Internal error", data: { details: "API error (status 500): upstream down" } } });
      else if (text === "exit") process.exit(7);
      else if (text === "die") { process.stderr.write("boom: out of memory SYNTHETIC_FIXTURE\\n"); process.kill(process.pid, "SIGKILL"); }
      else if (text === "fail7") { process.stderr.write("fatal: cannot read config key=sk-SYNTHETIC_FIXTURE_abcdefgh1234\\n"); process.exit(1); }
      else if (text === "hang") { openPrompt = m.id; fs.writeFileSync(process.env.FAKE_SEEN + ".ready", "1"); }
      else if (text === "stubborn") { openPrompt = m.id; process.on("SIGTERM", () => {}); fs.writeFileSync(process.env.FAKE_SEEN + ".ready", "1"); }
      else if (text === "answer-then-exit") { send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } }); setTimeout(() => process.exit(3), 20); }
      else if (text === "wake") { send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } }); setTimeout(() => send({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: { sessionId: "session_fake", options: [{ optionId: "approve", name: "Approve once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }], toolCall: { toolCallId: "t1", title: "Bash" } } }), 50); }
    } else if (m.method === "session/cancel") {
      ended("cancelled");
      if (openPrompt !== null) { send({ jsonrpc: "2.0", id: openPrompt, result: { stopReason: "end_turn" } }); openPrompt = null; }
    } else if (m.id === "perm-1") {
      fs.writeFileSync(process.env.FAKE_SEEN + ".perm", JSON.stringify(m));
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session_fake", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission answered" } } } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

async function start(name: string, opts: { limit?: LimitSnoozer; inTurnWatchMs?: number; extra?: Partial<RelayProcessOptions> } = {}) {
  const reset = new Date(Date.now() + 3 * 3600_000).toISOString(); // a long reset, over the two-minute horizon
  const burstReset = new Date(Date.now() + 30_000).toISOString(); // a short burst reset, under the horizon
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
  const stderr = new PassThrough();
  let errText = "";
  stderr.on("data", (d: Buffer) => (errText += d.toString("utf8")));
  const exit = runAcpRelay({
    command: process.execPath,
    args: [script, "acp", "--flag=value with space"],
    env: { ...process.env, FAKE_WIRE_LOG: wire, FAKE_SEEN: seen, FAKE_MARKER: "SYNTHETIC_FIXTURE_env", FAKE_RESET: reset, FAKE_BURST_RESET: burstReset },
    adapter: kimiAdapter(home),
    stdin,
    stdout,
    log: (l) => notes.push(l),
    stderr,
    agentName: "zcode",
    ...(opts.extra ?? {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
    ...(opts.inTurnWatchMs !== undefined ? { inTurnWatchMs: opts.inTurnWatchMs } : {}),
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
  return { stdin, send, prompt, next, exit, notes, seen, lines, reset, burstReset, stderrText: () => errText };
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

/** Waits until the stand-in agent has the open prompt (a loaded host can start it late). */
async function ready(a: { seen: string }): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await Bun.file(`${a.seen}.ready`).exists())) {
    if (Date.now() > deadline) throw new Error("the agent never got the prompt");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("an agent that ends with a prompt open", () => {
  test("it exits with a code: each open prompt gets one error with the reason, and stderr still reaches the client", async () => {
    const a = await start("end-code");
    a.prompt(1, "hang");
    a.prompt(2, "fail7"); // the agent exits at this prompt; prompt 1 is open too
    expect(await a.exit).toBe(1);
    const answers = a.lines.map((l) => JSON.parse(l));
    expect(answers.map((x) => x.id).sort()).toEqual([1, 2]);
    for (const x of answers) {
      expect(x.error.code).toBe(TURN_FAILED_CODE);
      expect(x.error.message).toContain("The ACP agent zcode stopped during the turn: it exited with code 1.");
      expect(x.error.message).toContain("Last agent output: fatal: cannot read config key=");
      expect(x.error.message).not.toContain("SYNTHETIC_FIXTURE_abcdefgh1234"); // redacted
      expect(x.error.message.length).toBeLessThan(END_MESSAGE_MAX);
      expect(x.error.data).toMatchObject({ source: "ais-acp-relay", reason: "agent_ended", exitCode: 1 });
    }
    expect(a.stderrText()).toContain("fatal: cannot read config key="); // the client still gets the agent's stderr, unchanged
    expect(a.stderrText()).toContain("sk-SYNTHETIC_FIXTURE_abcdefgh1234");
  }, 30_000);

  test("it is ended by a signal the relay never saw: the message says only the agent was stopped", async () => {
    const a = await start("end-signal");
    a.prompt(1, "die");
    expect(await a.exit).toBe(137);
    const [err] = await a.next(1);
    expect(err!.id).toBe(1);
    expect(err!.error.message).toContain("it was ended by SIGKILL.");
    expect(err!.error.message).toContain("The relay received no signal");
    expect(err!.error.message).toContain("boom: out of memory");
    expect(err!.error.data).toMatchObject({ signal: "SIGKILL" });
    expect(a.lines.length).toBe(1);
  }, 30_000);

  test("the relay gets SIGTERM first: the signal is forwarded, and the error names the outside stop", async () => {
    const a = await start("relay-sigterm");
    a.prompt(1, "hang");
    await ready(a); // the agent has the prompt
    process.emit("SIGTERM");
    expect(await a.exit).toBe(143);
    const [err] = await a.next(1);
    expect(err!.id).toBe(1);
    expect(err!.error.message).toContain("it was ended by SIGTERM.");
    expect(err!.error.message).toContain("The relay received SIGTERM first, so something outside the agent stopped its process group or systemd scope.");
    expect(err!.error.data).toMatchObject({ signal: "SIGTERM", relaySignal: "SIGTERM" });
    expect(a.lines.length).toBe(1);
  }, 30_000);

  test("an agent that ignores the signal is stopped after the grace time, and the prompt is still answered", async () => {
    const a = await start("relay-stubborn", { extra: { signalGraceMs: 300 } });
    a.prompt(1, "stubborn");
    await ready(a);
    process.emit("SIGTERM");
    expect(await a.exit).toBe(143);
    const [err] = await a.next(1);
    expect(err!.error.message).toContain("it did not end within 0.3 seconds after the relay received SIGTERM, so the relay stopped it.");
    expect(a.lines.length).toBe(1);
  }, 30_000);

  test("a prompt the agent already answered is not answered a second time", async () => {
    const a = await start("no-double");
    a.prompt(1, "answer-then-exit");
    a.prompt(2, "hang");
    expect(await a.exit).toBe(3);
    const answers = a.lines.map((l) => JSON.parse(l)).filter((x) => x.id !== undefined); // the empty-turn notice has no id
    expect(answers.map((x) => x.id)).toEqual([1, 2]);
    expect(answers[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
    expect(answers[1].error.message).toContain("it exited with code 3.");
  }, 30_000);

  test("no prompt open: the stream ends with no extra line", async () => {
    const a = await start("no-open");
    a.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 1 } });
    await a.next(1);
    a.prompt(1, "ok");
    await a.next(2);
    a.prompt(2, "exit");
    a.stdin.end();
    // prompt 2 is open, so it gets one; the answered prompt 1 does not
    expect(await a.exit).toBe(7);
    expect(a.lines.map((l) => JSON.parse(l).id).filter((id) => id !== undefined)).toEqual([0, 1, 2]);
  }, 30_000);

  test("lines pass byte for byte: odd spacing, key order and unicode stay as the agent wrote them", async () => {
    const dir = join(root, "bytes");
    await mkdir(dir, { recursive: true });
    const script = join(dir, "echo.cjs");
    const payload = '{ "jsonrpc":"2.0",  "method":"session/update","params":{"z":1,"a":"é\u00e9 ✓"} }';
    await writeFile(script, `process.stdout.write(${JSON.stringify(`${payload}
`)}); process.stdin.on("data", (d) => process.stdout.write(d)); process.stdin.on("end", () => process.exit(0));`);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let got = "";
    stdout.on("data", (d: Buffer) => (got += d.toString("utf8")));
    const done = runAcpRelay({ command: process.execPath, args: [script], stdin, stdout, stderr: new PassThrough(), log: () => {} });
    stdin.write("client  line  one\n");
    await new Promise((r) => setTimeout(r, 300));
    stdin.end();
    expect(await done).toBe(0);
    expect(got.startsWith(`${payload}\n`)).toBe(true);
    expect(got).toContain("client  line  one");
  }, 30_000);

  test("agentEndMessage: a start error, and a long stderr tail stays under the limit with its last lines", () => {
    expect(agentEndMessage({ agent: "zcode", code: null, signal: null, startError: "spawn ENOENT" })).toBe("The ACP agent zcode could not start: spawn ENOENT");
    const tail = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(100)}`).join("\n");
    const m = agentEndMessage({ agent: "zcode", code: 2, signal: null, stderrTail: tail });
    expect(m.length).toBeLessThanOrEqual(END_MESSAGE_MAX);
    expect(m).toContain("line 199");
    expect(m).not.toContain("line 100 ");
  });
});

describe("an agent whose helper process keeps its output open", () => {
  const PROMPT = '{"jsonrpc":"2.0","id":7,"method":"session/prompt","params":{"sessionId":"s1"}}\n';
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function waitFor(file: string): Promise<string> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const f = Bun.file(file);
      if (await f.exists()) {
        const t = (await f.text()).trim();
        if (t !== "") return t;
      }
      if (Date.now() > deadline) throw new Error(`${file} never appeared`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  test("a helper that inherits stderr does not keep the relay waiting: the prompt gets its error within a second", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    const t0 = Date.now();
    const done = runAcpRelay({ command: "/bin/sh", args: ["-c", "read l; sleep 3 >/dev/null </dev/null & exit 1"], stdin, stdout, stderr: new PassThrough(), log: () => {}, limit: false });
    stdin.write(PROMPT);
    expect(await done).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2000);
    const answers = out.trim().split("\n").map((l) => JSON.parse(l));
    expect(answers.length).toBe(1);
    expect(answers[0].id).toBe(7);
    expect(answers[0].error.message).toContain("it exited with code 1.");
  }, 30_000);

  test("a line a helper writes to stdout after the error answer is not passed on", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    const late = '{"jsonrpc":"2.0","method":"session/update","params":{"late":true}}';
    const done = runAcpRelay({ command: "/bin/sh", args: ["-c", `read l; (sleep 1.2; echo '${late}') >&1 2>/dev/null & exit 1`], stdin, stdout, stderr: new PassThrough(), log: () => {}, limit: false });
    stdin.write(PROMPT);
    expect(await done).toBe(1);
    await new Promise((r) => setTimeout(r, 1800)); // the helper writes now
    const lines = out.trim().split("\n");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).error.message).toContain("it exited with code 1.");
    expect(out).not.toContain("late");
  }, 30_000);

  test("a helper that holds stdout after the agent exits is stopped, and the message says the agent exited", async () => {
    const dir = join(root, "orphan-stdout");
    await mkdir(dir, { recursive: true });
    const pidFile = join(dir, "helper.pid");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    const done = runAcpRelay({ command: "/bin/sh", args: ["-c", `read l; (sleep 31 & echo $! > ${pidFile}; wait) & while [ ! -s ${pidFile} ]; do sleep 0.05; done; exit 3`], stdin, stdout, stderr: new PassThrough(), log: () => {}, limit: false });
    stdin.write(PROMPT);
    const pid = Number(await waitFor(pidFile));
    expect(await done).toBe(3);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pid)).toBe(false);
    const err = JSON.parse(out.trim().split("\n")[0]!);
    expect(err.error.message).toContain("it exited with code 3. Its output stayed open for 500 ms after that, so the relay stopped waiting for it.");
    expect(err.error.message).not.toContain("more than");
  }, 30_000);

  test("a helper that closed its output is stopped too after a normal exit", async () => {
    const dir = join(root, "orphan-normal");
    await mkdir(dir, { recursive: true });
    const pidFile = join(dir, "helper.pid");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.resume();
    const done = runAcpRelay({ command: "/bin/sh", args: ["-c", `read l; sleep 31 >/dev/null 2>&1 </dev/null & echo $! > ${pidFile}; exit 0`], stdin, stdout, stderr: new PassThrough(), log: () => {}, limit: false });
    stdin.write(PROMPT);
    const pid = Number(await waitFor(pidFile));
    expect(await done).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pid)).toBe(false);
  }, 30_000);

  test("a signal reaches the agent's helper too: nothing is left running after the relay ends", async () => {
    const dir = join(root, "orphan");
    await mkdir(dir, { recursive: true });
    const pidFile = join(dir, "helper.pid");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.resume();
    const done = runAcpRelay({ command: "/bin/sh", args: ["-c", `read l; sleep 31 & echo $! > ${pidFile}; wait`], stdin, stdout, stderr: new PassThrough(), log: () => {}, limit: false, signalGraceMs: 2000 });
    stdin.write(PROMPT);
    const pid = Number(await waitFor(pidFile));
    expect(alive(pid)).toBe(true);
    process.emit("SIGTERM");
    expect(await done).toBe(143);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(false);
  }, 30_000);

  test("an agent that ignores the signal: the group is killed after the grace time, helper included", async () => {
    const dir = join(root, "orphan-stubborn");
    await mkdir(dir, { recursive: true });
    const pidFile = join(dir, "helper.pid");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    const done = runAcpRelay({ command: "/bin/sh", args: ["-c", `trap "" TERM; read l; sleep 31 & echo $! > ${pidFile}; wait`], stdin, stdout, stderr: new PassThrough(), log: () => {}, limit: false, signalGraceMs: 1000 });
    stdin.write(PROMPT);
    const pid = Number(await waitFor(pidFile));
    process.emit("SIGTERM");
    expect(await done).toBe(143);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid)).toBe(false);
    const err = JSON.parse(out.trim().split("\n")[0]!);
    expect(err.error.message).toContain("it did not end within 1 second after the relay received SIGTERM, so the relay stopped it.");
  }, 30_000);
});

test("the end message separates an agent that did not end from one whose output stayed open, with singular and plural seconds", () => {
  const base = { agent: "zcode", code: null, signal: null, relaySignal: "SIGTERM" as const };
  expect(agentEndMessage({ ...base, timedOut: { graceMs: 1000 } })).toContain("it did not end within 1 second after the relay received SIGTERM, so the relay stopped it.");
  expect(agentEndMessage({ ...base, timedOut: { graceMs: 3000 } })).toContain("it did not end within 3 seconds after");
  // the agent ended and its output stayed open: the message says the agent ended, never "more than N seconds"
  const open = agentEndMessage({ agent: "zcode", code: 3, signal: null, outputOpen: { drainMs: 500 } });
  expect(open).toContain("it exited with code 3. Its output stayed open for 500 ms after that, so the relay stopped waiting for it.");
  expect(open).not.toContain("more than");
  expect(agentEndMessage({ agent: "zcode", code: null, signal: "SIGKILL", outputOpen: { drainMs: 500 } })).toContain("it was ended by SIGKILL. Its output stayed open for 500 ms after that");
  expect(agentEndMessage({ agent: "zcode", code: 0, signal: null })).not.toContain("output stayed open");
});

test("a stderr tail that was cut loses its partial first line, and secrets in it are redacted", () => {
  const idKey = `${"0123456789abcdef".repeat(2)}.${"AbCdEfGh".repeat(2)}`; // built here, not written out: no key-shaped literal
  const tail = ["ial first line", "fatal: password=hunter2extra", "token: SYNTHETIC_FIXTURE_tok", `x-api-key: ${idKey}`].join("\n");
  const cut = agentEndMessage({ agent: "zcode", code: 1, signal: null, stderrTail: tail, stderrCut: true });
  expect(cut).not.toContain("ial first line");
  expect(cut).toContain("fatal: password=[redacted]");
  expect(cut).toContain("token: [redacted]");
  expect(cut).not.toContain("hunter2extra");
  expect(cut).not.toContain("AbCdEfGh");
  expect(agentEndMessage({ agent: "zcode", code: 1, signal: null, stderrTail: tail })).toContain("ial first line"); // not cut: kept
});

test("an agent that cannot start gives 127 and a note", async () => {
  const notes: string[] = [];
  const code = await runAcpRelay({ command: join(root, "no-such-agent"), args: [], stdin: new PassThrough(), stdout: new PassThrough(), log: (l) => notes.push(l) });
  expect(code).toBe(127);
  expect(notes[0]).toContain("acp-relay: cannot start");
}, 30_000);

test("adapterFor: kimi-code reads its session log, other agents have no adapter", () => {
  const kimi = adapterFor("kimi-code", { KIMI_CODE_HOME: join(root, "h") });
  expect(kimi?.turnOutcome).toBeDefined();
  expect(kimi?.inTurnLimit).toBeDefined(); // the in-turn watch is kimi-specific
  expect(adapterFor("grok-build", {})).toBeUndefined();
  expect(adapterFor("glm-acp-agent", {})).toBeUndefined();
});

test("regression: a permission request from a turn the agent started itself is answered cancelled, never sent to the client", async () => {
  const t = await start("wake");
  t.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  t.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/x", mcpServers: [] } });
  await t.next(2);
  t.prompt(3, "wake"); // the turn ends; 50 ms later the agent asks permission with no prompt open
  const [notice, end] = await t.next(2);
  expect(end!.id).toBe(3);
  expect(notice!.method).toBe("session/update");
  const [after] = await t.next(1); // the agent got its answer and went on; the client never saw the request
  expect(after!.params.update.content.text).toBe("permission answered");
  expect(t.lines.some((l) => l.includes("session/request_permission"))).toBe(false);
  const { readFile } = await import("node:fs/promises");
  expect(JSON.parse(await readFile(`${t.seen}.perm`, "utf8")).result).toEqual({ outcome: { outcome: "cancelled" } });
  expect(t.notes).toContain("acp-relay: permission asked with no prompt open, nobody can answer: cancelled");
  t.stdin.end();
  expect(await t.exit).toBe(0);
});

describe("in-turn limit watch (end to end)", () => {
  const EP: McpEndpoint = { url: "http://127.0.0.1:1/mcp", authorization: ["Bear", "er SYNTHETIC"].join("") };
  const stdioServer = { name: "t3-code", command: "t3", args: ["acp-mcp-bridge"], env: [{ name: "T3_ACP_MCP_ENDPOINT", value: EP.url }, { name: "T3_ACP_MCP_AUTHORIZATION", value: EP.authorization }] };
  function snoozer(subagent = false) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const caller: McpCaller = {
      async call(_e, tool, args) {
        calls.push([tool, args]);
        if (tool === "schedule_task") return { scheduledTask: { scheduledTaskId: "task-1", boundThreadId: "thread-1" } };
        if (tool === "t3_thread_read") return { thread: { relationshipToParent: subagent ? "subagent" : null } };
        return {};
      },
    };
    return { calls, limit: new LimitSnoozer({ caller, log: () => {} }) };
  }
  const newSession = (a: Awaited<ReturnType<typeof start>>) => a.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/x", mcpServers: [stdioServer] } });

  test("a long limit retry snoozes, notifies and cancels the sleeping turn", async () => {
    const { calls, limit } = snoozer();
    const a = await start("inturn-long", { limit, inTurnWatchMs: 40 });
    newSession(a);
    await a.next(1);
    a.prompt(2, "limit");
    const [notice, answer] = await a.next(2); // the notice, then the cancelled turn's answer
    expect(notice!.method).toBe("session/update");
    expect(notice!.params.update.sessionUpdate).toBe("agent_message_chunk");
    expect(notice!.params.update.content.text).toContain("Usage limit");
    expect(notice!.params.update.content.text).toContain(a.reset);
    expect(answer!.id).toBe(2);
    expect(answer!.result.stopReason).toBe("end_turn");
    expect(calls.map((c) => c[0])).toEqual(["t3_thread_organize", "schedule_task", "t3_thread_read"]);
    expect(calls[0]![1]).toEqual({ action: "snooze", snoozedUntil: a.reset });
    expect(calls.some((c) => c[0] === "delete_scheduled_task")).toBe(false); // the resume survives the cancelled end
    a.stdin.end();
    expect(await a.exit).toBe(0);
  }, 30_000);

  test("a subagent thread snoozes without a resume", async () => {
    const { calls, limit } = snoozer(true);
    const a = await start("inturn-sub", { limit, inTurnWatchMs: 40 });
    newSession(a);
    await a.next(1);
    a.prompt(2, "limit");
    const [notice, answer] = await a.next(2);
    expect(notice!.params.update.content.text).toContain(a.reset);
    expect(answer!.id).toBe(2);
    expect(calls.map((c) => c[0])).toEqual(["t3_thread_organize", "schedule_task", "t3_thread_read", "delete_scheduled_task"]);
    a.stdin.end();
    expect(await a.exit).toBe(0);
  }, 30_000);

  test("a short burst retry does not snooze, notify or cancel", async () => {
    const { calls, limit } = snoozer();
    const a = await start("inturn-burst", { limit, inTurnWatchMs: 40 });
    newSession(a);
    await a.next(1);
    a.prompt(2, "burst");
    await new Promise((r) => setTimeout(r, 250)); // several poll intervals
    expect(calls.length).toBe(0);
    expect(a.lines.length).toBe(1); // only the session/new answer, no notice
    a.stdin.end();
    expect(await a.exit).toBe(0);
  }, 30_000);

  test("a completed turn with the watch on makes no limit calls and ends cleanly", async () => {
    const { calls, limit } = snoozer();
    const a = await start("inturn-ok", { limit, inTurnWatchMs: 40 });
    newSession(a);
    await a.next(1);
    a.prompt(2, "ok");
    const [chunk, answer] = await a.next(2);
    expect(chunk!.params.update.content.text).toBe("hello");
    expect(answer!.id).toBe(2);
    expect(calls.length).toBe(0);
    a.stdin.end();
    expect(await a.exit).toBe(0);
  }, 30_000);
});

describe("client to agent bytes", () => {
  /** `cat` as the agent echoes what it gets on stdin to stdout, which the relay passes on line by line. */
  async function through(chunks: Buffer[]): Promise<Buffer> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const got: Buffer[] = [];
    stdout.on("data", (c: Buffer) => got.push(c));
    const done = runAcpRelay({ command: "/bin/cat", args: [], stdin, stdout, stderr: new PassThrough(), log: () => {}, limit: false });
    for (const c of chunks) {
      stdin.write(c);
      await new Promise((r) => setTimeout(r, 15));
    }
    stdin.end();
    await done;
    return Buffer.concat(got);
  }

  test("lines split across chunks arrive whole", async () => {
    const out = await through([Buffer.from('{"a":'), Buffer.from('1}\n{"b"'), Buffer.from(":2}\n")]);
    expect(out.toString()).toBe('{"a":1}\n{"b":2}\n');
  });

  test("a last line with no newline arrives at end", async () => {
    const out = await through([Buffer.from('{"a":1}\n{"tail":true}')]);
    expect(out.toString()).toBe('{"a":1}\n{"tail":true}');
  });

  test("CRLF and invalid UTF-8 keep their exact bytes", async () => {
    const input = Buffer.concat([Buffer.from('{"x":"a"}\r\n'), Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0xc3, 0x28, 0x22, 0x7d, 0x0a])]);
    const out = await through([input]);
    expect(out.equals(input)).toBe(true);
  });
});
