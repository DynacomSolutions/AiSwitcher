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
  /** Set by the store on read: the lease is live by the store's own clock. Never compare leaseUntil with another clock. */
  leaseLive?: boolean;
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
/** appendEvent got no fence for a body that is not a user event. */
export class ChatFenceRequiredError extends Error {
  constructor(readonly chatId: string) { super(`a fence is required to append to chat ${chatId}`); this.name = "ChatFenceRequiredError"; }
}
/** A closed chat cannot open again. */
export class ChatClosedError extends Error {
  constructor(readonly chatId: string) { super(`chat ${chatId} is closed`); this.name = "ChatClosedError"; }
}
export type ChatPatch = Partial<Pick<ChatRecord, "name" | "state" | "selection" | "tabIds" | "acpSessionId" | "podSession" | "canLoad" | "generation">>;
export interface ChatEventRow { seq: number; ts: number; body: ChatBody }

/** Lease taken in the same step as create: the chat starts at epoch 1. */
export interface ChatOwner { replica: string; ttlMs: number }

/**
 * Broker rule: inside one replica, acquire and start of a chat must run single-flight per chat.
 * A second acquireLease by the same replica bumps the epoch, so the older code path then fails safe with ChatLeaseLostError.
 * Task 13 carries this rule.
 *
 * Lease rules. acquireLease, renewLease, appendEvent and update need a live lease.
 * The Postgres store judges expiry with the database clock (clock_timestamp()) and ignores nowMs.
 * The memory store judges expiry with its own clock (default Date.now) and ignores nowMs, in the same way.
 */
export interface ChatStore {
  /** Atomic count of the open chats of (binding, windowId). Returns "cap" when the window is full, and "global" when `globalCap` open chats exist over all bindings (the check and the insert are one atomic step). Throws ChatExistsError on a used id, even when the window is full.
   * With `since` (epoch ms, the approval time of the binding) the window count skips chats made earlier: they belong to an older binding of the same name.
   * With owner, the same step sets the owner, the lease and epoch 1, so the caller has the fence ({ replica, epoch: record.epoch }) at once. */
  create(rec: ChatCreate, cap: number, owner?: ChatOwner, globalCap?: number, since?: number): Promise<ChatRecord | "cap" | "global">;
  get(id: string): Promise<ChatRecord | undefined>;
  listByBinding(binding: string, opts?: { windowId?: number; includeClosed?: boolean }): Promise<ChatRecord[]>;
  /** Throws ChatLeaseLostError when the fence is stale or expired, ChatClosedError on a move from closed to an open state. Returns undefined for an unknown chat. */
  update(id: string, patch: ChatPatch, fence: LeaseFence): Promise<ChatRecord | undefined>;
  /**
   * Atomic sequence number: the first event of a chat gets 1. Throws ChatLeaseLostError when the fence is stale or expired.
   * The fence is optional for a user event only, so any replica can store a prompt. Other kinds without a fence throw ChatFenceRequiredError.
   */
  appendEvent(id: string, body: ChatBody, fence?: LeaseFence): Promise<number>;
  events(id: string, afterSeq: number, limit: number): Promise<ChatEventRow[]>;
  /** True when the chat has a turn_end event with a number above afterSeq. No row cap. */
  hasTurnEnd(id: string, afterSeq: number): Promise<boolean>;
  /** Returns the new epoch when the lease was free, already owned by this replica, or expired. Returns undefined otherwise. */
  acquireLease(id: string, replica: string, ttlMs: number, nowMs: number): Promise<number | undefined>;
  /** Throws ChatLeaseLostError when the fence is stale or the lease has expired. */
  renewLease(id: string, fence: LeaseFence, ttlMs: number, nowMs: number): Promise<void>;
  /** Frees the lease only when the fence still matches. A stale epoch does nothing. */
  releaseLease(id: string, fence: LeaseFence): Promise<void>;
  ownedBy(replica: string): Promise<ChatRecord[]>;
  /** Deletes chats closed before the cut-off, with their events, in batches of 500. Returns the number of chats removed. */
  pruneClosed(beforeMs: number): Promise<number>;
  /** Number of chats that are not closed, over all bindings. The gateway-wide cap reads it. */
  countOpen(): Promise<number>;
  /** Deletes open chats without a live lease whose updatedAt is before the cut-off, with their events, in batches of 500. Returns the ids removed, so the caller can stop any pod. */
  pruneIdle(cutMs: number): Promise<string[]>;
}
