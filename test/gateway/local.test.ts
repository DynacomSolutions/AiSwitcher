import { describe, expect, test } from "bun:test";
import { GatewayCredentialError } from "../../src/gateway/credentials.ts";
import { createLocalGateway, type LocalGatewayDeps, startLocalGateway, type LocalGateway } from "../../src/gateway/local.ts";

const enc = new TextEncoder();
const CLIENT_KEY = String(Math.random());
const REMOTE = "http://remote.invalid";

interface Call {
  url: string;
  headers: Headers;
  body: string;
}

/** Fake network: `remote` answers REMOTE urls, `upstream` answers provider urls; every call is recorded. */
function rig(opts: { remote: (c: Call) => Response | Promise<Response>; upstream?: (c: Call, identity: string) => Response | Promise<Response>; creds?: Partial<LocalGatewayDeps["creds"]>; now?: number; members?: string[]; breakerMs?: number; connectMs?: number; idleMs?: number; reachable?: boolean }) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const tokenOf: Record<string, string> = { a: "tok-a", b: "tok-b" };
  let clock = 1_000_000;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? await new Response(init.body as ConstructorParameters<typeof Response>[0]).text() : "";
    const call: Call = { url, headers: new Headers(init?.headers), body };
    calls.push(call);
    if (url.startsWith(REMOTE)) {
      const signal = init?.signal;
      const aborted = new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      return Promise.race([Promise.resolve(opts.remote(call)), aborted]);
    }
    const token = call.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    const identity = Object.entries(tokenOf).find(([, t]) => t === token)?.[0] ?? "?";
    return (opts.upstream ?? (() => new Response("direct")))(call, identity);
  }) as typeof fetch;
  const gw: LocalGateway = createLocalGateway({
    remoteBase: REMOTE,
    fetch: fetchImpl,
    now: () => clock,
    creds: {
      get: async (_p, identity) => ({ identity, accessToken: tokenOf[identity] as string }),
      refreshAfter401: async (_p, identity) => ({ identity, accessToken: tokenOf[identity] as string }),
      ...opts.creds,
    },
    members: async () => opts.members ?? ["a", "b"],
    log: (l) => logs.push(l),
    ...(opts.breakerMs !== undefined ? { breakerMs: opts.breakerMs } : {}),
    ...(opts.connectMs !== undefined ? { connectMs: opts.connectMs } : {}),
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
    reachable: async () => opts.reachable ?? true,
  });
  const post = (path = "/claude/v1/messages", body = '{"model":"m"}') =>
    gw.handle(new Request(`http://127.0.0.1:47140${path}`, { method: "POST", body, headers: { "x-api-key": CLIENT_KEY } }));
  return { gw, calls, logs, post, advance: (ms: number) => (clock += ms) };
}

const refused = (): Response => {
  throw new TypeError("connect ECONNREFUSED");
};

function sse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      for (const x of chunks) {
        c.enqueue(enc.encode(x));
        await Bun.sleep(1);
      }
      c.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}

describe("local gateway failover", () => {
  test("remote connect refused falls back direct and stream bytes are unchanged", async () => {
    const chunks = ["event: a\ndata: 1\n\n", "event: b\ndata: é✓\n\n", "event: c\ndata: 3\n\n"];
    const r = rig({ remote: refused, upstream: () => sse(chunks) });
    const res = await r.post();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(chunks.join(""));
    const direct = r.calls.find((c) => c.url.startsWith("https://api.anthropic.com/v1/messages"));
    expect(direct?.headers.get("authorization")).toBe("Bearer tok-a");
    expect(direct?.headers.get("x-api-key")).toBeNull();
    expect(direct?.body).toBe('{"model":"m"}');
    expect(r.gw.status().mode).toBe("direct");
  });

  test("a real refused connection (port 9) falls back", async () => {
    const calls: string[] = [];
    const gw = createLocalGateway({
      remoteBase: "http://127.0.0.1:9",
      fetch: ((u: string | URL | Request, i?: RequestInit) => {
        calls.push(String(u));
        return String(u).startsWith("http://127.0.0.1:9") ? fetch(u, i) : Promise.resolve(new Response("direct-ok"));
      }) as typeof fetch,
      now: Date.now,
      creds: { get: async (_p, identity) => ({ identity, accessToken: "t" }), refreshAfter401: async (_p, identity) => ({ identity, accessToken: "t" }) },
      members: async () => ["a"],
      log: () => {},
    });
    const res = await gw.handle(new Request("http://127.0.0.1:47140/codex/responses", { method: "POST", body: "{}" }));
    expect(await res.text()).toBe("direct-ok");
    expect(calls[1]).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  test("remote 503 falls back; 502 and 504 too", async () => {
    for (const status of [502, 503, 504]) {
      const r = rig({ remote: () => new Response("down", { status }) });
      const res = await r.post();
      expect(await res.text()).toBe("direct");
      expect(r.gw.status().mode).toBe("direct");
    }
  });

  test("a slow first byte is never replayed and does not open the breaker", async () => {
    const r = rig({ connectMs: 15, remote: () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response("slow-remote")), 120)) });
    const res = await r.post();
    expect(await res.text()).toBe("slow-remote");
    expect(r.calls.every((c) => c.url.startsWith(REMOTE))).toBe(true);
    expect(r.gw.status().mode).toBe("remote");
    expect(r.logs).toHaveLength(0);
  });

  test("a connect that never completes (not reachable after the connect window) fails over", async () => {
    const r = rig({ connectMs: 15, reachable: false, remote: () => new Promise<Response>(() => {}) });
    expect(await (await r.post()).text()).toBe("direct");
    expect(r.logs[0]).toContain("unreachable");
  });

  test("past the idle ceiling the client gets a 504 and nothing is replayed", async () => {
    const r = rig({ connectMs: 10, idleMs: 30, remote: () => new Promise<Response>(() => {}) });
    const res = await r.post();
    expect(res.status).toBe(504);
    expect(r.calls.every((c) => c.url.startsWith(REMOTE))).toBe(true);
    expect(r.gw.status().mode).toBe("remote");
  });

  test("remote 401 and 400 do not fall back", async () => {
    for (const status of [401, 400]) {
      const r = rig({ remote: () => new Response("nope", { status }) });
      const res = await r.post();
      expect(res.status).toBe(status);
      expect(await res.text()).toBe("nope");
      expect(r.calls.every((c) => c.url.startsWith(REMOTE))).toBe(true);
      expect(r.gw.status().mode).toBe("remote");
    }
  });

  test("remote failure after the first byte does not fall back", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("partial"));
        setTimeout(() => c.error(new Error("reset")), 5);
      },
    });
    const r = rig({ remote: () => new Response(stream, { status: 200 }) });
    const res = await r.post();
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toBeDefined();
    expect(r.calls.every((c) => c.url.startsWith(REMOTE))).toBe(true);
    expect(r.gw.status().mode).toBe("remote");
  });

  test("remote request carries the incoming key and body untouched", async () => {
    const r = rig({ remote: (c) => new Response(`${c.headers.get("x-api-key")}|${c.body}|${c.url}`) });
    const res = await r.post("/claude/v1/messages?beta=true", "BODY");
    expect(await res.text()).toBe(`${CLIENT_KEY}|BODY|${REMOTE}/agents-claude/v1/messages?beta=true`);
  });

  test("breaker opens, goes direct for 30 s, then re-probes", async () => {
    let remoteUp = false;
    const r = rig({ remote: () => (remoteUp ? new Response("remote") : refused()) });
    expect(await (await r.post()).text()).toBe("direct");
    const remoteCalls = (): number => r.calls.filter((c) => c.url.startsWith(REMOTE)).length;
    expect(remoteCalls()).toBe(1);
    r.advance(29_000);
    expect(await (await r.post()).text()).toBe("direct");
    expect(remoteCalls()).toBe(1); // no remote attempt inside the window
    r.advance(1_500);
    expect(await (await r.post()).text()).toBe("direct"); // probe fails, direct again
    expect(remoteCalls()).toBe(2);
    expect(await (await r.post()).text()).toBe("direct");
    expect(remoteCalls()).toBe(2);
    remoteUp = true;
    r.advance(31_000);
    expect(await (await r.post()).text()).toBe("remote");
    expect(r.gw.status().mode).toBe("remote");
    expect(r.logs).toHaveLength(2); // one line per state change, not per request
    expect(r.logs[0]).toContain("remote -> direct");
    expect(r.logs[1]).toContain("direct -> remote");
    expect(r.logs.join("\n")).not.toMatch(new RegExp(`tok-|${CLIENT_KEY}`));
  });

  test("a slow request that began before the breaker opened does not close it when it answers late", async () => {
    let release: () => void = () => {};
    let n = 0;
    const r = rig({
      remote: () => {
        n += 1;
        return n === 1 ? new Promise<Response>((resolve) => (release = () => resolve(new Response("late")))) : refused();
      },
    });
    const slow = r.post();
    await Bun.sleep(5);
    expect(await (await r.post()).text()).toBe("direct");
    expect(r.gw.status().mode).toBe("direct");
    release();
    expect(await (await slow).text()).toBe("late");
    expect(r.gw.status().mode).toBe("direct");
    expect(r.logs).toHaveLength(1);
  });

  test("429 on the active member tries the next member once", async () => {
    const seen: string[] = [];
    const r = rig({
      members: ["a", "b", "c"],
      remote: refused,
      upstream: (_c, id) => {
        seen.push(id);
        return id === "b" ? new Response("from-b") : new Response("limit", { status: 429 });
      },
    });
    expect(await (await r.post()).text()).toBe("from-b");
    expect(seen).toEqual(["a", "b"]);
    seen.length = 0;
    const r2 = rig({ members: ["a", "b", "c"], remote: refused, upstream: (_c, id) => (seen.push(id), new Response("limit", { status: 429 })) });
    const res = await r2.post();
    expect(res.status).toBe(429);
    expect(seen).toEqual(["a", "b"]); // never a third
  });

  test("quota error body on 403 also moves to the next member", async () => {
    const r = rig({
      remote: refused,
      upstream: (_c, id) => (id === "a" ? new Response('{"error":{"type":"rate_limit_error"}}', { status: 403 }) : new Response("from-b")),
    });
    expect(await (await r.post()).text()).toBe("from-b");
  });

  test("a 400 model_not_found on the active member tries the next member, other 400s do not", async () => {
    const r = rig({
      remote: refused,
      upstream: (_c, id) => (id === "a" ? new Response('{"error":{"code":"model_not_found"}}', { status: 400 }) : new Response("from-b")),
    });
    expect(await (await r.post()).text()).toBe("from-b");
    const r2 = rig({ remote: refused, upstream: () => new Response('{"error":{"code":"invalid_request"}}', { status: 400 }) });
    expect((await r2.post()).status).toBe(400);
    expect(r2.calls.filter((c) => !c.url.startsWith(REMOTE))).toHaveLength(1);
  });

  test("a 401 from the provider refreshes the login once and retries with the new token", async () => {
    let refreshed = 0;
    const r = rig({
      remote: refused,
      creds: { refreshAfter401: async (_p, identity) => (refreshed++, { identity, accessToken: "tok-b" }) },
      upstream: (c) => (c.headers.get("authorization") === "Bearer tok-b" ? new Response("fresh") : new Response("expired", { status: 401 })),
    });
    expect(await (await r.post()).text()).toBe("fresh");
    expect(refreshed).toBe(1);
  });

  test("an expired access token is refreshed before the first send", async () => {
    let refreshed = 0;
    const r = rig({
      remote: refused,
      creds: {
        get: async (_p, identity) => ({ identity, accessToken: "old", expiresAtMs: 1 }),
        refreshAfter401: async (_p, identity) => (refreshed++, { identity, accessToken: "tok-a" }),
      },
      upstream: (c) => new Response(c.headers.get("authorization") ?? ""),
    });
    expect(await (await r.post()).text()).toBe("Bearer tok-a");
    expect(refreshed).toBe(1);
  });

  test("a dead login answers in the client's error shape with the tool, identity and login command", async () => {
    const dead = (_p: string, identity: string): never => {
      throw new GatewayCredentialError("login-dead", "claude", identity);
    };
    const r = rig({ remote: refused, members: ["only"], creds: { get: async (p, i) => dead(p, i) } });
    const res = await r.post();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { type: string; error: { message: string } };
    expect(body.type).toBe("error");
    expect(body.error.message).toContain('claude identity "only" is logged out');
    expect(body.error.message).toContain("claude --identity=only");
    const codex = rig({ remote: refused, members: ["m"], creds: { get: async () => { throw new GatewayCredentialError("login-dead", "codex", "m"); } } });
    const cres = await codex.post("/codex/responses");
    const cbody = (await cres.json()) as { error: { message: string } };
    expect(cbody.error.message).toContain("codex --identity=m login");
  });

  test("a logged-out first member hands the request to the next member", async () => {
    const r = rig({
      remote: refused,
      creds: { get: async (_p, identity) => { if (identity === "a") throw new GatewayCredentialError("login-dead", "claude", "a"); return { identity, accessToken: "tok-b" }; } },
      upstream: () => new Response("from-b"),
    });
    expect(await (await r.post()).text()).toBe("from-b");
  });

  test("body over 8 MiB gets no fallback and the remote error passes through", async () => {
    const big = "x".repeat(8 * 1024 * 1024 + 10);
    const r = rig({ remote: () => new Response("busy", { status: 503 }) });
    const res = await r.post("/claude/v1/messages", big);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("busy");
    expect(r.calls.every((c) => c.url.startsWith(REMOTE))).toBe(true);
    const r2 = rig({ remote: refused });
    const res2 = await r2.post("/claude/v1/messages", big);
    expect(res2.status).toBe(502);
    expect(r2.calls.every((c) => c.url.startsWith(REMOTE))).toBe(true);
  });

  test("status path and unknown routes", async () => {
    const r = rig({ remote: refused });
    const st = (await (await r.gw.handle(new Request("http://127.0.0.1:47140/__ais/status"))).json()) as { mode: string };
    expect(st.mode).toBe("remote");
    expect((await r.gw.handle(new Request("http://127.0.0.1:47140/other/x"))).status).toBe(404);
  });

  test("binds to 127.0.0.1 only", async () => {
    const running = await startLocalGateway({ port: 0, members: async () => [], remoteBase: REMOTE, log: () => {} });
    try {
      const probe = await fetch(`http://127.0.0.1:${running.port}/__ais/status`);
      expect(probe.status).toBe(200);
      expect(running.host).toBe("127.0.0.1");
    } finally {
      running.stop();
    }
  });
});
