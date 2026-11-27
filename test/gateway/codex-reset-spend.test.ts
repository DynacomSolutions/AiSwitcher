import { describe, expect, test } from "bun:test";
import { checkCodexRedemptionFence } from "../../src/gateway/pool-reset.ts";
import { consumeCodexResetForIdentity } from "../../src/gateway/account.ts";

const RESET_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const IDENTITY = "codex-SYNTHETIC_FIXTURE-member";
const REQUEST_ID = crypto.randomUUID();

describe("Codex reset spend", () => {
  test("checks then consumes once with the official typed response and exact stored member credential", async () => {
    const calls: Array<{ url: string; method: string; auth: string | null; account: string | null; body?: string }> = [];
    const out = await consumeCodexResetForIdentity(IDENTITY, REQUEST_ID, {
      creds: { get: async (provider: string, identity: string) => {
        expect(provider).toBe("codex");
        expect(identity).toBe(IDENTITY);
        return { identity, accessToken: "access-SYNTHETIC_FIXTURE_member", accountId: "account-SYNTHETIC_FIXTURE_member" };
      } },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(input), method: init?.method ?? "GET", auth: headers.get("authorization"), account: headers.get("chatgpt-account-id"), ...(typeof init?.body === "string" ? { body: init.body } : {}) });
        return calls.length === 1 ? Response.json({ available_count: 1 }) : Response.json({ code: "reset", windows_reset: 2, credit: { id: "ignored" } });
      }) as typeof fetch,
    } as never);
    expect(out).toEqual({ identity: IDENTITY, result: "reset", windowsReset: 2 });
    expect(calls).toEqual([
      { url: RESET_URL, method: "GET", auth: "Bearer access-SYNTHETIC_FIXTURE_member", account: "account-SYNTHETIC_FIXTURE_member" },
      { url: `${RESET_URL}/consume`, method: "POST", auth: "Bearer access-SYNTHETIC_FIXTURE_member", account: "account-SYNTHETIC_FIXTURE_member", body: JSON.stringify({ redeem_request_id: REQUEST_ID }) },
    ]);
  });

  test("an invalid inventory cannot be interpreted as a known zero", async () => {
    const calls: string[] = [];
    await expect(consumeCodexResetForIdentity(IDENTITY, crypto.randomUUID(), {
      creds: { get: async () => ({ identity: IDENTITY, accessToken: "access-SYNTHETIC_FIXTURE_member" }) },
      fetch: (async (input: string | URL | Request) => { calls.push(String(input)); return Response.json({}); }) as typeof fetch,
    } as never)).rejects.toThrow("could not be verified");
    expect(calls).toEqual([RESET_URL]);
  });

  test.each([
    ["reset", "reset"],
    ["nothing_to_reset", "nothing_to_reset"],
    ["no_credit", "no_credit"],
    ["already_redeemed", "already_redeemed"],
  ] as const)("reports the provider outcome %s when the provider omits the window count", async (code, result) => {
    const out = await consumeCodexResetForIdentity(IDENTITY, crypto.randomUUID(), {
      creds: { get: async () => ({ identity: IDENTITY, accessToken: "access-SYNTHETIC_FIXTURE_member" }) },
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => init?.method === "POST" ? Response.json({ code }) : Response.json({ available_count: 1 })) as typeof fetch,
    } as never);
    expect(out).toEqual({ identity: IDENTITY, result, windowsReset: 0 });
  });

  test.each([undefined, {}, { code: "reset", windows_reset: null }, { code: "reset", windows_reset: "1" }, { code: "reset", windows_reset: -1 }])("rejects malformed or empty consume response %j", async (body) => {
    await expect(consumeCodexResetForIdentity(IDENTITY, crypto.randomUUID(), {
      creds: { get: async () => ({ identity: IDENTITY, accessToken: "access-SYNTHETIC_FIXTURE_member" }) },
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => init?.method === "POST" ? new Response(body === undefined ? "" : JSON.stringify(body)) : Response.json({ available_count: 1 })) as typeof fetch,
    } as never)).rejects.toThrow("outcome is unknown");
  });

  test("an ambiguous consume failure is never retried", async () => {
    let posts = 0;
    await expect(consumeCodexResetForIdentity(IDENTITY, crypto.randomUUID(), {
      creds: { get: async () => ({ identity: IDENTITY, accessToken: "access-SYNTHETIC_FIXTURE_member" }) },
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") { posts++; throw new Error("synthetic connection reset"); }
        return Response.json({ available_count: 1 });
      }) as typeof fetch,
    } as never)).rejects.toThrow("outcome is unknown");
    expect(posts).toBe(1);
  });

  test.each(["GET", "POST"])("preserves a provider 403 on %s", async (refusedMethod) => {
    let posts = 0;
    try {
      await consumeCodexResetForIdentity(IDENTITY, crypto.randomUUID(), {
        creds: { get: async () => ({ identity: IDENTITY, accessToken: "access-SYNTHETIC_FIXTURE_member" }) },
        fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
          if (init?.method === "POST") posts++;
          if (init?.method === refusedMethod) return new Response("forbidden", { status: 403 });
          return Response.json({ available_count: 1 });
        }) as typeof fetch,
      } as never);
      throw new Error("expected provider refusal");
    } catch (error) {
      expect((error as { status?: number }).status).toBe(403);
    }
    expect(posts).toBe(refusedMethod === "POST" ? 1 : 0);
  });
});

test("the legacy Console consume checks locked inventory against retained pool attempts", async () => {
  const creditId = "credit-SYNTHETIC_FIXTURE-fenced";
  let any = true;
  let pending = false;
  let inventory: unknown = { available_count: 1, credits: [{ id: creditId, status: "available" }] };
  let posts = 0;
  const consume = () => consumeCodexResetForIdentity(IDENTITY, REQUEST_ID, {
    creds: { get: async () => ({ identity: IDENTITY, accessToken: "access-SYNTHETIC_FIXTURE_member" }), refreshAfter401: async () => { throw new Error("unexpected refresh"); } },
    fetch: (async (_input, init) => {
      if (init?.method !== "POST") return Response.json(inventory);
      posts++;
      expect(JSON.parse(String(init.body))).toEqual({ redeem_request_id: REQUEST_ID });
      return Response.json({ code: "reset" });
    }) as typeof fetch,
  }, undefined, (identity, context) => checkCodexRedemptionFence({
    usedCredits: async (ids) => new Set(ids.filter((id) => id === creditId)),
    accountOutcomePending: async () => pending,
    inventoryFenceScope: async () => ({ any, relevant: any }),
  }, identity, context));

  await expect(consume()).rejects.toThrow("already attempted");
  inventory = { available_count: 1 };
  await expect(consume()).rejects.toThrow("already attempted");
  expect(posts).toBe(0);
  any = false;
  pending = true;
  await expect(consume()).rejects.toThrow("unresolved outcome");
  expect(posts).toBe(0);
  pending = false;
  expect(await consume()).toMatchObject({ result: "reset" });
  expect(posts).toBe(1);
});

test("a cancelled legacy Console preflight cannot send a POST after its fence check", async () => {
  const controller = new AbortController();
  let posts = 0;
  const spend = consumeCodexResetForIdentity(IDENTITY, REQUEST_ID, {
    creds: { get: async () => ({ identity: IDENTITY, accessToken: "access-SYNTHETIC_FIXTURE_member" }), refreshAfter401: async () => { throw new Error("unexpected refresh"); } },
    signal: controller.signal,
    fetch: (async (_input, init) => {
      if (init?.method === "POST") posts++;
      return Response.json({ available_count: 1 });
    }) as typeof fetch,
  }, undefined, async () => controller.abort());
  await expect(spend).rejects.toThrow();
  expect(posts).toBe(0);
});
