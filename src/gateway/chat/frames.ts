// Chat frames: the bridge between the extension socket (hub) and the broker.
// A chat belongs to one browser binding. Events and states reach only the socket of that binding, on the replica that holds it.
import type { ChatErrorCode, ChatFromExt, ChatSummary, ChatToExt } from "../../browser/chat-protocol.ts";
import type { BrowserBinding } from "../../browser/types.ts";
import type { BrowserHub } from "../browser/hub.ts";
import type { GatewayMetrics } from "../metrics.ts";
import { GATEWAY_CAP_MESSAGE as CAP_COPY, type BrokerReject, type ChatBroker } from "./broker.ts";
import type { ChatBus } from "./bus.ts";
import type { ChatCatalog } from "./catalog.ts";
import type { ChatRecord, ChatStore } from "./types.ts";

/** Events read from the store in one step. */
const PAGE = 200;
const MAX_WATCHES = 2000;
const MAX_LIST = 256;
export const GATEWAY_CAP_MESSAGE = CAP_COPY;
const DEFAULT_LOCK_WAIT_MS = 30_000;
const UNLISTED = "This agent is not available.";
const MODEL_UNLISTED = "This model is not available.";
const NOT_FOUND = "This chat does not exist.";
const EXPIRED = "This chat has expired.";
const SERVICE_BUSY = "The chat service is busy. Try again in a moment.";
const CATALOG_DOWN = "The agent list is unavailable. Try again in a moment.";

export interface ChatFramesDeps {
  broker: Pick<ChatBroker, "create" | "dispatch">;
  store: ChatStore;
  bus: ChatBus;
  catalog: Pick<ChatCatalog, "get" | "check">;
  hub: Pick<BrowserHub, "sendTo">;
  /** Open chats of one window of one browser. */
  maxPerWindow: number;
  /** Open chats on the whole gateway. Default 12. */
  maxLive?: number;
  /** Longest a create waits for the create before it. Only the wait for the lock is bound, never a create in flight. Default 30 s. */
  createLockWaitMs?: number;
  metrics?: Pick<GatewayMetrics, "chatError">;
}

/** A chat that has a socket on this replica. `cursor` is the last event number that went out. */
interface Watch {
  binding: string;
  cursor: number;
  /** The last state that went out. An empty key forces the next state frame. */
  key: string;
  dirty: boolean;
  /** Grows when a resume resets the cursor. A sync loop of an older generation stops. */
  gen: number;
  running?: Promise<void>;
}

export const summaryOf = (r: ChatRecord): ChatSummary => ({
  chatId: r.id,
  name: r.name,
  color: r.color,
  windowId: r.windowId,
  state: r.state,
  selection: r.selection,
  tabIds: r.tabIds,
  lastSeq: r.lastSeq,
  updatedAt: r.updatedAt,
});

/** What a state frame shows. The event number and the time are left out, so an event alone sends no state. */
const stateKey = (r: ChatRecord): string => JSON.stringify([r.state, r.name, r.color, r.windowId, r.selection, r.tabIds]);

export class ChatFrames {
  private readonly watches = new Map<string, Watch>();
  private readonly pendingCreate = new Map<string, Promise<void>>();
  private createLock: Promise<void> = Promise.resolve();
  private unsubscribe: (() => Promise<void>) | undefined;
  private stopped = false;

  constructor(private readonly d: ChatFramesDeps) {}

  /** Listen to the bus: event and state notices go to the socket of the chat's binding. */
  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.stopped = false;
    this.unsubscribe = await this.d.bus.subscribe((m) => {
      if (m.t === "event") {
        const w = this.watches.get(m.chatId);
        if (w && m.seq > w.cursor) void this.schedule(m.chatId, w);
      } else if (m.t === "state") this.poke(m.chatId);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.unsubscribe?.().catch(() => undefined);
    this.unsubscribe = undefined;
    await Promise.all([...this.watches.values()].map((w) => w.running));
    this.watches.clear();
  }

  /** Chats with a socket on this replica. The broker pushes their state again after a LISTEN reconnect. */
  watchedChats(): string[] {
    return [...this.watches.keys()];
  }

  /** The broker's local notice. Resolves when everything the notice made visible has gone out. */
  poke(chatId: string): Promise<void> {
    const w = this.watches.get(chatId);
    return w ? this.schedule(chatId, w) : Promise.resolve();
  }

  /** A command failed on a path with no reply (a forwarded command). The panel of the chat's binding shows it. */
  rejectChat(chatId: string, code: ChatErrorCode, message: string): void {
    const w = this.watches.get(chatId);
    if (w) this.out(chatId, w, { t: "chat.reject", chatId, code, message });
  }

  /** A binding attached: send its chat list. The extension then sends `chat.resume` for each chat. */
  async onAttach(binding: BrowserBinding): Promise<void> {
    // A new socket knows nothing yet. Its resume frames set the cursors again.
    for (const [id, w] of this.watches) if (w.binding === binding.name) this.watches.delete(id);
    const recs = await this.d.store.listByBinding(binding.name);
    this.d.hub.sendTo(binding.name, { t: "chat.list", chats: recs.slice(0, MAX_LIST).map(summaryOf) });
  }

  async handle(binding: BrowserBinding, frame: ChatFromExt, reply: (f: ChatToExt) => void): Promise<void> {
    try {
      await this.run(binding, frame, reply);
    } catch {
      this.d.metrics?.chatError("other");
      const r: Extract<ChatToExt, { t: "chat.reject" }> = { t: "chat.reject", code: "unavailable", message: SERVICE_BUSY };
      if ("chatId" in frame) r.chatId = frame.chatId;
      if (frame.t === "chat.catalog") r.reqId = frame.reqId;
      reply(r);
    }
  }

  private async run(binding: BrowserBinding, f: ChatFromExt, reply: (f: ChatToExt) => void): Promise<void> {
    const reject = (code: ChatErrorCode, message: string): void => reply({ t: "chat.reject", ...("chatId" in f ? { chatId: f.chatId } : {}), code, message });
    switch (f.t) {
      case "chat.create":
        return this.create(binding, f, reply);
      case "chat.list": {
        const recs = await this.d.store.listByBinding(binding.name, f.windowId === undefined ? {} : { windowId: f.windowId });
        reply({ t: "chat.list", chats: recs.slice(0, MAX_LIST).map(summaryOf) });
        return;
      }
      case "chat.catalog": {
        let providers: Awaited<ReturnType<ChatCatalog["get"]>>;
        try {
          providers = await this.d.catalog.get(f.provider);
        } catch {
          reply({ t: "chat.reject", reqId: f.reqId, code: "unavailable", message: CATALOG_DOWN });
          return;
        }
        reply({ t: "chat.catalog", reqId: f.reqId, providers });
        return;
      }
    }
    // Every other frame names a chat. It waits for a create of the same chat that is still running.
    await this.pendingCreate.get(f.chatId);
    const rec = await this.d.store.get(f.chatId);
    if (f.t === "chat.resume") {
      if (!rec) return reject("expired", EXPIRED);
      if (rec.binding !== binding.name) return reject("bad_request", NOT_FOUND);
      this.watch(f.chatId, binding.name, f.afterSeq);
      await this.poke(f.chatId);
      return;
    }
    if (!rec || rec.binding !== binding.name) return reject("bad_request", NOT_FOUND);
    // A panel that sends a command without a resume still gets the answer.
    if (!this.watches.has(f.chatId)) this.watch(f.chatId, binding.name, rec.lastSeq);
    const base = { chatId: f.chatId, binding: binding.name };
    let r: BrokerReject | undefined;
    switch (f.t) {
      case "chat.prompt":
        r = await this.d.broker.dispatch({ ...base, cmd: "prompt", args: { text: f.text } });
        break;
      case "chat.cancel":
        r = await this.d.broker.dispatch({ ...base, cmd: "cancel" });
        break;
      case "chat.close":
        r = await this.d.broker.dispatch({ ...base, cmd: "close" });
        break;
      case "chat.permission":
        r = await this.d.broker.dispatch({ ...base, cmd: "permission", args: { requestId: f.requestId, ...(f.optionId !== undefined ? { optionId: f.optionId } : {}) } });
        break;
      case "chat.link":
        r = await this.d.broker.dispatch({ ...base, cmd: "link", args: { tabIds: f.tabIds } });
        break;
      case "chat.config":
        if (f.model !== undefined && (await this.d.catalog.check(rec.selection.provider, rec.selection.identity, f.model)) === "model") return reject("bad_request", MODEL_UNLISTED);
        r = await this.d.broker.dispatch({ ...base, cmd: "configure", args: { ...(f.model !== undefined ? { model: f.model } : {}), ...(f.effort !== undefined ? { effort: f.effort } : {}) } });
        break;
      case "chat.rename":
        r = await this.d.broker.dispatch({ ...base, cmd: "configure", args: { name: f.name } });
        break;
    }
    if (r) reject(r.code, r.message);
  }

  /** Creates are one at a time on this replica. A create waits for the lock at most `createLockWaitMs`. */
  private create(binding: BrowserBinding, f: Extract<ChatFromExt, { t: "chat.create" }>, reply: (f: ChatToExt) => void): Promise<void> {
    const prev = this.createLock;
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.createLock = prev.then(() => mine);
    const run = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const got = await Promise.race([
        prev.then(() => true),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(false), this.d.createLockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
      try {
        if (!got) {
          reply({ t: "chat.reject", chatId: f.chatId, code: "unavailable", message: SERVICE_BUSY });
          return;
        }
        await this.doCreate(binding, f, reply);
      } finally {
        release();
      }
    })();
    const tracked = run.catch(() => undefined).finally(() => {
      if (this.pendingCreate.get(f.chatId) === tracked) this.pendingCreate.delete(f.chatId);
    });
    this.pendingCreate.set(f.chatId, tracked);
    return run;
  }

  private async doCreate(binding: BrowserBinding, f: Extract<ChatFromExt, { t: "chat.create" }>, reply: (f: ChatToExt) => void): Promise<void> {
    const reject = (code: ChatErrorCode, message: string): void => reply({ t: "chat.reject", chatId: f.chatId, code, message });
    const verdict = await this.d.catalog.check(f.selection.provider, f.selection.identity, f.selection.model);
    if (verdict === "identity") return reject("bad_request", UNLISTED);
    if (verdict === "model") return reject("bad_request", MODEL_UNLISTED);
    const inWindow = await this.d.store.listByBinding(binding.name, { windowId: f.windowId });
    if (inWindow.length >= this.d.maxPerWindow) return reject("window_cap", `A window holds at most ${this.d.maxPerWindow} chats.`);
    // The store checks the gateway-wide cap in the same step as the insert, so replicas cannot overshoot it.
    const r = await this.d.broker.create({ chatId: f.chatId, binding: binding.name, windowId: f.windowId, name: f.name, color: f.color, selection: f.selection, tabIds: f.tabIds, maxLive: this.d.maxLive ?? 12 });
    if ("code" in r) return reject(r.code, r.message);
    reply({ t: "chat.state", chatId: r.id, state: r.state, summary: summaryOf(r) });
    const w = this.watch(r.id, binding.name, 0);
    w.key = stateKey(r);
    await this.poke(r.id);
  }

  private watch(chatId: string, binding: string, cursor: number): Watch {
    let w = this.watches.get(chatId);
    if (w && w.binding === binding) {
      w.cursor = cursor;
      w.key = "";
      w.gen += 1;
      return w;
    }
    w = { binding, cursor, key: "", dirty: false, gen: 0 };
    this.watches.set(chatId, w);
    while (this.watches.size > MAX_WATCHES) {
      const k = this.watches.keys().next();
      if (k.done) break;
      this.watches.delete(k.value);
    }
    return w;
  }

  /** Marks the watch dirty and runs the sync loop if it is not running. One loop per chat keeps the frames in order. */
  private schedule(chatId: string, w: Watch): Promise<void> {
    w.dirty = true;
    if (w.running) return w.running;
    w.running = (async () => {
      try {
        while (w.dirty && !this.stopped && this.watches.get(chatId) === w) {
          w.dirty = false;
          await this.sync(chatId, w);
        }
      } catch {
        this.d.metrics?.chatError("store");
      } finally {
        w.running = undefined;
      }
    })();
    return w.running;
  }

  /** Sends a frame for watch `w`. False when `w` is no longer the live watch of its chat, or when the socket is gone. */
  private out(chatId: string, w: Watch, frame: ChatToExt, gen = w.gen): boolean {
    if (this.watches.get(chatId) !== w || w.gen !== gen) return false;
    if (this.d.hub.sendTo(w.binding, frame)) return true;
    // This replica holds no socket for the binding. A panel that connects again sends a resume.
    this.watches.delete(chatId);
    return false;
  }

  /** New events first, then the state when it changed. A newer watch or a newer resume of the same chat stops this loop. */
  private async sync(chatId: string, w: Watch): Promise<void> {
    const gen = w.gen;
    const live = (): boolean => this.watches.get(chatId) === w && w.gen === gen;
    const rec = await this.d.store.get(chatId);
    if (!live()) return;
    if (!rec || rec.binding !== w.binding) {
      this.watches.delete(chatId);
      return;
    }
    for (;;) {
      const rows = await this.d.store.events(chatId, w.cursor, PAGE);
      for (const e of rows) {
        if (!this.out(chatId, w, { t: "chat.event", chatId, seq: e.seq, ts: e.ts, body: e.body }, gen)) return;
        w.cursor = e.seq;
      }
      if (!live()) return;
      if (rows.length < PAGE) break;
    }
    const key = stateKey(rec);
    if (key !== w.key) {
      w.key = key;
      if (!this.out(chatId, w, { t: "chat.state", chatId, state: rec.state, summary: summaryOf(rec) }, gen)) return;
    }
    if (rec.state === "closed" && live()) this.watches.delete(chatId);
  }
}
