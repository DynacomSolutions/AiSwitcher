// Chat broker: create a chat, start its pod, attach, run turns, answer permissions, cancel, close, end idle pods, resume.
// Every failure shows in the feed as an error item with fixed copy, and in a metric.
import { CHAT_ERROR_CODES, MAX_CHATS_PER_WINDOW, sessionIdForChat, type ChatBody, type ChatSelection, type ChatState } from "../../browser/chat-protocol.ts";
import type { ChatAuth, ChatPrincipal } from "../browser/chat-auth.ts";
import type { GatewayMetrics } from "../metrics.ts";
import { AcpClient, AcpError, type AcpPermission, type AcpUpdate } from "./acp.ts";
import { cut, mergeTool, pieces, promptFailure, type ToolBody } from "./turn.ts";
import { KubeHttpError } from "./kube-http.ts";
import { sessionName, type PodHandle, type PodTransport } from "./kube.ts";
import { PodStartError, type Timers } from "./pod-transport.ts";
import { ChatClosedError, ChatExistsError, ChatLeaseLostError, type ChatRecord, type ChatStore, type LeaseFence } from "./types.ts";
import { mintChatToken, verifyChatToken } from "./token.ts";

const DAY_MS = 86_400_000;
const DEFAULT_LEASE_TTL_MS = 60_000;
/**
 * Idle limit of a chat pod. The kubelet closes an attach after 4 hours without client data, and the agent stops with it
 * (stdinOnce). The heartbeat is an annotation patch, so it is not client data on the attach. The gateway ends the idle pod
 * well before: 2 hours by default, and never more than 3 hours.
 */
const DEFAULT_IDLE_MS = 2 * 3_600_000;
const MAX_IDLE_MS = 3 * 3_600_000;
const MAX_TOOLS_KEPT = 500;
const RESTART_NOTICE = "This chat restarted. The agent does not remember earlier messages.";
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
  /** Idle time before a chat pod stops. Default 2 hours, at most 3 hours (see DEFAULT_IDLE_MS). */
  idleMs?: number;
  /** Tell the browser of a binding that a chat session ended (SESSION_END). Best effort. */
  endBrowserSession?(binding: string, sessionId: string): Promise<void>;
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

/** Renews the lease of one chat while a start or a running agent needs it. */
interface Lease {
  chatId: string;
  fence: LeaseFence;
  timer: unknown;
  stopped: boolean;
  /** Runs when the lease is gone. */
  onLost(): void;
}

/** Live state of one running agent. The ACP handlers and the turn code share it. */
interface Ctx {
  chatId: string;
  fence: LeaseFence;
  generation: number;
  /** Events and state writes run in this order, one after the other. */
  chain: Promise<void>;
  busy: boolean;
  /** The agent ended by itself while the chat ran. */
  exited: boolean;
  cancelRequested: boolean;
  /** True while session/load runs: the agent may replay old messages, which the feed already holds. */
  replaying: boolean;
  perms: Map<string, { options: AcpPermission["options"]; resolve(a: { optionId?: string }): void }>;
  permSeq: number;
  tools: Map<string, ToolBody>;
  config?: Extract<ChatBody, { k: "config" }>;
  lastActive: number;
}

/** A chat with a running agent. */
export interface ChatRuntime {
  chatId: string;
  fence: LeaseFence;
  acp: AcpClient;
  handle: PodHandle;
  sessionId: string;
  generation: number;
  lease: Lease;
  ctx: Ctx;
}

/** The agent did not offer HTTP MCP. */
class NoHttpError extends Error {}
/** The chat is older than maxAgeMs. */
class ExpiredError extends Error {}

type Failure = { code: (typeof CHAT_ERROR_CODES)[number]; message: string; kind: string };

/** Stream close reasons come from our own transport. Only a fixed set reaches the feed. */
const EXIT_REASONS: Record<string, string> = { "pod exited": "exited", "pod stream error": "stream_error", "line too long": "line_too_long" };
const exitFailure = (reason: string | undefined): Failure => ({
  code: "agent_exit",
  message: `The agent stopped before it was ready (reason: ${EXIT_REASONS[reason ?? ""] ?? "closed"}).`,
  kind: "agent_exit",
});
const LOST_FAILURE: Failure = { code: "unavailable", message: "The connection to your agent was lost. Try again.", kind: "other" };
/** Rejects when the signal aborts, so a hung call cannot hold a start past its deadline. */
const abortable = <T>(p: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const on = () => reject(new Error("aborted"));
    signal.addEventListener("abort", on, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", on);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", on);
        reject(e);
      },
    );
  });
/** Older generations of one chat that a new start removes. Bounded, so the loop stays short. */
const OLD_GENERATIONS = 10;

export class ChatBroker implements ChatAuth {
  private readonly runtimes = new Map<string, ChatRuntime>();
  private readonly starting = new Map<string, { promise: Promise<ChatRuntime | undefined>; ac: AbortController; ending?: boolean }>();
  /** Chats with a prompt that was accepted and has not ended. A second prompt gets "busy". */
  private readonly turning = new Set<string>();
  private readonly timers: Timers;

  constructor(private readonly d: BrokerDeps) {
    this.timers = d.timers ?? realTimers;
  }

  private get leaseTtl(): number {
    return this.d.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  /** Events always go through the store, then out to the listeners. Returns false when the lease is lost. */
  private async emit(chatId: string, body: ChatBody, fence: LeaseFence): Promise<boolean> {
    try {
      const seq = await this.d.store.appendEvent(chatId, body, fence);
      this.d.publish(chatId, seq);
      return true;
    } catch (e) {
      if (e instanceof ChatLeaseLostError) return false;
      throw e;
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
    try {
      await this.emit(rec.id, { k: "notice", text: "Starting your agent" }, fence);
    } finally {
      await this.d.store.releaseLease(rec.id, fence).catch(() => undefined);
    }
    this.d.metrics.chatSession("session_created");
    return (await this.d.store.get(rec.id)) ?? rec;
  }

  async principal(token: string): Promise<ChatPrincipal | undefined> {
    const now = this.d.now();
    const claims = verifyChatToken(this.d.tokenKey, token, now);
    if (!claims) return undefined;
    const chat = await this.d.store.get(claims.chatId);
    if (!chat || chat.state === "closed" || chat.state === "failed" || chat.binding !== claims.binding) return undefined;
    // A token belongs to one pod generation. A newer start or a failed start makes an older token useless.
    if (claims.gen !== chat.generation) return undefined;
    if (now > chat.createdAt + (this.d.maxAgeMs ?? 7 * DAY_MS)) return undefined;
    const identity = await this.d.identityOf(chat.binding);
    if (identity === undefined) return undefined;
    return { chatId: chat.id, binding: chat.binding, identity, label: chat.name, color: chat.color, linked: new Set(chat.tabIds) };
  }

  /**
   * Start the pod of a chat and open its ACP session. One start runs per chat at a time.
   * Returns the runtime, or undefined when the start failed (the chat then holds an error item) or another replica owns the chat.
   * It never rejects.
   */
  startPod(chatId: string): Promise<ChatRuntime | undefined> {
    const live = this.runtimes.get(chatId);
    if (live) return Promise.resolve(live);
    const pending = this.starting.get(chatId);
    // A lost-lease clean-up is running. A new start waits for it, so the clean-up cannot hit the new pod.
    if (pending?.ending) return pending.promise.then(() => this.startPod(chatId));
    if (pending) return pending.promise;
    const ac = new AbortController();
    const promise = this.runStart(chatId, ac)
      .catch(() => {
        this.d.metrics.chatError("other");
        return undefined;
      })
      .finally(() => this.starting.delete(chatId));
    this.starting.set(chatId, { promise, ac });
    return promise;
  }

  private armRenew(lease: Lease): void {
    if (lease.stopped) return;
    lease.timer = this.timers.setTimeout(() => {
      void this.d.store.renewLease(lease.chatId, lease.fence, this.leaseTtl, this.d.now()).then(
        () => this.armRenew(lease),
        (e: unknown) => {
          if (lease.stopped) return;
          if (e instanceof ChatLeaseLostError) {
            this.stopLease(lease);
            lease.onLost();
          } else this.armRenew(lease);
        },
      );
    }, Math.max(1000, Math.floor(this.leaseTtl / 3)));
  }

  private stopLease(lease: Lease): void {
    lease.stopped = true;
    this.timers.clearTimeout(lease.timer);
  }

  private async runStart(chatId: string, ac: AbortController): Promise<ChatRuntime | undefined> {
    const { store, transport, metrics } = this.d;
    if (!UUID_RE.test(chatId)) return undefined;
    const startedAt = this.d.now();
    const pre = await store.get(chatId);
    if (!pre || pre.state === "closed") return undefined;
    const epoch = await store.acquireLease(chatId, this.d.replicaId, this.leaseTtl, this.d.now());
    if (epoch === undefined) return undefined;
    const fence: LeaseFence = { replica: this.d.replicaId, epoch };
    const lease: Lease = { chatId, fence, timer: undefined, stopped: false, onLost: () => undefined };

    let timedOut = false;
    let leaseLost = false;
    let handle: PodHandle | undefined;
    let name = "";
    let generation = 0;
    let generationSet = false;
    let closedReason: string | undefined;
    let kept = false;
    let startTimer: unknown;
    try {
      // The lease is renewed from here, so a slow start does not lose it.
      lease.onLost = () => {
        leaseLost = true;
        ac.abort();
      };
      this.armRenew(lease);
      startTimer = this.timers.setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, this.d.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
      // An abort after the attach closes the stream, so a waiting ACP request ends.
      ac.signal.addEventListener("abort", () => handle?.stream.close(), { once: true });
      // Read the chat again now that this replica owns it. Another replica may have changed it since the first read.
      const chat = await store.get(chatId);
      if (!chat || chat.state === "closed") return undefined;
      // The generation lives in the store and only grows, so a pod name is never used twice.
      generation = chat.generation + 1;
      name = sessionName(chatId, generation);
      if (this.d.now() > chat.createdAt + (this.d.maxAgeMs ?? 7 * DAY_MS)) throw new ExpiredError();
      await store.update(chatId, { state: "starting", generation }, fence);
      generationSet = true;
      // A pod from before a gateway restart must not stay next to the new one. The calls run together and end with the start deadline.
      const olds: Array<Promise<void>> = [];
      for (let g = Math.max(1, generation - OLD_GENERATIONS); g < generation; g++) olds.push(transport.stopSession(sessionName(chatId, g)));
      await abortable(Promise.allSettled(olds), ac.signal);
      handle = await transport.start(
        { chatId, generation, provider: chat.selection.provider, identity: chat.selection.identity },
        ac.signal,
        (n) => void this.emit(chatId, { k: "notice", text: n.text }, fence).catch(() => undefined),
      );
      const stream = handle.stream;
      stream.onClose((r) => {
        closedReason = r;
      });
      const ctx: Ctx = { chatId, fence, generation, chain: Promise.resolve(), busy: false, exited: false, cancelRequested: false, replaying: false, perms: new Map(), permSeq: 0, tools: new Map(), lastActive: this.d.now() };
      const acp = new AcpClient(
        stream,
        { onUpdate: (_s, u) => this.onUpdate(ctx, u), onPermission: (_s, p) => this.onPermission(ctx, p) },
        this.d.acpTimeoutMs === undefined ? {} : { requestTimeoutMs: this.d.acpTimeoutMs },
      );
      const caps = await acp.initialize();
      metrics.chatPodStart((this.d.now() - startedAt) / 1000);
      if (!caps.http) throw new NoHttpError();
      // The token goes to the agent over the ACP stream only. It is never stored or logged.
      const token = mintChatToken(this.d.tokenKey, { chatId, binding: chat.binding, exp: chat.createdAt + 7 * DAY_MS, gen: generation });
      const mcpServers = [
        {
          type: "http" as const,
          name: MCP_NAME,
          url: this.d.mcpUrl,
          headers: [
            { name: "Authorization", value: `Bearer ${token}` },
            { name: "X-AIS-Session-Id", value: sessionIdForChat(chatId) },
            { name: "X-AIS-Session-Label", value: encodeURIComponent(chat.name) },
          ],
        },
      ];
      let sessionId: string | undefined;
      // A chat that had a session before is dormant. Load the session when the agent can, else say so and start a new one.
      if (chat.acpSessionId !== undefined) {
        let loaded = false;
        if (chat.canLoad === true) {
          ctx.replaying = true;
          try {
            await acp.loadSession({ sessionId: chat.acpSessionId, cwd: handle.cwd, mcpServers });
            loaded = true;
          } catch (e) {
            // A closed stream or an abort is a start failure, not a failed load.
            if (closedReason !== undefined || ac.signal.aborted) throw e;
            metrics.chatError("resume_failed");
          } finally {
            ctx.replaying = false;
          }
        }
        if (loaded) {
          sessionId = chat.acpSessionId;
          metrics.chatSession("session_resumed");
        } else {
          this.queue(ctx, () => this.emit(chatId, { k: "notice", text: RESTART_NOTICE }, fence));
        }
      }
      if (sessionId === undefined) sessionId = (await acp.newSession({ cwd: handle.cwd, mcpServers })).sessionId;
      // Apply the model and effort that the user chose.
      const want = { ...(chat.selection.model !== undefined ? { model: chat.selection.model } : {}), ...(chat.selection.effort !== undefined ? { effort: chat.selection.effort } : {}) };
      if (Object.keys(want).length > 0) {
        try {
          await acp.setConfig(sessionId, want);
        } catch (e) {
          if (closedReason !== undefined || ac.signal.aborted) throw e;
          metrics.chatError("acp");
          this.queue(ctx, () => this.emit(chatId, { k: "error", code: "acp", message: "The agent did not accept the chosen model or effort." }, fence));
        }
      }
      await ctx.chain;
      this.timers.clearTimeout(startTimer);
      await store.update(chatId, { state: "idle", acpSessionId: sessionId, podSession: handle.session, canLoad: caps.loadSession }, fence);
      const rt: ChatRuntime = { chatId, fence, acp, handle, sessionId, generation, lease, ctx };
      lease.onLost = () => {
        const gone = this.drop(chatId);
        if (!gone) return;
        const promise: Promise<ChatRuntime | undefined> = this.endLost(chatId, gone.handle.session, gone.generation)
          .catch(() => undefined)
          .then(() => undefined)
          .finally(() => {
            if (this.starting.get(chatId)?.promise === promise) this.starting.delete(chatId);
          });
        this.starting.set(chatId, { promise, ac: new AbortController(), ending: true });
      };
      this.runtimes.set(chatId, rt);
      kept = true;
      void acp.closed.then((reason) => this.onAgentClosed(rt, reason));
      return rt;
    } catch (e) {
      // Classify first. Closing the stream changes the close reason.
      const f = this.classify(e, { timedOut, handle, closedReason, named: name !== "" });
      handle?.stream.close();
      const own = handle?.session ?? name;
      if (e instanceof ChatClosedError) {
        if (own) await transport.stopSession(own).catch(() => undefined);
        return undefined;
      }
      if (leaseLost || e instanceof ChatLeaseLostError) {
        await this.endLost(chatId, own, generation);
        return undefined;
      }
      if (ac.signal.aborted && !timedOut) {
        // The broker is shutting down. This is not a failure, and the chat can start again later.
        // A newer generation makes the token of this start useless, even when the stop below fails.
        if (generationSet) await store.update(chatId, { generation: generation + 1 }, fence).catch(() => undefined);
        if (own) await transport.stopSession(own).catch(() => undefined);
        return undefined;
      }
      await this.fail(chatId, fence, f, own);
      return undefined;
    } finally {
      this.timers.clearTimeout(startTimer);
      if (!kept) {
        this.stopLease(lease);
        await store.releaseLease(chatId, fence).catch(() => undefined);
      }
    }
  }

  /**
   * The lease is gone. Try to take it again. With the lease back, show the failure.
   * When another replica owns the chat, end quietly and stop only our own session.
   */
  private async endLost(chatId: string, session: string, generation: number): Promise<void> {
    const { store, transport } = this.d;
    const epoch = await store.acquireLease(chatId, this.d.replicaId, this.leaseTtl, this.d.now()).catch(() => undefined);
    if (epoch === undefined) {
      if (session) await transport.stopSession(session).catch(() => undefined);
      return;
    }
    const fence: LeaseFence = { replica: this.d.replicaId, epoch };
    try {
      // A newer start or a close may have run while the lease was gone. Then this clean-up shows nothing and stops only its own session.
      const chat = await store.get(chatId);
      const newer = !chat || chat.state === "closed" || (generation > 0 && (chat.generation > generation || chat.state === "failed"));
      if (newer) {
        if (session) await transport.stopSession(session).catch(() => undefined);
        return;
      }
      await this.fail(chatId, fence, LOST_FAILURE, session);
    } finally {
      await store.releaseLease(chatId, fence).catch(() => undefined);
    }
  }

  /** Fixed copy by cause. The text of the error itself never reaches the feed. */
  private classify(e: unknown, s: { timedOut: boolean; handle: PodHandle | undefined; closedReason: string | undefined; named: boolean }): Failure {
    if (s.timedOut) return { code: "timeout", message: "The agent did not start in time.", kind: "timeout" };
    if (e instanceof ExpiredError) return { code: "expired", message: "This chat is too old. Open a new chat.", kind: "limit" };
    if (e instanceof PodStartError) return { code: "pod_start", message: e.message, kind: "pod_start" };
    if (e instanceof NoHttpError) return { code: "acp", message: "This agent cannot use HTTP tools", kind: "acp" };
    if (s.handle) {
      if (e instanceof AcpError && e.code === -32001) return { code: "timeout", message: "The agent did not answer in time.", kind: "timeout" };
      if (s.closedReason !== undefined) return exitFailure(s.closedReason);
      return { code: "acp", message: "The agent could not open a session.", kind: "acp" };
    }
    if (!s.named) return { code: "unavailable", message: "The chat service is not available.", kind: "other" };
    if (e instanceof KubeHttpError) return { code: "pod_start", message: "The agent could not start.", kind: "pod_start" };
    return { code: "attach", message: "The agent could not be reached.", kind: "attach" };
  }

  /**
   * Show a failure in the feed and stop the pod. It never throws.
   * With a live lease it stops every session of the chat. With a lost lease it stops only `session`, so a new owner keeps its pod.
   */
  private async fail(chatId: string, fence: LeaseFence, f: Failure, session: string): Promise<void> {
    const { store, transport, metrics } = this.d;
    let lost = false;
    let wrote = false;
    try {
      metrics.chatError(f.kind);
      wrote = await this.emit(chatId, { k: "error", code: f.code, message: f.message }, fence);
      if (wrote) await store.update(chatId, { state: "failed" }, fence);
      else lost = true;
    } catch (e) {
      if (e instanceof ChatLeaseLostError || e instanceof ChatClosedError) lost = true;
    } finally {
      // Stop every session of the chat only after a fenced write proved that we own it.
      if (wrote && !lost) await transport.stop(chatId).catch(() => undefined);
      else if (session) await transport.stopSession(session).catch(() => undefined);
    }
  }

  /**
   * The agent ended while the chat was running. The chat stays open and goes idle: the next prompt starts a new pod and loads the session.
   * It writes only with the lease of the runtime, and stops the whole chat only after a fenced write worked.
   */
  private onAgentClosed(rt: ChatRuntime, reason: string): void {
    if (this.runtimes.get(rt.chatId) !== rt) return;
    this.runtimes.delete(rt.chatId);
    this.stopLease(rt.lease);
    const { ctx } = rt;
    const { store, transport, metrics } = this.d;
    ctx.exited = true;
    metrics.chatError("agent_exit");
    if (ctx.busy) metrics.chatTurn("error");
    this.cancelPerms(ctx);
    const message = `The agent stopped (reason: ${EXIT_REASONS[reason] ?? "closed"}).`;
    void (async () => {
      let wrote = false;
      try {
        await ctx.chain;
        wrote = await this.emit(rt.chatId, { k: "error", code: "agent_exit", message }, rt.fence);
        if (wrote) await store.update(rt.chatId, { state: "idle" }, rt.fence);
      } catch {
        wrote = false;
      } finally {
        if (wrote) await transport.stop(rt.chatId).catch(() => undefined);
        else await transport.stopSession(rt.handle.session).catch(() => undefined);
        await store.releaseLease(rt.chatId, rt.fence).catch(() => undefined);
      }
    })();
  }

  /** Run one write after the earlier ones of the chat. A failing write never breaks the chain. */
  private queue(ctx: Ctx, fn: () => Promise<unknown>): void {
    ctx.chain = ctx.chain.then(fn).then(
      () => undefined,
      () => undefined,
    );
  }

  private push(ctx: Ctx, body: ChatBody): void {
    ctx.lastActive = this.d.now();
    this.queue(ctx, () => this.emit(ctx.chatId, body, ctx.fence));
  }

  private setState(ctx: Ctx, state: ChatState): void {
    this.queue(ctx, async () => {
      const rec = await this.d.store.update(ctx.chatId, { state }, ctx.fence);
      if (rec) this.d.publish(ctx.chatId, rec.lastSeq);
    });
  }

  private onUpdate(ctx: Ctx, u: AcpUpdate): void {
    if (u.kind === "other") return;
    if (u.kind === "config") {
      const body: Extract<ChatBody, { k: "config" }> = { k: "config", models: u.models, efforts: u.efforts, current: { ...u.current } };
      ctx.config = body;
      this.push(ctx, body);
      return;
    }
    if (ctx.replaying) return;
    if (u.kind !== "tool") {
      for (const t of pieces(u.text)) this.push(ctx, { k: u.kind, text: t });
      return;
    }
    const merged = mergeTool(ctx.tools.get(u.toolCallId), u);
    if (!ctx.tools.has(merged.toolCallId) && ctx.tools.size >= MAX_TOOLS_KEPT) ctx.tools.delete(ctx.tools.keys().next().value as string);
    ctx.tools.set(merged.toolCallId, merged);
    this.push(ctx, merged);
  }

  private onPermission(ctx: Ctx, p: AcpPermission): Promise<{ optionId?: string }> {
    return new Promise((resolve) => {
      const requestId = `${ctx.generation}-${++ctx.permSeq}`;
      ctx.perms.set(requestId, { options: p.options, resolve });
      this.push(ctx, { k: "permission", requestId, rpcId: p.rpcId, title: cut(p.title), options: p.options.slice(0, 64) });
      this.setState(ctx, "waiting");
    });
  }

  /** Close one permission ask. A missing or unknown option means cancelled. */
  private resolvePerm(ctx: Ctx, requestId: string, optionId: string | undefined): void {
    const ask = ctx.perms.get(requestId);
    if (!ask) return;
    ctx.perms.delete(requestId);
    const chosen = optionId !== undefined && ask.options.some((o) => o.id === optionId) ? optionId : undefined;
    ask.resolve(chosen === undefined ? {} : { optionId: chosen });
    this.push(ctx, chosen === undefined ? { k: "permission_resolved", requestId, cancelled: true } : { k: "permission_resolved", requestId, optionId: chosen });
    if (ctx.perms.size === 0 && ctx.busy) this.setState(ctx, "thinking");
  }

  private cancelPerms(ctx: Ctx): void {
    for (const id of [...ctx.perms.keys()]) this.resolvePerm(ctx, id, undefined);
  }

  /**
   * Accept a prompt. It returns when the prompt is stored, not when the turn ends: the turn streams into the feed.
   * A dormant chat gets a new pod first. Failures show in the feed.
   */
  async prompt(chatId: string, binding: string, text: string): Promise<BrokerReject | undefined> {
    const busy: BrokerReject = { code: "busy", message: "The agent is still working on the last message." };
    if (this.turning.has(chatId) || this.starting.has(chatId)) return busy;
    // Claim the chat before the first await, so two prompts cannot both pass.
    this.turning.add(chatId);
    let handed = false;
    try {
      const chat = await this.d.store.get(chatId);
      if (!chat || chat.binding !== binding) return { code: "bad_request", message: "This chat does not exist." };
      if (chat.state === "closed") return { code: "bad_request", message: "This chat is closed." };
      // Another replica may run a turn. A dead replica leaves a stale state, so only a live lease counts.
      const leased = chat.ownerReplica !== undefined && chat.leaseUntil !== undefined && chat.leaseUntil > this.d.now();
      if ((chat.state === "thinking" || chat.state === "waiting") && leased) return busy;
      const seq = await this.d.store.appendEvent(chatId, { k: "user", text });
      this.d.publish(chatId, seq);
      handed = true;
      void this.runPrompt(chatId, text).finally(() => this.turning.delete(chatId));
      return undefined;
    } finally {
      if (!handed) this.turning.delete(chatId);
    }
  }

  private async runPrompt(chatId: string, text: string): Promise<void> {
    try {
      const rt = await this.startPod(chatId);
      if (rt) await this.runTurn(rt, text);
    } catch {
      this.d.metrics.chatError("other");
    }
  }

  private async runTurn(rt: ChatRuntime, text: string): Promise<void> {
    const { ctx } = rt;
    const { metrics } = this.d;
    ctx.busy = true;
    ctx.cancelRequested = false;
    ctx.tools.clear();
    ctx.lastActive = this.d.now();
    this.setState(ctx, "thinking");
    try {
      const r = await rt.acp.prompt(rt.sessionId, text);
      this.push(ctx, { k: "turn_end", stopReason: r.stopReason });
      metrics.chatTurn(r.stopReason === "cancelled" || ctx.cancelRequested ? "cancelled" : "ok");
    } catch (e) {
      if (e instanceof AcpError) {
        const f = promptFailure(e.message, e.code, this.d.now());
        metrics.chatError(f.kind);
        metrics.chatTurn("error");
        this.push(ctx, { k: "error", code: f.code, message: f.message });
      } else {
        // The connection ended. A close that the broker asked for is no failure.
        this.onAgentClosed(rt, String((e as Error).message).replace(/^ACP connection closed: /, ""));
        // A close that the broker asked for (close, idle end, shutdown) cancels the turn. An agent exit was counted by onAgentClosed.
        if (!ctx.exited) metrics.chatTurn("cancelled");
      }
    } finally {
      ctx.busy = false;
      ctx.cancelRequested = false;
      if (this.runtimes.get(rt.chatId) === rt) {
        this.cancelPerms(ctx);
        this.setState(ctx, "idle");
      }
      ctx.lastActive = this.d.now();
      await ctx.chain;
    }
  }

  /** Stop the current turn with ACP session/cancel. The pod stays. */
  async cancel(chatId: string): Promise<void> {
    const rt = this.runtimes.get(chatId);
    if (!rt || !rt.ctx.busy) return;
    rt.ctx.cancelRequested = true;
    this.cancelPerms(rt.ctx);
    rt.acp.cancel(rt.sessionId);
  }

  async answerPermission(chatId: string, requestId: string, optionId: string | undefined): Promise<void> {
    const rt = this.runtimes.get(chatId);
    if (rt) this.resolvePerm(rt.ctx, requestId, optionId);
  }

  /** Forget a runtime and close its stream. It sends no event. */
  private drop(chatId: string): ChatRuntime | undefined {
    const rt = this.runtimes.get(chatId);
    if (!rt) return undefined;
    this.runtimes.delete(chatId);
    this.stopLease(rt.lease);
    rt.handle.stream.close();
    return rt;
  }

  /** The lease of a chat for one write. A running chat uses its own fence. Another replica that owns the chat makes this throw ChatLeaseLostError. */
  private async withFence<T>(chatId: string, fn: (fence: LeaseFence) => Promise<T>): Promise<T> {
    const pending = this.starting.get(chatId);
    if (pending) await pending.promise.catch(() => undefined);
    const rt = this.runtimes.get(chatId);
    if (rt) return fn(rt.fence);
    const epoch = await this.d.store.acquireLease(chatId, this.d.replicaId, this.leaseTtl, this.d.now());
    if (epoch === undefined) throw new ChatLeaseLostError(chatId);
    const fence: LeaseFence = { replica: this.d.replicaId, epoch };
    try {
      return await fn(fence);
    } finally {
      await this.d.store.releaseLease(chatId, fence).catch(() => undefined);
    }
  }

  /** Set the model or effort. A running agent gets it now. A dormant chat gets it at the next start. */
  async configure(chatId: string, patch: { model?: string; effort?: string }): Promise<void> {
    const clean = { ...(patch.model !== undefined ? { model: patch.model } : {}), ...(patch.effort !== undefined ? { effort: patch.effort } : {}) };
    if (Object.keys(clean).length === 0) return;
    const rt = this.runtimes.get(chatId);
    if (rt) {
      try {
        await rt.acp.setConfig(rt.sessionId, clean);
      } catch {
        this.d.metrics.chatError("acp");
        this.push(rt.ctx, { k: "error", code: "acp", message: "The agent did not accept this setting." });
        return;
      }
    }
    await this.withFence(chatId, async (fence) => {
      const chat = await this.d.store.get(chatId);
      if (!chat || chat.state === "closed") return;
      await this.d.store.update(chatId, { selection: { ...chat.selection, ...clean } }, fence);
      if (rt) {
        const base = rt.ctx.config ?? { k: "config" as const, models: [], efforts: [], current: {} };
        const body = { ...base, current: { ...base.current, ...clean } };
        rt.ctx.config = body;
        this.push(rt.ctx, body);
        await rt.ctx.chain;
      }
    });
  }

  /** Store the tabs the chat may use. The next tool call reads them from the store. */
  async link(chatId: string, tabIds: number[]): Promise<void> {
    await this.withFence(chatId, async (fence) => {
      await this.d.store.update(chatId, { tabIds: [...tabIds] }, fence);
    });
  }

  async rename(chatId: string, name: string): Promise<void> {
    await this.withFence(chatId, async (fence) => {
      await this.d.store.update(chatId, { name }, fence);
    });
  }

  /** End a chat for good: delete the pod, tell the browser, refuse more prompts. */
  async close(chatId: string, reason: "user" | "idle" | "expired"): Promise<void> {
    const pending = this.starting.get(chatId);
    if (pending) {
      pending.ac.abort();
      await pending.promise.catch(() => undefined);
    }
    const rt = this.runtimes.get(chatId);
    await this.withFence(chatId, async (fence) => {
      const chat = await this.d.store.get(chatId);
      if (!chat || chat.state === "closed") return;
      if (rt) {
        this.cancelPerms(rt.ctx);
        await rt.ctx.chain;
        this.drop(chatId);
      }
      try {
        if (reason !== "user") await this.emit(chatId, { k: "notice", text: reason === "idle" ? "This chat closed after a long time without use." : "This chat is too old and was closed." }, fence);
        await this.d.store.update(chatId, { state: "closed" }, fence);
      } catch (e) {
        // No proof of ownership: stop only our own pod.
        if (rt) await this.d.transport.stopSession(rt.handle.session).catch(() => undefined);
        throw e;
      }
      await this.d.transport.stop(chatId).catch(() => undefined);
      await this.d.endBrowserSession?.(chat.binding, sessionIdForChat(chatId)).catch(() => undefined);
      this.d.metrics.chatSession("session_closed");
    }).finally(async () => {
      if (rt) await this.d.store.releaseLease(chatId, rt.fence).catch(() => undefined);
    });
  }

  /**
   * End the pod of every chat that was idle for idleMs. The chat stays open and goes dormant: the next prompt starts a pod and loads the session.
   * A chat with a turn, a start or a pending ask is never swept.
   */
  async sweepIdle(): Promise<void> {
    const limit = Math.min(this.d.idleMs ?? DEFAULT_IDLE_MS, MAX_IDLE_MS);
    for (const rt of [...this.runtimes.values()]) {
      const { ctx } = rt;
      if (ctx.busy || ctx.perms.size > 0 || this.turning.has(rt.chatId) || this.starting.has(rt.chatId)) continue;
      if (this.d.now() - ctx.lastActive < limit) continue;
      await this.idleEnd(rt);
    }
  }

  private async idleEnd(rt: ChatRuntime): Promise<void> {
    if (this.runtimes.get(rt.chatId) !== rt) return;
    const { store, transport, metrics } = this.d;
    await rt.ctx.chain;
    this.drop(rt.chatId);
    let wrote = false;
    try {
      wrote = await this.emit(rt.chatId, { k: "notice", text: "The agent stopped after a long time without use. Send a message to continue." }, rt.fence);
      if (wrote) await store.update(rt.chatId, { state: "idle" }, rt.fence);
    } catch {
      wrote = false;
    } finally {
      if (wrote) await transport.stop(rt.chatId).catch(() => undefined);
      else await transport.stopSession(rt.handle.session).catch(() => undefined);
      await store.releaseLease(rt.chatId, rt.fence).catch(() => undefined);
    }
    metrics.chatSession("idle_closed");
  }

  /** Stop all work of this broker: running starts, streams and lease timers. */
  async dispose(): Promise<void> {
    const waits = [...this.starting.values()].map((s) => {
      s.ac.abort();
      return s.promise.catch(() => undefined);
    });
    await Promise.all(waits);
    for (const id of [...this.runtimes.keys()]) {
      const live = this.runtimes.get(id);
      if (live) {
        // A pending ask ends as cancelled before the stream closes.
        this.cancelPerms(live.ctx);
        await live.ctx.chain;
      }
      const rt = this.drop(id);
      if (rt) await this.d.store.releaseLease(id, rt.fence).catch(() => undefined);
    }
  }
}
