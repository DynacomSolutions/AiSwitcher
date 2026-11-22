import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient } from "../../src/gateway/chat/acp.ts";
import { ACP_ARGS, buildChatSession, sessionName } from "../../src/gateway/chat/kube.ts";
import type { PodPhaseNotice, PodSpecInput } from "../../src/gateway/chat/kube.ts";
import { HttpKubeApi, inClusterKube } from "../../src/gateway/chat/kube-http.ts";
import { CatalogError, KubePodTransport, PodStartError, type Timers } from "../../src/gateway/chat/pod-transport.ts";
import { ensureLocalTls } from "../../src/gateway/local-tls.ts";
import { FAKE_GROUP, FAKE_NAMESPACE, FAKE_TOKEN, FakeKubeServer } from "./fixtures/fake-kube.ts";

const root = mkdtempSync(join(tmpdir(), "ais-chat-kube-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const env = { group: FAKE_GROUP, namespace: FAKE_NAMESPACE, node: "node-a", configMap: "runtime-config", class: "chat" };
const CHAT = "0b6f3c2a-1111-4222-8333-444455556666";
const input = (over: Partial<PodSpecInput> = {}): PodSpecInput => ({ chatId: CHAT, generation: 1, provider: "claude", identity: "alpha", ...over });

class FakeTimers implements Timers {
  private n = 0;
  readonly items = new Map<number, { fn: () => void; ms: number }>();
  setTimeout(fn: () => void, ms: number): unknown {
    this.items.set(++this.n, { fn, ms });
    return this.n;
  }
  clearTimeout(h: unknown): void {
    this.items.delete(h as number);
  }
  get pending(): number[] {
    return [...this.items.values()].map((i) => i.ms);
  }
  /** Run the oldest timer, or the oldest with this delay. */
  fire(ms?: number): void {
    const first = [...this.items.entries()].find(([, i]) => ms === undefined || i.ms === ms);
    if (!first) throw new Error("no timer");
    this.items.delete(first[0]);
    first[1].fn();
  }
}

async function until(fn: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const servers: FakeKubeServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

function setup(opts: ConstructorParameters<typeof FakeKubeServer>[0] = {}, extra: { timers?: Timers; maxLineBytes?: number; api?: { watchTimeoutSeconds?: number; attachOpenTimeoutMs?: number; watchGraceMs?: number } } = {}) {
  const server = new FakeKubeServer(opts);
  servers.push(server);
  const api = new HttpKubeApi({ baseUrl: server.baseUrl, token: () => FAKE_TOKEN, env, ...extra.api });
  const transport = new KubePodTransport({ api, env, now: () => 1_700_000_000_000, timers: extra.timers, maxLineBytes: extra.maxLineBytes });
  return { server, api, transport };
}

const name1 = sessionName(CHAT, 1);

test("Bun WebSocket sends an Authorization header and trusts a custom CA", async () => {
  const tls = await ensureLocalTls({ dir: join(root, "tls"), systemRoots: [] });
  let seen = "";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { cert: tls.cert, key: tls.key },
    fetch(req, srv) {
      seen = req.headers.get("authorization") ?? "";
      if (srv.upgrade(req, { headers: { "sec-websocket-protocol": "v4.channel.k8s.io" } })) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: { message() {} },
  });
  try {
    const ca = await Bun.file(tls.caPath).text();
    const open = (opts: object) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`wss://localhost:${server.port}/x`, { protocols: ["v4.channel.k8s.io"], headers: { Authorization: "Bearer tok" }, ...opts } as never);
        ws.onopen = () => {
          resolve(`open:${ws.protocol}`);
          ws.close();
        };
        ws.onerror = () => resolve("error");
      });
    expect(await open({ tls: { ca } })).toBe("open:v4.channel.k8s.io");
    expect(seen).toBe("Bearer tok");
    expect(await open({})).toBe("error");
  } finally {
    await server.stop(true);
  }
});

test("buildChatSession sets workspace chat, the created-by label, the chat-id label, no secret and no token", () => {
  const obj = buildChatSession(input(), env, 1234) as { apiVersion: string; kind: string; metadata: any; spec: any };
  expect(obj.apiVersion).toBe(`${FAKE_GROUP}/v1alpha1`);
  expect(obj.kind).toBe("AgentSession");
  expect(obj.metadata.name).toBe(name1);
  expect(obj.metadata.namespace).toBe(FAKE_NAMESPACE);
  expect(obj.metadata.labels).toEqual({ [`${FAKE_GROUP}/created-by`]: "ais-gateway", [`${FAKE_GROUP}/chat-id`]: CHAT });
  expect(obj.metadata.annotations).toEqual({ [`${FAKE_GROUP}/client-seen`]: "1234" });
  expect(obj.spec).toEqual({ workspace: "chat", provider: "claude", identity: "alpha", node: "node-a", class: "chat", args: ACP_ARGS.claude });
  const text = JSON.stringify(obj).toLowerCase();
  expect(text).not.toContain("secret");
  expect(text).not.toContain("token");
});

test("sessionName never contains -c- and matches the admission pattern for generations 1 to 999", () => {
  const ids = [CHAT, "ffffffff-ffff-4fff-8fff-ffffffffffff", "c0c0c0c0-0000-4000-8000-000000000000", "0123abcd-0000-4000-8000-000000000000"];
  for (const id of ids) {
    for (let g = 1; g <= 999; g++) {
      const n = sessionName(id, g);
      expect(n).toMatch(/^chat-[0-9a-f]{8}-[0-9]{1,3}$/);
      expect(n).not.toContain("-c-");
    }
  }
});

test("start creates the session, waits through Pending, attaches and returns a handle that talks to the stub agent", async () => {
  const { server, transport } = setup({ initialPhase: "Pending" });
  const ac = new AbortController();
  const p = transport.start(input(), ac.signal, () => {});
  await until(() => server.sessions.has(name1));
  server.setStatus(name1, { phase: "Pending" });
  server.setStatus(name1, { phase: "Running", pod: `agent-${name1}`, worktreePath: "/work/chat/home" });
  const h = await p;
  expect(h.session).toBe(name1);
  expect(h.name).toBe(`agent-${name1}`);
  expect(h.cwd).toBe("/work/chat/home");
  expect(server.attachPaths[0]).toContain(`/pods/agent-${name1}/attach?container=agent&stdin=true&stdout=true&stderr=true&tty=false`);
  expect(server.attachAuth[0]).toBe(`Bearer ${FAKE_TOKEN}`);
  expect(server.sessions.get(name1)!.spec).toMatchObject({ workspace: "chat" });
  const client = new AcpClient({ write: (l) => h.stream.write(l), onLine: (cb) => h.stream.onLine(cb), onClose: (cb) => h.stream.onClose(cb) }, { onUpdate() {}, onPermission: async () => ({}) });
  expect(await client.initialize()).toMatchObject({ http: expect.any(Boolean) });
  h.stream.close();
  await until(() => server.watcherCount() === 0);
});

test("start surfaces NodeBudget as a notice and keeps waiting", async () => {
  const { server, transport } = setup({ initialPhase: "Pending" });
  const notices: PodPhaseNotice[] = [];
  const p = transport.start(input(), new AbortController().signal, (n) => notices.push(n));
  await until(() => server.sessions.has(name1));
  server.setStatus(name1, { phase: "Pending", reason: "NodeBudget", message: "waiting for agent memory on node-a: 36Gi in use, family agent-x (secret-repo)" });
  await until(() => notices.length === 1);
  server.setStatus(name1, { phase: "Pending", reason: "NodeBudget", message: "again" });
  server.setStatus(name1, { phase: "Running", pod: `agent-${name1}`, worktreePath: "/w" });
  const h = await p;
  expect(notices).toEqual([{ reason: "NodeBudget", text: "The cluster is busy. Your chat starts when memory is free." }]);
  expect(JSON.stringify(notices)).not.toContain("secret-repo");
  h.stream.close();
});

test("start rejects with pod_start and the reason code when the phase is Failed", async () => {
  const { server, transport } = setup({ initialPhase: "Pending" });
  const notices: PodPhaseNotice[] = [];
  const p = transport.start(input(), new AbortController().signal, (n) => notices.push(n));
  const failed = p.then(() => undefined, (e: unknown) => e);
  await until(() => server.sessions.has(name1));
  server.setStatus(name1, { phase: "Failed", reason: "StartTimeout", message: "raw controller text with secret-repo" });
  const e = (await failed) as PodStartError;
  expect(e).toBeInstanceOf(PodStartError);
  expect(e.code).toBe("pod_start");
  expect(e.reason).toBe("StartTimeout");
  expect(e.message).not.toContain("secret-repo");
  expect(notices).toEqual([]);
  await until(() => !server.sessions.has(name1));
});

test("a Failed phase with odd reason text gives the Unknown code", async () => {
  const { server, transport } = setup({ initialPhase: "Pending" });
  const failed = transport.start(input(), new AbortController().signal, () => {}).then(() => undefined, (e: unknown) => e);
  await until(() => server.sessions.has(name1));
  server.setStatus(name1, { phase: "Failed", reason: "bad reason: leak sk-abcdefgh1234" });
  const e = (await failed) as PodStartError;
  expect(e.reason).toBe("Unknown");
  expect(e.message).not.toContain("sk-");
});

test("heartbeat writes client-seen before the attach and attached after it", async () => {
  const timers = new FakeTimers();
  const { server, transport } = setup({ initialPhase: "Pending" }, { timers });
  const p = transport.start(input(), new AbortController().signal, () => {});
  await until(() => server.sessions.has(name1));
  await until(() => timers.pending.includes(15_000));
  timers.fire();
  await until(() => server.annotations.length === 1);
  expect(Object.keys(server.annotations[0]!.notes)).toEqual([`${FAKE_GROUP}/client-seen`]);
  expect(server.annotations[0]!.notes[`${FAKE_GROUP}/client-seen`]).toBe("1700000000");
  expect(server.annotations[0]!.attachedSocket).toBe(false);
  server.setStatus(name1, { phase: "Running", pod: `agent-${name1}`, worktreePath: "/w" });
  const h = await p;
  await until(() => server.annotations.length === 2);
  const last = server.annotations[1]!;
  expect(Object.keys(last.notes).sort()).toEqual([`${FAKE_GROUP}/attached`, `${FAKE_GROUP}/client-seen`]);
  expect(last.attachedSocket).toBe(true);
  await until(() => timers.pending.includes(30_000));
  h.stream.close();
  await until(() => timers.pending.length === 0);
});

test("a failed heartbeat is retried after the retry delay (fake clock)", async () => {
  const timers = new FakeTimers();
  const { server, transport } = setup({}, { timers });
  server.failAnnotate = 1;
  const h = await transport.start(input(), new AbortController().signal, () => {});
  await until(() => timers.pending.includes(10_000));
  expect(server.annotations.length).toBe(0);
  timers.fire(10_000);
  await until(() => server.annotations.length === 1);
  expect(Object.keys(server.annotations[0]!.notes)).toContain(`${FAKE_GROUP}/attached`);
  await until(() => timers.pending.includes(30_000));
  h.stream.close();
});

test("stop deletes every session labelled with the chat id", async () => {
  const { server, transport } = setup();
  const other = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
  const a = await transport.start(input(), new AbortController().signal, () => {});
  const b = await transport.start(input({ generation: 2 }), new AbortController().signal, () => {});
  const c = await transport.start(input({ chatId: other }), new AbortController().signal, () => {});
  const closed: string[] = [];
  a.stream.onClose((r) => closed.push(r));
  await transport.stop(CHAT);
  expect([...server.sessions.keys()]).toEqual([sessionName(other, 1)]);
  expect(closed).toEqual(["closed locally"]);
  b.stream.close();
  c.stream.close();
});

test("a closed WebSocket ends the stream with a reason", async () => {
  const { server, transport } = setup();
  const h = await transport.start(input(), new AbortController().signal, () => {});
  const reasons: string[] = [];
  h.stream.onClose((r) => reasons.push(r));
  server.killPod();
  await until(() => reasons.length === 1);
  expect(reasons[0]).toBe("pod stream error");
  const late: string[] = [];
  h.stream.onClose((r) => late.push(r));
  expect(late).toEqual(["pod stream error"]);
});

test("a very long stdout line closes the stream with the reason line too long", async () => {
  const { server, transport } = setup({}, { maxLineBytes: 1024 });
  const h = await transport.start(input(), new AbortController().signal, () => {});
  const reasons: string[] = [];
  h.stream.onClose((r) => reasons.push(r));
  server.sendFrame(1, new TextEncoder().encode("x".repeat(4000)));
  await until(() => reasons.length === 1);
  expect(reasons[0]).toBe("line too long");
});

test("stdout lines split across frames and UTF-8 characters arrive whole", async () => {
  const { server, transport } = setup();
  const h = await transport.start(input(), new AbortController().signal, () => {});
  const lines: string[] = [];
  h.stream.onLine((l) => lines.push(l));
  const bytes = new TextEncoder().encode("café one\nsecond\n");
  server.sendFrame(1, bytes.subarray(0, 4));
  server.sendFrame(1, bytes.subarray(4));
  await until(() => lines.length === 2);
  expect(lines).toEqual(["café one", "second"]);
  h.stream.close();
});

test("stderr is passed through redactText and capped at 4 KiB", async () => {
  const { server, transport } = setup();
  const h = await transport.start(input(), new AbortController().signal, () => {});
  const out: string[] = [];
  h.stream.onStderr((c) => out.push(c));
  const enc = new TextEncoder();
  server.sendFrame(2, enc.encode("login with sk-SYNTHETIC_FIXTURE_abcdefgh12345678 failed\n"));
  server.sendFrame(2, enc.encode(`${"word ".repeat(3000)}\n`));
  await until(() => out.length === 2);
  expect(out[0]).toBe("login with [redacted] failed");
  expect(out[1]!.length).toBeLessThanOrEqual(4096);
  h.stream.close();
});

test("an abort while the pod is pending clears the watch and the timers and deletes the session", async () => {
  const timers = new FakeTimers();
  const { server, transport } = setup({ initialPhase: "Pending" }, { timers });
  const ac = new AbortController();
  const failed = transport.start(input(), ac.signal, () => {}).then(() => undefined, (e: unknown) => e);
  await until(() => server.sessions.has(name1));
  await until(() => server.watcherCount() === 1);
  ac.abort();
  expect(await failed).toBeInstanceOf(Error);
  await until(() => server.watcherCount() === 0);
  await until(() => !server.sessions.has(name1));
  expect(timers.pending).toEqual([]);
});

test("a dropped watch is opened again after a delay", async () => {
  const timers = new FakeTimers();
  const { server, transport } = setup({ initialPhase: "Pending" }, { timers });
  const p = transport.start(input(), new AbortController().signal, () => {});
  await until(() => server.watcherCount() === 1);
  server.dropWatches();
  await until(() => timers.pending.includes(2_000));
  server.setStatus(name1, { phase: "Running", pod: `agent-${name1}`, worktreePath: "/w" });
  timers.fire(2_000);
  const h = await p;
  expect(h.cwd).toBe("/w");
  h.stream.close();
});

test("a refused attach rejects the start and deletes the session", async () => {
  const { server, transport } = setup();
  server.rejectAttach = true;
  const err = await transport.start(input(), new AbortController().signal, () => {}).then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  await until(() => !server.sessions.has(name1));
});

test("catalog reads config.json from the ConfigMap", async () => {
  const { server, transport } = setup();
  expect((await transport.catalog()).providers?.claude?.identities).toEqual(["alpha"]);
  server.configMap = {};
  expect(await transport.catalog()).toEqual({});
});

test("catalog throws a typed error on invalid JSON", async () => {
  const { server, transport } = setup();
  server.configMap = { "config.json": "{not json" };
  await expect(transport.catalog()).rejects.toBeInstanceOf(CatalogError);
  server.configMap = { "config.json": "[1]" };
  await expect(transport.catalog()).rejects.toBeInstanceOf(CatalogError);
});

test("a failed start never deletes a session of another chat (409 on create)", async () => {
  const { server, transport } = setup();
  const other = "77777777-aaaa-4bbb-8ccc-dddddddddddd";
  server.sessions.set(name1, { metadata: { name: name1, labels: { [`${FAKE_GROUP}/chat-id`]: other } }, status: { phase: "Running", pod: "p" } });
  const err = await transport.start(input(), new AbortController().signal, () => {}).then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  await new Promise((r) => setTimeout(r, 50));
  expect(server.sessions.has(name1)).toBe(true);
  expect(server.sessions.get(name1)!.metadata.labels![`${FAKE_GROUP}/chat-id`]).toBe(other);
});

test("the service account token is read again after the cache time", async () => {
  const server = new FakeKubeServer();
  servers.push(server);
  let clock = 1_000_000;
  let reads = 0;
  const files = (p: string): string => {
    if (p.endsWith("ca.crt")) return "";
    reads += 1;
    return reads === 1 ? "old-token" : "new-token";
  };
  const kube = inClusterKube({ KUBERNETES_SERVICE_HOST: "127.0.0.1", KUBERNETES_SERVICE_PORT: "1" }, files, () => clock);
  const api = new HttpKubeApi({ baseUrl: server.baseUrl, token: kube.token, env });
  server.token = "new-token";
  await expect(api.getConfigMap("x")).rejects.toThrow();
  expect(reads).toBe(1);
  clock += 61_000;
  expect(await api.getConfigMap("x")).toBeTruthy();
  expect(reads).toBe(2);
});

test("a 403 on the session read makes start reject with pod_start", async () => {
  const { server, transport } = setup();
  server.getStatusCode = 403;
  const err = (await transport.start(input(), new AbortController().signal, () => {}).then(() => undefined, (e: unknown) => e)) as PodStartError;
  expect(err).toBeInstanceOf(PodStartError);
  expect(err.code).toBe("pod_start");
  expect(err.reason).toBe("Forbidden");
  await until(() => !server.sessions.has(name1));
});

test("a silent watch ends at its time limit and start asks again", async () => {
  const timers = new FakeTimers();
  const { server, transport } = setup({ initialPhase: "Pending" }, { timers, api: { watchTimeoutSeconds: 1 } });
  const p = transport.start(input(), new AbortController().signal, () => {});
  await until(() => server.watcherCount() === 1);
  expect(server.watchQueries[0]).toContain("timeoutSeconds=1");
  await until(() => timers.pending.includes(2_000), 5000);
  server.setStatus(name1, { phase: "Running", pod: `agent-${name1}`, worktreePath: "/w" });
  timers.fire(2_000);
  const h = await p;
  expect(h.cwd).toBe("/w");
  h.stream.close();
});

test("a silent watch that ignores its limit ends at the client limit", async () => {
  const timers = new FakeTimers();
  const { server, transport } = setup({ initialPhase: "Pending" }, { timers, api: { watchTimeoutSeconds: 1, watchGraceMs: 200 } });
  server.silentWatch = true;
  const p = transport.start(input(), new AbortController().signal, () => {});
  await until(() => server.watcherCount() === 1);
  server.setStatus(name1, { phase: "Pending" });
  await until(() => timers.pending.includes(2_000), 3000);
  server.setStatus(name1, { phase: "Running", pod: `agent-${name1}`, worktreePath: "/w" });
  timers.fire(2_000);
  const h = await p;
  expect(server.watchQueries.length).toBe(1);
  h.stream.close();
});

test("stop interrupts the wait even when list and delete fail", async () => {
  const { server, transport } = setup({ initialPhase: "Pending" });
  const failed = transport.start(input(), new AbortController().signal, () => {}).then(() => undefined, (e: unknown) => e);
  await until(() => server.watcherCount() === 1);
  server.failListDelete = true;
  const t0 = Date.now();
  await expect(transport.stop(CHAT)).rejects.toThrow();
  expect(((await failed) as Error).message).toBe("cancelled");
  expect(Date.now() - t0).toBeLessThan(1000);
});

test("cleanup after an aborted create keeps a same-chat session of another start", async () => {
  const { server, transport } = setup();
  server.sessions.set(name1, { metadata: { name: name1, labels: { [`${FAKE_GROUP}/chat-id`]: CHAT }, annotations: { [`${FAKE_GROUP}/start-id`]: "other-start" } }, status: { phase: "Running", pod: "p" } });
  server.postDelayMs = 300;
  const ac = new AbortController();
  const failed = transport.start(input(), ac.signal, () => {}).then(() => undefined, (e: unknown) => e);
  await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  expect(await failed).toBeInstanceOf(Error);
  await new Promise((r) => setTimeout(r, 500));
  expect(server.sessions.get(name1)!.metadata.annotations![`${FAKE_GROUP}/start-id`]).toBe("other-start");
});

test("the attach has an open timeout", async () => {
  const { server, transport } = setup({}, { api: { attachOpenTimeoutMs: 100 } });
  server.attachDelayMs = 1500;
  const err = await transport.start(input(), new AbortController().signal, () => {}).then(() => undefined, (e: unknown) => e);
  expect((err as Error).message).toBe("attach timed out");
  await until(() => !server.sessions.has(name1));
});

test("stop during an in-flight create ends the start and leaves no session", async () => {
  const { server, transport } = setup();
  server.postDelayMs = 300;
  const failed = transport.start(input(), new AbortController().signal, () => {}).then(() => undefined, (e: unknown) => e);
  await new Promise((r) => setTimeout(r, 50));
  await transport.stop(CHAT);
  expect(((await failed) as Error).message).toBe("cancelled");
  await until(() => server.sessions.size === 0);
});

test("a normal exit of the pod ends the stream with the reason pod exited", async () => {
  const { server, transport } = setup();
  const h = await transport.start(input(), new AbortController().signal, () => {});
  const reasons: string[] = [];
  h.stream.onClose((r) => reasons.push(r));
  server.endStdin();
  await until(() => reasons.length === 1);
  expect(reasons[0]).toBe("pod exited");
});

test("the notice shows again after the reason clears and comes back", async () => {
  const { server, transport } = setup({ initialPhase: "Pending" });
  const notices: PodPhaseNotice[] = [];
  const p = transport.start(input(), new AbortController().signal, (n) => notices.push(n));
  await until(() => server.sessions.has(name1));
  server.setStatus(name1, { phase: "Pending", reason: "NodeBudget" });
  server.setStatus(name1, { phase: "Pending" });
  server.setStatus(name1, { phase: "Pending", reason: "NodeBudget" });
  await until(() => notices.length === 2);
  server.setStatus(name1, { phase: "Running", pod: `agent-${name1}`, worktreePath: "/w" });
  (await p).stream.close();
});

test("stderr is capped at 4096 UTF-8 bytes", async () => {
  const { server, transport } = setup();
  const h = await transport.start(input(), new AbortController().signal, () => {});
  const out: string[] = [];
  h.stream.onStderr((c) => out.push(c));
  server.sendFrame(2, new TextEncoder().encode(`${"\u00e9".repeat(3500)}\n`));
  await until(() => out.length === 1);
  expect(Buffer.byteLength(out[0]!)).toBeLessThanOrEqual(4096);
  h.stream.close();
});

test("inClusterKube reads the token and CA from the given file reader", () => {
  const files: Record<string, string> = {
    "/var/run/secrets/kubernetes.io/serviceaccount/token": "tok-value\n",
    "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt": "CA-PEM",
  };
  const r = inClusterKube({ KUBERNETES_SERVICE_HOST: "127.0.0.1", KUBERNETES_SERVICE_PORT: "443" }, (p) => files[p]!);
  expect(r.baseUrl).toBe("https://127.0.0.1:443");
  expect(r.token()).toBe("tok-value");
  expect(r.ca).toBe("CA-PEM");
  expect(inClusterKube({ KUBERNETES_SERVICE_HOST: "fd00::1", KUBERNETES_SERVICE_PORT: "443" }, (p) => files[p]!).baseUrl).toBe("https://[fd00::1]:443");
  expect(() => inClusterKube({}, (p) => files[p]!)).toThrow();
});
