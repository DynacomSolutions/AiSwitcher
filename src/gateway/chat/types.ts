import type { ChatBody, ChatSelection, ChatState } from "../../browser/chat-protocol.ts";

export interface ChatRecord {
  id: string;
  binding: string;
  windowId: number;
  name: string;
  color: string;
  selection: ChatSelection;
  state: ChatState;
  tabIds: number[];
  acpSessionId?: string;
  podSession?: string;
  canLoad?: boolean;
  ownerReplica?: string;
  leaseUntil?: number;
  lastSeq: number;
  generation: number;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export type ChatCreate = Omit<ChatRecord, "lastSeq" | "generation" | "updatedAt" | "state" | "closedAt">;
export type ChatPatch = Partial<Pick<ChatRecord, "name" | "state" | "selection" | "tabIds" | "acpSessionId" | "podSession" | "canLoad" | "generation">>;
export interface ChatEventRow { seq: number; ts: number; body: ChatBody }

export interface ChatStore {
  /** Atomic count of the open chats of (binding, windowId). Returns "cap" when the window is full. */
  create(rec: ChatCreate, cap: number): Promise<ChatRecord | "cap">;
  get(id: string): Promise<ChatRecord | undefined>;
  listByBinding(binding: string, opts?: { windowId?: number; includeClosed?: boolean }): Promise<ChatRecord[]>;
  update(id: string, patch: ChatPatch): Promise<ChatRecord | undefined>;
  /** Atomic sequence number: the first event of a chat gets 1. */
  appendEvent(id: string, body: ChatBody): Promise<number>;
  events(id: string, afterSeq: number, limit: number): Promise<ChatEventRow[]>;
  /** True when the lease was free, already owned by this replica, or expired. */
  acquireLease(id: string, replica: string, ttlMs: number, nowMs: number): Promise<boolean>;
  renewLease(id: string, replica: string, ttlMs: number, nowMs: number): Promise<boolean>;
  releaseLease(id: string, replica: string): Promise<void>;
  ownedBy(replica: string): Promise<ChatRecord[]>;
  /** Deletes chats closed before the cut-off, with their events. Returns the number of chats removed. */
  pruneClosed(beforeMs: number): Promise<number>;
}
