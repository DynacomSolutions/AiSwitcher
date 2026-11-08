import { afterEach, expect, test } from "bun:test";
import { fetchKimiUsageForCredentials } from "../../../src/cli/limits/kimi-limits.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a gateway-owned kimi login is never refreshed by the usage fetcher, even when expired", async () => {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input));
    return new Response("{}", { status: 401 });
  }) as unknown as typeof fetch;
  let persisted = 0;
  const outcome = await fetchKimiUsageForCredentials(
    { access_token: "at", refresh_token: "rt", expires_at: 1 } as never,
    async () => void (persisted += 1),
    { lockDir: "/nonexistent-lock-dir", gatewayManaged: true, reread: async () => undefined },
  );
  expect(persisted).toBe(0);
  expect(urls.every((u) => u.includes("/usages"))).toBe(true); // only the read, never the token endpoint
  expect(outcome.error).toBeDefined();
});

test("a 401 for a gateway-owned kimi login re-reads the store and retries once, then says the gateway owns it", async () => {
  const used: string[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string>).Authorization);
    used.push(auth);
    return auth === "Bearer at-new" ? new Response(JSON.stringify({ usage: {}, limits: [] }), { status: 200 }) : new Response("{}", { status: 401 });
  }) as unknown as typeof fetch;
  const ctx = (token: string) => ({ lockDir: "/nonexistent-lock-dir", gatewayManaged: true, reread: async () => ({ access_token: token, refresh_token: "rt" }) as never });
  const retried = await fetchKimiUsageForCredentials({ access_token: "at-old", refresh_token: "rt", expires_at: Date.now() / 1000 + 3600 } as never, async () => {}, ctx("at-new"));
  expect(used).toEqual(["Bearer at-old", "Bearer at-new"]);
  expect(retried.error ?? "").not.toContain("authentication rejected");
  used.length = 0;
  const stuck = await fetchKimiUsageForCredentials({ access_token: "at-old", refresh_token: "rt", expires_at: Date.now() / 1000 + 3600 } as never, async () => {}, ctx("at-old"));
  expect(used).toEqual(["Bearer at-old"]); // nothing newer to retry with
  expect(stuck.error).toContain("cluster gateway owns");
  expect(stuck.error).not.toContain("running `kimi`");
});
