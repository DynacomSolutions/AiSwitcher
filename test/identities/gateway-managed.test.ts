import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATEWAY_REFRESH_TOOLS, isGatewayManagedHere, isGatewayServedTool, listGatewayManagedAccounts } from "../../src/identities/gateway-managed.ts";

describe("gateway ownership beyond claude", () => {
  let root: string;
  let registry: string;
  let saved: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ais-gw-managed-"));
    registry = join(root, "identities.json");
    await writeFile(registry, JSON.stringify({
      version: 1,
      identities: [
        { name: "live", label: "live", configDir: join(root, "live") },
        { name: "gone", label: "gone", configDir: join(root, "gone"), retired: true },
        { name: "pool", label: "pool", configDir: join(root, "pool"), swapPool: { accounts: ["live"], active: "live" } },
      ],
    }));
    saved = process.env.AIS_GATEWAY_OWNER;
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.AIS_GATEWAY_OWNER;
    else process.env.AIS_GATEWAY_OWNER = saved;
    await rm(root, { recursive: true, force: true });
  });

  test("codex, grok and kimi list their live, non-pool identities", async () => {
    for (const tool of ["codex", "grok", "kimi"]) {
      expect((await listGatewayManagedAccounts(registry, tool)).map((i) => i.name)).toEqual(["live"]);
    }
  });

  test("host and console processes skip them; the gateway owner role does not", async () => {
    for (const tool of ["codex", "grok", "kimi"]) {
      process.env.AIS_GATEWAY_OWNER = "0";
      expect(await isGatewayManagedHere(tool, "live", registry)).toBe(true);
      expect(await isGatewayManagedHere(tool, "gone", registry)).toBe(false);
      expect(await isGatewayManagedHere(tool, "pool", registry)).toBe(false);
      expect(await isGatewayManagedHere(tool, "unknown", registry)).toBe(false);
      process.env.AIS_GATEWAY_OWNER = "1";
      expect(await isGatewayManagedHere(tool, "live", registry)).toBe(false);
    }
  });

  test("a tool the gateway does not serve is never claimed", async () => {
    process.env.AIS_GATEWAY_OWNER = "0";
    for (const tool of ["zai", "ali", "opencode", "pi", "nonsense"]) {
      expect(isGatewayServedTool(tool)).toBe(false);
      expect(await listGatewayManagedAccounts(registry, tool)).toEqual([]);
      expect(await isGatewayManagedHere(tool, "live", registry)).toBe(false);
    }
    expect([...GATEWAY_REFRESH_TOOLS]).toEqual(["claude", "codex", "grok", "kimi"]);
  });

  test("an unreadable registry claims nothing", async () => {
    process.env.AIS_GATEWAY_OWNER = "0";
    expect(await isGatewayManagedHere("codex", "live", join(root, "missing.json"))).toBe(false);
  });
});

describe("nothing local refreshes a gateway-owned login", () => {
  test("a non-owner refresh of a codex or kimi member is skipped with no request", async () => {
    const { refreshIdentityOAuthGrant } = await import("../../src/identities/oauth-refresh.ts");
    const root = await mkdtemp(join(tmpdir(), "ais-gw-managed-r-"));
    const saved = process.env.AIS_GATEWAY_OWNER;
    try {
      const registry = join(root, "identities.json");
      const member = { name: "m", label: "m", configDir: join(root, "m") };
      await writeFile(registry, JSON.stringify({ version: 1, identities: [member] }));
      let posts = 0;
      const fetchImpl = (async () => { posts++; return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
      process.env.AIS_GATEWAY_OWNER = "0";
      for (const tool of ["codex", "kimi"] as const) {
        const r = await refreshIdentityOAuthGrant(tool, member, { force: true, poolRegistryPath: registry, fetchImpl });
        expect(r.outcome).toBe("skipped-fresh");
        expect(r.detail).toContain("owned by the cluster gateway");
      }
      expect(posts).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.AIS_GATEWAY_OWNER;
      else process.env.AIS_GATEWAY_OWNER = saved;
      await rm(root, { recursive: true, force: true });
    }
  });
});
