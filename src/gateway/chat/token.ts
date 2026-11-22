import { createHmac, timingSafeEqual } from "node:crypto";

/** Start of every per-chat browser token. An agent token starts `aisg_`, so the two never clash. */
export const CHAT_TOKEN_HEAD = "aisc1.";

/** `gen` is the pod generation of the chat. A newer start or a failed start makes an older token useless. */
export interface ChatTokenClaims { chatId: string; binding: string; exp: number; gen: number }

/** The signing key, derived from the admin token so that no second secret needs storage. */
export function chatTokenKey(adminToken: string): Buffer {
  return createHmac("sha256", adminToken).update("ais-gateway-chat-token").digest();
}

const sign = (key: Buffer, payload: string): Buffer => createHmac("sha256", key).update(payload).digest();

/** `aisc1.<claims, base64url>.<signature, base64url>`. */
export function mintChatToken(key: Buffer, c: ChatTokenClaims): string {
  const payload = Buffer.from(JSON.stringify({ chatId: c.chatId, binding: c.binding, exp: c.exp, gen: c.gen })).toString("base64url");
  return `${CHAT_TOKEN_HEAD}${payload}.${sign(key, payload).toString("base64url")}`;
}

/** The claims of a token that is genuine and not expired, else undefined. Never throws. */
export function verifyChatToken(key: Buffer, token: string, nowMs: number): ChatTokenClaims | undefined {
  try {
    if (typeof token !== "string" || !token.startsWith(CHAT_TOKEN_HEAD)) return undefined;
    const parts = token.slice(CHAT_TOKEN_HEAD.length).split(".");
    if (parts.length !== 2) return undefined;
    const [payload, sig] = parts as [string, string];
    const given = Buffer.from(sig, "base64url");
    const expected = sign(key, payload);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    const c = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof c !== "object" || c === null) return undefined;
    const { chatId, binding, exp, gen } = c as Record<string, unknown>;
    if (typeof chatId !== "string" || chatId === "" || typeof binding !== "string" || binding === "") return undefined;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= nowMs) return undefined;
    if (typeof gen !== "number" || !Number.isSafeInteger(gen) || gen < 0) return undefined;
    return { chatId, binding, exp, gen };
  } catch {
    return undefined;
  }
}
