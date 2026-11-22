import type { ChatBody } from "../../browser/chat-protocol.ts";
import { ChatClosedError, ChatExistsError, ChatLeaseLostError, type ChatCreate, type ChatEventRow, type ChatPatch, type ChatRecord, type ChatStore, type LeaseFence } from "./types.ts";

const copy = (r: ChatRecord): ChatRecord => structuredClone(r);
const PATCH_KEYS = ["name", "state", "selection", "tabIds", "acpSessionId", "podSession", "canLoad", "generation"] as const;

/** In-memory chat store for tests and single-process use. */
export class MemoryChatStore implements ChatStore {
  private readonly chats = new Map<string, ChatRecord>();
  private readonly log = new Map<string, ChatEventRow[]>();

  constructor(private readonly now: () => number = Date.now) {}

  private holds(r: ChatRecord, f: LeaseFence): boolean {
    return r.ownerReplica === f.replica && r.epoch === f.epoch && r.leaseUntil !== undefined && r.leaseUntil > this.now();
  }

  async create(rec: ChatCreate, cap: number): Promise<ChatRecord | "cap"> {
    if (this.chats.has(rec.id)) throw new ChatExistsError(rec.id);
    let open = 0;
    for (const c of this.chats.values()) {
      if (c.binding === rec.binding && c.windowId === rec.windowId && c.state !== "closed") open += 1;
    }
    if (open >= cap) return "cap";
    const row: ChatRecord = { ...structuredClone(rec), state: "starting", epoch: 0, lastSeq: 0, generation: 0, updatedAt: rec.createdAt };
    this.chats.set(row.id, row);
    this.log.set(row.id, []);
    return copy(row);
  }

  async get(id: string): Promise<ChatRecord | undefined> {
    const r = this.chats.get(id);
    return r ? copy(r) : undefined;
  }

  async listByBinding(binding: string, opts: { windowId?: number; includeClosed?: boolean } = {}): Promise<ChatRecord[]> {
    return [...this.chats.values()]
      .filter((c) => c.binding === binding)
      .filter((c) => opts.windowId === undefined || c.windowId === opts.windowId)
      .filter((c) => opts.includeClosed === true || c.state !== "closed")
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(copy);
  }

  async update(id: string, patch: ChatPatch, fence: LeaseFence): Promise<ChatRecord | undefined> {
    const r = this.chats.get(id);
    if (!r) return undefined;
    if (!this.holds(r, fence)) throw new ChatLeaseLostError(id);
    if (r.state === "closed" && patch.state !== undefined && patch.state !== "closed") throw new ChatClosedError(id);
    const target = r as unknown as Record<string, unknown>;
    for (const k of PATCH_KEYS) {
      if (patch[k] !== undefined) target[k] = structuredClone(patch[k]);
    }
    const now = Date.now();
    if (patch.state === "closed" && r.closedAt === undefined) r.closedAt = now;
    r.updatedAt = now;
    return copy(r);
  }

  async appendEvent(id: string, body: ChatBody, fence: LeaseFence): Promise<number> {
    const r = this.chats.get(id);
    if (!r) throw new Error(`unknown chat ${id}`);
    if (!this.holds(r, fence)) throw new ChatLeaseLostError(id);
    r.lastSeq += 1;
    r.updatedAt = Date.now();
    this.log.get(id)?.push({ seq: r.lastSeq, ts: r.updatedAt, body: structuredClone(body) });
    return r.lastSeq;
  }

  async events(id: string, afterSeq: number, limit: number): Promise<ChatEventRow[]> {
    return (this.log.get(id) ?? []).filter((e) => e.seq > afterSeq).slice(0, Math.max(0, limit)).map((e) => structuredClone(e));
  }

  async acquireLease(id: string, replica: string, ttlMs: number, nowMs: number): Promise<number | undefined> {
    const r = this.chats.get(id);
    if (!r) return undefined;
    const free = r.ownerReplica === undefined || r.leaseUntil === undefined || r.leaseUntil <= nowMs;
    if (!free && r.ownerReplica !== replica) return undefined;
    r.ownerReplica = replica;
    r.leaseUntil = nowMs + ttlMs;
    r.epoch += 1;
    return r.epoch;
  }

  async renewLease(id: string, fence: LeaseFence, ttlMs: number, nowMs: number): Promise<void> {
    const r = this.chats.get(id);
    if (!r || !this.holds(r, fence)) throw new ChatLeaseLostError(id);
    r.leaseUntil = nowMs + ttlMs;
  }

  async releaseLease(id: string, replica: string): Promise<void> {
    const r = this.chats.get(id);
    if (!r || r.ownerReplica !== replica) return;
    delete r.ownerReplica;
    delete r.leaseUntil;
  }

  async ownedBy(replica: string): Promise<ChatRecord[]> {
    return [...this.chats.values()].filter((c) => c.ownerReplica === replica && c.state !== "closed").map(copy);
  }

  private prune(match: (c: ChatRecord) => boolean): number {
    let n = 0;
    for (const [id, c] of this.chats) {
      if (match(c)) {
        this.chats.delete(id);
        this.log.delete(id);
        n += 1;
      }
    }
    return n;
  }

  async pruneClosed(beforeMs: number): Promise<number> {
    return this.prune((c) => c.state === "closed" && c.closedAt !== undefined && c.closedAt < beforeMs);
  }

  async pruneIdle(cutMs: number): Promise<number> {
    return this.prune((c) => c.state !== "closed" && c.updatedAt < cutMs);
  }
}
