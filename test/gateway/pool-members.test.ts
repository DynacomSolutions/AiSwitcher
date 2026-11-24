import { describe, expect, test } from "bun:test";
import type { IdentitiesFile } from "../../src/identities/types.ts";
import { appPoolMemberNames } from "../../src/gateway/serve.ts";

const retired = { retired: true, retiredAt: "2026-11-01T00:00:00.000Z" };

describe("appPoolMemberNames", () => {
  test("a pool app uses only the swap pool's allowed members, never an account the pool does not list", () => {
    const file = {
      identities: [
        { name: "alpha", label: "alpha", configDir: "/x/alpha" },
        { name: "beta", label: "beta", configDir: "/x/beta", ...retired },
        { name: "team-pool", label: "team-pool", configDir: "/x/pool", swapPool: { accounts: ["alpha", "beta", "delta", "gamma-alias"], disallowed: ["delta"], active: "alpha" } },
        { name: "gamma", label: "gamma", configDir: "/x/gamma", aliases: ["gamma-alias"] },
        { name: "delta", label: "delta", configDir: "/x/delta" },
        { name: "kept-out", label: "kept-out", configDir: "/x/kept-out" },
      ],
    } as unknown as IdentitiesFile;
    // beta is retired, delta is disallowed, kept-out is in no pool; gamma is listed by its alias.
    expect(appPoolMemberNames(file)).toEqual(["alpha", "gamma"]);
  });

  test("members of every active swap pool count; a retired pool lists none", () => {
    const file = {
      identities: [
        { name: "alpha", label: "alpha", configDir: "/x/alpha" },
        { name: "gamma", label: "gamma", configDir: "/x/gamma" },
        { name: "omega", label: "omega", configDir: "/x/omega" },
        { name: "one", label: "one", configDir: "/x/one", swapPool: { accounts: ["alpha"] } },
        { name: "two", label: "two", configDir: "/x/two", swapPool: { accounts: ["gamma"] } },
        { name: "old", label: "old", configDir: "/x/old", swapPool: { accounts: ["omega"] }, ...retired },
      ],
    } as unknown as IdentitiesFile;
    expect(appPoolMemberNames(file)).toEqual(["alpha", "gamma"]);
  });

  test("with no swap pool, every real login that is not retired is a member", () => {
    const file = {
      identities: [
        { name: "alpha", label: "alpha", configDir: "/x/alpha" },
        { name: "beta", label: "beta", configDir: "/x/beta", ...retired },
        { name: "gamma", label: "gamma", configDir: "/x/gamma" },
      ],
    } as unknown as IdentitiesFile;
    expect(appPoolMemberNames(file)).toEqual(["alpha", "gamma"]);
  });
});
