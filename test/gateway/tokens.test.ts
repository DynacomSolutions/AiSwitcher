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

  test("a secret containing _ and - parses and verifies", async () => {
    const secret = `${"a_b-".repeat(10)}abc`; // 43 chars with both separators
    expect(secret.length).toBe(43);
    const prefix = "abcdefgh";
    const store = new MemoryGatewayStore();
    await store.putApp(app("a"));
    await store.addToken({ app: "a", prefix, hash: hashSecret(secret), createdAt: "2026-11-01T00:00:00.000Z" });
    const raw = `aisg_${prefix}_${secret}`;
    expect(parseToken(raw)).toEqual({ prefix, secret });
    expect(await verifyToken(store, "a", raw, new Date("2026-11-02T00:00:00.000Z"))).toBe(true);
  });

  test("parseToken pins the secret length to the generated 43 characters", () => {
    const t = generateToken();
    expect(parseToken(t.token)?.secret.length).toBe(43);
    expect(parseToken(`${t.token}x`)).toBeUndefined();
    expect(parseToken(t.token.slice(0, -1))).toBeUndefined();
  });

  test("an unparseable expiresAt counts as expired", async () => {
    const { store, t } = await seed("a");
    const now = new Date("2026-11-02T12:00:00.000Z");
    await store.expireTokens("a", "not-a-date");
    expect(await verifyToken(store, "a", t.token, now)).toBe(false);
  });

  test("a token for one app is rejected by another app, even with the same prefix", async () => {
    const store = new MemoryGatewayStore();
    await store.putApp(app("a"));
    await store.putApp(app("b"));
    const ta = generateToken();
    const tb = generateToken();
    // Force the same prefix on both apps.
    await store.addToken({ app: "a", prefix: "samepref", hash: ta.hash, createdAt: "2026-11-01T00:00:00.000Z" });
    await store.addToken({ app: "b", prefix: "samepref", hash: tb.hash, createdAt: "2026-11-01T00:00:00.000Z" });
    const rawA = `aisg_samepref_${parseToken(ta.token)!.secret}`;
    const rawB = `aisg_samepref_${parseToken(tb.token)!.secret}`;
    const now = new Date("2026-11-02T12:00:00.000Z");
    expect(await verifyToken(store, "a", rawA, now)).toBe(true);
    expect(await verifyToken(store, "b", rawB, now)).toBe(true);
    expect(await verifyToken(store, "b", rawA, now)).toBe(false);
    expect(await verifyToken(store, "a", rawB, now)).toBe(false);
    // Different prefixes too.
    expect(await verifyToken(store, "b", ta.token, now)).toBe(false);
  });

  test("verifyToken accepts current and in-overlap token, rejects expired, revoked app", async () => {
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

    expect(await verifyToken(store, "a", `${next.token}x`, now)).toBe(false);

    await store.revokeApp("a");
    expect(await verifyToken(store, "a", next.token, now)).toBe(false);
  });
});
