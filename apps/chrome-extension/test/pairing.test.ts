import { describe, expect, test } from "bun:test";
import { KEYS, pollPairing, saveGatewayUrl, startPairing, validateGatewayUrl } from "../src/background/pairing.ts";
import { FakeChrome } from "./fakes.ts";

const json = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

describe("gateway url", () => {
  test("requires wss except localhost", () => {
    expect(validateGatewayUrl("wss://gw.example.test/")).toBe("wss://gw.example.test");
    expect(validateGatewayUrl("ws://localhost:8080")).toBe("ws://localhost:8080");
    expect(validateGatewayUrl("ws://127.0.0.1:1")).toBe("ws://127.0.0.1:1");
    expect(() => validateGatewayUrl("ws://gw.example.test")).toThrow();
    expect(() => validateGatewayUrl("https://gw.example.test")).toThrow();
    expect(() => validateGatewayUrl("nonsense")).toThrow();
  });

  test("changing the URL clears the token, same URL keeps it", async () => {
    const chrome = new FakeChrome();
    await saveGatewayUrl(chrome.storage, "wss://a.example.test");
    chrome.store[KEYS.token] = "tok";
    chrome.store[KEYS.binding] = "b";
    await saveGatewayUrl(chrome.storage, "wss://a.example.test");
    expect(chrome.store[KEYS.token]).toBe("tok");
    await saveGatewayUrl(chrome.storage, "wss://b.example.test");
    expect(chrome.store[KEYS.token]).toBeUndefined();
    expect(chrome.store[KEYS.binding]).toBeUndefined();
  });
});

describe("pairing", () => {
  test("stores the token only after the poll succeeds", async () => {
    const chrome = new FakeChrome();
    const responses = [json(202), json(202), json(200, { binding: "mac", token: "secret", target: { kind: "identity", identity: "dyn" } })];
    const seen: string[] = [];
    const fetchFn = async (url: string) => {
      seen.push(url);
      if (url.endsWith("/browser/pair")) return json(200, { code: "ABCD2345", pollSecret: "ps", expiresAt: new Date(Date.now() + 60_000).toISOString() });
      expect(chrome.store[KEYS.token]).toBeUndefined();
      return responses.shift()!;
    };
    const start = await startPairing(fetchFn, "wss://gw.example.test", "Work");
    expect(start.code).toBe("ABCD2345");
    expect(seen[0]).toBe("https://gw.example.test/browser/pair");
    let sleeps = 0;
    const result = await pollPairing({ fetch: fetchFn, storage: chrome.storage, sleep: async ms => { expect(ms).toBe(2000); sleeps++; } }, "wss://gw.example.test", start);
    expect(sleeps).toBe(2);
    expect(result.binding).toBe("mac");
    expect(chrome.store[KEYS.token]).toBe("secret");
  });

  test("429 on poll backs off and keeps polling", async () => {
    const chrome = new FakeChrome();
    const responses = [json(429), json(200, { binding: "b", token: "t", target: { kind: "pool", pool: "p" } })];
    const sleeps: number[] = [];
    await pollPairing({ fetch: async () => responses.shift()!, storage: chrome.storage, sleep: async ms => { sleeps.push(ms); } }, "wss://gw.example.test", { code: "X", pollSecret: "p", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(sleeps).toEqual([4000]);
    expect(chrome.store[KEYS.token]).toBe("t");
  });

  test("expiry stores nothing", async () => {
    const chrome = new FakeChrome();
    const fetchFn = async () => json(410);
    await expect(pollPairing({ fetch: fetchFn, storage: chrome.storage, sleep: async () => {} }, "wss://gw.example.test", { code: "X", pollSecret: "p", expiresAt: "" })).rejects.toThrow(/expired/);
    expect(chrome.store[KEYS.token]).toBeUndefined();
  });
});
