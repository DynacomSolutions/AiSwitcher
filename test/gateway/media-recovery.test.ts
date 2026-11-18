import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createGatewayApp, type GatewayDeps } from "../../src/gateway/app.ts";
import { LedgerBuffer } from "../../src/gateway/ledger-buffer.ts";
import { badFiles, fileIds, fileVerdict, KnownBadFiles, MEDIA_PLACEHOLDER, MEDIA_REMOVED_HEADER, mentionedFileIds, rejectedUpload, withoutFiles } from "../../src/gateway/media-recovery.ts";
import { noopMetrics } from "../../src/gateway/metrics.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken } from "../../src/gateway/tokens.ts";
import type { GatewayApp, UsageRow } from "../../src/gateway/types.ts";

const NOW = new Date("2026-11-18T05:00:00.000Z");
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Bytes of an upload the stub provider stores but marks as failed, as Kimi does for some images. */
const REJECT_MARK = "SYNTHETIC_FIXTURE_REJECTED_IMAGE";
const INVALID = { error: { message: "Invalid request Error", type: "invalid_request_error" } };
const NOT_FOUND = { error: { message: "The requested resource was not found", type: "resource_not_found_error" } };

interface Seen {
  method: string;
  path: string;
  body: string;
}

/**
 * A stand-in for the Kimi Coding API, with the behaviour measured against the real one on 18 Nov 2026: an upload is
 * always answered 200, a failed one with `status: "error"`; a chat request naming a failed file is refused with
 * `400 Invalid request Error`, one naming an unknown file with 404; `GET /files/<id>` answers the status alone.
 */
class StubKimi {
  readonly files = new Map<string, "ready" | "error">();
  readonly seen: Seen[] = [];
  lookupStatus = 200;
  private n = 0;
  readonly server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => this.handle(req) });

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const body = dec.decode(await req.arrayBuffer());
    this.seen.push({ method: req.method, path, body });
    if (req.method === "POST" && path === "/coding/v1/files") {
      const id = `file_synthetic${++this.n}`;
      const status = body.includes(REJECT_MARK) ? "error" : "ready";
      this.files.set(id, status);
      return this.json({ id, object: "file", purpose: "image", status, status_details: status === "error" ? "image moderation unavailable" : "" });
    }
    const one = /^\/coding\/v1\/files\/([^/]+)$/.exec(path);
    if (req.method === "GET" && one) {
      if (this.lookupStatus !== 200) return this.json({ error: { message: "try later", type: "server_error" } }, this.lookupStatus);
      const status = this.files.get(one[1] as string);
      return status ? this.json({ status }) : this.json(NOT_FOUND, 404);
    }
    if (req.method === "POST" && path === "/coding/v1/chat/completions") {
      const named = [...body.matchAll(/ms:\/\/([A-Za-z0-9._-]+)/g)].map((m) => m[1] as string);
      if (named.some((id) => !this.files.has(id))) return this.json(NOT_FOUND, 404);
      if (named.some((id) => this.files.get(id) === "error")) return this.json(INVALID, 400);
      if (body.includes("SYNTHETIC_FIXTURE_OTHER_400")) return this.json({ error: { message: "role must be one of 'system', 'user', 'assistant', 'tool'", type: "invalid_request_error" } }, 400);
      return this.json({ id: "chatcmpl-synthetic", choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
    }
    return this.json(NOT_FOUND, 404);
  }

  chats(): Seen[] {
    return this.seen.filter((s) => s.path.endsWith("/chat/completions"));
  }
  lookups(): Seen[] {
    return this.seen.filter((s) => s.method === "GET");
  }
}

let kimi: StubKimi;
let store: MemoryGatewayStore;
let ledger: LedgerBuffer;
let written: UsageRow[];
let logs: string[];
let deps: GatewayDeps;
let token: string;
let gateway: ReturnType<typeof createGatewayApp>;

const app = (over: Partial<GatewayApp> = {}): GatewayApp => ({
  name: "k",
  owner: "o",
  namespace: "ns",
  provider: "kimi",
  style: "anthropic", // as the T3 Kimi apps are registered; the client still speaks the OpenAI-style API under /v1
  target: { kind: "pin", identity: "id1" },
  state: "active",
  createdAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

async function addApp(a: GatewayApp): Promise<string> {
  await store.putApp(a);
  const t = generateToken();
  await store.addToken({ app: a.name, prefix: t.prefix, hash: t.hash, createdAt: NOW.toISOString() });
  return t.token;
}

beforeEach(async () => {
  kimi = new StubKimi();
  written = [];
  logs = [];
  store = new (class extends MemoryGatewayStore {
    override async appendUsage(rows: UsageRow[]): Promise<void> {
      written.push(...rows);
      await super.appendUsage(rows);
    }
  })();
  ledger = new LedgerBuffer(store, { max: 1000, flushMs: 3_600_000 });
  deps = {
    sleep: async () => {},
    store,
    ledger,
    creds: { get: async (_p: string, identity: string) => ({ identity, accessToken: `tok-${identity}` }), refreshAfter401: async () => ({ identity: "id1", accessToken: "fresh" }) } as unknown as GatewayDeps["creds"],
    usageFor: async () => undefined,
    poolMembers: async () => ["id1"],
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return fetch(`http://127.0.0.1:${kimi.server.port}${u.pathname}${u.search}`, init);
    }) as typeof fetch,
    now: () => NOW,
    metrics: noopMetrics,
    log: (line) => logs.push(line),
  };
  token = await addApp(app());
  gateway = createGatewayApp(deps);
});

afterEach(async () => {
  await kimi.server.stop(true);
  await ledger.close();
});

async function call(path: string, init: RequestInit = {}, on = gateway): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await on.request(`http://gw.test${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) } });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

const upload = (bytes: string) => {
  const form = new FormData();
  form.set("purpose", "image");
  form.set("file", new File([bytes], "synthetic.png", { type: "image/png" }));
  return call("/k/v1/files", { method: "POST", body: form });
};

const image = (id: string) => ({ type: "image_url", image_url: { url: `ms://${id}`, id } });
/** A conversation as kimi-code sends it: the images of a tool result are parts of the `tool` message. */
const conversation = (ids: string[], extra = "") =>
  JSON.stringify({
    model: "k3",
    stream: false,
    messages: [
      { role: "user", content: `look at these${extra}` },
      { role: "assistant", content: "", tool_calls: ids.map((_, i) => ({ id: `call_${i}`, type: "function", function: { name: "ReadMediaFile", arguments: "{}" } })) },
      ...ids.map((id, i) => ({ role: "tool", tool_call_id: `call_${i}`, content: [{ type: "text", text: "<image>" }, image(id), { type: "text", text: "</image>" }] })),
      { role: "user", content: [{ type: "text", text: "and now?" }] },
    ],
  });
const chat = (body: string, on = gateway) => call("/k/v1/chat/completions", { method: "POST", body, headers: { "content-type": "application/json" } }, on);
const events = (event: string): Array<Record<string, unknown>> => logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === event);
const rows = async (): Promise<UsageRow[]> => {
  await ledger.flush();
  return written;
};

describe("request bodies", () => {
  const body = enc.encode(conversation(["file_a", "file_b", "file_a"]));

  test("fileIds lists each provider file once, in order", () => {
    expect(fileIds(body)).toEqual(["file_a", "file_b"]);
    expect(fileIds(enc.encode(JSON.stringify({ messages: [{ role: "user", content: "ms://file_in_text" }] })))).toEqual([]);
    expect(fileIds(enc.encode("not json ms://file_a"))).toEqual([]);
    expect(fileIds(enc.encode(JSON.stringify({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] })))).toEqual([]);
  });

  test("mentionedFileIds finds every id in the raw bytes without parsing them", () => {
    expect(mentionedFileIds(body)).toEqual(["file_a", "file_b"]);
    expect(mentionedFileIds(enc.encode("not json ms://file_a\" ms://file-b.1_x, ms:// ms://"))).toEqual(["file_a", "file-b.1_x"]);
    expect(mentionedFileIds(enc.encode(`ms://${"a".repeat(300)}`))).toEqual([]);
    expect(mentionedFileIds(enc.encode("{}"))).toEqual([]);
  });

  test("withoutFiles replaces only the parts naming a bad file", () => {
    const out = withoutFiles(body, new Set(["file_a"]));
    expect(out?.removed).toBe(2);
    const messages = (JSON.parse(dec.decode(out!.bytes)) as { messages: Array<{ role: string; content: unknown }> }).messages;
    expect(messages[2]!.content).toEqual([{ type: "text", text: "<image>" }, { type: "text", text: MEDIA_PLACEHOLDER.image }, { type: "text", text: "</image>" }]);
    expect(messages[3]!.content).toEqual([{ type: "text", text: "<image>" }, image("file_b"), { type: "text", text: "</image>" }]);
    expect(messages[0]!.content).toBe("look at these");
    expect(withoutFiles(body, new Set(["file_other"]))).toBeUndefined();
    expect(withoutFiles(body, new Set())).toBeUndefined();
  });

  test("a video part gets the video note", () => {
    const b = enc.encode(JSON.stringify({ messages: [{ role: "user", content: [{ type: "video_url", video_url: { url: "ms://file_v" } }] }] }));
    expect(fileIds(b)).toEqual(["file_v"]);
    expect(dec.decode(withoutFiles(b, new Set(["file_v"]))!.bytes)).toContain(MEDIA_PLACEHOLDER.video);
  });
});

describe("provider answers", () => {
  test("rejectedUpload reads only a failed file object", () => {
    expect(rejectedUpload(enc.encode(JSON.stringify({ id: "file_1", status: "error", status_details: "parsing failed" })))).toEqual({ id: "file_1", details: "parsing failed" });
    expect(rejectedUpload(enc.encode(JSON.stringify({ id: "file_1", status: "error", status_details: "" })))).toEqual({ id: "file_1", details: "file processing failed" });
    expect(rejectedUpload(enc.encode(JSON.stringify({ id: "file_1", status: "ready" })))).toBeUndefined();
    expect(rejectedUpload(enc.encode("<html>"))).toBeUndefined();
  });

  test("fileVerdict: failed is bad, gone is bad only for one account, anything unclear is unknown", () => {
    expect(fileVerdict(200, enc.encode('{"status":"error"}'), false)).toBe("bad");
    expect(fileVerdict(404, enc.encode("{}"), true)).toBe("bad");
    expect(fileVerdict(404, enc.encode("{}"), false)).toBe("unknown");
    expect(fileVerdict(200, enc.encode('{"status":"ready"}'), true)).toBe("ok");
    expect(fileVerdict(200, enc.encode("{}"), true)).toBe("unknown");
    expect(fileVerdict(500, enc.encode('{"status":"error"}'), true)).toBe("unknown");
    expect(fileVerdict(401, enc.encode("{}"), true)).toBe("unknown");
  });

  test("badFiles keeps a part whose lookup throws", async () => {
    const bad = await badFiles(["a", "b", "c"], async (id) => {
      if (id === "b") throw new Error("network");
      return id === "c" ? "bad" : "ok";
    });
    expect([...bad]).toEqual(["c"]);
  });

  test("KnownBadFiles is per provider, bounded and time-limited", () => {
    const k = new KnownBadFiles();
    k.add("kimi", "file_1", 0);
    expect([...k.among("kimi", ["file_1", "file_2"], 1)]).toEqual(["file_1"]);
    expect(k.among("zai", ["file_1"], 1).size).toBe(0);
    expect(k.among("kimi", ["file_1"], 25 * 3_600_000).size).toBe(0);
    for (let i = 0; i < 2100; i++) k.add("kimi", `f${i}`, 0);
    expect(k.size).toBe(2000);
    expect(k.among("kimi", ["f0"], 1).size).toBe(0);
    expect(k.among("kimi", ["f2099"], 1).size).toBe(1);
  });
});

describe("a session poisoned by a failed upload", () => {
  test("the provider refuses every request that names the file (the wedge, as measured)", async () => {
    const direct = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${kimi.server.port}${path}`, init);
    const form = new FormData();
    form.set("file", new File([REJECT_MARK], "synthetic.png", { type: "image/png" }));
    const up = (await (await direct("/coding/v1/files", { method: "POST", body: form })).json()) as { id: string; status: string };
    expect(up.status).toBe("error");
    for (let turn = 0; turn < 3; turn++) {
      const res = await direct("/coding/v1/chat/completions", { method: "POST", body: conversation([up.id]) });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(INVALID);
    }
  });

  test("an upload the provider marked as failed is answered as an error, so the client keeps no file id", async () => {
    const res = await upload(REJECT_MARK);
    expect(res.status).toBe(422);
    expect(JSON.parse(res.text)).toMatchObject({ error: { type: "invalid_request_error", message: "upload rejected by provider: image moderation unavailable" } });
    expect(res.text).not.toContain("file_synthetic");
    const r = await rows();
    expect(r[0]).toMatchObject({ status: "upstream_error", httpStatus: 422 });
    expect(events("request")[0]).toMatchObject({ status: "upstream_error", http: 422, reason: "upload_rejected", upstream: { type: "file_status_error", message: "image moderation unavailable" } });
  });

  test("a usable upload passes through unchanged", async () => {
    const res = await upload("SYNTHETIC_FIXTURE fine image bytes");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ id: "file_synthetic1", status: "ready" });
    expect(events("request")[0]).toMatchObject({ status: "ok", http: 200 });
  });

  test("a refused chat request is sent again without the failed file, the rest intact", async () => {
    kimi.files.set("file_bad", "error");
    kimi.files.set("file_good", "ready");
    const res = await chat(conversation(["file_good", "file_bad"]));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ choices: [{ message: { content: "ok" } }] });
    expect(res.headers.get(MEDIA_REMOVED_HEADER)).toBe("1");
    const chats = kimi.chats();
    expect(chats.length).toBe(2);
    expect(chats[0]!.body).toContain("ms://file_bad");
    expect(chats[1]!.body).not.toContain("ms://file_bad");
    expect(chats[1]!.body).toContain("ms://file_good");
    expect(chats[1]!.body).toContain(MEDIA_PLACEHOLDER.image);
    expect(kimi.lookups().map((s) => s.path).sort()).toEqual(["/coding/v1/files/file_bad", "/coding/v1/files/file_good"]);
    expect(events("media_removed")).toEqual([{ event: "media_removed", app: "k", provider: "kimi", identity: "id1", model: "k3", parts: 1, http: 200 }]);
    expect(events("request")[0]).toMatchObject({ status: "ok", http: 200, reason: "media_removed" });
    const r = await rows();
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({ status: "ok", httpStatus: 200 });
  });

  test("later turns are repaired before the first send", async () => {
    kimi.files.set("file_bad", "error");
    expect((await chat(conversation(["file_bad"]))).status).toBe(200);
    kimi.seen.length = 0;
    const res = await chat(conversation(["file_bad"], " again"));
    expect(res.status).toBe(200);
    expect(res.headers.get(MEDIA_REMOVED_HEADER)).toBe("1");
    expect(kimi.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /coding/v1/chat/completions"]);
    expect(kimi.seen[0]!.body).not.toContain("ms://");
  });

  test("a failed upload is remembered: a client that kept the id anyway is repaired before the first send", async () => {
    await upload(REJECT_MARK);
    kimi.seen.length = 0;
    expect((await chat(conversation(["file_synthetic1"]))).status).toBe(200);
    expect(kimi.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /coding/v1/chat/completions"]);
  });

  test("a file the provider no longer has (404) is removed too", async () => {
    const res = await chat(conversation(["file_gone"]));
    expect(res.status).toBe(200);
    expect(res.headers.get(MEDIA_REMOVED_HEADER)).toBe("1");
    expect(kimi.chats()[1]!.body).toContain(MEDIA_PLACEHOLDER.image);
  });

  test("a pool app is repaired with the member that answered", async () => {
    token = await addApp(app({ name: "kp", target: { kind: "pool", identities: ["id1"] } }));
    kimi.files.set("file_bad", "error");
    const res = await call("/kp/v1/chat/completions", { method: "POST", body: conversation(["file_bad"]) });
    expect(res.status).toBe(200);
    expect(res.headers.get(MEDIA_REMOVED_HEADER)).toBe("1");
  });

  test("a pool app keeps a file its member does not have: another member may hold it", async () => {
    token = await addApp(app({ name: "kp", target: { kind: "pool", identities: ["id1"] } }));
    const res = await call("/kp/v1/chat/completions", { method: "POST", body: conversation(["file_elsewhere"]) });
    expect(res.status).toBe(404);
    expect(kimi.seen.length).toBe(1);
    kimi.files.set("file_bad", "error");
    const mixed = await call("/kp/v1/chat/completions", { method: "POST", body: conversation(["file_bad", "file_elsewhere"]) });
    expect(mixed.status).toBe(404); // the 404 is not looked into for a pool
  });
});

describe("refusals the gateway does not repair", () => {
  test("a 400 for another reason passes through once, and the log says why", async () => {
    kimi.files.set("file_good", "ready");
    const res = await chat(conversation(["file_good"], " SYNTHETIC_FIXTURE_OTHER_400"));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(res.headers.get(MEDIA_REMOVED_HEADER)).toBeNull();
    expect(kimi.chats().length).toBe(1);
    expect(events("media_removed")).toEqual([]);
    expect(events("request")[0]).toMatchObject({ status: "upstream_error", http: 400, upstream: { type: "invalid_request_error", message: "role must be one of 'system', 'user', 'assistant', 'tool'" } });
  });

  test("a request with no provider file is never looked up", async () => {
    const res = await chat(JSON.stringify({ model: "k3", messages: [{ role: "user", content: "SYNTHETIC_FIXTURE_OTHER_400" }] }));
    expect(res.status).toBe(400);
    expect(kimi.seen.length).toBe(1);
  });

  test("when the file lookup fails the refusal stands", async () => {
    kimi.files.set("file_bad", "error");
    kimi.lookupStatus = 500;
    const res = await chat(conversation(["file_bad"]));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.text)).toEqual(INVALID);
    expect(kimi.chats().length).toBe(1);
    expect(events("request")[0]).toMatchObject({ status: "upstream_error", http: 400, upstream: { type: "invalid_request_error", message: "Invalid request Error" } });
  });

  test("another provider's chat request is left alone", async () => {
    token = await addApp(app({ name: "z", provider: "zai", style: "openai" }));
    const res = await call("/z/chat/completions", { method: "POST", body: conversation(["file_bad"]) });
    expect(res.status).toBe(404);
    expect(kimi.seen.length).toBe(1);
  });
});
