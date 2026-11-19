import { describe, expect, test } from "bun:test";
import { poolsUsage } from "../../src/server/pools-usage.ts";

const period = { configured: true, rows: [] };
const base = {
  pools: async () => [{ tool: "claude", name: "pool", members: [{ name: "alpha", allowed: true }, { name: "beta", allowed: true }, { name: "gamma", allowed: true }] }],
  gateway: async () => period,
};

describe("poolsUsage member accounts", () => {
  test("adds the account and the shared-account list per member", async () => {
    const res = await poolsUsage({
      ...base,
      accounts: async () =>
        new Map([
          ["claude/alpha", { source: "gateway-member" as const, email: "alice@example.test", sharedWith: ["beta"] }],
          ["claude/beta", { source: "folder" as const, email: "alice@example.test", sharedWith: ["alpha"] }],
        ]),
    });
    const members = res.pools[0]!.members;
    expect(members[0]!.account?.email).toBe("alice@example.test");
    expect(members[0]!.account?.sharedWith).toEqual(["beta"]);
    expect(members[1]!.account?.sharedWith).toEqual(["alpha"]);
    expect(members[2]!.account).toBeUndefined();
  });

  test("a failed account read leaves the pools unchanged", async () => {
    const res = await poolsUsage({
      ...base,
      accounts: async () => {
        throw new Error("boom");
      },
    });
    expect(res.pools[0]!.members[0]).toEqual({ name: "alpha", allowed: true });
  });
});
