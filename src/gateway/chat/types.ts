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
  /** Grows by one on each acquireLease. A stale owner holds an old epoch. */
  epoch: number;
  lastSeq: number;
  generation: number;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export type ChatCreate = Omit<ChatRecord, "lastSeq" | "generation" | "updatedAt" | "state" | "closedAt" | "ownerReplica" | "leaseUntil" | "epoch">;
/** Proof of lease ownership: the replica and the epoch that acquireLease returned. */
export interface LeaseFence { replica: string; epoch: number }

/** create found a chat with the same id. */
export class ChatExistsError extends Error {
  constructor(readonly chatId: string) { super(`chat ${chatId} already exists`); this.name = "ChatExistsError"; }
}
/** The caller does not hold a live lease of the current epoch. */
export class ChatLeaseLostError extends Error {
  constructor(readonly chatId: string) { super(`lease lost for chat ${chatId}`); this.name = "ChatLeaseLostError"; }
}
/** A closed chat cannot open again. */
export class ChatClosedError extends Error {
  constructor(readonly chatId: string) { super(`chat ${chatId} is closed`); this.name = "ChatClosedError"; }
}
export type ChatPatch = Partial<Pick<ChatRecord, "name" | "state" | "selection" | "tabIds" | "acpSessionId" | "podSession" | "canLoad" | "generation">>;
export interface ChatEventRow { seq: number; ts: number; body: ChatBody }

/**
 * Lease rules. acquireLease, renewLease, appendEvent and update need a live lease.
 * The Postgres store judges expiry with the database clock (clock_timestamp()) and ignores nowMs.
 * The memory store judges expiry with nowMs in acquireLease and with its own clock (default Date.now) in the fenced calls.
 */
export interface ChatStore {
  /** Atomic count of the open chats of (binding, windowId). Returns "cap" when the window is full. Throws ChatExistsError on a used id. */
  create(rec: ChatCreate, cap: number): Promise<ChatRecord | "cap">;
  get(id: string): Promise<ChatRecord | undefined>;
  listByBinding(binding: string, opts?: { windowId?: number; includeClosed?: boolean }): Promise<ChatRecord[]>;
  /** Throws ChatLeaseLostError when the fence is stale or expired, ChatClosedError on a move from closed to an open state. Returns undefined for an unknown chat. */
  update(id: string, patch: ChatPatch, fence: LeaseFence): Promise<ChatRecord | undefined>;
  /** Atomic sequence number: the first event of a chat gets 1. Throws ChatLeaseLostError when the fence is stale or expired. */
  appendEvent(id: string, body: ChatBody, fence: LeaseFence): Promise<number>;
  events(id: string, afterSeq: number, limit: number): Promise<ChatEventRow[]>;
  /** Returns the new epoch when the lease was free, already owned by this replica, or expired. Returns undefined otherwise. */
  acquireLease(id: string, replica: string, ttlMs: number, nowMs: number): Promise<number | undefined>;
  /** Throws ChatLeaseLostError when the fence is stale or the lease has expired. */
  renewLease(id: string, fence: LeaseFence, ttlMs: number, nowMs: number): Promise<void>;
  releaseLease(id: string, replica: string): Promise<void>;
  ownedBy(replica: string): Promise<ChatRecord[]>;
  /** Deletes chats closed before the cut-off, with their events, in batches of 500. Returns the number of chats removed. */
  pruneClosed(beforeMs: number): Promise<number>;
  /** Deletes open chats whose updatedAt is before the cut-off, with their events, in batches of 500. Returns the number removed. */
  pruneIdle(cutMs: number): Promise<number>;
}
