import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { CHAT_TOKEN_HEAD, chatTokenKey, mintChatToken, verifyChatToken } from "../../src/gateway/chat/token.ts";
import { ChatGrants } from "../../src/gateway/browser/chat-grants.ts";

const key = chatTokenKey("admin-secret");
const claims = { chatId: "c1", binding: "b1", exp: 2_000_000, gen: 1 };
const now = 1_000_000;

describe("chat token", () => {
  test("a fresh token returns its claims", () => {
    const t = mintChatToken(key, claims);
    expect(t.startsWith(CHAT_TOKEN_HEAD)).toBe(true);
    expect(verifyChatToken(key, t, now)).toEqual(claims);
  });

  test("a flipped signature byte fails", () => {
    const t = mintChatToken(key, claims);
    const [head, sig] = [t.slice(0, t.lastIndexOf(".") + 1), t.slice(t.lastIndexOf(".") + 1)];
    const raw = Buffer.from(sig, "base64url");
    raw[0] = (raw[0] ?? 0) ^ 1;
    expect(verifyChatToken(key, head + raw.toString("base64url"), now)).toBeUndefined();
  });

  test("a token without a valid generation fails", () => {
    for (const gen of [undefined, -1, 1.5, "1"]) {
      const payload = Buffer.from(JSON.stringify({ ...claims, gen })).toString("base64url");
      const sig = createHmac("sha256", key).update(payload).digest("base64url");
      expect(verifyChatToken(key, `${CHAT_TOKEN_HEAD}${payload}.${sig}`, now)).toBeUndefined();
    }
  });

  test("another key fails", () => {
    expect(verifyChatToken(chatTokenKey("other"), mintChatToken(key, claims), now)).toBeUndefined();
  });

  test("an expired token fails", () => {
    expect(verifyChatToken(key, mintChatToken(key, { ...claims, exp: now }), now)).toBeUndefined();
    expect(verifyChatToken(key, mintChatToken(key, { ...claims, exp: now - 1 }), now)).toBeUndefined();
  });

  test("a changed binding with the old signature fails", () => {
    const t = mintChatToken(key, claims);
    const sig = t.slice(t.lastIndexOf(".") + 1);
    const payload = Buffer.from(JSON.stringify({ ...claims, binding: "b2" })).toString("base64url");
    expect(verifyChatToken(key, `${CHAT_TOKEN_HEAD}${payload}.${sig}`, now)).toBeUndefined();
  });

  test("a signature of the wrong length returns undefined without throwing", () => {
    const t = mintChatToken(key, claims);
    expect(verifyChatToken(key, `${t}AA`, now)).toBeUndefined();
    expect(verifyChatToken(key, t.slice(0, -4), now)).toBeUndefined();
    expect(verifyChatToken(key, `${CHAT_TOKEN_HEAD}x`, now)).toBeUndefined();
    expect(verifyChatToken(key, "aisg_nope_nope", now)).toBeUndefined();
    expect(verifyChatToken(key, "", now)).toBeUndefined();
  });
});

describe("ChatGrants", () => {
  test("several chats may hold one tab and each grant ends on its own", () => {
    const g = new ChatGrants();
    g.set("a", [1, 2]);
    g.set("b", [2]);
    expect(g.allows("a", 2) && g.allows("b", 2)).toBe(true);
    expect(g.allows("b", 1)).toBe(false);
    g.delete("a");
    expect(g.allows("a", 2)).toBe(false);
    expect(g.allows("b", 2)).toBe(true);
    expect(g.get("a")).toBeUndefined();
  });
});
