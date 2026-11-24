import { describe, expect, test } from "bun:test";
import type { IdentitiesFile } from "../../src/identities/types.ts";
import type { PoolUsage } from "../../src/identities/pool/adapter.ts";
import type { GatewayDeps } from "../../src/gateway/app.ts";
import { appPoolMemberNames, onlyManaged, poolManagementCheck } from "../../src/gateway/serve.ts";
import { pickIdentity } from "../../src/gateway/select.ts";
import type { GatewayApp } from "../../src/gateway/types.ts";

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

describe("appPoolMemberNames when the swap pools are retired", () => {
  test("a provider whose only swap pool is retired has no members, never every login", () => {
    const file = {
      identities: [
        { name: "alpha", label: "alpha", configDir: "/x/alpha" },
        { name: "gamma", label: "gamma", configDir: "/x/gamma" },
        { name: "old", label: "old", configDir: "/x/old", swapPool: { accounts: ["alpha", "gamma"] }, ...retired },
      ],
    } as unknown as IdentitiesFile;
    expect(appPoolMemberNames(file)).toEqual([]);
  });

  test("a registry with no swap pool at all (grok, say) keeps every login that is not retired", () => {
    const file = { identities: [{ name: "g1", label: "g1", configDir: "/x/g1" }, { name: "g2", label: "g2", configDir: "/x/g2" }] } as unknown as IdentitiesFile;
    expect(appPoolMemberNames(file)).toEqual(["g1", "g2"]);
  });

  test("an active swap pool still gives its allowed members next to a retired one", () => {
    const file = {
      identities: [
        { name: "alpha", label: "alpha", configDir: "/x/alpha" },
        { name: "gamma", label: "gamma", configDir: "/x/gamma" },
        { name: "live", label: "live", configDir: "/x/live", swapPool: { accounts: ["alpha", "gamma"], disallowed: ["gamma"] } },
        { name: "old", label: "old", configDir: "/x/old", swapPool: { accounts: ["gamma"] }, ...retired },
      ],
    } as unknown as IdentitiesFile;
    expect(appPoolMemberNames(file)).toEqual(["alpha"]);
  });

  test("a retired-only swap pool gives requests the no-identities answer", async () => {
    const file = { identities: [{ name: "alpha", label: "alpha", configDir: "/x/alpha" }, { name: "old", label: "old", configDir: "/x/old", swapPool: { accounts: ["alpha"] }, ...retired }] } as unknown as IdentitiesFile;
    const app: GatewayApp = { name: "pool", owner: "o", namespace: "n", provider: "claude", style: "anthropic", target: { kind: "pool" }, state: "active", createdAt: "2026-11-01T00:00:00.000Z" };
    const poolMembers = async (p: string) => onlyManaged(p, appPoolMemberNames(file), poolManagementCheck({} as GatewayDeps["creds"], async () => true));
    expect(await pickIdentity(app, { usageFor: async () => undefined, poolMembers })).toEqual({ reject: "no-identities" });
  });

  test("claude: the management gate and swap-pool membership together", async () => {
    const file = {
      identities: [
        { name: "member", label: "member", configDir: "/x/member" },
        { name: "unmanaged", label: "unmanaged", configDir: "/x/unmanaged" },
        { name: "outside", label: "outside", configDir: "/x/outside" },
        { name: "team-pool", label: "team-pool", configDir: "/x/pool", swapPool: { accounts: ["member", "unmanaged"] } },
      ],
    } as unknown as IdentitiesFile;
    const isManaged = async (_t: string, id: string) => id !== "unmanaged";
    expect(await onlyManaged("claude", appPoolMemberNames(file), poolManagementCheck({} as GatewayDeps["creds"], isManaged))).toEqual(["member"]);
  });
});

describe("the pool management gate", () => {
  // "guest" is in the registry but not gateway-managed (no gateway copy); "member" is managed.
  const file = {
    identities: [
      { name: "member", label: "member", configDir: "/x/member" },
      { name: "guest", label: "guest", configDir: "/x/guest" },
    ],
  } as unknown as IdentitiesFile;
  const live = (u: number): PoolUsage => ({ status: "live", maxUtilization: u, capturedAt: "2026-11-24T00:00:00.000Z" });
  const opencodePool: GatewayApp = {
    name: "pool", owner: "o", namespace: "n", provider: "opencode", style: "openai",
    target: { kind: "pool" }, state: "active", createdAt: "2026-11-01T00:00:00.000Z",
  };
  // The gateway holds a credential copy for "member" only, so the probe reports "guest" as logged out / absent.
  const creds = { loggedOut: async (_p: string, id: string) => id === "guest" } as unknown as GatewayDeps["creds"];

  test("an unmanaged identity present in the registry is excluded, even on a gateway with no management check", async () => {
    const names = appPoolMemberNames(file);
    expect(names).toEqual(["member", "guest"]);
    // No isManaged passed: an unmanaged gateway. The opencode gate still drops the identity with no gateway copy.
    const kept = await onlyManaged("opencode", names, poolManagementCheck(creds));
    expect(kept).toEqual(["member"]);
  });

  test("pool selection never offers the unmanaged identity, on the known or the unknown path", async () => {
    const poolMembers = async (p: string) => onlyManaged(p, appPoolMemberNames(file), poolManagementCheck(creds));
    // The managed member is full and the unmanaged one has no figure: without the gate the unknown fallback would pick it.
    const deps = { usageFor: async (_p: string, id: string) => (id === "member" ? live(100) : undefined), poolMembers };
    expect(await pickIdentity(opencodePool, deps)).toEqual({ reject: "no-headroom" });
    // With headroom on the managed member, it is chosen and the unmanaged one is never a candidate.
    const headroom = { usageFor: async (_p: string, id: string) => (id === "member" ? live(10) : undefined), poolMembers };
    expect(await pickIdentity(opencodePool, headroom)).toEqual({ identity: "member" });
  });

  test("the refresh management check still decides for a refresh tool", async () => {
    const isManaged = async (_tool: string, id: string) => id === "member";
    const kept = await onlyManaged("claude", ["member", "guest"], poolManagementCheck(creds, isManaged));
    expect(kept).toEqual(["member"]);
  });

  test("a probe error keeps the member (fail-open), never silently dropping a healthy login", async () => {
    const failing = { loggedOut: async () => { throw new Error("probe blew up"); } } as unknown as GatewayDeps["creds"];
    const kept = await onlyManaged("opencode", ["member", "guest"], poolManagementCheck(failing));
    expect(kept).toEqual(["member", "guest"]);
  });
});

describe("swap-pool membership and the management gates together", () => {
  const file = {
    identities: [
      { name: "member", label: "member", configDir: "/x/member" },
      { name: "dead", label: "dead", configDir: "/x/dead" },
      { name: "outside", label: "outside", configDir: "/x/outside" },
      { name: "team-pool", label: "team-pool", configDir: "/x/pool", swapPool: { accounts: ["member", "dead"], disallowed: [], active: "member" } },
    ],
  } as unknown as IdentitiesFile;
  const live = (u: number): PoolUsage => ({ status: "live", maxUtilization: u, capturedAt: "2026-11-24T00:00:00.000Z" });
  const app: GatewayApp = {
    name: "pool", owner: "o", namespace: "n", provider: "opencode", style: "openai",
    target: { kind: "pool" }, state: "active", createdAt: "2026-11-01T00:00:00.000Z",
  };
  const creds = { loggedOut: async (_p: string, id: string) => id === "dead" } as unknown as GatewayDeps["creds"];
  const poolMembers = async (p: string) => onlyManaged(p, appPoolMemberNames(file), poolManagementCheck(creds));

  test("a member outside the swap pool and a dead swap-pool member are never picked", async () => {
    expect(await poolMembers("opencode")).toEqual(["member"]);
    // The outside and dead accounts have the most headroom (or no figure), yet only the live pool member can win.
    const usageFor = async (_p: string, id: string) => (id === "member" ? live(90) : id === "outside" ? live(1) : undefined);
    expect(await pickIdentity(app, { usageFor, poolMembers })).toEqual({ identity: "member" });
  });

  test("a full live member rejects the request rather than falling back to an outside or dead account", async () => {
    const usageFor = async (_p: string, id: string) => (id === "member" ? live(100) : undefined);
    expect(await pickIdentity(app, { usageFor, poolMembers })).toEqual({ reject: "no-headroom" });
  });
});
