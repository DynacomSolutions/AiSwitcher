// Kubernetes API over fetch and WebSocket. No client library.
//
// Spike result (Bun 1.4): `new WebSocket(url, { headers, tls: { ca } })` sends the Authorization header and trusts
// the custom CA, and a server with an unknown CA is refused. So the attach uses a normal authorisation header and no
// token subprotocol is needed. The test `Bun WebSocket sends an Authorization header and trusts a custom CA` keeps this proof.
import { createLineReader } from "./acp.ts";
import type { KubeApi, KubeConfigEnv, KubeSession, KubeSocket } from "./kube.ts";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const REQUEST_TIMEOUT_MS = 20_000;

const TOKEN_CACHE_MS = 60_000;

/** The service account token rotates. `token()` re-reads the file and caches it for at most 60 s. */
export function inClusterKube(env: NodeJS.ProcessEnv, readFile: (p: string) => string, now: () => number = Date.now): { baseUrl: string; token: () => string; ca: string } {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) throw new Error("not running in a cluster");
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  let cached = "";
  let readAt = -Infinity;
  const token = (): string => {
    const t = now();
    if (cached === "" || t - readAt >= TOKEN_CACHE_MS || t < readAt) {
      cached = readFile(`${SA_DIR}/token`).trim();
      readAt = t;
    }
    return cached;
  };
  token();
  return { baseUrl: `https://${h}:${port}`, token, ca: readFile(`${SA_DIR}/ca.crt`) };
}

/** A reason is a short code. Anything else is replaced, so odd text cannot pass through. */
export const reasonCode = (r: string | undefined): string => (r && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(r) ? r : "Unknown");

const STATUS_PEEK_BYTES = 300;

/** Read at most 300 bytes of a Kubernetes Status reply and keep only its short `reason` code. Never throws. */
async function statusReason(res: Response): Promise<string | undefined> {
  try {
    const reader = res.body?.getReader();
    if (!reader) return undefined;
    const parts: Uint8Array[] = [];
    let got = 0;
    while (got < STATUS_PEEK_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      parts.push(value);
      got += value.length;
    }
    await reader.cancel().catch(() => undefined);
    const buf = new Uint8Array(got);
    let at = 0;
    for (const p of parts) {
      buf.set(p, at);
      at += p.length;
    }
    const text = new TextDecoder().decode(buf.subarray(0, STATUS_PEEK_BYTES));
    // The cap can cut the JSON. Read the reason field from the text, only when it is a short code.
    const m = /"reason"\s*:\s*"([A-Za-z][A-Za-z0-9]{0,39})"/.exec(text);
    return m ? reasonCode(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

export class KubeHttpError extends Error {
  constructor(readonly status: number, readonly op: string, readonly kubeReason?: string) {
    super(`kube ${op} failed with status ${status}`);
    this.name = "KubeHttpError";
  }
}

export interface HttpKubeOptions {
  baseUrl: string;
  /** Called for every request, so a rotated token is used. */
  token: () => string;
  ca?: string;
  env: Pick<KubeConfigEnv, "group" | "namespace">;
  requestTimeoutMs?: number;
  /** Server side limit of one watch. The client then asks again. Default 300. */
  watchTimeoutSeconds?: number;
  /** Time allowed for the attach upgrade. Default 30 s. */
  attachOpenTimeoutMs?: number;
  /** Extra time past the server limit before the client ends a silent watch. Default 30 s. */
  watchGraceMs?: number;
}

export class HttpKubeApi implements KubeApi {
  constructor(private readonly o: HttpKubeOptions) {}

  private sessionsPath(name?: string): string {
    const { group, namespace } = this.o.env;
    return `/apis/${group}/v1alpha1/namespaces/${encodeURIComponent(namespace)}/agentsessions${name ? `/${encodeURIComponent(name)}` : ""}`;
  }

  private init(method: string, signal: AbortSignal | undefined, extra: Record<string, string> = {}, body?: string): RequestInit {
    const timeout = AbortSignal.timeout(this.o.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    const init: Record<string, unknown> = {
      method,
      headers: { Authorization: `Bearer ${this.o.token()}`, Accept: "application/json", ...extra },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    };
    if (body !== undefined) init.body = body;
    if (this.o.ca) init.tls = { ca: this.o.ca };
    return init as RequestInit;
  }

  private async json<T>(op: string, path: string, init: RequestInit, allow404 = false): Promise<T | undefined> {
    const res = await fetch(`${this.o.baseUrl}${path}`, init);
    if (res.status === 404 && allow404) {
      await res.body?.cancel();
      return undefined;
    }
    if (!res.ok) {
      throw new KubeHttpError(res.status, op, await statusReason(res));
    }
    return (await res.json()) as T;
  }

  async createSession(obj: object, signal?: AbortSignal): Promise<KubeSession> {
    return (await this.json<KubeSession>("create", this.sessionsPath(), this.init("POST", signal, { "Content-Type": "application/json" }, JSON.stringify(obj))))!;
  }

  getSession(name: string, signal?: AbortSignal): Promise<KubeSession | undefined> {
    return this.json<KubeSession>("get", this.sessionsPath(name), this.init("GET", signal), true);
  }

  async listSessions(labelSelector: string): Promise<KubeSession[]> {
    const r = await this.json<{ items?: KubeSession[] }>("list", `${this.sessionsPath()}?labelSelector=${encodeURIComponent(labelSelector)}`, this.init("GET", undefined));
    return r?.items ?? [];
  }

  async annotate(name: string, notes: Record<string, string>): Promise<void> {
    await this.json("annotate", this.sessionsPath(name), this.init("PATCH", undefined, { "Content-Type": "application/merge-patch+json" }, JSON.stringify({ metadata: { annotations: notes } })));
  }

  async deleteSession(name: string): Promise<void> {
    await this.json("delete", this.sessionsPath(name), this.init("DELETE", undefined), true);
  }

  async getConfigMap(name: string): Promise<Record<string, string>> {
    const { namespace } = this.o.env;
    const r = await this.json<{ data?: Record<string, string> }>("configmap", `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${encodeURIComponent(name)}`, this.init("GET", undefined));
    return r?.data ?? {};
  }

  watchSession(name: string, onEvent: (s: KubeSession | undefined) => void, onEnd: (reason: string) => void): { close(): void } {
    const ctl = new AbortController();
    let ended = false;
    const limit = setTimeout(() => {
      if (ended) return;
      ctl.abort();
      end("watch timed out");
    }, (this.o.watchTimeoutSeconds ?? 300) * 1000 + (this.o.watchGraceMs ?? 30_000));
    const end = (reason: string) => {
      clearTimeout(limit);
      if (ended) return;
      ended = true;
      onEnd(reason);
    };
    const path = `${this.sessionsPath()}?watch=1&timeoutSeconds=${this.o.watchTimeoutSeconds ?? 300}&fieldSelector=${encodeURIComponent(`metadata.name=${name}`)}`;
    void (async () => {
      try {
        // No request timeout: a watch is long. Only the close handle stops it.
        const init = this.init("GET", ctl.signal);
        (init as { signal: AbortSignal }).signal = ctl.signal;
        const res = await fetch(`${this.o.baseUrl}${path}`, init);
        if (!res.ok || !res.body) {
          await res.body?.cancel();
          return end(`watch status ${res.status}`);
        }
        const reader = createLineReader({
          onLine: (line) => {
            if (ended || line.trim() === "") return;
            try {
              const ev = JSON.parse(line) as { type?: string; object?: KubeSession };
              if (ev.type === "DELETED") onEvent(undefined);
              else if ((ev.type === "ADDED" || ev.type === "MODIFIED") && ev.object) onEvent(ev.object);
            } catch {
              // A bad line is skipped.
            }
          },
          onOverflow: () => {
            ctl.abort();
            end("watch line too long");
          },
        });
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) reader.push(chunk);
        end("watch ended");
      } catch {
        end("watch failed");
      }
    })();
    return {
      close() {
        clearTimeout(limit);
        ended = true;
        ctl.abort();
      },
    };
  }

  openAttach(pod: string, signal: AbortSignal): Promise<KubeSocket> {
    const { namespace } = this.o.env;
    const base = this.o.baseUrl.replace(/^http/, "ws");
    const url = `${base}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/attach?container=agent&stdin=true&stdout=true&stderr=true&tty=false`;
    return new Promise<KubeSocket>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      const opts: Record<string, unknown> = { protocols: ["v4.channel.k8s.io"], headers: { Authorization: `Bearer ${this.o.token()}` } };
      if (this.o.ca) opts.tls = { ca: this.o.ca };
      const ws = new WebSocket(url, opts as never);
      ws.binaryType = "arraybuffer";
      const msgCbs: Array<(d: Uint8Array) => void> = [];
      const closeCbs: Array<(r: string) => void> = [];
      let opened = false;
      let closed = false;
      const fireClose = (reason: string) => {
        if (closed) return;
        closed = true;
        for (const cb of closeCbs) cb(reason);
      };
      const onAbort = () => {
        clearTimeout(openTimer);
        if (!opened) reject(new Error("aborted"));
        ws.close();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const openTimer = setTimeout(() => {
        if (opened) return;
        signal.removeEventListener("abort", onAbort);
        reject(new Error("attach timed out"));
        ws.close();
      }, this.o.attachOpenTimeoutMs ?? 30_000);
      ws.onopen = () => {
        clearTimeout(openTimer);
        opened = true;
        signal.removeEventListener("abort", onAbort);
        resolve({
          send: (d) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(d);
          },
          onMessage: (cb) => void msgCbs.push(cb),
          onClose: (cb) => {
            if (closed) cb("attach closed");
            else closeCbs.push(cb);
          },
          close: () => {
            ws.close();
            fireClose("closed locally");
          },
        });
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") return;
        const d = new Uint8Array(ev.data as ArrayBuffer);
        for (const cb of msgCbs) cb(d);
      };
      ws.onerror = () => {
        if (!opened) {
          clearTimeout(openTimer);
          signal.removeEventListener("abort", onAbort);
          reject(new Error("attach failed"));
        }
      };
      ws.onclose = (ev) => {
        clearTimeout(openTimer);
        signal.removeEventListener("abort", onAbort);
        if (!opened) return reject(new Error("attach failed"));
        fireClose(`attach closed (${ev.code})`);
      };
    });
  }
}
