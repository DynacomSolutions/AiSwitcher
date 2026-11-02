import { afterAll, describe, expect, test } from "bun:test";

const FAKE = ["aisg", "test", "value"].join("_");

// The e2e scripts are exercised against a fake upstream so their shape (baseURL + apiKey
// only, one JSON usage line, failure exit) is checked without a live gateway.
const seen: { path: string; auth: string | null; key: string | null; body: Record<string, unknown> }[] = [];
const sse = (events: string[]): Response => new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
const ev = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json()) as Record<string, unknown>;
    seen.push({ path: url.pathname, auth: req.headers.get("authorization"), key: req.headers.get("x-api-key"), body });
    if (url.pathname.startsWith("/denied/")) return Response.json({ error: { message: "nope" } }, { status: 403 });
    if (url.pathname === "/app/v1/messages") {
      if (!body.stream) return Response.json({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 11, output_tokens: 2 } });
      return sse([
        ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 1 } } }),
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
        ev("content_block_stop", { type: "content_block_stop", index: 0 }),
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
        ev("message_stop", { type: "message_stop" }),
      ]);
    }
    if (url.pathname === "/app/chat/completions") {
      const chunk = (extra: object) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "x", choices: [], ...extra })}\n\n`;
      if (!body.stream) return Response.json({ id: "c", object: "chat.completion", created: 1, model: "x", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
      return new Response(chunk({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] }) + chunk({ usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ error: "unexpected" }, { status: 404 });
  },
});
afterAll(() => server.stop(true));

async function run(script: string, path: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", `test/gateway-e2e/${script}.ts`], {
    env: { PATH: process.env.PATH ?? "", AIS_GATEWAY_URL: `http://127.0.0.1:${server.port}${path}`, AIS_GATEWAY_TOKEN: FAKE },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out.trim(), err: err.trim() };
}

describe("gateway e2e scripts", () => {
  test("claude: both requests, usage line, identity system block, small max_tokens", async () => {
    seen.length = 0;
    const r = await run("claude", "/app");
    expect(r.code).toBe(0);
    const line = JSON.parse(r.out);
    expect(line.nonStreamed.input_tokens).toBe(11);
    expect(line.streamed.output_tokens).toBe(2);
    expect(seen.length).toBe(2);
    for (const s of seen) {
      expect(s.key ?? s.auth?.replace("Bearer ", "")).toBe(FAKE);
      expect(s.body.max_tokens).toBeLessThanOrEqual(32);
      expect(JSON.stringify(s.body.system)).toContain("You are Claude Code");
    }
    expect(seen.map((s) => s.body.stream === true)).toEqual([false, true]);
  });

  test("grok: chat completions with bearer key and include_usage on the stream", async () => {
    seen.length = 0;
    const r = await run("grok", "/app");
    expect(r.code).toBe(0);
    const line = JSON.parse(r.out);
    expect(line.nonStreamed.total_tokens).toBe(6);
    expect(line.streamed.prompt_tokens).toBe(5);
    expect(seen.every((s) => s.auth === `Bearer ${FAKE}`)).toBe(true);
    expect(seen[1]!.body.stream_options).toEqual({ include_usage: true });
  });

  test("an upstream error exits 1 with status and a body that has no token", async () => {
    const r = await run("claude", "/denied");
    expect(r.code).toBe(1);
    const e = JSON.parse(r.err);
    expect(e.status).toBe(403);
    expect(r.err).not.toContain(FAKE);
  });

  test("missing env exits 2", async () => {
    const proc = Bun.spawn(["bun", "test/gateway-e2e/claude.ts"], { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(2);
  });
});
