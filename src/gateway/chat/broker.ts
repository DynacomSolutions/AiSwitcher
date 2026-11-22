// Chat broker, start path: create a chat, start its pod, attach, report errors.
// Prompts, cancels, permissions and close come in later tasks.
import { CHAT_ERROR_CODES, MAX_CHATS_PER_WINDOW, sessionIdForChat, type ChatBody, type ChatSelection } from "../../browser/chat-protocol.ts";
import type { ChatAuth, ChatPrincipal } from "../browser/chat-auth.ts";
import type { GatewayMetrics } from "../metrics.ts";
import { AcpClient, AcpError } from "./acp.ts";
import { KubeHttpError } from "./kube-http.ts";
import type { PodHandle, PodTransport } from "./kube.ts";
import { PodStartError, type Timers } from "./pod-transport.ts";
import { ChatClosedError, ChatExistsError, ChatLeaseLostError, type ChatRecord, type ChatStore, type LeaseFence } from "./types.ts";
import { mintChatToken, verifyChatToken } from "./token.ts";

const DAY_MS = 86_400_000;
const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_START_TIMEOUT_MS = 5 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The agent may use the browser tools only through this MCP server name. */
const MCP_NAME = "ais-browser";

const realTimers: Timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export interface BrokerDeps {
  store: ChatStore;
  transport: PodTransport;
  mcpUrl: string;
  tokenKey: Buffer;
  replicaId: string;
  metrics: GatewayMetrics;
  now(): number;
  leaseTtlMs?: number;
  /** Idle time before a chat pod stops. Used by a later task. */
  idleMs?: number;
  /** Time limit of one pod start, from the call to the new ACP session. Default 5 minutes. */
  startTimeoutMs?: number;
  /** A chat older than this gets no principal. Default 7 days. */
  maxAgeMs?: number;
  publish(chatId: string, seq: number): void;
  identityOf(binding: string): Promise<string | undefined>;
  /** Time limit of one ACP request in the start path. */
  acpTimeoutMs?: number;
  timers?: Timers;
}

export type BrokerReject = { code: (typeof CHAT_ERROR_CODES)[number]; message: string };

/** A chat with a running agent. Later tasks add prompt, cancel and close on top of it. */
export interface ChatRuntime {
  chatId: string;
  fence: LeaseFence;
  acp: AcpClient;
  handle: PodHandle;
  sessionId: string;
}

/** The agent did not offer HTTP MCP. */
class NoHttpError extends Error {}

type Failure = { code: (typeof CHAT_ERROR_CODES)[number]; message: string; kind: string };

/** Stream close reasons come from our own transport. Only a fixed set reaches the feed. */
const EXIT_REASONS: Record<string, string> = { "pod exited": "exited", "pod stream error": "stream_error", "line too long": "line_too_long" };
const exitFailure = (reason: string | undefined): Failure => ({
  code: "agent_exit",
  message: `The agent stopped before it was ready (reason: ${EXIT_REASONS[reason ?? ""] ?? "closed"}).`,
  kind: "agent_exit",
});

export class ChatBroker implements ChatAuth {
  private readonly runtimes = new Map<string, ChatRuntime & { renew: unknown }>();
  private readonly starting = new Map<string, { promise: Promise<ChatRuntime | undefined>; ac: AbortController }>();
  private readonly timers: Timers;

  constructor(private readonly d: BrokerDeps) {
    this.timers = d.timers ?? realTimers;
  }

  private get leaseTtl(): number {
    return this.d.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  /** Events always go through the store, then out to the listeners. A lost lease is not an error here. */
  private async emit(chatId: string, body: ChatBody, fence: LeaseFence): Promise<void> {
    try {
      const seq = await this.d.store.appendEvent(chatId, body, fence);
      this.d.publish(chatId, seq);
    } catch (e) {
      if (!(e instanceof ChatLeaseLostError)) throw e;
    }
  }

  async create(i: { chatId: string; binding: string; windowId: number; name: string; color: string; selection: ChatSelection; tabIds: number[] }): Promise<ChatRecord | BrokerReject> {
    // The pod name and the admission rule use the first eight hex digits. A hostile id could collide on them.
    if (!UUID_RE.test(i.chatId)) return { code: "bad_request", message: "The chat id is not valid." };
    let rec: ChatRecord | "cap";
    try {
      rec = await this.d.store.create(
        { id: i.chatId, binding: i.binding, windowId: i.windowId, name: i.name, color: i.color, selection: i.selection, tabIds: i.tabIds, createdAt: this.d.now() },
        MAX_CHATS_PER_WINDOW,
        { replica: this.d.replicaId, ttlMs: this.leaseTtl },
      );
    } catch (e) {
      if (e instanceof ChatExistsError) return { code: "bad_request", message: "A chat with this id exists." };
      throw e;
    }
    if (rec === "cap") return { code: "window_cap", message: `A window holds at most ${MAX_CHATS_PER_WINDOW} chats.` };
    const fence = { replica: this.d.replicaId, epoch: rec.epoch };
    await this.emit(rec.id, { k: "notice", text: "Starting your agent" }, fence);
    await this.d.store.releaseLease(rec.id, fence);
    this.d.metrics.chatSession("session_created");
    return (await this.d.store.get(rec.id)) ?? rec;
  }

  async principal(token: string): Promise<ChatPrincipal | undefined> {
    const now = this.d.now();
    const claims = verifyChatToken(this.d.tokenKey, token, now);
    if (!claims) return undefined;
    const chat = await this.d.store.get(claims.chatId);
    if (!chat || chat.state === "closed" || chat.binding !== claims.binding) return undefined;
    if (now > chat.createdAt + (this.d.maxAgeMs ?? 7 * DAY_MS)) return undefined;
    const identity = await this.d.identityOf(chat.binding);
    if (identity === undefined) return undefined;
    return { chatId: chat.id, binding: chat.binding, identity, label: chat.name, color: chat.color, linked: new Set(chat.tabIds) };
  }

  /**
   * Start the pod of a chat and open its ACP session. One start runs per chat at a time.
   * Returns the runtime, or undefined when the start failed (the chat then holds an error item) or another replica owns the chat.
   */
  startPod(chatId: string): Promise<ChatRuntime | undefined> {
    const live = this.runtimes.get(chatId);
    if (live) return Promise.resolve(live);
    const pending = this.starting.get(chatId);
    if (pending) return pending.promise;
    const ac = new AbortController();
    const promise = this.runStart(chatId, ac).finally(() => this.starting.delete(chatId));
    this.starting.set(chatId, { promise, ac });
    return promise;
  }

  private async runStart(chatId: string, ac: AbortController): Promise<ChatRuntime | undefined> {
    const { store, transport, metrics } = this.d;
    if (!UUID_RE.test(chatId)) return undefined;
    const chat = await store.get(chatId);
    if (!chat || chat.state === "closed") return undefined;
    const epoch = await store.acquireLease(chatId, this.d.replicaId, this.leaseTtl, this.d.now());
    if (epoch === undefined) return undefined;
    const fence: LeaseFence = { replica: this.d.replicaId, epoch };

    let timedOut = false;
    let handle: PodHandle | undefined;
    const timer = this.timers.setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, this.d.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    // An abort after the attach closes the stream, so a waiting ACP request ends.
    ac.signal.addEventListener("abort", () => handle?.stream.close(), { once: true });
    let closedReason: string | undefined;
    try {
      // The generation lives in the store and only grows, so a pod name is never used twice.
      const generation = chat.generation + 1;
      await store.update(chatId, { state: "starting", generation }, fence);
      handle = await transport.start(
        { chatId, generation, provider: chat.selection.provider, identity: chat.selection.identity },
        ac.signal,
        (n) => void this.emit(chatId, { k: "notice", text: n.text }, fence).catch(() => undefined),
      );
      const stream = handle.stream;
      stream.onClose((r) => {
        closedReason = r;
      });
      const acp = new AcpClient(
        stream,
        { onUpdate: () => undefined, onPermission: async () => ({}) },
        this.d.acpTimeoutMs === undefined ? {} : { requestTimeoutMs: this.d.acpTimeoutMs },
      );
      const caps = await acp.initialize();
      metrics.chatPodStart((this.d.now() - chat.createdAt) / 1000);
      if (!caps.http) throw new NoHttpError();
      // The token goes to the agent over the ACP stream only. It is never stored or logged.
      const token = mintChatToken(this.d.tokenKey, { chatId, binding: chat.binding, exp: chat.createdAt + 7 * DAY_MS });
      const { sessionId } = await acp.newSession({
        cwd: handle.cwd,
        mcpServers: [
          {
            type: "http",
            name: MCP_NAME,
            url: this.d.mcpUrl,
            headers: [
              { name: "Authorization", value: `Bearer ${token}` },
              { name: "X-AIS-Session-Id", value: sessionIdForChat(chatId) },
              { name: "X-AIS-Session-Label", value: encodeURIComponent(chat.name) },
            ],
          },
        ],
      });
      this.timers.clearTimeout(timer);
      await store.update(chatId, { state: "idle", acpSessionId: sessionId, podSession: handle.session, canLoad: caps.loadSession }, fence);
      const rt: ChatRuntime & { renew: unknown } = { chatId, fence, acp, handle, sessionId, renew: undefined };
      this.runtimes.set(chatId, rt);
      this.armRenew(rt);
      void acp.closed.then((reason) => this.onAgentClosed(rt, reason));
      return rt;
    } catch (e) {
      this.timers.clearTimeout(timer);
      handle?.stream.close();
      if (e instanceof ChatLeaseLostError || e instanceof ChatClosedError) {
        // Another owner or a close took the chat. This start stops without a word.
        await transport.stop(chatId).catch(() => undefined);
        return undefined;
      }
      const f = this.classify(e, { timedOut, handle, closedReason });
      await this.fail(chatId, fence, f);
      return undefined;
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  /** Fixed copy by cause. The text of the error itself never reaches the feed. */
  private classify(e: unknown, s: { timedOut: boolean; handle: PodHandle | undefined; closedReason: string | undefined }): Failure {
    if (s.timedOut) return { code: "timeout", message: "The agent did not start in time.", kind: "timeout" };
    if (e instanceof PodStartError) return { code: "pod_start", message: e.message, kind: "pod_start" };
    if (e instanceof NoHttpError) return { code: "acp", message: "This agent cannot use HTTP tools", kind: "acp" };
    if (s.handle) {
      if (e instanceof AcpError && e.code === -32001) return { code: "timeout", message: "The agent did not answer in time.", kind: "timeout" };
      if (s.closedReason !== undefined) return exitFailure(s.closedReason);
      return { code: "acp", message: "The agent could not open a session.", kind: "acp" };
    }
    if (e instanceof KubeHttpError) return { code: "pod_start", message: "The agent could not start.", kind: "pod_start" };
    return { code: "attach", message: "The agent could not be reached.", kind: "attach" };
  }

  private async fail(chatId: string, fence: LeaseFence, f: Failure): Promise<void> {
    const { store, transport, metrics } = this.d;
    metrics.chatError(f.kind);
    try {
      await this.emit(chatId, { k: "error", code: f.code, message: f.message }, fence);
      await store.update(chatId, { state: "failed" }, fence);
    } catch (e) {
      if (!(e instanceof ChatLeaseLostError || e instanceof ChatClosedError)) throw e;
    }
    await transport.stop(chatId).catch(() => undefined);
    await store.releaseLease(chatId, fence).catch(() => undefined);
  }

  /** The agent ended while the chat was running. */
  private onAgentClosed(rt: ChatRuntime & { renew: unknown }, reason: string): void {
    if (this.runtimes.get(rt.chatId) !== rt) return;
    this.runtimes.delete(rt.chatId);
    this.timers.clearTimeout(rt.renew);
    void this.fail(rt.chatId, rt.fence, { code: "agent_exit", message: `The agent stopped (reason: ${EXIT_REASONS[reason] ?? "closed"}).`, kind: "agent_exit" }).catch(() => undefined);
  }

  private armRenew(rt: ChatRuntime & { renew: unknown }): void {
    rt.renew = this.timers.setTimeout(() => {
      void this.d.store.renewLease(rt.chatId, rt.fence, this.leaseTtl, this.d.now()).then(
        () => {
          if (this.runtimes.get(rt.chatId) === rt) this.armRenew(rt);
        },
        (e: unknown) => {
          if (e instanceof ChatLeaseLostError) this.drop(rt.chatId);
          else if (this.runtimes.get(rt.chatId) === rt) this.armRenew(rt);
        },
      );
    }, Math.max(1000, Math.floor(this.leaseTtl / 3)));
  }

  /** Forget a runtime and close its stream. It sends no event. */
  private drop(chatId: string): ChatRuntime | undefined {
    const rt = this.runtimes.get(chatId);
    if (!rt) return undefined;
    this.runtimes.delete(chatId);
    this.timers.clearTimeout(rt.renew);
    rt.handle.stream.close();
    return rt;
  }

  /** Stop all work of this broker: running starts, streams and lease timers. */
  async dispose(): Promise<void> {
    const waits = [...this.starting.values()].map((s) => {
      s.ac.abort();
      return s.promise.catch(() => undefined);
    });
    await Promise.all(waits);
    for (const id of [...this.runtimes.keys()]) {
      const rt = this.drop(id);
      if (rt) await this.d.store.releaseLease(id, rt.fence).catch(() => undefined);
    }
  }
}
