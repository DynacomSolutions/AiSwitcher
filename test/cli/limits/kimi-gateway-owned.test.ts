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
