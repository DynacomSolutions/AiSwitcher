import { afterEach, describe, expect, test } from "bun:test";
import { fetchWithRetry } from "../../../src/cli/limits/http.ts";

const realFetch = globalThis.fetch;
const calls: Array<{ url: string }> = [];

function failWithTimes(failTimes: number, respond: () => Response): void {
  let n = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push({ url: String(url) });
    n++;
    if (n <= failTimes) throw new Error("The operation timed out.");
    return respond();
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

describe("fetchWithRetry", () => {
  test("retries a transient transport failure once and returns the response", async () => {
    failWithTimes(1, () => new Response("{}", { status: 200 }));
    const res = await fetchWithRetry("https://example.test/usage");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("does NOT retry HTTP error statuses — auth failures and rate limits mean what they say", async () => {
    failWithTimes(0, () => new Response("nope", { status: 401 }));
    const res = await fetchWithRetry("https://example.test/usage");
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  test("exhausting both attempts throws a diagnosable error naming the attempts", async () => {
    failWithTimes(99, () => new Response("{}", { status: 200 }));
    await expect(fetchWithRetry("https://example.test/usage")).rejects.toThrow(
      /The operation timed out\. \(still failing after 2 attempts, 30s timeout each\)/,
    );
    expect(calls).toHaveLength(2);
  });
});
