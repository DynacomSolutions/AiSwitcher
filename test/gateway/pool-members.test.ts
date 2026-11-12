import { describe, expect, test } from "bun:test";
import type { IdentitiesFile } from "../../src/identities/types.ts";
import { appPoolMemberNames } from "../../src/gateway/serve.ts";

describe("appPoolMemberNames", () => {
  test("an unrestricted pool app never gets a swap pool or a retired identity as a member", () => {
    const file = {
      identities: [
        { name: "alpha", label: "alpha", configDir: "/x/alpha" },
        { name: "beta", label: "beta", configDir: "/x/beta", retired: true, retiredAt: "2026-11-01T00:00:00.000Z" },
        { name: "team-pool", label: "team-pool", configDir: "/x/pool", swapPool: { accounts: ["alpha"], active: "alpha" } },
        { name: "gamma", label: "gamma", configDir: "/x/gamma" },
      ],
    } as unknown as IdentitiesFile;
    expect(appPoolMemberNames(file)).toEqual(["alpha", "gamma"]);
  });
});
