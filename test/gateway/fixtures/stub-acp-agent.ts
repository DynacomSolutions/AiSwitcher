// A stand-in ACP agent for tests. It speaks JSON lines on stdio.
// Prompts: say:<text>, tool, ask, slow, wait:<ms>, mcp, mcp-tabs, ctx (says back the first text block), run:<json> (browser tool calls), and a few failure scripts. Anything else echoes.
// Environment: STUB_ACP_STATE (file that stores session ids), STUB_ACP_LOAD ("0" turns loadSession off), STUB_ACP_HTTP ("0" turns HTTP MCP off), STUB_ACP_NEW_ERROR ("1" makes session/new fail), STUB_ACP_NEW_HANG ("1" never answers session/new).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createLineReader } from "../../../src/gateway/chat/acp.ts";

const statePath = process.env.STUB_ACP_STATE ?? "";
const send = (o: unknown): void => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
};
const stored = (): string[] => (statePath && existsSync(statePath) ? readFileSync(statePath, "utf8").split("\n").filter(Boolean) : []);
const update = (sessionId: string, u: Record<string, unknown>) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const chunk = (sessionId: string, text: string) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

const cancels = new Map<string, () => void>();
const earlyCancel = new Set<string>();
const replies = new Map<string | number, (result: any) => void>();
let nextOut = 1;

function configOptions() {
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: "stub-fast", options: [{ value: "stub-fast", name: "Stub Fast" }, { value: "stub-deep", name: "Stub Deep" }] },
    { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
  ];
}

async function runPrompt(id: string | number, sessionId: string, text: string, first = "") {
  const done = (stopReason = "end_turn") => send({ jsonrpc: "2.0", id, result: { stopReason } });
  if (text.startsWith("say:")) {
    const t = text.slice(4);
    const mid = Math.ceil(t.length / 2);
    chunk(sessionId, t.slice(0, mid));
    chunk(sessionId, t.slice(mid));
    return done();
  }
  if (text === "ctx") {
    chunk(sessionId, first);
    return done();
  }
  if (text === "tool") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Read file", status: "pending", rawInput: { path: "a.txt" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc1", status: "completed", content: [{ type: "content", content: { type: "text", text: "file body" } }] });
    return done();
  }
  if (text === "big") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "tc3", title: "Big", status: "pending" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc3", status: "completed", content: [{ type: "content", content: { type: "text", text: "x".repeat(1_000_000) } }] });
    return done();
  }
  if (text === "image") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "tc4", title: "Shot", status: "pending" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc4", status: "completed", content: [{ type: "content", content: { type: "image", data: "AAAAIMAGEDATA", mimeType: "image/png" } }, { type: "content", content: { type: "text", text: "caption" } }] });
    return done();
  }
  if (text === "limit") return send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Rate limit reached. Resets at 2023-11-15T00:00:00Z" } });
  if (text === "weekly") return send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error: You've hit your weekly limit \u00b7 resets Nov 26, 2am (Asia/Bangkok)", data: { errorKind: "rate_limit" } } });
  if (text === "hang") return;
  if (text === "lateask") {
    done();
    const rpcId = `perm-${nextOut++}`;
    send({ jsonrpc: "2.0", id: rpcId, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tc9", title: "Late" }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] } });
    return;
  }
  if (text === "longask") {
    const long = "o".repeat(300);
    const rpcId = `perm-${nextOut++}`;
    const answer = new Promise<any>((resolve) => replies.set(rpcId, resolve));
    send({ jsonrpc: "2.0", id: rpcId, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tc8", title: "Long" }, options: [{ optionId: long, name: "n".repeat(300), kind: "allow_once" }] } });
    const r = await answer;
    chunk(sessionId, r?.outcome?.outcome === "selected" ? `chose:${r.outcome.optionId}` : "cancelled");
    return done();
  }
  if (text === "ask") {
    const rpcId = `perm-${nextOut++}`;
    const answer = new Promise<any>((resolve) => replies.set(rpcId, resolve));
    send({ jsonrpc: "2.0", id: rpcId, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "tc2", title: "Run command" }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "deny", name: "Reject", kind: "reject_once" }] } });
    const r = await answer;
    chunk(sessionId, r?.outcome?.outcome === "selected" ? `chose:${r.outcome.optionId}` : "cancelled");
    return done();
  }
  if (text === "slow") {
    if (!earlyCancel.delete(sessionId)) await new Promise<void>((resolve) => cancels.set(sessionId, resolve));
    cancels.delete(sessionId);
    return done("cancelled");
  }
  if (text === "fail") return send({ jsonrpc: "2.0", id, error: { code: -32000, message: "stub failure", data: { why: "requested" } } });
  if (text === "exit") {
    process.stderr.write("stub exiting\n");
    process.exit(3);
  }
  if (text.startsWith("wait:")) {
    await new Promise((r) => setTimeout(r, Number(text.slice(5)) || 0));
    chunk(sessionId, "waited");
    return done();
  }
  if (text.startsWith("run:")) {
    // run:{"steps":[{"tool":"read_page","args":{"tabId":1}}],"repeat":false,"gapMs":200}
    // Calls the browser tools through the MCP server of the chat, step by step. With "repeat" the steps loop until a call fails or the turn is cancelled.
    // The reply is one text line: `RUN <n> <tool>=ok|ERR|ABORTED:<first text>` joined with " || ", the last two calls at most.
    const spec = JSON.parse(text.slice(4)) as { steps: Array<{ tool: string; args?: Record<string, unknown> }>; repeat?: boolean; gapMs?: number };
    const server = (mcpByS.get(sessionId) ?? [])[0];
    if (!server) {
      chunk(sessionId, "no mcp server");
      return done();
    }
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    for (const h of server.headers ?? []) headers[h.name] = h.value;
    const ac = new AbortController();
    cancels.set(sessionId, () => ac.abort());
    const lines: string[] = [];
    let count = 0;
    outer: do {
      for (const st of spec.steps) {
        if (ac.signal.aborted) break outer;
        count++;
        try {
          const res = await fetch(server.url, { method: "POST", headers, signal: ac.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1000 + count, method: "tools/call", params: { name: st.tool, arguments: st.args ?? {} } }) });
          const j = JSON.parse(await res.text());
          const r = j.result ?? { isError: true, content: [{ type: "text", text: JSON.stringify(j.error ?? j) }] };
          const first = (r.content ?? []).find((c: { type: string }) => c.type === "text");
          lines.push(`${st.tool}=${r.isError ? "ERR" : "ok"}:${String(first?.text ?? "image").slice(0, 400)}`);
          if (r.isError) break outer;
        } catch {
          lines.push(`${st.tool}=ABORTED:`);
          break outer;
        }
        if (spec.gapMs) await new Promise((r) => setTimeout(r, spec.gapMs));
      }
    } while (spec.repeat);
    const cancelled = ac.signal.aborted;
    cancels.delete(sessionId);
    chunk(sessionId, `RUN ${count} ${lines.slice(-2).join(" || ")}`);
    return done(cancelled ? "cancelled" : "end_turn");
  }
  if (text === "mcp-tabs") {
    const server = (mcpByS.get(sessionId) ?? [])[0];
    if (!server) {
      chunk(sessionId, "no mcp server");
      return done();
    }
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    for (const h of server.headers ?? []) headers[h.name] = h.value;
    const res = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tabs_context", arguments: {} } }) });
    chunk(sessionId, `tabs:${res.status}:${await res.text()}`);
    return done();
  }
  if (text === "mcp") {
    const server = (mcpByS.get(sessionId) ?? [])[0];
    if (!server) {
      chunk(sessionId, "no mcp server");
      return done();
    }
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    for (const h of server.headers ?? []) headers[h.name] = h.value;
    const post = async (rid: number, method: string, params: unknown) => (await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) })).text();
    const list = await post(1, "tools/list", {});
    const tabs = await post(2, "tools/call", { name: "tabs_context", arguments: {} });
    chunk(sessionId, `tools:${list}|tabs:${tabs}`);
    return done();
  }
  chunk(sessionId, `echo:${text}`);
  return done();
}

const mcpByS = new Map<string, Array<{ url: string; headers: Array<{ name: string; value: string }> }>>();

function handle(m: any): void {
  if (typeof m !== "object" || m === null) return;
  if (m.method === undefined) {
    const r = replies.get(m.id);
    if (r) {
      replies.delete(m.id);
      r(m.result);
    }
    return;
  }
  const reply = (result: unknown) => send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: process.env.STUB_ACP_HTTP !== "0" }, loadSession: process.env.STUB_ACP_LOAD !== "0" } });
    case "session/new": {
      if (process.env.STUB_ACP_NEW_HANG === "1") return;
      if (process.env.STUB_ACP_NEW_ERROR === "1") return send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "no session for you" } });
      const sessionId = `stub-${crypto.randomUUID().slice(0, 8)}`;
      if (statePath) appendFileSync(statePath, `${sessionId}\n`);
      mcpByS.set(sessionId, m.params?.mcpServers ?? []);
      return reply({ sessionId, configOptions: configOptions() });
    }
    case "session/load": {
      if (!stored().includes(m.params?.sessionId)) return send({ jsonrpc: "2.0", id: m.id, error: { code: -32002, message: "unknown session" } });
      mcpByS.set(m.params.sessionId, m.params?.mcpServers ?? []);
      return reply({ configOptions: configOptions() });
    }
    case "session/set_config_option":
    case "session/set_model":
      return reply({});
    case "session/prompt": {
      // Scripts match on the LAST text block. The gateway may put a context block before the user's text.
      const blocks = ((m.params?.prompt ?? []) as Array<{ type?: string; text?: string }>).filter((b) => b.type === "text");
      const text = blocks[blocks.length - 1]?.text ?? "";
      void runPrompt(m.id, m.params.sessionId, text, blocks[0]?.text ?? "");
      return;
    }
    case "session/cancel":
      if (cancels.has(m.params?.sessionId)) cancels.get(m.params.sessionId)?.();
      else earlyCancel.add(m.params?.sessionId);
      return;
    default:
      if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
  }
}

const reader = createLineReader({
  onLine: (line) => {
    if (line.trim() === "") return;
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    handle(m);
  },
  onOverflow: () => process.exit(4),
});
process.stdin.on("data", (d: Buffer) => reader.push(d));
process.stdin.on("end", () => process.exit(0));
