import { describe, expect, test } from "bun:test";
import { consumeCodexResetForIdentity } from "../../src/gateway/account.ts";

const RESET_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const IDENTITY = "codex-SYNTHETIC_FIXTURE-member";

describe("Codex reset spend", () => {
  test("checks then consumes once with the exact stored member credential", async () => {
    const calls: Array<{ url: string; method: string; auth: string | null; account: string | null; body?: string }> = [];
    const out = await consumeCodexResetForIdentity(IDENTITY, {
      creds: { get: async (provider: string, identity: string) => {
        expect(provider).toBe("codex");
        expect(identity).toBe(IDENTITY);
        return { identity, accessToken: "access-SYNTHETIC_FIXTURE_member", accountId: "account-SYNTHETIC_FIXTURE_member" };
      } },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(input), method: init?.method ?? "GET", auth: headers.get("authorization"), account: headers.get("chatgpt-account-id"), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
        return calls.length === 1 ? Response.json({ available_count: 1 }) : Response.json({ ok: true });
      }) as typeof fetch,
    } as never);
    expect(out).toEqual({ identity: IDENTITY });
    expect(calls).toEqual([
      { url: RESET_URL, method: "GET", auth: "Bearer access-SYNTHETIC_FIXTURE_member", account: "account-SYNTHETIC_FIXTURE_member" },
      { url: `${RESET_URL}/consume`, method: "POST", auth: "Bearer access-SYNTHETIC_FIXTURE_member", account: "account-SYNTHETIC_FIXTURE_member", body: "{}" },
    ]);
  });

  test("a fresh zero blocks the POST", async () => {
    const calls: string[] = [];
    await expect(consumeCodexResetForIdentity(IDENTITY, {
      creds: { get: async () => ({ identity: IDENTITY, accessToken: "access-SYNTHETIC_FIXTURE_member" }) },
      fetch: (async (input: string | URL | Request) => { calls.push(String(input)); return Response.json({ available_count: 0 }); }) as typeof fetch,
    } as never)).rejects.toThrow("no available reset credits");
    expect(calls).toEqual([RESET_URL]);
  });

  test("an ambiguous consume failure is never retried", async () => {
    let posts = 0;
    await expect(consumeCodexResetForIdentity(IDENTITY, {
      creds: { get: async () => ({ identity: IDENTITY, accessToken: "access-SYNTHETIC_FIXTURE_member" }) },
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") { posts++; throw new Error("synthetic connection reset"); }
        return Response.json({ available_count: 1 });
      }) as typeof fetch,
    } as never)).rejects.toThrow("outcome is unknown");
    expect(posts).toBe(1);
  });
});
