// Chat bus: how gateway replicas talk about chats. Events travel as {chatId, seq} only: the body is read from the store.
import type { SQL } from "bun";
import type { PgListener } from "../pg-listen.ts";

export const CHAT_CHANNEL = "ais_gateway_chat";
/** NOTIFY allows 8000 bytes. Stay well under it. */
export const MAX_BUS_PAYLOAD = 7000;

export type ChatCmd = "prompt" | "cancel" | "permission" | "configure" | "close" | "link";
export type ChatBusMsg =
  | { t: "event"; chatId: string; seq: number }
  | { t: "state"; chatId: string }
  | { t: "cmd"; to: string; chatId: string; cmd: ChatCmd; seq?: number; args?: Record<string, unknown>; from?: string; ref?: string }
  | { t: "ack"; to: string; chatId: string; ref: string };

export interface ChatBus {
  publish(m: ChatBusMsg): Promise<void>;
  subscribe(h: (m: ChatBusMsg) => void): Promise<() => Promise<void>>;
  /** Runs after the LISTEN connection came back. Notices sent while it was down are lost, so the replica reads the store again. */
  onReconnect?(h: () => void): () => void;
}

/** Bytes of one message as the bus sends it. */
export const busSize = (m: ChatBusMsg): number => Buffer.byteLength(JSON.stringify(m));
const checkSize = (m: ChatBusMsg): void => {
  if (busSize(m) > MAX_BUS_PAYLOAD) throw new Error("chat bus message is too large");
};

const CMDS: readonly string[] = ["prompt", "cancel", "permission", "configure", "close", "link"];

/** Parse one payload. Returns undefined for anything that is not a known message. */
export function parseBusMsg(payload: string): ChatBusMsg | undefined {
  let v: unknown;
  try {
    v = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.chatId !== "string") return undefined;
  switch (o.t) {
    case "event":
      return typeof o.seq === "number" ? { t: "event", chatId: o.chatId, seq: o.seq } : undefined;
    case "state":
      return { t: "state", chatId: o.chatId };
    case "ack":
      return typeof o.to === "string" && typeof o.ref === "string" ? { t: "ack", to: o.to, chatId: o.chatId, ref: o.ref } : undefined;
    case "cmd": {
      if (typeof o.to !== "string" || typeof o.cmd !== "string" || !CMDS.includes(o.cmd)) return undefined;
      const m: ChatBusMsg = { t: "cmd", to: o.to, chatId: o.chatId, cmd: o.cmd as ChatCmd };
      if (typeof o.seq === "number") m.seq = o.seq;
      if (typeof o.from === "string") m.from = o.from;
      if (typeof o.ref === "string") m.ref = o.ref;
      if (typeof o.args === "object" && o.args !== null && !Array.isArray(o.args)) m.args = o.args as Record<string, unknown>;
      return m;
    }
    default:
      return undefined;
  }
}

/** Replicas in one process (tests): every subscriber gets every message, in publish order. */
export class MemoryChatBus implements ChatBus {
  private readonly subs = new Set<(m: ChatBusMsg) => void>();
  private readonly reconnects = new Set<() => void>();
  /** Tests set this to drop messages. */
  drop?: (m: ChatBusMsg) => boolean;

  /** Tests call this to model a LISTEN reconnect. */
  simulateReconnect(): void {
    for (const h of [...this.reconnects]) h();
  }

  onReconnect(h: () => void): () => void {
    this.reconnects.add(h);
    return () => void this.reconnects.delete(h);
  }

  async publish(m: ChatBusMsg): Promise<void> {
    checkSize(m);
    if (this.drop?.(m)) return;
    const copy = structuredClone(m);
    for (const h of [...this.subs]) queueMicrotask(() => h(structuredClone(copy)));
  }

  async subscribe(h: (m: ChatBusMsg) => void): Promise<() => Promise<void>> {
    this.subs.add(h);
    return async () => void this.subs.delete(h);
  }
}

/** Postgres LISTEN/NOTIFY. One shared LISTEN connection serves the whole process. */
export class PgChatBus implements ChatBus {
  constructor(
    private readonly sql: SQL,
    private readonly listener: PgListener,
  ) {}

  async publish(m: ChatBusMsg): Promise<void> {
    checkSize(m);
    const payload = JSON.stringify(m);
    await this.sql`SELECT pg_notify(${CHAT_CHANNEL}, ${payload})`;
  }

  onReconnect(h: () => void): () => void {
    return this.listener.onReconnect?.(h) ?? (() => undefined);
  }

  async subscribe(h: (m: ChatBusMsg) => void): Promise<() => Promise<void>> {
    return this.listener.listen(CHAT_CHANNEL, (payload) => {
      const m = parseBusMsg(payload);
      if (m) h(m);
    });
  }
}
