import { expect, test } from "bun:test";
import type { AgentTokenRecord, BrowserBinding, BrowserPairing } from "../../src/browser/types.ts";
import type { GatewayStore } from "../../src/gateway/store.ts";

const binding: BrowserBinding = {
  name: "work-laptop",
  target: { kind: "pool", pool: "main" },
  profileLabel: "Work",
  state: "active",
  createdAt: "2026-11-04T00:00:00.000Z",
};

const pairing: BrowserPairing = {
  code: "ABCD-1234",
  profileLabel: "Work",
  createdAt: "2026-11-04T00:00:00.000Z",
  expiresAt: "2020-01-01T00:00:00.000Z",
  pollSecretHash: "ab".repeat(32),
};

export function browserStoreContract(make: () => Promise<GatewayStore>): void {
  test("binding round-trips and lists", async () => {
    const s = await make();
    expect(await s.getBrowserBinding("work-laptop")).toBeUndefined();
    await s.putBrowserBinding(binding);
    expect(await s.getBrowserBinding("work-laptop")).toEqual(binding);
    const withSeen: BrowserBinding = {
      ...binding,
      name: "home",
      target: { kind: "identity", identity: "id1" },
      lastSeenAt: "2026-11-04T01:00:00.000Z",
    };
    await s.putBrowserBinding(withSeen);
    expect(await s.getBrowserBinding("home")).toEqual(withSeen);
    expect((await s.listBrowserBindings()).map((b) => b.name).sort()).toEqual(["home", "work-laptop"]);
  });

  test("revokeBrowserBinding sets state revoked", async () => {
    const s = await make();
    await s.putBrowserBinding(binding);
    await s.revokeBrowserBinding("work-laptop");
    expect((await s.getBrowserBinding("work-laptop"))?.state).toBe("revoked");
  });

  test("browser tokens store prefix and hash per binding", async () => {
    const s = await make();
    await s.putBrowserBinding(binding);
    await s.addBrowserToken("work-laptop", "pre1", "hash1");
    const toks = await s.browserTokensFor("work-laptop");
    expect(toks).toHaveLength(1);
    expect(toks[0]).toMatchObject({ app: "work-laptop", prefix: "pre1", hash: "hash1" });
    expect(await s.browserTokensFor("other")).toEqual([]);
  });

  test("claimPairing returns the pairing once", async () => {
    const s = await make();
    await s.putPairing(pairing);
    expect(await s.claimPairing(pairing.code)).toEqual(pairing);
    expect(await s.claimPairing(pairing.code)).toBeUndefined();
    expect(await s.getPairing(pairing.code)).toBeUndefined();
  });

  test("browser token is found by prefix", async () => {
    const s = await make();
    await s.putBrowserBinding(binding);
    await s.addBrowserToken("work-laptop", "abcdefgh", "ff".repeat(32));
    expect(await s.browserTokenByPrefix("abcdefgh")).toMatchObject({ app: "work-laptop", prefix: "abcdefgh", hash: "ff".repeat(32) });
    expect(await s.browserTokenByPrefix("zzzzzzzz")).toBeUndefined();
  });

  test("pairing round-trips, expired is still readable, delete removes", async () => {
    const s = await make();
    await s.putPairing(pairing);
    expect(await s.getPairing("ABCD-1234")).toEqual(pairing);
    const approved: BrowserPairing = { ...pairing, approvedBinding: "work-laptop" };
    await s.putPairing(approved);
    expect(await s.getPairing("ABCD-1234")).toEqual(approved);
    await s.deletePairing("ABCD-1234");
    expect(await s.getPairing("ABCD-1234")).toBeUndefined();
  });

  test("agent token lookup by prefix, gone after revoke", async () => {
    const s = await make();
    const rec: AgentTokenRecord = { identity: "id1", prefix: "agp1", hash: "h", createdAt: "2026-11-04T00:00:00.000Z" };
    await s.addAgentToken(rec);
    await s.addAgentToken({ ...rec, identity: "id2", prefix: "agp2" });
    expect(await s.agentTokenByPrefix("agp1")).toEqual(rec);
    await s.revokeAgentTokens("id1");
    expect(await s.agentTokenByPrefix("agp1")).toBeUndefined();
    expect((await s.agentTokenByPrefix("agp2"))?.identity).toBe("id2");
  });
}
