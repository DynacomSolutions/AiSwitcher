import { afterEach, describe, expect, test } from "bun:test";
import { fetchWithRetry } from "../../../src/cli/limits/http.ts";

const realFetch = globalThis.fetch;
const realSleep = Bun.sleep;
const calls: Array<{ url: string }> = [];
const pauses: number[] = [];

function failWithTimes(failTimes: number, respond: () => Response): void {
  let n = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push({ url: String(url) });
    n++;
    if (n <= failTimes) throw new Error("The operation timed out.");
    return respond();
  }) as typeof fetch;
  // Collapse the real backoff pauses — the policy (which pauses, how many
  // attempts) is asserted separately via the recorded pauses.
  Bun.sleep = ((ms: number) => {
    pauses.push(ms);
    return Promise.resolve();
  }) as typeof Bun.sleep;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  Bun.sleep = realSleep;
  calls.length = 0;
  pauses.length = 0;
});

describe("fetchWithRetry", () => {
  test("retries a transient transport failure with BACKOFF and returns the response", async () => {
    failWithTimes(2, () => new Response("{}", { status: 200 }));
    const res = await fetchWithRetry("https://example.test/usage");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(pauses).toEqual([3_000, 8_000]);
  });

  test("does NOT retry HTTP error statuses — auth failures and rate limits mean what they say", async () => {
    failWithTimes(0, () => new Response("nope", { status: 401 }));
    const res = await fetchWithRetry("https://example.test/usage");
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(pauses).toEqual([]);
  });

  test("exhausting all attempts throws a diagnosable error naming the policy", async () => {
    failWithTimes(99, () => new Response("{}", { status: 200 }));
    await expect(fetchWithRetry("https://example.test/usage")).rejects.toThrow(
      /The operation timed out\. \(still failing after 3 attempts, 30s timeout each\)/,
    );
    expect(calls).toHaveLength(3);
    expect(pauses).toEqual([3_000, 8_000]);
  });
});
