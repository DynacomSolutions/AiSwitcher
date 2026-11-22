// ACP (Agent Client Protocol) client over JSON lines. The broker uses it to talk to an agent process.

export interface AcpIo {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: (reason: string) => void): void;
}
export interface AcpMcpServer {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}
export type AcpUpdate =
  | { kind: "text" | "thought"; text: string }
  | { kind: "tool"; toolCallId: string; title?: string; status?: string; args?: string; result?: string }
  | { kind: "config"; models: Array<{ id: string; name: string }>; efforts: string[]; current: { model?: string; effort?: string } }
  | { kind: "other" };
export type AcpPermission = { rpcId: string | number; title: string; options: Array<{ id: string; name: string; kind: string }> };
export interface AcpHandlers {
  onUpdate(sessionId: string, u: AcpUpdate): void;
  /** No optionId in the answer means the request is cancelled. */
  onPermission(sessionId: string, p: AcpPermission): Promise<{ optionId?: string }>;
}

export class AcpError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function stringify(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Join the text parts of a tool call content array. */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!isObj(item)) continue;
    const inner = isObj(item.content) ? item.content : item;
    const t = str(inner.text);
    if (t !== undefined) parts.push(t);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export const MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Split a byte or text stream into lines. It handles partial lines, several lines in one chunk, CRLF and
 * UTF-8 characters split across chunks. A line longer than `maxBytes` calls `onOverflow` once and stops the reader.
 */
export function createLineReader(opts: { maxBytes?: number; onLine: (line: string) => void; onOverflow: () => void }): { push(chunk: Uint8Array | string): void } {
  const maxBytes = opts.maxBytes ?? MAX_LINE_BYTES;
  const decoder = new TextDecoder();
  let pending = "";
  let pendingBytes = 0;
  let stopped = false;
  const overflow = () => {
    stopped = true;
    pending = "";
    pendingBytes = 0;
    opts.onOverflow();
  };
  return {
    push(chunk) {
      if (stopped) return;
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let start = 0;
      for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", start)) {
        const seg = text.slice(start, nl);
        start = nl + 1;
        let line = pending + seg;
        let bytes = pendingBytes + Buffer.byteLength(seg);
        pending = "";
        pendingBytes = 0;
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
          bytes -= 1;
        }
        if (bytes > maxBytes) return overflow();
        opts.onLine(line);
        if (stopped) return;
      }
      if (start < text.length) {
        const rest = text.slice(start);
        pending += rest;
        pendingBytes += Buffer.byteLength(rest);
        // A trailing CR may belong to a CRLF whose LF comes next, so allow one extra byte.
        if (pendingBytes > maxBytes + (pending.endsWith("\r") ? 1 : 0)) overflow();
      }
    },
  };
}

interface ConfigIds {
  model?: string;
  effort?: string;
}

export class AcpClient {
  readonly closed: Promise<string>;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
  private closedReason: string | undefined;
  private resolveClosed!: (reason: string) => void;
  private readonly configIds = new Map<string, ConfigIds>();
  private readonly sessions = new Set<string>();
  private readonly permWaiters = new Map<string | number, { sessionId: string; cancel: () => void }>();
  private readonly timeoutMs: number;

  constructor(
    private readonly io: AcpIo,
    private readonly handlers: AcpHandlers,
    opts: { requestTimeoutMs?: number } = {},
  ) {
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.closed = new Promise<string>((resolve) => {
      this.resolveClosed = resolve;
    });
    io.onClose((reason) => this.close(reason));
    io.onLine((line) => {
      try {
        this.onLine(line);
      } catch {
        // A bad line or a failing handler must not stop later lines.
      }
    });
  }

  private close(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`ACP connection closed: ${reason}`));
    }
    this.pending.clear();
    this.configIds.clear();
    this.sessions.clear();
    for (const w of [...this.permWaiters.values()]) w.cancel();
    this.permWaiters.clear();
    this.resolveClosed(reason);
  }

  async initialize(): Promise<{ http: boolean; loadSession: boolean }> {
    const r = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, this.timeoutMs);
    if (!isObj(r) || r.protocolVersion !== 1) throw new AcpError(-32603, "Unsupported ACP protocol version");
    const caps = isObj(r.agentCapabilities) ? r.agentCapabilities : {};
    const mcp = isObj(caps.mcpCapabilities) ? caps.mcpCapabilities : {};
    return { http: mcp.http === true, loadSession: caps.loadSession === true };
  }

  async newSession(p: { cwd: string; mcpServers: AcpMcpServer[] }): Promise<{ sessionId: string }> {
    const r = await this.request("session/new", { cwd: p.cwd, mcpServers: p.mcpServers }, this.timeoutMs);
    const sessionId = isObj(r) ? str(r.sessionId) : undefined;
    if (!sessionId) throw new AcpError(-32603, "session/new returned no sessionId");
    this.sessions.add(sessionId);
    this.applyConfig(sessionId, r as Obj);
    return { sessionId };
  }

  async loadSession(p: { sessionId: string; cwd: string; mcpServers: AcpMcpServer[] }): Promise<void> {
    // The agent may replay history before it answers, so the id is known from the start.
    const had = this.sessions.has(p.sessionId);
    this.sessions.add(p.sessionId);
    try {
      const r = await this.request("session/load", { sessionId: p.sessionId, cwd: p.cwd, mcpServers: p.mcpServers }, this.timeoutMs);
      if (isObj(r)) this.applyConfig(p.sessionId, r);
    } catch (e) {
      if (!had) this.sessions.delete(p.sessionId);
      throw e;
    }
  }

  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    const r = await this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    const stopReason = isObj(r) ? str(r.stopReason) : undefined;
    if (!stopReason) throw new AcpError(-32603, "session/prompt returned no stopReason");
    return { stopReason };
  }

  cancel(sessionId: string): void {
    for (const w of [...this.permWaiters.values()]) if (w.sessionId === sessionId) w.cancel();
    this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  async setConfig(sessionId: string, patch: { model?: string; effort?: string }): Promise<void> {
    const ids = this.configIds.get(sessionId) ?? {};
    if (patch.model !== undefined) {
      if (ids.model) await this.request("session/set_config_option", { sessionId, configId: ids.model, value: patch.model }, this.timeoutMs);
      else await this.request("session/set_model", { sessionId, modelId: patch.model }, this.timeoutMs);
    }
    if (patch.effort !== undefined) {
      if (!ids.effort) throw new AcpError(-32602, "The agent has no effort option");
      await this.request("session/set_config_option", { sessionId, configId: ids.effort, value: patch.effort }, this.timeoutMs);
    }
  }

  private applyConfig(sessionId: string, r: Obj): void {
    const cfg = parseConfig(r);
    if (!cfg) return;
    this.configIds.set(sessionId, cfg.ids);
    this.safeUpdate(sessionId, cfg.update);
  }

  private safeUpdate(sessionId: string, u: AcpUpdate): void {
    try {
      this.handlers.onUpdate(sessionId, u);
    } catch {
      // A failing handler must not break the reader.
    }
  }

  private send(msg: Obj): void {
    if (this.closedReason !== undefined) return;
    try {
      this.io.write(JSON.stringify(msg));
    } catch (e) {
      this.close(`write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private request(method: string, params: Obj, timeoutMs?: number): Promise<unknown> {
    if (this.closedReason !== undefined) return Promise.reject(new Error(`ACP connection closed: ${this.closedReason}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const entry: { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpError(-32001, `ACP request ${method} timed out`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private onLine(line: string): void {
    if (this.closedReason !== undefined) return;
    const trimmed = line.trim();
    if (trimmed === "") return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isObj(msg)) return;
    const method = str(msg.method);
    if (method === undefined) {
      this.onResponse(msg);
      return;
    }
    const params = isObj(msg.params) ? msg.params : {};
    if (msg.id === undefined) {
      if (method === "session/update") this.onSessionUpdate(params);
      return;
    }
    if (typeof msg.id !== "string" && typeof msg.id !== "number") return;
    const rpcId = msg.id;
    if (method === "session/request_permission") void this.onPermissionRequest(rpcId, params).catch(() => {});
    else this.send({ jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: "Method not found" } });
  }

  private onResponse(msg: Obj): void {
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (msg.error != null) {
      const e = isObj(msg.error) ? msg.error : {};
      p.reject(new AcpError(typeof e.code === "number" ? e.code : -32603, str(e.message) ?? "ACP error", e.data));
    } else p.resolve(msg.result);
  }

  private onSessionUpdate(params: Obj): void {
    const sessionId = str(params.sessionId);
    const u = isObj(params.update) ? params.update : undefined;
    if (!sessionId || !u || !this.sessions.has(sessionId)) return;
    const kind = str(u.sessionUpdate);
    let out: AcpUpdate = { kind: "other" };
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const text = isObj(u.content) ? str(u.content.text) : undefined;
      if (text !== undefined) out = { kind: kind === "agent_message_chunk" ? "text" : "thought", text };
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const toolCallId = str(u.toolCallId);
      if (toolCallId) {
        const t: AcpUpdate = { kind: "tool", toolCallId };
        const title = str(u.title);
        if (title !== undefined) t.title = title;
        const status = str(u.status) ?? (kind === "tool_call" ? "pending" : undefined);
        if (status !== undefined) t.status = status;
        const args = stringify(u.rawInput);
        if (args !== undefined) t.args = args;
        const result = contentText(u.content) ?? stringify(u.rawOutput);
        if (result !== undefined) t.result = result;
        out = t;
      }
    }
    this.safeUpdate(sessionId, out);
  }

  private respondPermission(rpcId: string | number, optionId: string | undefined): void {
    const outcome = optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" };
    this.send({ jsonrpc: "2.0", id: rpcId, result: { outcome } });
  }

  private async onPermissionRequest(rpcId: string | number, params: Obj): Promise<void> {
    const sessionId = str(params.sessionId) ?? "";
    if (!this.sessions.has(sessionId)) {
      this.respondPermission(rpcId, undefined);
      return;
    }
    if (this.permWaiters.has(rpcId)) {
      this.respondPermission(rpcId, undefined);
      return;
    }
    const call = isObj(params.toolCall) ? params.toolCall : {};
    const options = (Array.isArray(params.options) ? params.options : []).flatMap((o) =>
      isObj(o) && str(o.optionId) ? [{ id: str(o.optionId) as string, name: str(o.name) ?? "", kind: str(o.kind) ?? "" }] : [],
    );
    let settled = false;
    const finish = (optionId?: string) => {
      if (settled) return;
      settled = true;
      this.permWaiters.delete(rpcId);
      this.respondPermission(rpcId, optionId);
    };
    this.permWaiters.set(rpcId, { sessionId, cancel: () => finish(undefined) });
    try {
      const answer = await this.handlers.onPermission(sessionId, { rpcId, title: str(call.title) ?? "", options });
      finish(answer?.optionId && options.some((o) => o.id === answer.optionId) ? answer.optionId : undefined);
    } catch {
      finish(undefined);
    }
  }
}

/** Read the model and effort options from a `session/new` result. */
function parseConfig(r: Obj): { ids: ConfigIds; update: AcpUpdate } | undefined {
  const ids: ConfigIds = {};
  const models: Array<{ id: string; name: string }> = [];
  let efforts: string[] = [];
  const current: { model?: string; effort?: string } = {};
  const flat = (opts: unknown): Array<{ value: string; name: string }> =>
    (Array.isArray(opts) ? opts : []).flatMap((o) => {
      if (!isObj(o)) return [];
      if (Array.isArray(o.options)) return flat(o.options); // grouped options
      const value = str(o.value);
      return value ? [{ value, name: str(o.name) ?? value }] : [];
    });
  for (const c of Array.isArray(r.configOptions) ? r.configOptions : []) {
    if (!isObj(c)) continue;
    const id = str(c.id);
    if (!id) continue;
    const cat = str(c.category);
    if (cat === "model") {
      ids.model = id;
      for (const o of flat(c.options)) models.push({ id: o.value, name: o.name });
      current.model = str(c.currentValue);
    } else if (cat === "thought_level") {
      ids.effort = id;
      efforts = flat(c.options).map((o) => o.value);
      current.effort = str(c.currentValue);
    }
  }
  if (models.length === 0 && isObj(r.models)) {
    for (const m of Array.isArray(r.models.availableModels) ? r.models.availableModels : []) {
      if (isObj(m) && str(m.modelId)) models.push({ id: str(m.modelId) as string, name: str(m.name) ?? (str(m.modelId) as string) });
    }
    current.model = str(r.models.currentModelId) ?? current.model;
  }
  if (models.length === 0 && efforts.length === 0) return undefined;
  for (const k of ["model", "effort"] as const) if (current[k] === undefined) delete current[k];
  return { ids, update: { kind: "config", models, efforts, current } };
}
