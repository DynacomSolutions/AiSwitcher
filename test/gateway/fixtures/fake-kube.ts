// A fake Kubernetes API server for the chat transport tests. It listens on loopback over plain HTTP.
import type { Subprocess } from "bun";
import { join } from "node:path";
import type { KubeSession } from "../../../src/gateway/chat/kube.ts";

export const FAKE_GROUP = "agents.example.test";
export const FAKE_NAMESPACE = "agents-test";
export const FAKE_TOKEN = "fake-token";
const STUB = join(import.meta.dir, "stub-acp-agent.ts");

export interface FakeKubeOptions {
  /** Phase set on create. Default: Running. Use "Pending" to drive the phases by hand. */
  initialPhase?: string;
  stubEnv?: Record<string, string>;
}

interface Watcher { name: string; send(ev: object): void; close(): void }

export class FakeKubeServer {
  readonly sessions = new Map<string, KubeSession>();
  /** Every annotate call in order, with whether the session had an attach socket open at that time. */
  readonly annotations: Array<{ name: string; notes: Record<string, string>; attachedSocket: boolean }> = [];
  readonly attachPaths: string[] = [];
  readonly attachAuth: string[] = [];
  readonly stubStderr: string[] = [];
  failAnnotate = 0;
  rejectAttach = false;
  readonly server: ReturnType<typeof Bun.serve>;
  private readonly watchers = new Set<Watcher>();
  private readonly sockets = new Map<string, number>();
  private readonly procs = new Set<Subprocess>();
  private readonly opts: FakeKubeOptions;
  configMap: Record<string, string> = { "config.json": JSON.stringify({ providers: { claude: { identities: ["alpha"], app: "alpha-app" } } }) };

  constructor(opts: FakeKubeOptions = {}) {
    this.opts = opts;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.server = Bun.serve<{ pod: string }>({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 120,
      fetch: (req, srv) => self.handle(req, srv),
      websocket: {
        open: (ws) => self.onOpen(ws),
        message: (ws, m) => self.onMessage(ws, m),
        close: (ws) => self.onClose(ws),
      },
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** Change the status of a session and tell the watchers. */
  setStatus(name: string, status: KubeSession["status"]): void {
    const s = this.sessions.get(name);
    if (!s) return;
    s.status = status;
    for (const w of this.watchers) if (w.name === name) w.send({ type: "MODIFIED", object: s });
  }

  /** End every open watch stream. The client should reconnect. */
  dropWatches(): void {
    for (const w of [...this.watchers]) w.close();
  }

  watcherCount(): number {
    return this.watchers.size;
  }

  attachCount(pod: string): number {
    return this.sockets.get(pod) ?? 0;
  }

  /** Stop the stub process of a pod and close its socket from the server side. */
  killPod(): void {
    for (const p of this.procs) p.kill();
  }

  async stop(): Promise<void> {
    this.dropWatches();
    for (const p of this.procs) p.kill();
    await this.server.stop(true);
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private async handle(req: Request, srv: ReturnType<typeof Bun.serve>): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (req.headers.get("authorization") !== `Bearer ${FAKE_TOKEN}`) return this.json({ message: "unauthorised" }, 401);
    const base = `/apis/${FAKE_GROUP}/v1alpha1/namespaces/${FAKE_NAMESPACE}/agentsessions`;
    const attach = /^\/api\/v1\/namespaces\/[^/]+\/pods\/([^/]+)\/attach$/.exec(url.pathname);
    if (attach) {
      this.attachPaths.push(`${url.pathname}${url.search}`);
      this.attachAuth.push(req.headers.get("authorization") ?? "");
      if (this.rejectAttach) return new Response("no", { status: 403 });
      const ok = srv.upgrade(req, { data: { pod: attach[1]! }, headers: { "sec-websocket-protocol": "v4.channel.k8s.io" } });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }
    const cm = /^\/api\/v1\/namespaces\/[^/]+\/configmaps\/([^/]+)$/.exec(url.pathname);
    if (cm) return this.json({ data: this.configMap });
    if (url.pathname === base) {
      if (req.method === "POST") {
        const obj = (await req.json()) as KubeSession;
        const name = obj.metadata.name;
        if (this.sessions.has(name)) return this.json({ message: "exists" }, 409);
        obj.status = { phase: this.opts.initialPhase ?? "Running", ...(this.opts.initialPhase && this.opts.initialPhase !== "Running" ? {} : { pod: `agent-${name}`, worktreePath: "/work/chat/home" }) };
        this.sessions.set(name, obj);
        return this.json(obj, 201);
      }
      if (url.searchParams.get("watch")) return this.watch(req, url);
      const sel = (url.searchParams.get("labelSelector") ?? "").split(",").filter(Boolean).map((p) => p.split("="));
      const items = [...this.sessions.values()].filter((s) => sel.every(([k, v]) => s.metadata.labels?.[k!] === v));
      return this.json({ items });
    }
    if (url.pathname.startsWith(`${base}/`)) {
      const name = decodeURIComponent(url.pathname.slice(base.length + 1));
      const s = this.sessions.get(name);
      if (!s) return this.json({ message: "not found" }, 404);
      if (req.method === "GET") return this.json(s);
      if (req.method === "DELETE") {
        this.sessions.delete(name);
        for (const w of this.watchers) if (w.name === name) w.send({ type: "DELETED", object: s });
        return this.json({ status: "Success" });
      }
      if (req.method === "PATCH") {
        if (this.failAnnotate > 0) {
          this.failAnnotate -= 1;
          return this.json({ message: "boom" }, 500);
        }
        const patch = (await req.json()) as { metadata?: { annotations?: Record<string, string> } };
        const notes = patch.metadata?.annotations ?? {};
        s.metadata.annotations = { ...s.metadata.annotations, ...notes };
        const pod = s.status?.pod ?? "";
        this.annotations.push({ name, notes, attachedSocket: this.attachCount(pod) > 0 });
        return this.json(s);
      }
    }
    return this.json({ message: "not found" }, 404);
  }

  private watch(req: Request, url: URL): Response {
    const name = /metadata\.name=(.+)$/.exec(url.searchParams.get("fieldSelector") ?? "")?.[1] ?? "";
    const enc = new TextEncoder();
    let w: Watcher;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        w = {
          name,
          send: (ev) => {
            try {
              c.enqueue(enc.encode(`${JSON.stringify(ev)}\n`));
            } catch {
              // closed
            }
          },
          close: () => {
            this.watchers.delete(w);
            try {
              c.close();
            } catch {
              // closed
            }
          },
        };
        this.watchers.add(w);
        const cur = this.sessions.get(name);
        if (cur) w.send({ type: "ADDED", object: cur });
        req.signal.addEventListener("abort", () => this.watchers.delete(w));
      },
      cancel: () => {
        this.watchers.delete(w);
      },
    });
    return new Response(stream, { headers: { "content-type": "application/json" } });
  }

  private onOpen(ws: Bun.ServerWebSocket<{ pod: string }>): void {
    const pod = ws.data.pod;
    this.sockets.set(pod, this.attachCount(pod) + 1);
    this.openSockets.add(ws);
    const proc = Bun.spawn([process.execPath, STUB], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...this.opts.stubEnv } });
    this.procs.add(proc);
    (ws.data as { proc?: Subprocess }).proc = proc;
    const pump = async (stream: ReadableStream<Uint8Array>, channel: number) => {
      for await (const chunk of stream) {
        const f = new Uint8Array(chunk.length + 1);
        f[0] = channel;
        f.set(chunk, 1);
        try {
          ws.send(f);
        } catch {
          return;
        }
      }
    };
    void pump(proc.stdout as ReadableStream<Uint8Array>, 1);
    void pump(proc.stderr as ReadableStream<Uint8Array>, 2);
    void proc.exited.then(() => {
      this.procs.delete(proc);
      try {
        ws.send(new Uint8Array([3, ...new TextEncoder().encode(JSON.stringify({ status: "Failure" }))]));
        ws.close(1000);
      } catch {
        // closed
      }
    });
  }

  /** Write bytes to the stderr channel of every open socket (test helper). */
  sendFrame(channel: number, bytes: Uint8Array): void {
    for (const ws of this.openSockets) ws.send(new Uint8Array([channel, ...bytes]));
  }

  readonly openSockets = new Set<Bun.ServerWebSocket<{ pod: string }>>();

  private onMessage(ws: Bun.ServerWebSocket<{ pod: string }>, m: string | Buffer): void {
    if (typeof m === "string") return;
    const proc = (ws.data as { proc?: Subprocess }).proc;
    if (m.length > 1 && m[0] === 0) (proc?.stdin as { write(b: Uint8Array): number; flush(): void } | undefined)?.write(m.subarray(1));
    (proc?.stdin as { flush?(): void } | undefined)?.flush?.();
  }

  private onClose(ws: Bun.ServerWebSocket<{ pod: string }>): void {
    this.openSockets.delete(ws);
    this.sockets.set(ws.data.pod, Math.max(0, this.attachCount(ws.data.pod) - 1));
    (ws.data as { proc?: Subprocess }).proc?.kill();
  }
}
