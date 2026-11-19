import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantMintedAt, keepAliveOnce } from "../../../src/gateway/serve.ts";
import { KIMI_RENEW_BELOW_S, refreshIdentityOAuthGrant, shouldAttemptOAuthRefresh } from "../../../src/identities/oauth-refresh.ts";
import { fetchKimiLimits } from "../../../src/cli/limits/kimi-limits.ts";
import { RefreshGuardRetryable } from "../../../src/gateway/refresh-guard.ts";
import { persistKimiCredentials } from "../../../src/cli/limits/kimi-store.ts";
import { recordOwned } from "../../../src/identities/gateway-owned.ts";
import { grantFileTuning } from "../../../src/identities/pool/grant-file-adapter.ts";
import { piAdapter } from "../../../src/identities/pool/pi-adapter.ts";
import { kimiAdapter } from "../../../src/identities/pool/kimi-adapter.ts";
import { performPoolSwap } from "../../../src/identities/pool/swap.ts";
import { requirePool } from "../../../src/identities/pool/swap-pool.ts";
import { loadIdentitiesFile } from "../../../src/identities/store.ts";
import { KIMI_CONFIG, PI_CONFIG } from "../../../src/identities/tool-configs.ts";
import type { Identity } from "../../../src/identities/types.ts";

// Fake values only. "owned" stands for a login the cluster gateway renews; "free" for a plain host login.
let root: string;
let registry: string;
const saved = { kimi: KIMI_CONFIG.identitiesJsonPath, pi: PI_CONFIG.identitiesJsonPath };
const ENV = ["AIS_GATEWAY_OWNED", "AIS_GATEWAY_OWNER", "AIS_GATEWAY_HEARTBEAT", "AIS_GATEWAY_MEMBERS_DIR"] as const;
const savedEnv: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

beforeEach(async () => {
  for (const k of ENV) savedEnv[k] = process.env[k];
  root = await mkdtemp(join(tmpdir(), "ais-kimi-owned-"));
  registry = join(root, "kimi-identities.json");
  process.env.AIS_GATEWAY_OWNED = join(root, "owned.json");
  process.env.AIS_GATEWAY_HEARTBEAT = join(root, "heartbeat.json");
  process.env.AIS_GATEWAY_MEMBERS_DIR = join(root, "members");
  process.env.AIS_GATEWAY_OWNER = "0";
  grantFileTuning.healRetryMs = 0;
  (KIMI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = registry;
  (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = join(root, "pi-identities.json");
});
afterEach(async () => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  globalThis.fetch = realFetch;
  (KIMI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.kimi;
  (PI_CONFIG as { identitiesJsonPath: string }).identitiesJsonPath = saved.pi;
  await rm(root, { recursive: true, force: true });
});

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (user: string, iat: number) => `${b64({ alg: "none" })}.${b64({ user_id: user, iat, exp: iat + 900 })}.SYNTHETIC_FIXTURE`;
const creds = (user: string, exp: number, tag: string): string =>
  JSON.stringify({ access_token: jwt(user, exp - 900), refresh_token: `SYNTHETIC_FIXTURE-rt-${tag}`, expires_at: exp, scope: "kimi-code", token_type: "Bearer" }, null, 2);

/** A fake token value built at run time (never a literal in the file). */
const fake = (tag: string) => `SYNTHETIC_FIXTURE-${tag}`;
const dirOf = (name: string) => join(root, name);
const credPath = (name: string) => join(dirOf(name), "credentials", "kimi-code.json");
const put = async (name: string, text: string) => {
  await mkdir(join(dirOf(name), "credentials"), { recursive: true });
  await writeFile(credPath(name), text);
};
const readGrant = async (name: string) => JSON.parse(await readFile(credPath(name), "utf8")) as { access_token: string; refresh_token?: string; expires_at: number };
const member = (name: string): Identity => ({ name, label: name, configDir: dirOf(name) });
const T0 = 1_789_200_000;

async function setup(): Promise<void> {
  await writeFile(registry, JSON.stringify({ version: 1, identities: [member("owned"), member("free"), { ...member("pool"), swapPool: { accounts: ["owned", "free"], active: "owned" } }] }));
  await put("owned", creds("user-owned", T0, "owned-1"));
  await put("free", creds("user-free", T0, "free-1"));
  await put("pool", creds("user-owned", T0, "owned-1"));
  await recordOwned(["kimi/owned"], new Date().toISOString());
}

async function healPool() {
  const file = await loadIdentitiesFile(registry);
  const pool = requirePool(file, "pool", "kimi");
  return kimiAdapter.heal!(pool, pool.swapPool.accounts.map((n) => file.identities.find((i) => i.name === n)!));
}
const swap = (target: string) => performPoolSwap(kimiAdapter, { registryPath: registry, ledgerPath: join(root, "ledger.jsonl"), pool: "pool", target, reason: "manual" });

describe("kimi pool: a gateway-owned member never puts its refresh token in the pool", () => {
  test("heal restores the owned vault into the pool as an access token only", async () => {
    await setup();
    await put("pool", creds("user-owned", T0 - 3600, "stale")); // pool behind the vault
    const notes = await healPool();
    expect(notes.join("\n")).toContain('restored "owned"');
    const pool = await readGrant("pool");
    const vault = await readGrant("owned");
    expect(pool.access_token).toBe(vault.access_token);
    expect(pool.expires_at).toBe(vault.expires_at);
    expect(pool.refresh_token).toBeUndefined();
    expect(vault.refresh_token).toBe("SYNTHETIC_FIXTURE-rt-owned-1"); // the vault keeps its token
  });

  test("a pool copy without a refresh token is whole: the next heal changes nothing", async () => {
    await setup();
    await healPool();
    const before = await readFile(credPath("pool"), "utf8");
    expect(await healPool()).toEqual([]);
    expect(await readFile(credPath("pool"), "utf8")).toBe(before);
  });

  test("an access-only pool copy that is older or equal never goes back to the owned vault", async () => {
    await setup();
    const vaultBefore = await readFile(credPath("owned"), "utf8");
    await put("pool", JSON.stringify({ access_token: jwt("user-owned", T0 - 1800), expires_at: T0 - 900, scope: "kimi-code", token_type: "Bearer" }));
    const notes = await healPool();
    expect(notes.join("\n")).not.toContain("adopted");
    expect(await readFile(credPath("owned"), "utf8")).toBe(vaultBefore);
    expect((await readGrant("pool")).refresh_token).toBeUndefined();
    expect((await readGrant("pool")).expires_at).toBe(T0); // the pool follows the vault
  });

  test("swapping away from an owned member with an access-only pool copy writes nothing into its vault", async () => {
    await setup();
    const vaultBefore = await readFile(credPath("owned"), "utf8");
    await put("pool", JSON.stringify({ access_token: jwt("user-owned", T0 - 1800), expires_at: T0 - 900 }));
    const result = await swap("free");
    expect(result.writeBack).toBe("none-gateway-owned");
    expect(await readFile(credPath("owned"), "utf8")).toBe(vaultBefore);
    expect((await readGrant("pool")).refresh_token).toBe(fake("rt-free-1")); // a plain member still gets its full login
  });

  test("swapping to an owned member copies the access token only", async () => {
    await setup();
    await writeFile(registry, JSON.stringify({ version: 1, identities: [member("owned"), member("free"), { ...member("pool"), swapPool: { accounts: ["owned", "free"], active: "free" } }] }));
    await put("pool", creds("user-free", T0, "free-1"));
    const result = await swap("owned");
    expect(result.noop).toBe(false);
    const pool = await readGrant("pool");
    expect(pool.access_token).toBe((await readGrant("owned")).access_token);
    expect(pool.refresh_token).toBeUndefined();
  });

  test("a plain member keeps today's behaviour: full copy and write-back of newer pool tokens", async () => {
    await setup();
    await writeFile(registry, JSON.stringify({ version: 1, identities: [member("owned"), member("free"), { ...member("pool"), swapPool: { accounts: ["owned", "free"], active: "free" } }] }));
    await put("pool", creds("user-free", T0 + 900, "free-rotated"));
    const result = await swap("owned");
    expect(result.writeBack).toBe("written");
    expect((await readGrant("free")).refresh_token).toBe("SYNTHETIC_FIXTURE-rt-free-rotated");
  });

  test("a member refresh written through to pools drops the refresh token for an owned login only", async () => {
    await setup();
    const next = { access_token: jwt("user-owned", T0 + 1800), refresh_token: fake("rt-owned-2"), expires_at: T0 + 2700 };
    await persistKimiCredentials(member("owned"), "kimi", next);
    const pool = await readGrant("pool");
    expect(pool.access_token).toBe(next.access_token);
    expect(pool.refresh_token).toBeUndefined();
    // the member's own vault gets the full grant (the gateway process writes it through its guard)
    expect((await readGrant("owned")).refresh_token).toBe(fake("rt-owned-2"));
  });
});

describe("the gateway usage poll never rotates a kimi login", () => {
  function fakeUpstream(): { urls: string[] } {
    const seen = { urls: [] as string[] };
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      seen.urls.push(url);
      if (url.includes("/oauth/token")) return new Response(JSON.stringify({ access_token: fake("at-new"), refresh_token: fake("rt-new"), expires_in: 900 }), { status: 200 });
      return new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;
    return seen;
  }
  const expiredNow = () => Math.floor(Date.now() / 1000) - 60;

  test("noRefresh: an expired token is not sent to the token endpoint and the store is not written", async () => {
    await setup();
    await put("free", creds("user-free", expiredNow(), "free-1"));
    const before = await readFile(credPath("free"), "utf8");
    const seen = fakeUpstream();
    const result = await kimiAdapter.fetchUsage(member("free"), { noRefresh: true });
    expect(result.status).toBe("unavailable");
    expect(seen.urls.some((u) => u.includes("/oauth/token"))).toBe(false);
    expect(await readFile(credPath("free"), "utf8")).toBe(before);
  });

  test("the gateway process never refreshes through a usage read, even without noRefresh", async () => {
    await setup();
    await put("free", creds("user-free", expiredNow(), "free-1"));
    const before = await readFile(credPath("free"), "utf8");
    process.env.AIS_GATEWAY_OWNER = "1";
    const seen = fakeUpstream();
    const result = await fetchKimiLimits(member("free"));
    expect(result.status).toBe("unavailable");
    expect(seen.urls.some((u) => u.includes("/oauth/token"))).toBe(false);
    expect(await readFile(credPath("free"), "utf8")).toBe(before);
  });

  test("a plain host process still refreshes an expired login it owns (today's behaviour)", async () => {
    await setup();
    await put("free", creds("user-free", expiredNow(), "free-1"));
    const seen = fakeUpstream();
    await fetchKimiLimits(member("free"));
    expect(seen.urls.some((u) => u.includes("/oauth/token"))).toBe(true);
  });
});

describe("the gateway keep-alive renews a kimi login daily", () => {
  /** Runs one keep-alive pass over the stored grant of `free` and returns what the refresher would decide. */
  async function decision(expiresAt: number): Promise<boolean> {
    await setup();
    await put("free", creds("user-free", expiresAt, "free-1"));
    let lastSuccessAt: string | null = null;
    await keepAliveOnce({
      tools: ["kimi"],
      accounts: async () => [member("free")],
      metrics: { keepAlive() {} },
      mintedAt: grantMintedAt,
      refresh: (async (_tool: string, _acct: Identity, opts?: { lastSuccessAt?: string | null }) => {
        lastSuccessAt = opts?.lastSuccessAt ?? null;
        return { outcome: "skipped-fresh" };
      }) as never,
    });
    const grant = await readGrant("free");
    return shouldAttemptOAuthRefresh({ access_token: grant.access_token, refresh_token: grant.refresh_token, expires_at: grant.expires_at }, { tool: "kimi", lastSuccessAt }).attempt;
  }
  const now = () => Math.floor(Date.now() / 1000);

  test("a grant minted 30 hours ago (no unguarded refresh since) is renewed by the daily pass", async () => {
    expect(await decision(now() - 30 * 3600 + 900)).toBe(true);
  });

  test("a grant an outside writer minted 10 minutes ago hides the daily pass: why the pass never ran before the fix", async () => {
    expect(await decision(now() + 300)).toBe(false);
  });
});

describe("the gateway keep-alive renews a kimi login on every tick", () => {
  const line = KIMI_RENEW_BELOW_S;
  const NOW = 1_789_300_000;
  const decide = (secondsLeft: number, extra: { renewBelowSeconds?: number; lastSuccessAt?: string | null } = {}) =>
    shouldAttemptOAuthRefresh({ access_token: "x", expires_at: NOW + secondsLeft }, { tool: "kimi", expiryWindowHours: 24, nowSeconds: NOW, lastSuccessAt: new Date((NOW - 60) * 1000).toISOString(), ...extra });

  test("the renew line is the token lifetime minus 30 s: a late tick still renews", () => {
    expect(line).toBe(870);
    expect(decide(600, { renewBelowSeconds: line }).attempt).toBe(true); // 5 minutes after minting
    expect(decide(120, { renewBelowSeconds: line }).attempt).toBe(true); // the tick ran 8 minutes late
  });

  test("a token minted one tick ago (5 minutes left) is renewed; a fresh one is not", () => {
    expect(decide(300, { renewBelowSeconds: line }).attempt).toBe(true);
    expect(decide(300, { renewBelowSeconds: line }).reason).toContain("renew line");
    expect(decide(line - 1, { renewBelowSeconds: line }).attempt).toBe(true);
    expect(decide(line, { renewBelowSeconds: line }).attempt).toBe(false);
    expect(decide(890, { renewBelowSeconds: line }).attempt).toBe(false); // minted seconds ago
  });

  test("an expired token is renewed on the tick, whatever the last success", () => {
    expect(decide(-30, { renewBelowSeconds: line }).attempt).toBe(true);
  });

  test("without the renew line (host daemon, CLI) kimi keeps the daily rule only", () => {
    expect(decide(300).attempt).toBe(false);
    expect(decide(300, { lastSuccessAt: new Date((NOW - 30 * 3600) * 1000).toISOString() }).reason).toContain("daily keep-alive");
  });

  test("the keep-alive sets the line for kimi only", async () => {
    const seen: Record<string, number | undefined> = {};
    await keepAliveOnce({
      tools: ["claude", "codex", "kimi"],
      accounts: async () => [member("one")],
      metrics: { keepAlive() {} },
      refresh: (async (tool: string, _acct: Identity, opts?: { renewBelowSeconds?: number }) => {
        seen[tool] = opts?.renewBelowSeconds;
        return { outcome: "skipped-fresh" };
      }) as never,
    });
    expect(seen).toEqual({ claude: undefined, codex: undefined, kimi: line });
  });

  test("a renewal in the gateway reaches the pool as an access token and expiry only; the vault keeps the full grant", async () => {
    await setup();
    process.env.AIS_GATEWAY_OWNER = "1";
    const nowS = Math.floor(Date.now() / 1000);
    await put("owned", creds("user-owned", nowS + 300, "owned-1")); // one tick after minting: 5 minutes left
    await put("pool", creds("user-owned", nowS + 300, "owned-1"));
    const bodies: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ access_token: jwt("user-owned", nowS), refresh_token: fake("rt-owned-2"), expires_in: 900 }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await refreshIdentityOAuthGrant("kimi", member("owned"), { keepAlive: true, renewBelowSeconds: line, fetchImpl, now: () => nowS * 1000 });
    expect(result.outcome).toBe("refreshed");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(fake("rt-owned-1")); // the spent token went out exactly once
    const vault = await readGrant("owned");
    expect(vault.refresh_token).toBe(fake("rt-owned-2"));
    expect(vault.expires_at).toBeGreaterThan(nowS + 800);
    const pool = await readGrant("pool");
    expect(pool.access_token).toBe(vault.access_token);
    expect(pool.expires_at).toBe(vault.expires_at);
    expect(pool.refresh_token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Review fixes: pi pools, rollout (a pool copy from before), late tick, one ownership rule.

describe("rollout: a pool copy from before this build is kept, and adopted when it is newer", () => {
  const baks = async (name: string): Promise<string[]> =>
    (await readdir(join(dirOf(name), "credentials"))).filter((n) => n.includes(".pre-heal.") && n.endsWith(".bak")).map((n) => join(dirOf(name), "credentials", n));

  test("a pool session rotated before the first heal: its newer grant is backed up (0600) and adopted into the vault", async () => {
    await setup();
    await put("pool", creds("user-owned", T0 + 900, "rotated-before-heal")); // real refresh token, newer than the vault's
    const notes = await healPool();
    expect(notes.join("\n")).toContain("adopted it into the vault");
    expect((await readGrant("owned")).refresh_token).toBe(fake("rt-rotated-before-heal")); // the only live chain is kept
    const files = await baks("pool");
    expect(files).toHaveLength(1);
    expect((await stat(files[0]!)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(files[0]!, "utf8")).refresh_token).toBe(fake("rt-rotated-before-heal"));
    expect((await readGrant("pool")).refresh_token).toBeUndefined(); // the pool follows the vault, as a view
    expect(notes.join("\n")).not.toContain(fake("rt-rotated-before-heal")); // never logged
  });

  test("a second heal adopts nothing and writes no second backup", async () => {
    await setup();
    await put("pool", creds("user-owned", T0 + 900, "rotated-before-heal"));
    await healPool();
    expect(await healPool()).toEqual([]);
    expect(await baks("pool")).toHaveLength(1);
  });

  test("a pool grant older than the vault's is backed up, not adopted", async () => {
    await setup();
    await put("pool", creds("user-owned", T0 - 900, "stale-in-pool"));
    const vaultBefore = await readFile(credPath("owned"), "utf8");
    await healPool();
    expect(await readFile(credPath("owned"), "utf8")).toBe(vaultBefore);
    expect(await baks("pool")).toHaveLength(1);
  });

  test("a pool copy with the vault's own refresh token needs no backup", async () => {
    await setup();
    await put("pool", creds("user-owned", T0, "owned-1")); // same refresh token as the vault: a plain copy from before
    await healPool();
    expect(await baks("pool")).toHaveLength(0);
    expect((await readGrant("pool")).refresh_token).toBeUndefined();
  });

  test("swapping away from an owned member adopts a newer pool grant too", async () => {
    await setup();
    await put("pool", creds("user-owned", T0 + 900, "rotated-before-swap"));
    const result = await swap("free");
    expect(result.writeBack).toBe("written");
    expect((await readGrant("owned")).refresh_token).toBe(fake("rt-rotated-before-swap"));
    expect(readdirSync(join(dirOf("pool"), "credentials")).filter((n) => n.includes(".pre-swap.") && n.endsWith(".bak"))).toHaveLength(1);
  });
});

describe("one ownership rule: sticky ownership or a fresh heartbeat", () => {
  const noSticky = () => writeFile(process.env.AIS_GATEWAY_OWNED!, JSON.stringify({ version: 1, owned: {} }));
  const heartbeat = (passAt: Date) => writeFile(process.env.AIS_GATEWAY_HEARTBEAT!, JSON.stringify({ version: 1, passAt: passAt.toISOString(), held: { "kimi/owned": {} } }));

  test("with neither, a pool copy is the full login as before", async () => {
    await setup();
    await noSticky();
    await put("pool", creds("user-owned", T0 - 3600, "stale"));
    await healPool();
    expect((await readGrant("pool")).refresh_token).toBe(fake("rt-owned-1"));
  });

  test("a fresh heartbeat that names the login makes the pool copy access-only, with no sticky record", async () => {
    await setup();
    await noSticky();
    await heartbeat(new Date());
    await put("pool", creds("user-owned", T0 - 3600, "stale"));
    await healPool();
    expect((await readGrant("pool")).refresh_token).toBeUndefined();
  });

  test("a stale heartbeat does not count", async () => {
    await setup();
    await noSticky();
    await heartbeat(new Date(Date.now() - 3 * 3600_000));
    await put("pool", creds("user-owned", T0 - 3600, "stale"));
    await healPool();
    expect((await readGrant("pool")).refresh_token).toBe(fake("rt-owned-1"));
  });
});

describe("pi pools hold no refresh token of a gateway-owned kimi login", () => {
  const piAuth = (user: string, exp: number, tag: string, other?: string): string =>
    JSON.stringify({ "kimi-coding": { type: "oauth", access: jwt(user, exp - 900), refresh: fake(`pirt-${tag}`), expires: exp * 1000 }, ...(other ? { anthropic: { type: "oauth", access: fake(`oa-${other}`), refresh: fake(`or-${other}`), expires: (exp + 7200) * 1000 } } : {}) });
  const putPi = async (name: string, text: string) => {
    await mkdir(dirOf(name), { recursive: true });
    await writeFile(join(dirOf(name), "auth.json"), text);
  };
  const readPi = async (name: string) => JSON.parse(await readFile(join(dirOf(name), "auth.json"), "utf8")) as Record<string, { access: string; refresh: string; expires: number }>;
  const piRegistry = () => PI_CONFIG.identitiesJsonPath;
  async function setupPi(active = "owned"): Promise<void> {
    await writeFile(piRegistry(), JSON.stringify({ version: 1, identities: [member("owned"), member("free"), { ...member("pool"), swapPool: { accounts: ["owned", "free"], active } }] }));
    await putPi("owned", piAuth("user-owned", T0, "owned-1"));
    await putPi("free", piAuth("user-free", T0, "free-1"));
    await putPi("pool", piAuth("user-owned", T0, "owned-1"));
    await recordOwned(["kimi/owned"], new Date().toISOString());
  }
  const healPi = async () => {
    const file = await loadIdentitiesFile(piRegistry());
    const pool = requirePool(file, "pool", "pi");
    return piAdapter.heal!(pool, pool.swapPool.accounts.map((n) => file.identities.find((i) => i.name === n)!));
  };
  const swapPi = (target: string) => performPoolSwap(piAdapter, { registryPath: piRegistry(), ledgerPath: join(root, "pi-ledger.jsonl"), pool: "pool", target, reason: "manual" });

  test("heal restores the owned vault into the pool with an empty refresh token", async () => {
    await setupPi();
    await putPi("pool", piAuth("user-owned", T0 - 3600, "stale"));
    await healPi();
    const pool = await readPi("pool");
    expect(pool["kimi-coding"]!.access).toBe((await readPi("owned"))["kimi-coding"]!.access);
    expect(pool["kimi-coding"]!.refresh).toBe("");
    expect((await readPi("owned"))["kimi-coding"]!.refresh).toBe(fake("pirt-owned-1"));
    expect(await healPi()).toEqual([]); // the access-only copy is whole
  });

  test("swapping to an owned pi member copies no refresh token", async () => {
    await setupPi("free");
    await putPi("pool", piAuth("user-free", T0, "free-1"));
    await swapPi("owned");
    expect((await readPi("pool"))["kimi-coding"]!.refresh).toBe("");
  });

  test("the pool's kimi-coding entry never goes back to the owned vault, other providers still do", async () => {
    await setupPi();
    await putPi("owned", piAuth("user-owned", T0, "owned-1", "a"));
    await putPi("pool", piAuth("user-owned", T0, "owned-1", "a").replace(fake("or-a"), fake("or-b"))); // anthropic rotated in the pool
    const pool = JSON.parse(await readFile(join(dirOf("pool"), "auth.json"), "utf8"));
    pool.anthropic.expires += 1000;
    pool["kimi-coding"].refresh = "";
    await putPi("pool", JSON.stringify(pool));
    await healPi();
    const owned = await readPi("owned");
    expect(owned["kimi-coding"]!.refresh).toBe(fake("pirt-owned-1"));
    expect(owned.anthropic!.refresh).toBe(fake("or-b"));
  });

  test("a pi pool copy from before, with a newer real refresh token, is backed up and adopted", async () => {
    await setupPi();
    await putPi("pool", piAuth("user-owned", T0 + 900, "rotated-before-heal"));
    await healPi();
    expect((await readPi("owned"))["kimi-coding"]!.refresh).toBe(fake("pirt-rotated-before-heal"));
    const baks = (await readdir(dirOf("pool"))).filter((n) => n.includes(".pre-heal.") && n.endsWith(".bak"));
    expect(baks).toHaveLength(1);
    expect((await stat(join(dirOf("pool"), baks[0]!))).mode & 0o777).toBe(0o600);
    expect((await readPi("pool"))["kimi-coding"]!.refresh).toBe("");
  });

  test("a member refresh reaches the pi pool as access token and expiry only", async () => {
    await setupPi();
    await putPi("pool", piAuth("user-owned", T0, "owned-1"));
    await writeFile(registry, JSON.stringify({ version: 1, identities: [member("owned")] })); // kimi registry: the member only
    const next = { access_token: jwt("user-owned", T0 + 1800), refresh_token: fake("rt-owned-2"), expires_at: T0 + 2700 };
    await persistKimiCredentials(member("owned"), "pi", next);
    const pool = await readPi("pool");
    expect(pool["kimi-coding"]!.access).toBe(next.access_token);
    expect(pool["kimi-coding"]!.expires).toBe(next.expires_at * 1000);
    expect(pool["kimi-coding"]!.refresh).toBe("");
  });
});

describe("a busy guard at the tick is retried soon for kimi", () => {
  test("keepAliveOnce names the tools whose renewal the guard could not take", async () => {
    const result = await keepAliveOnce({
      tools: ["codex", "kimi"],
      accounts: async () => [member("one")],
      metrics: { keepAlive() {} },
      refresh: (async (tool: string) => {
        if (tool === "kimi") throw new RefreshGuardRetryable("database busy");
        return { outcome: "skipped-fresh" };
      }) as never,
    });
    expect(result.retryTools).toEqual(["kimi"]);
  });
});
