// Minimal Chrome DevTools Protocol client over WebSocket, so the e2e needs no browser-automation package.
const CDP_TIMEOUT_MS = 30_000;

export class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = ev => {
      const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p?.reject(new Error(m.error.message)); else p?.resolve(m.result);
      } else if (m.method) {
        for (const l of this.listeners) l(m.method, m.params ?? {}, m.sessionId);
      }
    };
  }

  static connect(url: string, timeoutMs = 15_000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.close(); reject(new Error(`CDP connect timed out after ${timeoutMs} ms`)); }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(new Cdp(ws)); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("CDP connect failed")); };
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out after ${CDP_TIMEOUT_MS} ms`)); }, CDP_TIMEOUT_MS);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v as T); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void { this.ws.close(); }

  /** Attach to a target and return a handle bound to its session. */
  async attach(targetId: string): Promise<Session> {
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    return new Session(this, sessionId, targetId);
  }
}

export class Session {
  constructor(readonly cdp: Cdp, readonly id: string, readonly targetId: string) {}

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.cdp.send<T>(method, params, this.id);
  }

  /** Evaluates an expression (promises awaited) and returns its JSON value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  async screenshot(opts: { clip?: { x: number; y: number; width: number; height: number; scale: number }; format?: "png" | "jpeg" } = {}): Promise<Buffer> {
    const r = await this.send<{ data: string }>("Page.captureScreenshot", { format: opts.format ?? "png", ...(opts.clip ? { clip: opts.clip } : {}) });
    return Buffer.from(r.data, "base64");
  }
}
