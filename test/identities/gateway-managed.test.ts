import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEARTBEAT_FRESH_MS, writeHeartbeat } from "../../src/identities/gateway-heartbeat.ts";
import { GATEWAY_REFRESH_TOOLS, isGatewayManagedHere, isGatewayServedTool, listGatewayManagedAccounts } from "../../src/identities/gateway-managed.ts";

describe("gateway ownership beyond claude", () => {
  let root: string;
  let registry: string;
  let saved: string | undefined;
  let savedBeat: string | undefined;
  const beat = (ageMs: number, held: string[]) =>
    writeHeartbeat({ version: 1, passAt: new Date(Date.now() - ageMs).toISOString(), held: Object.fromEntries(held.map((k) => [k, {}])) });

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
    savedBeat = process.env.AIS_GATEWAY_HEARTBEAT;
    process.env.AIS_GATEWAY_HEARTBEAT = join(root, "heartbeat.json");
    await beat(1000, ["codex/live", "grok/live", "kimi/live", "codex/gone", "codex/pool"]);
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.AIS_GATEWAY_OWNER;
    else process.env.AIS_GATEWAY_OWNER = saved;
    if (savedBeat === undefined) delete process.env.AIS_GATEWAY_HEARTBEAT;
    else process.env.AIS_GATEWAY_HEARTBEAT = savedBeat;
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

  test("without a fresh heartbeat naming the login nothing is claimed", async () => {
    process.env.AIS_GATEWAY_OWNER = "0";
    await rm(process.env.AIS_GATEWAY_HEARTBEAT!);
    expect(await isGatewayManagedHere("codex", "live", registry)).toBe(false); // no heartbeat
    await beat(HEARTBEAT_FRESH_MS + 60_000, ["codex/live"]);
    expect(await isGatewayManagedHere("codex", "live", registry)).toBe(false); // stale
    await beat(1000, ["codex/other"]);
    expect(await isGatewayManagedHere("codex", "live", registry)).toBe(false); // fresh but does not name it
    expect(await isGatewayManagedHere("kimi", "live", registry)).toBe(false);
    await beat(1000, ["codex/live"]);
    expect(await isGatewayManagedHere("codex", "live", registry)).toBe(true); // fresh and names it
    expect(await isGatewayManagedHere("grok", "live", registry)).toBe(false); // names codex only
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
    const savedBeat = process.env.AIS_GATEWAY_HEARTBEAT;
    process.env.AIS_GATEWAY_HEARTBEAT = join(root, "heartbeat.json");
    await writeHeartbeat({ version: 1, passAt: new Date().toISOString(), held: { "codex/m": {}, "kimi/m": {} } });
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
      if (savedBeat === undefined) delete process.env.AIS_GATEWAY_HEARTBEAT;
      else process.env.AIS_GATEWAY_HEARTBEAT = savedBeat;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("an account moved into the gateway member store is the gateway's", () => {
  let root: string;
  let registry: string;
  const env: Record<string, string | undefined> = {};
  const keys = ["AIS_GATEWAY_OWNER", "AIS_GATEWAY_HEARTBEAT", "AIS_GATEWAY_MEMBERS_DIR"];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ais-gw-managed-store-"));
    registry = join(root, "identities.json");
    await writeFile(registry, JSON.stringify({
      version: 1,
      identities: [
        { name: "moved", label: "moved", configDir: join(root, "moved") },
        { name: "plain", label: "plain", configDir: join(root, "plain") },
        { name: "old", label: "old", configDir: join(root, "old"), retired: true },
      ],
    }));
    for (const k of keys) env[k] = process.env[k];
    process.env.AIS_GATEWAY_HEARTBEAT = join(root, "no-heartbeat.json"); // no heartbeat at all
    process.env.AIS_GATEWAY_MEMBERS_DIR = join(root, "members");
    for (const [tool, file] of [["claude", ".credentials.json"], ["codex", "auth.json"]] as const) {
      for (const name of ["moved", "old"]) {
        await mkdir(join(root, "members", tool, name), { recursive: true });
        const login = tool === "claude" ? { claudeAiOauth: { accessToken: "a", refreshToken: "SYNTHETIC_FIXTURE-r" } } : { tokens: { access_token: "a", refresh_token: "SYNTHETIC_FIXTURE-r" } };
        await writeFile(join(root, "members", tool, name, file), JSON.stringify(login));
      }
    }
  });
  afterEach(async () => {
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    await rm(root, { recursive: true, force: true });
  });

  test("claimed by every non-owner process without a heartbeat; never by the gateway itself", async () => {
    process.env.AIS_GATEWAY_OWNER = "0";
    for (const tool of ["claude", "codex"]) {
      expect(await isGatewayManagedHere(tool, "moved", registry)).toBe(true);
      expect(await isGatewayManagedHere(tool, "plain", registry)).toBe(false);
    }
    process.env.AIS_GATEWAY_OWNER = "1";
    expect(await isGatewayManagedHere("claude", "moved", registry)).toBe(false);
  });

  test("an empty or token-less store file left by a crash does not make the account the gateway's", async () => {
    process.env.AIS_GATEWAY_OWNER = "0";
    await writeFile(join(root, "members", "codex", "moved", "auth.json"), "");
    await writeFile(join(root, "members", "claude", "moved", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "" } }));
    for (const tool of ["claude", "codex"]) expect(await isGatewayManagedHere(tool, "moved", registry)).toBe(false);
  });

  test("claude lists a moved account even outside a gateway-routed pool (retired ones excluded)", async () => {
    expect((await listGatewayManagedAccounts(registry, "claude")).map((i) => i.name)).toEqual(["moved"]);
  });

  test("a non-owner refresh of a moved claude account is skipped with no request", async () => {
    const { refreshIdentityOAuthGrant } = await import("../../src/identities/oauth-refresh.ts");
    process.env.AIS_GATEWAY_OWNER = "0";
    let posts = 0;
    const fetchImpl = (async () => { posts++; return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
    const r = await refreshIdentityOAuthGrant("claude", { name: "moved", label: "moved", configDir: join(root, "moved") }, { force: true, claudeRegistryPath: registry, fetchImpl });
    expect(r.outcome).toBe("skipped-fresh");
    expect(posts).toBe(0);
  });
});
