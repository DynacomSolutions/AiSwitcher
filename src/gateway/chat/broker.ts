// Chat broker: create a chat, start its pod, attach, run turns, answer permissions, cancel, close, end idle pods, resume.
// Every failure shows in the feed as an error item with fixed copy, and in a metric.
import { CHAT_ERROR_CODES, MAX_CHATS_PER_WINDOW, parseChatFromExt, sessionIdForChat, type ChatBody, type ChatSelection, type ChatState } from "../../browser/chat-protocol.ts";
import type { ChatAuth, ChatPrincipal } from "../browser/chat-auth.ts";
import type { GatewayMetrics } from "../metrics.ts";
import { AcpClient, AcpError, type AcpPermission, type AcpUpdate } from "./acp.ts";
import { clean, cut, mergeTool, pieces, promptFailure, shortField, type ToolBody } from "./turn.ts";
import { KubeHttpError } from "./kube-http.ts";
import { sessionName, type PodHandle, type PodTransport } from "./kube.ts";
import { PodStartError, type Timers } from "./pod-transport.ts";
import { ChatClosedError, ChatExistsError, ChatLeaseLostError, type ChatRecord, type ChatStore, type LeaseFence } from "./types.ts";
import { busSize, MAX_BUS_PAYLOAD, type ChatBus, type ChatBusMsg } from "./bus.ts";
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
const DEFAULT_CANCEL_GRACE_MS = 15_000;
const DEFAULT_STALL_MS = 30 * 60_000;
const HUNG_MESSAGE = "The agent did not stop. It was restarted. Send a message to continue.";
const STATE_TRIES = 3;
const STATE_BACKOFF_MS = 50;
const RESTART_NOTICE = "This chat restarted. The agent does not remember earlier messages.";
const RESUMED_NOTICE = "The agent resumed this chat.";
const BUSY_NOTICE = "The agent was still working, so it did not take your last message. Send it again.";
const UNREACHABLE_MESSAGE = "Your message could not reach the agent. Send it again.";
const DRAINING_MESSAGE = "The gateway is restarting. Try again in a moment.";
const DEFAULT_FORWARD_ACK_MS = 10_000;
const BAD_COMMAND_MESSAGE = "The command is not valid.";
const NOT_SENT_MESSAGE = "Your message could not be passed on. Try again.";
/** Per-chat maps keep at most this many chats. The oldest entries go first. */
const MAP_MAX = 1000;
/** A stored prompt without an answer stays reusable for this long. */
const UNANSWERED_MS = 10 * 60_000;
const NO_ACK_MESSAGE = "The chat did not answer. Try again in a moment.";
const DEFAULT_SWEEP_MS = 60_000;
const DEFAULT_START_TIMEOUT_MS = 5 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The agent may use the browser tools only through this MCP server name. */
const MCP_NAME = "ais-browser";

/** The idle limit from AIS_GATEWAY_CHAT_IDLE_MINUTES: default 2 hours, at most 3 hours, a bad value means the default. */
export function chatIdleMsFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.AIS_GATEWAY_CHAT_IDLE_MINUTES;
  const minutes = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_IDLE_MS;
  return Math.min(Math.round(minutes * 60_000), MAX_IDLE_MS);
}

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
  /** Time after a cancel in which the agent must end the turn. Then the agent restarts. Default 15 seconds. */
  cancelGraceMs?: number;
  /** A turn without an ask, an update or a write to the agent for this long counts as hung. Default 30 minutes. Checked by sweepIdle. */
  stallMs?: number;
  /** Tell the browser of a binding that a chat session ended (SESSION_END). Best effort. */
  endBrowserSession?(binding: string, sessionId: string): Promise<void>;
  /** Time limit of one pod start, from the call to the new ACP session. Default 5 minutes. */
  startTimeoutMs?: number;
  /** A chat older than this gets no principal. Default 7 days. */
  maxAgeMs?: number;
  publish(chatId: string, seq: number): void;
  /** Talks to the other replicas. Without it this replica works alone. */
  bus?: ChatBus;
  /** After a prompt went to another replica, wait this long for the chat to move on. Then check again. Default 10 seconds. */
  forwardAckMs?: number;
  /** Tell the extension of a chat that a command failed. Not stored. */
  rejectChat?(chatId: string, code: BrokerReject["code"], message: string): void;
  /** Chats that have browser sockets on this replica. After a LISTEN reconnect the broker pushes their state again. */
  watchedChats?(): string[];
  /** Time between idle sweeps. Default 60 seconds. */
  sweepMs?: number;
  identityOf(binding: string): Promise<string | undefined>;
  /** Time limit of one ACP request in the start path. */
  acpTimeoutMs?: number;
  timers?: Timers;
}

/** Copy of the gateway-wide cap refusal. */
export const GATEWAY_CAP_MESSAGE = "Too many chats are open. Close one, then try again.";

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
  /** Copy for the agent_exit item when the broker restarts a hung agent. */
  exitMessage?: string;
  cancelTimer?: unknown;
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

const clearTimeoutSafe = (t: Timers, h: unknown): void => {
  if (h !== undefined) t.clearTimeout(h);
};

export class ChatBroker implements ChatAuth {
  private readonly runtimes = new Map<string, ChatRuntime>();
  private readonly starting = new Map<string, { promise: Promise<ChatRuntime | undefined>; ac: AbortController; ending?: boolean }>();
  /** Chats with a prompt that was accepted and has not ended. A second prompt gets "busy". */
  private readonly turning = new Set<string>();
  /** Chats that a user asked to cancel while the pod was still starting. */
  private readonly cancelledEarly = new Set<string>();
  /** One write path per chat on this replica: starts, close, link, configure and rename run one after the other. */
  private readonly locks = new Map<string, Promise<void>>();
  private readonly timers: Timers;
  /** The turn of each chat with an accepted prompt, until it ends. Drain waits for them. */
  private readonly turnDone = new Map<string, Promise<void>>();
  /** Chats whose start found a live lease of another replica. The prompt then goes to that replica. */
  private readonly denied = new Set<string>();
  /** Highest event number this replica told its own listeners about, per chat. */
  private readonly notified = new Map<string, number>();
  private readonly watches = new Set<unknown>();
  /** Refs of commands that the owner acknowledged. */
  private readonly acked = new Map<string, number>();
  /** A prompt that got no answer from a live owner. A retry with the same text reuses its stored event. */
  private readonly unanswered = new Map<string, { seq: number; text: string; at: number }>();
  /** The highest prompt number that this replica took as owner, per chat. A command with a lower or equal number is a repeat. */
  private readonly lastAccepted = new Map<string, number>();
  /** A forwarded prompt that holds the chat while it checks the store. A second command waits for it. */
  private readonly claims = new Map<string, Promise<void>>();
  private resyncing = false;
  private resyncAgain = false;
  /** Chats where a start was refused because the replica drains. The prompt then gets a feed notice. */
  private readonly drainRefused = new Set<string>();
  private offReconnect: (() => void) | undefined;
  private draining = false;
  private unsubscribe: (() => Promise<void>) | undefined;
  private sweepTimer: unknown;
  private stopped = false;

  constructor(private readonly d: BrokerDeps) {
    this.timers = d.timers ?? realTimers;
  }

  /** Listen to the bus and sweep idle chats on a timer. Call once. */
  async start(): Promise<void> {
    if (this.d.bus && !this.unsubscribe) {
      this.unsubscribe = await this.d.bus.subscribe((m) => this.onBus(m));
      this.offReconnect = this.d.bus.onReconnect?.(() => void this.resync().catch(() => this.d.metrics.chatError("other")));
    }
    this.armSweep();
  }

  private armSweep(): void {
    if (this.stopped) return;
    this.sweepTimer = this.timers.setTimeout(() => {
      void this.sweepIdle()
        .catch(() => this.d.metrics.chatError("other"))
        .finally(() => this.armSweep());
    }, this.d.sweepMs ?? DEFAULT_SWEEP_MS);
  }

  /** Forget the per-chat entries of a chat that ended or whose lease went. */
  private forget(chatId: string): void {
    this.notified.delete(chatId);
    this.unanswered.delete(chatId);
    this.lastAccepted.delete(chatId);
  }

  /** Keep a map under MAP_MAX entries, oldest first. */
  private bound<K, V>(m: Map<K, V>): void {
    while (m.size > MAP_MAX) {
      const k = m.keys().next();
      if (k.done) return;
      m.delete(k.value);
    }
  }

  private setBounded<V>(m: Map<string, V>, key: string, v: V): void {
    m.delete(key);
    m.set(key, v);
    this.bound(m);
  }

  /**
   * After the LISTEN connection came back, notices may be lost. For every chat that this replica delivered to, or has sockets for,
   * read the store again and push the last event number, so a consumer reads from its own cursor and fills the gap. The state follows.
   */
  private async resync(): Promise<void> {
    // Overlapping reconnects merge into one more run.
    if (this.resyncing) {
      this.resyncAgain = true;
      return;
    }
    this.resyncing = true;
    try {
      do {
        this.resyncAgain = false;
        const ids = new Set<string>([...this.notified.keys(), ...(this.d.watchedChats?.() ?? [])]);
        for (const id of ids) {
          // One failed read must not stop the other chats.
          try {
            const rec = await this.d.store.get(id);
            if (!rec) continue;
            this.setBounded(this.notified, id, Math.max(this.notified.get(id) ?? 0, rec.lastSeq));
            this.d.publish(id, rec.lastSeq);
          } catch {
            this.d.metrics.chatError("store");
          }
        }
      } while (this.resyncAgain && !this.stopped);
    } finally {
      this.resyncing = false;
    }
  }

  /** Tell the listeners of this replica, and the other replicas, that a chat has a new event. */
  private notify(chatId: string, seq: number): void {
    if (seq > (this.notified.get(chatId) ?? 0)) this.setBounded(this.notified, chatId, seq);
    this.d.publish(chatId, seq);
    this.send({ t: "event", chatId, seq });
  }

  private send(m: ChatBusMsg): Promise<void> {
    return (this.d.bus?.publish(m) ?? Promise.resolve()).catch(() => this.d.metrics.chatError("other"));
  }

  private get leaseTtl(): number {
    return this.d.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  private locked<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(chatId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(chatId, tail);
    void tail.then(() => {
      if (this.locks.get(chatId) === tail) this.locks.delete(chatId);
    });
    return run;
  }

  /** Run a clean-up as an ending entry: a new start on this replica waits for it, so the clean-up cannot hit the new pod. */
  private registerEnding(chatId: string, run: () => Promise<void>): void {
    const promise: Promise<ChatRuntime | undefined> = run()
      .catch(() => undefined)
      .then(() => undefined)
      .finally(() => {
        if (this.starting.get(chatId)?.promise === promise) this.starting.delete(chatId);
      });
    this.starting.set(chatId, { promise, ac: new AbortController(), ending: true });
  }

  /** Write the state of a chat and tell the listeners, so the summary follows. */
  private async writeState(chatId: string, patch: Parameters<ChatStore["update"]>[1], fence: LeaseFence): Promise<void> {
    const rec = await this.d.store.update(chatId, patch, fence);
    if (rec) {
      this.d.publish(chatId, rec.lastSeq);
      void this.send({ t: "state", chatId });
    }
  }

  /** Events always go through the store, then out to the listeners. Returns false when the lease is lost. */
  private async emit(chatId: string, body: ChatBody, fence: LeaseFence): Promise<boolean> {
    try {
      const seq = await this.d.store.appendEvent(chatId, body, fence);
      this.notify(chatId, seq);
      return true;
    } catch (e) {
      if (e instanceof ChatLeaseLostError) return false;
      throw e;
    }
  }

  async create(i: { chatId: string; binding: string; windowId: number; name: string; color: string; selection: ChatSelection; tabIds: number[]; maxLive?: number }): Promise<ChatRecord | BrokerReject> {
    // The pod name and the admission rule use the first eight hex digits. A hostile id could collide on them.
    if (!UUID_RE.test(i.chatId)) return { code: "bad_request", message: "The chat id is not valid." };
    let rec: ChatRecord | "cap" | "global";
    try {
      rec = await this.d.store.create(
        { id: i.chatId, binding: i.binding, windowId: i.windowId, name: i.name, color: i.color, selection: i.selection, tabIds: i.tabIds, createdAt: this.d.now() },
        MAX_CHATS_PER_WINDOW,
        { replica: this.d.replicaId, ttlMs: this.leaseTtl },
        i.maxLive,
      );
    } catch (e) {
      if (e instanceof ChatExistsError) return { code: "bad_request", message: "A chat with this id exists." };
      throw e;
    }
    if (rec === "global") return { code: "limit", message: GATEWAY_CAP_MESSAGE };
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
    const promise = this.locked(chatId, () => this.runStart(chatId, ac))
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
    // A replica in drain starts nothing. The next owner starts the pod.
    if (this.draining) {
      this.drainRefused.add(chatId);
      return undefined;
    }
    const startedAt = this.d.now();
    const pre = await store.get(chatId);
    if (!pre || pre.state === "closed") return undefined;
    const epoch = await store.acquireLease(chatId, this.d.replicaId, this.leaseTtl, this.d.now());
    if (epoch === undefined) {
      this.denied.add(chatId);
      return undefined;
    }
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
      await this.writeState(chatId, { state: "starting", generation }, fence);
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
      // Our writes count as activity: the kubelet idle limit counts client data only.
      const io = {
        write: (line: string) => {
          ctx.lastActive = this.d.now();
          stream.write(line);
        },
        onLine: (cb: (line: string) => void) => stream.onLine(cb),
        onClose: (cb: (reason: string) => void) => stream.onClose(cb),
      };
      const acp = new AcpClient(
        io,
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
        if (caps.loadSession) {
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
          this.queue(ctx, () => this.emit(chatId, { k: "notice", text: RESUMED_NOTICE }, fence));
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
      await this.writeState(chatId, { state: "idle", acpSessionId: sessionId, podSession: handle.session, canLoad: caps.loadSession }, fence);
      const rt: ChatRuntime = { chatId, fence, acp, handle, sessionId, generation, lease, ctx };
      lease.onLost = () => {
        this.forget(chatId);
        const gone = this.drop(chatId);
        if (!gone) return;
        // Answer open asks now. The items follow once the lease is back, because this fence is gone.
        const asks = [...gone.ctx.perms.keys()];
        for (const id of asks) gone.ctx.perms.get(id)?.resolve({});
        gone.ctx.perms.clear();
        this.registerEnding(chatId, () => this.endLost(chatId, gone.handle.session, gone.generation, asks));
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
  private async endLost(chatId: string, session: string, generation: number, asks: string[] = []): Promise<void> {
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
      // The asks that were open stay open in the feed until they are marked cancelled.
      for (const requestId of asks) await this.emit(chatId, { k: "permission_resolved", requestId, cancelled: true }, fence).catch(() => false);
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
      if (wrote) await this.writeState(chatId, { state: "failed" }, fence);
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
   * The clean-up is an ending entry. A new start waits for it, and it stops only its own session.
   */
  private onAgentClosed(rt: ChatRuntime, reason: string): void {
    if (this.runtimes.get(rt.chatId) !== rt) return;
    this.runtimes.delete(rt.chatId);
    this.stopLease(rt.lease);
    const { ctx } = rt;
    const { store, transport, metrics } = this.d;
    ctx.exited = true;
    this.timers.clearTimeout(ctx.cancelTimer);
    metrics.chatError("agent_exit");
    if (ctx.busy) metrics.chatTurn("error");
    this.cancelPerms(ctx);
    const message = ctx.exitMessage ?? `The agent stopped (reason: ${EXIT_REASONS[reason] ?? "closed"}).`;
    this.registerEnding(rt.chatId, async () => {
      try {
        await ctx.chain;
        if (await this.emit(rt.chatId, { k: "error", code: "agent_exit", message }, rt.fence)) await this.writeState(rt.chatId, { state: "idle" }, rt.fence);
      } finally {
        await transport.stopSession(rt.handle.session).catch(() => undefined);
        await store.releaseLease(rt.chatId, rt.fence).catch(() => undefined);
      }
    });
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

  /** Write the state. A failed write is tried again, then counted. A lost lease or a closed chat ends the tries. */
  private setState(ctx: Ctx, state: ChatState): void {
    this.queue(ctx, async () => {
      for (let i = 1; i <= STATE_TRIES; i++) {
        try {
          await this.writeState(ctx.chatId, { state }, ctx.fence);
          return;
        } catch (e) {
          if (e instanceof ChatLeaseLostError || e instanceof ChatClosedError) return;
          if (i === STATE_TRIES) {
            this.d.metrics.chatError("store");
            return;
          }
          await new Promise((r) => setTimeout(r, STATE_BACKOFF_MS * i));
        }
      }
    });
  }

  private onUpdate(ctx: Ctx, u: AcpUpdate): void {
    if (u.kind === "other") return;
    if (u.kind === "config") {
      const f = shortField;
      const current: { model?: string; effort?: string } = {};
      if (u.current.model !== undefined) current.model = f(u.current.model);
      if (u.current.effort !== undefined) current.effort = f(u.current.effort);
      const body: Extract<ChatBody, { k: "config" }> = { k: "config", models: u.models.slice(0, 4096).map((m) => ({ id: f(m.id), name: f(m.name) })), efforts: u.efforts.slice(0, 64).map((e) => f(e)), current };
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
      const short = shortField;
      const options = p.options.slice(0, 64).map((o) => ({ id: short(o.id), name: short(o.name), kind: short(o.kind) }));
      this.push(ctx, { k: "permission", requestId, rpcId: typeof p.rpcId === "string" ? shortField(p.rpcId) : p.rpcId, title: cut(p.title), options });
      this.setState(ctx, "waiting");
      // A draining replica answers every ask as cancelled at once, so the turn can end.
      if (this.draining) queueMicrotask(() => this.resolvePerm(ctx, requestId, undefined));
    });
  }

  /** Close one permission ask. A missing or unknown option means cancelled. The panel sees option ids cut to the parser limit. */
  private resolvePerm(ctx: Ctx, requestId: string, optionId: string | undefined): void {
    const ask = ctx.perms.get(requestId);
    if (!ask) return;
    ctx.perms.delete(requestId);
    const short = shortField;
    const found = optionId === undefined ? undefined : ask.options.find((o) => o.id === optionId || short(o.id) === optionId);
    ask.resolve(found === undefined ? {} : { optionId: found.id });
    this.push(ctx, found === undefined ? { k: "permission_resolved", requestId, cancelled: true } : { k: "permission_resolved", requestId, optionId: short(found.id) });
    if (ctx.perms.size === 0 && !ctx.exited) this.setState(ctx, ctx.busy ? "thinking" : "idle");
  }

  private cancelPerms(ctx: Ctx): void {
    for (const id of [...ctx.perms.keys()]) this.resolvePerm(ctx, id, undefined);
  }

  /**
   * Accept a prompt. It returns when the prompt is stored, not when the turn ends: the turn streams into the feed.
   * A dormant chat gets a new pod first. Failures show in the feed.
   */
  async prompt(chatId: string, binding: string, text: string): Promise<BrokerReject | undefined> {
    if (this.draining) return { code: "unavailable", message: DRAINING_MESSAGE };
    const busy: BrokerReject = { code: "busy", message: "The agent is still working on the last message." };
    const st = this.starting.get(chatId);
    if (this.turning.has(chatId) || (st && !st.ending)) return busy;
    // Claim the chat before the first await, so two prompts cannot both pass.
    this.turning.add(chatId);
    this.cancelledEarly.delete(chatId);
    const release = this.claim(chatId);
    let handed = false;
    try {
      const chat = await this.d.store.get(chatId);
      if (!chat || chat.binding !== binding) return { code: "bad_request", message: "This chat does not exist." };
      if (chat.state === "closed") return { code: "bad_request", message: "This chat is closed." };
      if (this.draining) return { code: "unavailable", message: DRAINING_MESSAGE };
      const local = this.runtimes.get(chatId);
      if (local) {
        // This replica runs the agent, so its own flag is the truth. A stored state can be stale after a failed write.
        if (local.ctx.busy) return busy;
      } else {
        // Another replica may run a turn. A dead replica leaves a stale state, so only a live lease counts.
        const leased = chat.ownerReplica !== undefined && chat.leaseLive === true;
        if ((chat.state === "thinking" || chat.state === "waiting") && leased) return busy;
      }
      const seq = await this.d.store.appendEvent(chatId, { k: "user", text: clean(text) });
      this.notify(chatId, seq);
      handed = true;
      this.launch(chatId, clean(text), seq);
      return undefined;
    } finally {
      release();
      if (!handed) this.turning.delete(chatId);
    }
  }

  /** Mark the chat as held by a prompt that has not started its turn yet. A forwarded command waits for the release. */
  private claim(chatId: string): () => void {
    let release = (): void => undefined;
    const p = new Promise<void>((r) => (release = r));
    this.claims.set(chatId, p);
    return () => {
      if (this.claims.get(chatId) === p) this.claims.delete(chatId);
      release();
    };
  }

  /** Start the turn of an accepted prompt. The chat must be in `turning`. */
  private launch(chatId: string, text: string, seq: number): void {
    const done = this.runPrompt(chatId, text, seq).finally(() => {
      this.turning.delete(chatId);
      if (this.turnDone.get(chatId) === done) this.turnDone.delete(chatId);
    });
    this.turnDone.set(chatId, done);
  }

  private async runPrompt(chatId: string, text: string, seq: number): Promise<void> {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const rt = await this.startPod(chatId);
        if (!rt && this.drainRefused.delete(chatId)) {
          // The replica began to drain after it took the prompt. The prompt stays in the feed, so show why it did not run.
          await this.feedNotice(chatId, DRAINING_MESSAGE);
          return;
        }
        // A cancel that came while the pod started ends the turn before it begins.
        const early = this.cancelledEarly.delete(chatId);
        if (rt) {
          if (early) {
            this.push(rt.ctx, { k: "turn_end", stopReason: "cancelled" });
            this.d.metrics.chatTurn("cancelled");
            await rt.ctx.chain;
          } else await this.runTurn(rt, text);
          return;
        }
        // A start that failed shows its error in the feed. A start that met another owner sends the prompt there.
        if (!this.denied.delete(chatId)) return;
        const chat = await this.d.store.get(chatId);
        if (!chat || chat.state === "closed") return;
        const owner = this.liveOwner(chat);
        if (owner !== undefined) {
          if (await this.sendCmd({ t: "cmd", to: owner, chatId, cmd: "prompt", seq })) return;
          break;
        }
      }
      this.d.metrics.chatError("owner_unreachable");
      await this.feedNotice(chatId, UNREACHABLE_MESSAGE);
    } catch {
      this.d.metrics.chatError("other");
    } finally {
      this.cancelledEarly.delete(chatId);
    }
  }

  /** The replica that holds a live lease of the chat, when it is not this one. */
  private liveOwner(chat: ChatRecord): string | undefined {
    if (chat.ownerReplica === undefined || chat.ownerReplica === this.d.replicaId) return undefined;
    // The store judges the lease with its own clock. This replica's clock may differ.
    return chat.leaseLive === true ? chat.ownerReplica : undefined;
  }

  /**
   * Put an item in the feed. A running agent writes with its own fence. Without one, the write takes the lease for a moment.
   * It runs inside the per-chat lock, so two notices cannot take the lease from each other. It never throws.
   */
  private async feedNotice(chatId: string, message: string, kind: "error" | "notice" = "error"): Promise<void> {
    try {
      await this.locked(chatId, async () => {
        const body: ChatBody = kind === "notice" ? { k: "notice", text: message } : { k: "error", code: "unavailable", message };
        const rt = this.runtimes.get(chatId);
        if (rt) {
          await this.emit(chatId, body, rt.fence);
          return;
        }
        const epoch = await this.d.store.acquireLease(chatId, this.d.replicaId, this.leaseTtl, this.d.now());
        if (epoch === undefined) return;
        const fence: LeaseFence = { replica: this.d.replicaId, epoch };
        try {
          await this.emit(chatId, body, fence);
        } finally {
          await this.d.store.releaseLease(chatId, fence).catch(() => undefined);
        }
      });
    } catch {
      // The metric already counted it.
    }
  }

  /**
   * Send a command to its owner and wait for the ack. The owner acks every command it gets.
   * No ack after forwardAckMs: an expired lease means the owner is gone, so this replica runs the command.
   * A live lease means the owner is silent: the extension gets a reject (not stored) and a metric counts it.
   */
  private async sendCmd(msg: Extract<ChatBusMsg, { t: "cmd" }>): Promise<boolean> {
    const ref = crypto.randomUUID();
    msg.from = this.d.replicaId;
    msg.ref = ref;
    try {
      await this.d.bus?.publish(msg);
    } catch {
      this.d.metrics.chatError("other");
      return false;
    }
    if (this.stopped) return true;
    const handle = this.timers.setTimeout(() => {
      this.watches.delete(handle);
      if (this.acked.delete(ref)) return;
      void this.noAck(msg).catch(() => this.d.metrics.chatError("other"));
    }, this.d.forwardAckMs ?? DEFAULT_FORWARD_ACK_MS);
    this.watches.add(handle);
    return true;
  }

  private async noAck(msg: Extract<ChatBusMsg, { t: "cmd" }>): Promise<void> {
    if (this.stopped || this.draining) return;
    const chat = await this.d.store.get(msg.chatId);
    if (!chat || chat.state === "closed") return;
    if (this.liveOwner(chat) !== undefined) {
      this.d.metrics.chatError("owner_unreachable");
      this.d.rejectChat?.(msg.chatId, "unavailable", NO_ACK_MESSAGE);
      // A retry of the same prompt reuses the stored event.
      if (msg.cmd === "prompt" && msg.seq !== undefined) {
        const row = (await this.d.store.events(msg.chatId, msg.seq - 1, 1))[0];
        if (row?.seq === msg.seq && row.body.k === "user") this.setBounded(this.unanswered, msg.chatId, { seq: msg.seq, text: row.body.text, at: this.d.now() });
      }
      return;
    }
    await this.onCmd(msg, false);
  }

  /** Check the arguments of a command with the protocol parsers, so the bus carries only valid commands. */
  private checkCmd(chatId: string, cmd: Extract<ChatBusMsg, { t: "cmd" }>["cmd"], args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    const a = args ?? {};
    switch (cmd) {
      case "prompt": {
        const r = parseChatFromExt({ t: "chat.prompt", chatId, text: a.text });
        return r?.t === "chat.prompt" ? { text: r.text } : undefined;
      }
      case "cancel":
        return parseChatFromExt({ t: "chat.cancel", chatId }) ? {} : undefined;
      case "close":
        return parseChatFromExt({ t: "chat.close", chatId }) ? {} : undefined;
      case "permission": {
        const r = parseChatFromExt({ t: "chat.permission", chatId, requestId: a.requestId, optionId: a.optionId });
        return r?.t === "chat.permission" ? { requestId: r.requestId, ...(r.optionId !== undefined ? { optionId: r.optionId } : {}) } : undefined;
      }
      case "link": {
        const r = parseChatFromExt({ t: "chat.link", chatId, tabIds: a.tabIds });
        return r?.t === "chat.link" ? { tabIds: r.tabIds } : undefined;
      }
      case "configure": {
        const out: Record<string, unknown> = {};
        if (a.name !== undefined) {
          const r = parseChatFromExt({ t: "chat.rename", chatId, name: a.name });
          if (r?.t !== "chat.rename") return undefined;
          out.name = r.name;
        }
        if (a.model !== undefined || a.effort !== undefined) {
          const r = parseChatFromExt({ t: "chat.config", chatId, model: a.model, effort: a.effort });
          if (r?.t !== "chat.config") return undefined;
          if (r.model !== undefined) out.model = r.model;
          if (r.effort !== undefined) out.effort = r.effort;
        }
        return out;
      }
    }
  }

  /**
   * One entry for every user command. The replica that owns the chat runs it. Another replica sends it over the bus.
   * A chat that nobody owns is taken by this replica for a prompt. Returns a reject when the command cannot run.
   */
  async dispatch(c: { chatId: string; binding: string; cmd: Extract<ChatBusMsg, { t: "cmd" }>["cmd"]; args?: Record<string, unknown> }): Promise<BrokerReject | undefined> {
    const chat = await this.d.store.get(c.chatId);
    if (!chat || chat.binding !== c.binding) return { code: "bad_request", message: "This chat does not exist." };
    if (chat.state === "closed") return c.cmd === "close" ? undefined : { code: "bad_request", message: "This chat is closed." };
    if (this.draining && c.cmd === "prompt") return { code: "unavailable", message: DRAINING_MESSAGE };
    const args = this.checkCmd(c.chatId, c.cmd, c.args);
    if (args === undefined) return { code: "bad_request", message: BAD_COMMAND_MESSAGE };
    const clear = { ...c, args };
    const owner = this.liveOwner(chat);
    if (owner === undefined) return this.runLocal(clear);
    return this.forward(chat, owner, clear);
  }

  private async forward(chat: ChatRecord, owner: string, c: { chatId: string; cmd: Extract<ChatBusMsg, { t: "cmd" }>["cmd"]; args?: Record<string, unknown> }): Promise<BrokerReject | undefined> {
    if (!this.d.bus) return { code: "unavailable", message: "Another gateway replica runs this chat." };
    const msg: Extract<ChatBusMsg, { t: "cmd" }> = { t: "cmd", to: owner, chatId: c.chatId, cmd: c.cmd };
    if (c.args) msg.args = c.args;
    if (c.cmd === "prompt") {
      const text = typeof c.args?.text === "string" ? clean(c.args.text) : "";
      if (chat.state === "thinking" || chat.state === "waiting") return { code: "busy", message: "The agent is still working on the last message." };
      const prior = this.unanswered.get(c.chatId);
      this.unanswered.delete(c.chatId);
      let seq: number;
      if (prior && prior.text === text && chat.lastSeq === prior.seq && this.d.now() - prior.at < UNANSWERED_MS) seq = prior.seq;
      else {
        seq = await this.d.store.appendEvent(c.chatId, { k: "user", text });
        this.notify(c.chatId, seq);
      }
      // The text stays in the store. The bus carries only its number.
      delete msg.args;
      msg.seq = seq;
      if (!(await this.sendCmd(msg))) {
        // The event stays in the feed. A retry with the same text reuses it.
        this.setBounded(this.unanswered, c.chatId, { seq, text, at: this.d.now() });
        return { code: "unavailable", message: NOT_SENT_MESSAGE };
      }
      return undefined;
    }
    if (busSize(msg) > MAX_BUS_PAYLOAD) return { code: "bad_request", message: BAD_COMMAND_MESSAGE };
    if (!(await this.sendCmd(msg))) return { code: "unavailable", message: NOT_SENT_MESSAGE };
    return undefined;
  }

  private async runLocal(c: { chatId: string; binding: string; cmd: Extract<ChatBusMsg, { t: "cmd" }>["cmd"]; args?: Record<string, unknown> }): Promise<BrokerReject | undefined> {
    const a = c.args ?? {};
    try {
      switch (c.cmd) {
        case "prompt":
          return await this.prompt(c.chatId, c.binding, typeof a.text === "string" ? a.text : "");
        case "cancel":
          await this.cancel(c.chatId);
          return undefined;
        case "permission":
          if (typeof a.requestId === "string") await this.answerPermission(c.chatId, a.requestId, typeof a.optionId === "string" ? a.optionId : undefined);
          return undefined;
        case "configure":
          if (typeof a.name === "string") await this.rename(c.chatId, a.name);
          await this.configure(c.chatId, { ...(typeof a.model === "string" ? { model: a.model } : {}), ...(typeof a.effort === "string" ? { effort: a.effort } : {}) });
          return undefined;
        case "link":
          if (Array.isArray(a.tabIds)) await this.link(c.chatId, a.tabIds.filter((n): n is number => typeof n === "number"));
          return undefined;
        case "close":
          await this.close(c.chatId, "user");
          return undefined;
      }
    } catch (e) {
      if (!(e instanceof ChatLeaseLostError)) throw e;
      // Another replica took the lease between the read and the write. Send the command there once.
      const chat = await this.d.store.get(c.chatId);
      const owner = chat ? this.liveOwner(chat) : undefined;
      if (chat && owner !== undefined && c.cmd !== "prompt") return this.forward(chat, owner, c);
      this.d.metrics.chatError("owner_unreachable");
      return { code: "unavailable", message: UNREACHABLE_MESSAGE };
    }
  }

  private onBus(m: ChatBusMsg): void {
    if (m.t === "event") {
      if (m.seq <= (this.notified.get(m.chatId) ?? 0)) return;
      this.setBounded(this.notified, m.chatId, m.seq);
      this.d.publish(m.chatId, m.seq);
      return;
    }
    if (m.t === "state") {
      void this.d.store.get(m.chatId).then((r) => r && this.d.publish(m.chatId, r.lastSeq), () => undefined);
      return;
    }
    if (m.t === "ack") {
      if (m.to === this.d.replicaId) {
        // A late ack finds no timer. Entries older than twice the wait are dropped, so the map stays small.
        const now = this.d.now();
        const age = (this.d.forwardAckMs ?? DEFAULT_FORWARD_ACK_MS) * 2;
        for (const [ref, at] of this.acked) if (now - at > age) this.acked.delete(ref);
        this.acked.set(m.ref, now);
        this.bound(this.acked);
      }
      return;
    }
    if (m.t !== "cmd" || m.to !== this.d.replicaId) return;
    void this.onCmd(m).catch(() => this.d.metrics.chatError("other"));
  }

  /** Tell the sender that this replica took the command, or took it before. */
  private ack(m: Extract<ChatBusMsg, { t: "cmd" }>): void {
    if (m.from !== undefined && m.ref !== undefined) void this.send({ t: "ack", to: m.from, chatId: m.chatId, ref: m.ref });
  }

  /**
   * Run a command that another replica sent, or that this replica adopts after the owner went silent (`ack` false).
   * The ack goes out only after the command is taken or known as taken. A replica in drain takes nothing and acks nothing.
   */
  private async onCmd(m: Extract<ChatBusMsg, { t: "cmd" }>, ack = true): Promise<void> {
    if (m.cmd === "prompt") {
      // A replica in drain takes no new prompt and acks nothing. The sender adopts it or the next owner does.
      if (this.draining) return;
      if (m.seq === undefined) return;
      const chatId = m.chatId;
      // A repeat of a prompt that this replica already started (a retry after a late ack).
      if ((this.lastAccepted.get(chatId) ?? 0) >= m.seq) {
        if (ack) this.ack(m);
        return;
      }
      const busy = (): boolean => this.turning.has(chatId) || !!(this.starting.get(chatId) && !this.starting.get(chatId)?.ending) || !!this.runtimes.get(chatId)?.ctx.busy;
      if (busy()) {
        // The owner took the command, so it acks at once. The notice follows when the busy state is clear.
        if (ack) this.ack(m);
        await this.claims.get(chatId);
        const st = this.starting.get(chatId);
        if (st && !st.ending) await st.promise.catch(() => undefined);
        // Every acked prompt ends in a turn, a draining notice or a busy notice.
        if (this.draining) {
          await this.feedNotice(chatId, DRAINING_MESSAGE);
          return;
        }
        if (!busy()) {
          // The claim that held the chat failed, or the turn ended. Nothing runs, so this prompt runs now.
          await this.onCmd(m, false);
          return;
        }
        await this.feedNotice(chatId, BUSY_NOTICE, "notice");
        return;
      }
      // Claim the chat and the number before the first await, so two commands in one tick cannot both run.
      const before = this.lastAccepted.get(chatId);
      this.setBounded(this.lastAccepted, chatId, m.seq);
      this.turning.add(chatId);
      const release = this.claim(chatId);
      let launched = false;
      try {
        const row = (await this.d.store.events(chatId, m.seq - 1, 1))[0];
        const chat = row?.seq === m.seq && row.body.k === "user" ? await this.d.store.get(chatId) : undefined;
        if (!chat || chat.state === "closed" || row?.body.k !== "user" || this.draining) return;
        // An adopted prompt may have run on the owner before it went silent. A turn end after it means it ran.
        if (!ack && (await this.d.store.hasTurnEnd(chatId, m.seq))) return;
        this.cancelledEarly.delete(chatId);
        this.launch(chatId, row.body.text, m.seq);
        launched = true;
        if (ack) this.ack(m);
      } finally {
        release();
        if (!launched) {
          this.turning.delete(chatId);
          // Undo only the number this call set. A newer value belongs to another command.
          if (this.lastAccepted.get(chatId) === m.seq) {
            if (before === undefined) this.lastAccepted.delete(chatId);
            else this.lastAccepted.set(chatId, before);
          }
        }
      }
      return;
    }
    const chat = await this.d.store.get(m.chatId);
    if (!chat) return;
    if (ack) this.ack(m);
    try {
      await this.runLocal({ chatId: m.chatId, binding: chat.binding, cmd: m.cmd, ...(m.args ? { args: m.args } : {}) });
    } catch {
      this.d.metrics.chatError("other");
    }
  }

  /** Chats with a running agent on this replica. The `ais_gateway_chats_active` gauge reads it. */
  active(): number {
    return this.runtimes.size;
  }

  /**
   * Finish this replica's work for a rollout. New prompts are refused. Asks end as cancelled. Turns in flight end by themselves:
   * there is no timer here, the pod grace period is the only ceiling. Then each pod detaches, each chat goes idle and each lease is released,
   * so another replica resumes the chat with session/load.
   */
  async drain(): Promise<void> {
    this.draining = true;
    // The sweep keeps running: it also restarts a hung turn, which drain waits for. During drain it ends no idle pod.
    for (const h of this.watches) this.timers.clearTimeout(h);
    this.watches.clear();
    for (let i = 0; ; i++) {
      for (const rt of this.runtimes.values()) this.cancelPerms(rt.ctx);
      const waits = [...this.starting.values()].map((e) => e.promise.catch(() => undefined) as Promise<unknown>).concat([...this.turnDone.values()]);
      if (waits.length === 0 && this.turning.size === 0) break;
      await (waits.length > 0 ? Promise.all(waits) : new Promise((r) => setImmediate(r)));
    }
    for (const rt of [...this.runtimes.values()]) {
      await rt.ctx.chain;
      await this.writeState(rt.chatId, { state: "idle" }, rt.fence).catch(() => undefined);
      this.drop(rt.chatId);
      await this.d.transport.stopSession(rt.handle.session).catch(() => undefined);
      await this.d.store.releaseLease(rt.chatId, rt.fence).catch(() => undefined);
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
      this.push(ctx, { k: "turn_end", stopReason: shortField(r.stopReason) });
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
      this.timers.clearTimeout(ctx.cancelTimer);
      ctx.busy = false;
      ctx.cancelRequested = false;
      // An ask that came after the end of the turn stays open. The answer then sets the state idle.
      if (this.runtimes.get(rt.chatId) === rt) this.setState(ctx, ctx.perms.size > 0 ? "waiting" : "idle");
      ctx.lastActive = this.d.now();
      await ctx.chain;
    }
  }

  /** Stop the current turn with ACP session/cancel. The pod stays, unless the agent ignores the cancel (see cancelGraceMs). */
  async cancel(chatId: string): Promise<void> {
    const rt = this.runtimes.get(chatId);
    if (!rt || !rt.ctx.busy) {
      // The prompt is accepted but the turn has not begun: the pod is still starting.
      if (this.turning.has(chatId)) this.cancelledEarly.add(chatId);
      return;
    }
    const { ctx } = rt;
    ctx.cancelRequested = true;
    this.cancelPerms(ctx);
    rt.acp.cancel(rt.sessionId);
    this.timers.clearTimeout(ctx.cancelTimer);
    ctx.cancelTimer = this.timers.setTimeout(() => this.restartHung(rt), this.d.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
  }

  /** The agent did not end its turn. Close its stream: the agent_exit path sets the chat idle, and the next prompt resumes. */
  private restartHung(rt: ChatRuntime): void {
    if (this.runtimes.get(rt.chatId) !== rt || !rt.ctx.busy) return;
    rt.ctx.exitMessage = HUNG_MESSAGE;
    rt.handle.stream.close();
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
    this.timers.clearTimeout(rt.ctx.cancelTimer);
    rt.handle.stream.close();
    return rt;
  }

  /**
   * The lease of a chat for one write, inside the per-chat lock. A running chat uses its own fence.
   * Another replica that owns the chat makes this throw ChatLeaseLostError. `fn` gets the runtime as it is after the lock, so a start in progress is done.
   */
  private withFence<T>(chatId: string, fn: (fence: LeaseFence, rt: ChatRuntime | undefined) => Promise<T>): Promise<T> {
    return this.locked(chatId, async () => {
      // A clean-up of the last pod writes with its own lease. Wait for it, so this write cannot take that lease away.
      for (let e = this.starting.get(chatId); e?.ending; e = this.starting.get(chatId)) await e.promise.catch(() => undefined);
      const rt = this.runtimes.get(chatId);
      if (rt) return fn(rt.fence, rt);
      const epoch = await this.d.store.acquireLease(chatId, this.d.replicaId, this.leaseTtl, this.d.now());
      if (epoch === undefined) throw new ChatLeaseLostError(chatId);
      const fence: LeaseFence = { replica: this.d.replicaId, epoch };
      try {
        return await fn(fence, undefined);
      } finally {
        await this.d.store.releaseLease(chatId, fence).catch(() => undefined);
      }
    });
  }

  /** Set the model or effort. A running agent gets it now. A dormant chat gets it at the next start. */
  async configure(chatId: string, patch: { model?: string; effort?: string }): Promise<void> {
    const want = { ...(patch.model !== undefined ? { model: patch.model } : {}), ...(patch.effort !== undefined ? { effort: patch.effort } : {}) };
    if (Object.keys(want).length === 0) return;
    await this.withFence(chatId, async (fence, rt) => {
      const chat = await this.d.store.get(chatId);
      if (!chat || chat.state === "closed") return;
      if (rt) {
        try {
          await rt.acp.setConfig(rt.sessionId, want);
        } catch {
          this.d.metrics.chatError("acp");
          this.push(rt.ctx, { k: "error", code: "acp", message: "The agent did not accept this setting." });
          return;
        }
      }
      await this.d.store.update(chatId, { selection: { ...chat.selection, ...want } }, fence);
      if (rt) {
        const base = rt.ctx.config ?? { k: "config" as const, models: [], efforts: [], current: {} };
        const body = { ...base, current: { ...base.current, ...want } };
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
    await this.withFence(chatId, async (fence, rt) => {
      try {
        const chat = await this.d.store.get(chatId);
        if (!chat || chat.state === "closed") return;
        if (rt) {
          this.cancelPerms(rt.ctx);
          await rt.ctx.chain;
          this.drop(chatId);
        }
        try {
          if (reason !== "user") await this.emit(chatId, { k: "notice", text: reason === "idle" ? "This chat closed after a long time without use." : "This chat is too old and was closed." }, fence);
          await this.writeState(chatId, { state: "closed" }, fence);
        } catch (e) {
          // No proof of ownership: stop only our own pod.
          if (rt) await this.d.transport.stopSession(rt.handle.session).catch(() => undefined);
          throw e;
        }
        await this.d.transport.stop(chatId).catch(() => undefined);
        await this.d.endBrowserSession?.(chat.binding, sessionIdForChat(chatId)).catch(() => undefined);
        this.d.metrics.chatSession("session_closed");
      } finally {
        this.forget(chatId);
        if (rt) await this.d.store.releaseLease(chatId, rt.fence).catch(() => undefined);
      }
    });
  }

  /**
   * End the pod of every chat that was idle for idleMs. The chat stays open and goes dormant: the next prompt starts a pod and loads the session.
   * A chat with a turn, a start or a pending ask is never swept for idleness.
   * A turn that shows no sign of life for stallMs is restarted like a hung cancel.
   */
  async sweepIdle(): Promise<void> {
    const limit = Math.min(this.d.idleMs ?? DEFAULT_IDLE_MS, MAX_IDLE_MS);
    const stall = this.d.stallMs ?? DEFAULT_STALL_MS;
    const ending: Array<Promise<unknown>> = [];
    for (const rt of [...this.runtimes.values()]) {
      const { ctx } = rt;
      const quiet = this.d.now() - ctx.lastActive;
      if (ctx.busy) {
        if (ctx.perms.size === 0 && quiet >= stall) this.restartHung(rt);
        continue;
      }
      if (this.draining) continue;
      if (this.turning.has(rt.chatId) || this.starting.has(rt.chatId)) continue;
      if (quiet < limit) continue;
      // An open ask outside a turn does not keep the pod alive. It ends as cancelled with the pod.
      this.cancelPerms(ctx);
      this.idleEnd(rt);
      const e = this.starting.get(rt.chatId);
      if (e) ending.push(e.promise);
    }
    await Promise.all(ending);
    // A restarted agent ends through its stream close. Wait for the clean-up that it started.
    await Promise.all([...this.starting.values()].filter((e) => e.ending).map((e) => e.promise));
  }

  private idleEnd(rt: ChatRuntime): void {
    if (this.runtimes.get(rt.chatId) !== rt) return;
    const { store, transport, metrics } = this.d;
    this.drop(rt.chatId);
    metrics.chatSession("idle_closed");
    this.registerEnding(rt.chatId, async () => {
      try {
        await rt.ctx.chain;
        if (await this.emit(rt.chatId, { k: "notice", text: "The agent stopped after a long time without use. Send a message to continue." }, rt.fence)) await this.writeState(rt.chatId, { state: "idle" }, rt.fence);
      } finally {
        await transport.stopSession(rt.handle.session).catch(() => undefined);
        await store.releaseLease(rt.chatId, rt.fence).catch(() => undefined);
      }
    });
  }

  /** Stop all work of this broker: running starts, streams and lease timers. */
  async dispose(): Promise<void> {
    this.stopped = true;
    clearTimeoutSafe(this.timers, this.sweepTimer);
    for (const h of this.watches) this.timers.clearTimeout(h);
    this.watches.clear();
    this.offReconnect?.();
    this.offReconnect = undefined;
    await this.unsubscribe?.().catch(() => undefined);
    this.unsubscribe = undefined;
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
