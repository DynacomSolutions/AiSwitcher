import type { ChatBody } from "../../browser/chat-protocol.ts";
import type { ChatCreate, ChatEventRow, ChatPatch, ChatRecord, ChatStore } from "./types.ts";

const copy = (r: ChatRecord): ChatRecord => structuredClone(r);

/** In-memory chat store for tests and single-process use. */
export class MemoryChatStore implements ChatStore {
  private readonly chats = new Map<string, ChatRecord>();
  private readonly log = new Map<string, ChatEventRow[]>();

  async create(rec: ChatCreate, cap: number): Promise<ChatRecord | "cap"> {
    let open = 0;
    for (const c of this.chats.values()) {
      if (c.binding === rec.binding && c.windowId === rec.windowId && c.state !== "closed") open += 1;
    }
    if (open >= cap) return "cap";
    const row: ChatRecord = { ...structuredClone(rec), state: "starting", lastSeq: 0, generation: 0, updatedAt: rec.createdAt };
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

  async update(id: string, patch: ChatPatch): Promise<ChatRecord | undefined> {
    const r = this.chats.get(id);
    if (!r) return undefined;
    const now = Date.now();
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = structuredClone(v);
    }
    if (patch.state === "closed" && r.closedAt === undefined) r.closedAt = now;
    if (patch.state !== undefined && patch.state !== "closed") delete r.closedAt;
    r.updatedAt = now;
    return copy(r);
  }

  async appendEvent(id: string, body: ChatBody): Promise<number> {
    const r = this.chats.get(id);
    if (!r) throw new Error(`unknown chat ${id}`);
    r.lastSeq += 1;
    this.log.get(id)?.push({ seq: r.lastSeq, ts: Date.now(), body: structuredClone(body) });
    return r.lastSeq;
  }

  async events(id: string, afterSeq: number, limit: number): Promise<ChatEventRow[]> {
    return (this.log.get(id) ?? []).filter((e) => e.seq > afterSeq).slice(0, Math.max(0, limit)).map((e) => structuredClone(e));
  }

  async acquireLease(id: string, replica: string, ttlMs: number, nowMs: number): Promise<boolean> {
    const r = this.chats.get(id);
    if (!r) return false;
    const free = r.ownerReplica === undefined || r.leaseUntil === undefined || r.leaseUntil <= nowMs;
    if (!free && r.ownerReplica !== replica) return false;
    r.ownerReplica = replica;
    r.leaseUntil = nowMs + ttlMs;
    return true;
  }

  async renewLease(id: string, replica: string, ttlMs: number, nowMs: number): Promise<boolean> {
    const r = this.chats.get(id);
    if (!r || r.ownerReplica !== replica) return false;
    r.leaseUntil = nowMs + ttlMs;
    return true;
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

  async pruneClosed(beforeMs: number): Promise<number> {
    let n = 0;
    for (const [id, c] of this.chats) {
      if (c.state === "closed" && c.closedAt !== undefined && c.closedAt < beforeMs) {
        this.chats.delete(id);
        this.log.delete(id);
        n += 1;
      }
    }
    return n;
  }
}
