import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayEntryText, isGatewayBaseUrl, isGatewayRoutedDir } from "../../src/identities/claude-gateway-entry.ts";
import { performSwap, readSwapEvents } from "../../src/identities/claude-swap.ts";
import { convergeClaudePoolStores, effectiveGrantPaths, poolStoreDirsFor, readEffectiveGrant } from "../../src/identities/oauth-refresh.ts";
import { claudeAdapter } from "../../src/identities/pool/claude-adapter.ts";
import { readProviderGrantCopy } from "../../src/identities/oauth-reconcile.ts";
import type { IdentitiesFile } from "../../src/identities/types.ts";

// All tokens are short synthetic strings built for this test only.
const GW = "aisg_SYNTHETIC_FIXTURE_gateway_token_0001";
const NOW_S = 1_800_000_000;
const dirs: string[] = [];
let root = "";
let registry = "";
let ledger = "";
let origSecrets: string | undefined;

const cred = (access: string, refresh: string, expiresAtS: number) =>
  JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: expiresAtS * 1000, scopes: ["x"] } });
const claudeJson = (uuid: string) => JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@example.com` }, theme: "dark" });
const read = async (p: string) => JSON.parse(await readFile(p, "utf8"));
const poolDir = () => join(root, "pool");

async function seed(name: string, access: string, refresh: string, exp: number) {
  const d = join(root, name);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, ".credentials.json"), cred(access, refresh, exp));
  await writeFile(join(d, ".claude.json"), claudeJson(`uuid-${name}`));
}

async function writeRegistry() {
  const file: IdentitiesFile = {
    version: 1,
    identities: [
      { name: "a", label: "a", configDir: join(root, "a") },
      { name: "b", label: "b", configDir: join(root, "b") },
      { name: "pool", label: "pool", configDir: poolDir(), swapPool: { accounts: ["a", "b"], active: "a" } },
    ],
  };
  await writeFile(registry, JSON.stringify(file));
}

const routeThroughProxy = () => writeFile(join(poolDir(), "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:47140/claude" }, model: "opus" }));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ais-gw-entry-"));
  dirs.push(root);
  registry = join(root, "identities.json");
  ledger = join(root, "ledger.jsonl");
  origSecrets = process.env.AIS_SECRETS_FILE;
  process.env.AIS_SECRETS_FILE = join(root, "secrets");
  await writeFile(join(root, "secrets"), `AIS_GATEWAY_APP_AGENTS_CLAUDE_TOKEN=${GW}\n`, { mode: 0o600 });
  await seed("a", "at-a1", "rt-a1", NOW_S + 1000);
  await seed("b", "at-b1", "rt-b1", NOW_S + 2000);
  await mkdir(poolDir(), { recursive: true });
  await writeFile(join(poolDir(), ".credentials.json"), cred("at-a1", "rt-a1", NOW_S + 1000));
  await writeFile(join(poolDir(), ".claude.json"), claudeJson("uuid-a"));
  await writeRegistry();
});
afterEach(async () => {
  if (origSecrets === undefined) delete process.env.AIS_SECRETS_FILE;
  else process.env.AIS_SECRETS_FILE = origSecrets;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("gateway routing detection", () => {
  test("local proxy and cluster gateway origins are gateway base URLs; others are not", () => {
    expect(isGatewayBaseUrl("http://127.0.0.1:47140/claude")).toBe(true);
    expect(isGatewayBaseUrl("http://localhost:47140")).toBe(true);
    expect(isGatewayBaseUrl("http://127.0.0.1:9999/claude")).toBe(false);
    expect(isGatewayBaseUrl("https://api.example.com")).toBe(false);
    expect(isGatewayBaseUrl("https://gw.example.net/agents-claude", { remoteBase: "https://gw.example.net" })).toBe(true);
    expect(isGatewayBaseUrl("not a url")).toBe(false);
    expect(isGatewayBaseUrl(undefined)).toBe(false);
  });

  test("a pool folder is routed by its settings or by holding the gateway entry", async () => {
    expect(await isGatewayRoutedDir(poolDir())).toBe(false);
    await routeThroughProxy();
    expect(await isGatewayRoutedDir(poolDir())).toBe(true);
    await rm(join(poolDir(), "settings.json"));
    await writeFile(join(poolDir(), ".credentials.json"), gatewayEntryText(GW));
    expect(await isGatewayRoutedDir(poolDir())).toBe(true);
  });
});

describe("swap into a gateway-routed pool", () => {
  test("writes the gateway entry (0600, no refresh token) and never a member login", async () => {
    await routeThroughProxy();
    const r = await performSwap({ registryPath: registry, ledgerPath: ledger, pool: "pool", target: "b", reason: "manual" });
    expect(r.to).toBe("b");
    const file = join(poolDir(), ".credentials.json");
    expect(await read(file)).toEqual({
      claudeAiOauth: { accessToken: GW, refreshToken: null, expiresAt: 4_102_444_800_000, scopes: ["user:inference"], subscriptionType: "max" },
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // member stores are untouched
    expect((await read(join(root, "b", ".credentials.json"))).claudeAiOauth.accessToken).toBe("at-b1");
    expect((await read(join(root, "a", ".credentials.json"))).claudeAiOauth.accessToken).toBe("at-a1");
    // registry records the active member as usual
    expect((await read(registry)).identities.find((i: { name: string }) => i.name === "pool").swapPool.active).toBe("b");
  });

  test("the pool's last live member grant is written back before the real login is replaced", async () => {
    await routeThroughProxy();
    await writeFile(join(poolDir(), ".credentials.json"), cred("at-a2", "rt-a2", NOW_S + 5000)); // refreshed inside the pool
    const r = await performSwap({ registryPath: registry, ledgerPath: ledger, pool: "pool", target: "b", reason: "manual" });
    expect(r.writeBack).toBe("written");
    expect((await read(join(root, "a", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-a2");
    expect((await read(join(poolDir(), ".credentials.json"))).claudeAiOauth.accessToken).toBe(GW);
  });

  test("a pool that is not gateway-routed still gets the member's real login", async () => {
    await performSwap({ registryPath: registry, ledgerPath: ledger, pool: "pool", target: "b", reason: "manual" });
    expect((await read(join(poolDir(), ".credentials.json"))).claudeAiOauth.accessToken).toBe("at-b1");
  });

  test("an already-correct entry with the same active member is a no-op", async () => {
    await routeThroughProxy();
    await performSwap({ registryPath: registry, ledgerPath: ledger, pool: "pool", target: "b", reason: "manual" });
    const again = await performSwap({ registryPath: registry, ledgerPath: ledger, pool: "pool", target: "b", reason: "manual" });
    expect(again.noop).toBe(true);
  });

  test("no gateway token in ~/.secrets: the swap refuses and leaves the pool alone", async () => {
    await routeThroughProxy();
    await writeFile(join(root, "secrets"), "OTHER=1\n");
    await expect(performSwap({ registryPath: registry, ledgerPath: ledger, pool: "pool", target: "b", reason: "manual" })).rejects.toThrow(/AGENTS_CLAUDE_TOKEN/);
    expect((await read(join(poolDir(), ".credentials.json"))).claudeAiOauth.accessToken).toBe("at-a1");
  });

  test("the token never lands in settings.json, the ledger or the swap result", async () => {
    await routeThroughProxy();
    const r = await performSwap({ registryPath: registry, ledgerPath: ledger, pool: "pool", target: "b", reason: "manual" });
    expect(JSON.stringify(r)).not.toContain(GW);
    expect(await readFile(join(poolDir(), "settings.json"), "utf8")).not.toContain(GW);
    expect(JSON.stringify(await readSwapEvents(ledger))).not.toContain(GW);
    expect(await readFile(registry, "utf8")).not.toContain(GW);
  });
});

describe("heal restores the gateway entry after a /login", () => {
  const heal = async () => {
    const file = (await read(registry)) as IdentitiesFile;
    const pool = file.identities.find((i) => i.name === "pool")!;
    const members = file.identities.filter((i) => i.name === "a" || i.name === "b");
    return claudeAdapter.heal!(pool as never, members);
  };

  test("a real login of a known member is saved to that member, then the entry is restored", async () => {
    await routeThroughProxy();
    await performSwap({ registryPath: registry, ledgerPath: ledger, pool: "pool", target: "a", reason: "manual" });
    // the user runs /login inside the identity and signs in as member b
    await writeFile(join(poolDir(), ".credentials.json"), cred("at-b9", "rt-b9", NOW_S + 9000));
    await writeFile(join(poolDir(), ".claude.json"), claudeJson("uuid-b"));
    await writeFile(join(poolDir(), "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:47140/claude" } }));
    const notes = await heal();
    expect(notes.join(" ")).toContain("restored");
    expect((await read(join(poolDir(), ".credentials.json"))).claudeAiOauth.accessToken).toBe(GW);
    expect((await read(join(root, "b", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-b9");
    expect(JSON.stringify(notes)).not.toContain(GW);
  });

  test("a login that matches no member is kept in a 0600 backup, then the entry is restored", async () => {
    await routeThroughProxy();
    await performSwap({ registryPath: registry, ledgerPath: ledger, pool: "pool", target: "a", reason: "manual" });
    await writeFile(join(poolDir(), ".credentials.json"), cred("at-x1", "rt-x1", NOW_S + 7000));
    await writeFile(join(poolDir(), ".claude.json"), claudeJson("uuid-stranger"));
    const notes = await heal();
    expect(notes.join(" ")).toContain("backup");
    const backups = (await readdir(poolDir())).filter((n) => n.endsWith(".bak"));
    expect(backups.length).toBe(1);
    expect((await stat(join(poolDir(), backups[0] as string))).mode & 0o777).toBe(0o600);
    expect((await read(join(poolDir(), ".credentials.json"))).claudeAiOauth.accessToken).toBe(GW);
    // neither member was overwritten with the stranger's login
    expect((await read(join(root, "a", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-a1");
    expect((await read(join(root, "b", ".credentials.json"))).claudeAiOauth.refreshToken).toBe("rt-b1");
  });

  test("a correct entry is left alone and reports nothing", async () => {
    await routeThroughProxy();
    await performSwap({ registryPath: registry, ledgerPath: ledger, pool: "pool", target: "a", reason: "manual" });
    expect(await heal()).toEqual([]);
  });

  test("a pool that is not gateway-routed is not touched by the gateway heal", async () => {
    expect(await heal()).toEqual([]);
    expect((await read(join(poolDir(), ".credentials.json"))).claudeAiOauth.accessToken).toBe("at-a1");
  });
});

describe("member credential convergence ignores a gateway pool folder", () => {
  test("the gateway entry is never converged into a member store and is not seen as a grant", async () => {
    await routeThroughProxy();
    await performSwap({ registryPath: registry, ledgerPath: ledger, pool: "pool", target: "a", reason: "manual" });
    const file = (await read(registry)) as IdentitiesFile;
    const a = file.identities.find((i) => i.name === "a")!;
    expect(await poolStoreDirsFor(a, registry)).toEqual([]);
    const out = await convergeClaudePoolStores(a, registry);
    expect(out.written).toEqual([]);
    expect((await read(join(root, "a", ".credentials.json"))).claudeAiOauth.accessToken).toBe("at-a1");
    expect(await readProviderGrantCopy("claude", poolDir())).toBeUndefined();
  });

  test("the gateway and the local proxy's direct mode read the member's own login, never the pool folder's copy", async () => {
    await routeThroughProxy();
    await performSwap({ registryPath: registry, ledgerPath: ledger, pool: "pool", target: "a", reason: "manual" });
    const file = (await read(registry)) as IdentitiesFile;
    const a = file.identities.find((i) => i.name === "a")!;
    const found = await readEffectiveGrant("claude", a, { claudeRegistryPath: registry });
    expect(found?.grant.access_token).toBe("at-a1");
    expect(found?.source).not.toContain(poolDir());
    const paths = await effectiveGrantPaths("claude", a, { claudeRegistryPath: registry });
    expect(paths.some((p) => p.startsWith(poolDir()))).toBe(false);
  });
});
