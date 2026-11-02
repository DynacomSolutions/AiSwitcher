import { describe, expect, test } from "bun:test";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { generateToken, hashSecret, parseToken, verifyToken } from "../../src/gateway/tokens.ts";
import type { GatewayApp } from "../../src/gateway/types.ts";

function app(name: string): GatewayApp {
  return {
    name,
    owner: "o",
    namespace: "ns",
    provider: "claude",
    style: "anthropic",
    target: { kind: "pool" },
    state: "active",
    createdAt: "2026-11-01T00:00:00.000Z",
  };
}

async function seed(name: string) {
  const store = new MemoryGatewayStore();
  await store.putApp(app(name));
  const t = generateToken();
  await store.addToken({ app: name, prefix: t.prefix, hash: t.hash, createdAt: "2026-11-01T00:00:00.000Z" });
  return { store, t };
}

describe("tokens", () => {
  test("generated token round-trips through parseToken", () => {
    const t = generateToken();
    const parsed = parseToken(t.token);
    expect(parsed?.prefix).toBe(t.prefix);
    expect(t.prefix).toMatch(/^[a-z2-7]{8}$/);
    expect(hashSecret(parsed?.secret ?? "")).toBe(t.hash);
  });

  test("hash never equals secret and is 64 hex", () => {
    const t = generateToken();
    const secret = parseToken(t.token)?.secret ?? "";
    expect(t.hash).not.toBe(secret);
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("parseToken rejects aisg_ with missing parts", () => {
    expect(parseToken("aisg_")).toBeUndefined();
    expect(parseToken("aisg_abcdefgh")).toBeUndefined();
    expect(parseToken("aisg_abcdefgh_")).toBeUndefined();
    expect(parseToken("aisg_abc_secret")).toBeUndefined();
    expect(parseToken("other_abcdefgh_secret")).toBeUndefined();
  });

  test("verifyToken accepts current and in-overlap token, rejects expired, wrong app, revoked app", async () => {
    const { store, t } = await seed("a");
    const now = new Date("2026-11-02T12:00:00.000Z");
    expect(await verifyToken(store, "a", t.token, now)).toBe(true);

    // rotate: old token gets an expiry, new one added
    await store.expireTokens("a", "2026-11-02T13:00:00.000Z");
    const next = generateToken();
    await store.addToken({ app: "a", prefix: next.prefix, hash: next.hash, createdAt: now.toISOString() });
    expect(await verifyToken(store, "a", t.token, now)).toBe(true);
    expect(await verifyToken(store, "a", next.token, now)).toBe(true);
    expect(await verifyToken(store, "a", t.token, new Date("2026-11-02T13:00:00.000Z"))).toBe(false);
    expect(await verifyToken(store, "a", next.token, new Date("2026-11-03T00:00:00.000Z"))).toBe(true);

    expect(await verifyToken(store, "b", next.token, now)).toBe(false);
    expect(await verifyToken(store, "a", `${next.token}x`, now)).toBe(false);

    await store.revokeApp("a");
    expect(await verifyToken(store, "a", next.token, now)).toBe(false);
  });
});
