import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CredentialCache, GatewayCredentialError, NotRefreshableError, RefreshCooldownError, type RefreshFn } from "../../src/gateway/credentials.ts";
import { SwapLockError } from "../../src/identities/claude-swap-lock.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG, GROK_CONFIG, KIMI_CONFIG, PI_CONFIG } from "../../src/identities/tool-configs.ts";
import { OAuthRefreshError, refreshIdentityOAuthGrant } from "../../src/identities/oauth-refresh.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "gateway");
const SCRATCH = join(import.meta.dir, ".tmp");
const ANTHROPIC_TOKEN_HOST = "platform.claude.com";

let work = "";
const CONFIGS = { claude: CLAUDE_CONFIG, codex: CODEX_CONFIG, grok: GROK_CONFIG, kimi: KIMI_CONFIG, pi: PI_CONFIG } as const;
const savedPaths: Record<string, string> = {};
const registryOf = (tool: string) => join(work, `${tool}-registry.json`);
// Registries are repointed at empty temp files so no test ever reads the real home directory.
beforeEach(async () => {
  await mkdir(SCRATCH, { recursive: true });
  work = await mkdtemp(join(SCRATCH, "gw-cred-"));
  await cp(FIXTURES, work, { recursive: true });
  for (const [tool, config] of Object.entries(CONFIGS)) {
    savedPaths[tool] = config.identitiesJsonPath;
    (config as { identitiesJsonPath: string }).identitiesJsonPath = registryOf(tool);
    await writeFile(registryOf(tool), JSON.stringify({ version: 1, identities: [] }));
  }
});
afterEach(async () => {
  for (const [tool, config] of Object.entries(CONFIGS)) (config as { identitiesJsonPath: string }).identitiesJsonPath = savedPaths[tool]!;
  await rm(work, { recursive: true, force: true });
});
const registerPi = async (): Promise<string> => {
  const piDir = join(work, "pi");
  await mkdir(piDir, { recursive: true });
  await writeFile(registryOf("pi"), JSON.stringify({ version: 1, identities: [{ name: "id1", label: "id1", configDir: piDir }] }));
  return join(piDir, "auth.json");
};

const claudeFile = () => join(work, "claude", ".credentials.json");
const writeClaude = async (token: string, mtimeSec: number): Promise<void> => {
  await writeFile(claudeFile(), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "SYNTHETIC_FIXTURE-claude-refresh-0001", expiresAt: 1893456000000 } }));
  await utimes(claudeFile(), mtimeSec, mtimeSec);
};
const makeCache = (refresh?: RefreshFn) => new CredentialCache({ resolveConfigDir: async (p) => join(work, p), ...(refresh ? { refresh } : {}) });
const refreshed = (over: Partial<Awaited<ReturnType<RefreshFn>>> = {}): Awaited<ReturnType<RefreshFn>> => ({
  tool: "claude", identity: "id1", outcome: "refreshed", detail: "ok", written: [], writeFailures: [], ...over,
});

describe("CredentialCache", () => {
  test("reads codex account id and claude expiry", async () => {
    const c = makeCache();
    expect((await c.get("codex", "id1")).accountId).toBe("SYNTHETIC_FIXTURE-account-0001");
    expect((await c.get("claude", "id1")).expiresAtMs).toBe(1893456000000);
  });

  test("cache reloads after mtime change", async () => {
    await writeClaude("SYNTHETIC_FIXTURE-claude-access-0001", 1_800_000_000);
    const c = makeCache();
    expect((await c.get("claude", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0001");
    await writeClaude("SYNTHETIC_FIXTURE-claude-access-0002", 1_800_000_000);
    expect((await c.get("claude", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0001");
    await writeClaude("SYNTHETIC_FIXTURE-claude-access-0002", 1_800_000_100);
    expect((await c.get("claude", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0002");
  });

  test("concurrent 401 refreshes share one locked refresh", async () => {
    let calls = 0;
    const refresh: RefreshFn = async () => {
      calls++;
      await Bun.sleep(20);
      await writeClaude("SYNTHETIC_FIXTURE-claude-access-0002", 1_800_000_200);
      return refreshed();
    };
    const c = makeCache(refresh);
    const [a, b] = await Promise.all([
      c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001"),
      c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001"),
    ]);
    expect(calls).toBe(1);
    expect(a.accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0002");
    expect(b.accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0002");
  });

  test("a revoked refresh token is a dead login with a plain message and the login command", async () => {
    const c = makeCache(async () => {
      throw new OAuthRefreshError("token refresh rejected (HTTP 400 invalid_grant)", true, undefined, "invalid_grant");
    });
    const err = (await c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001").catch((e: unknown) => e)) as GatewayCredentialError;
    expect(err).toBeInstanceOf(GatewayCredentialError);
    expect(err.code).toBe("login-dead");
    expect(err.loggedOut).toBe(true);
    expect(err.clientMessage).toContain('claude identity "id1" is logged out');
    expect(err.clientMessage).toContain("claude --identity=id1");
    expect(err.clientMessage).not.toContain("SYNTHETIC_FIXTURE");
    expect(new GatewayCredentialError("login-dead", "codex", "x").clientMessage).toContain("codex --identity=x login");
    expect(new GatewayCredentialError("refresh-lock-timeout", "codex", "x").loggedOut).toBe(false);
  });

  test("a 400/401 without an OAuth invalid_grant code is not a dead login", async () => {
    for (const code of [undefined, "invalid_request", "temporarily_unavailable"]) {
      const c = makeCache(async () => {
        throw new OAuthRefreshError("token refresh rejected (HTTP 400)", true, undefined, code);
      });
      const err = (await c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001").catch((e: unknown) => e)) as GatewayCredentialError;
      expect(err.code).toBe("refresh-failed");
      expect(err.loggedOut).toBe(false);
    }
  });

  test("the Codex dead-grant codes count as a dead login; unknown codes do not", async () => {
    for (const code of ["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated", "invalid_grant"]) {
      const c = makeCache(async () => { throw new OAuthRefreshError("rejected", true, undefined, code); });
      expect(((await c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001").catch((e: unknown) => e)) as GatewayCredentialError).code).toBe("login-dead");
    }
    const other = makeCache(async () => { throw new OAuthRefreshError("rejected", true, undefined, "invalid_client"); });
    expect(((await other.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001").catch((e: unknown) => e)) as GatewayCredentialError).code).toBe("refresh-failed");
  });

  test("a no-grant caused by a store read error is transient, not a dead login", async () => {
    const c = makeCache(async () => refreshed({ outcome: "no-grant", readError: true }));
    const err = (await c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001").catch((e: unknown) => e)) as GatewayCredentialError;
    expect(err.code).toBe("refresh-failed");
    expect(err.loggedOut).toBe(false);
  });

  test("no-grant is a dead login for a plain identity but only transient for a swap pool identity", async () => {
    const noGrant = async () => refreshed({ outcome: "no-grant" });
    const plain = makeCache(noGrant);
    expect(((await plain.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001").catch((e: unknown) => e)) as GatewayCredentialError).code).toBe("login-dead");
    const pool = new CredentialCache({
      resolveIdentity: async (_p, name) => ({ name, label: name, configDir: join(work, "claude"), swapPool: { accounts: ["m1"], active: "m1" } }),
      refresh: noGrant,
    });
    const err = (await pool.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001").catch((e: unknown) => e)) as GatewayCredentialError;
    expect(err.code).toBe("refresh-failed");
    expect(err.loggedOut).toBe(false);
  });

  test("a credential confirmed absent by a second read is a dead login; a swap pool identity's is transient", async () => {
    await rm(claudeFile(), { force: true });
    const plain = makeCache();
    const dead = (await plain.get("claude", "id1").catch((e: unknown) => e)) as GatewayCredentialError;
    expect(dead.code).toBe("login-dead");
    const pool = new CredentialCache({ resolveIdentity: async (_p, name) => ({ name, label: name, configDir: join(work, "claude"), swapPool: { accounts: ["m1"], active: "m1" } }) });
    const transient = (await pool.get("claude", "id1").catch((e: unknown) => e)) as GatewayCredentialError;
    expect(transient.code).toBe("no-credential");
    expect(transient.loggedOut).toBe(false);
  });

  test("a file that reappears on the second read is not a dead login", async () => {
    await rm(claudeFile(), { force: true });
    setTimeout(() => void writeClaude("SYNTHETIC_FIXTURE-claude-access-0005", 1_800_000_900), 10);
    const cred = await makeCache().get("claude", "id1");
    expect(cred.accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0005");
  });

  test("refresh skipped when file already holds a newer token", async () => {
    await writeClaude("SYNTHETIC_FIXTURE-claude-access-0009", 1_800_000_300);
    let calls = 0;
    const c = makeCache(async () => { calls++; return refreshed(); });
    const cred = await c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001");
    expect(calls).toBe(0);
    expect(cred.accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0009");
  });

  test("file rotated between the gateway read and the lock gives zero token POSTs", async () => {
    const posts: string[] = [];
    const registry = join(work, "claude-registry.json");
    await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "id1", label: "id1", configDir: join(work, "claude") }] }));
    const fetchImpl = (async (url: string) => { posts.push(String(url)); return new Response("{}", { status: 500 }); }) as unknown as typeof fetch;
    const refresh: RefreshFn = async (tool, identity, options) => {
      // Another process rotates T1 to T2 after the gateway read, before the lock is taken.
      await writeClaude("SYNTHETIC_FIXTURE-claude-access-0002", 1_800_000_400);
      return refreshIdentityOAuthGrant(tool, identity, { ...options, fetchImpl, claudeRegistryPath: registry });
    };
    const c = makeCache(refresh);
    const cred = await c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001");
    expect(posts).toEqual([]);
    expect(cred.accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0002");
  });

  test("repeated 401s within the cooldown give exactly one token POST", async () => {
    const posts: string[] = [];
    const registry = join(work, "claude-registry.json");
    await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "id1", label: "id1", configDir: join(work, "claude") }] }));
    const fetchImpl = (async (url: string) => {
      posts.push(String(url));
      return new Response(JSON.stringify({ access_token: "SYNTHETIC_FIXTURE-claude-access-0002", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    let now = 1_800_000_000_000;
    const c = new CredentialCache({
      resolveConfigDir: async (p) => join(work, p),
      now: () => now,
      refresh: (tool, identity, options) => refreshIdentityOAuthGrant(tool, identity, { ...options, fetchImpl, claudeRegistryPath: registry }),
    });
    const first = await c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001");
    expect(first.accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0002");
    now += 30_000;
    await expect(c.refreshAfter401("claude", "id1", first.accessToken)).rejects.toBeInstanceOf(RefreshCooldownError);
    expect(posts.length).toBe(1);
    expect(posts[0]).toContain(ANTHROPIC_TOKEN_HOST);
    now += 31_000;
    await c.refreshAfter401("claude", "id1", first.accessToken).catch(() => undefined);
    expect(posts.length).toBe(2);
  });

  test("opencode prefers the v2 db key over a stale auth.json and watches the db mtime", async () => {
    const dbPath = join(work, "opencode", "data", "opencode", "opencode.db");
    const db = new Database(dbPath, { create: true });
    db.run("CREATE TABLE credential (id TEXT, integration_id TEXT, label TEXT, value TEXT, active INTEGER, time_updated INTEGER)");
    db.run("INSERT INTO credential VALUES ('1','opencode','x', ?, 1, 5)", [JSON.stringify({ type: "api", key: "SYNTHETIC_FIXTURE-opencode-db-0001" })]);
    db.close();
    const c = makeCache();
    expect((await c.get("opencode", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-opencode-db-0001");
    const db2 = new Database(dbPath);
    db2.run("UPDATE credential SET value = ?", [JSON.stringify({ type: "api", key: "SYNTHETIC_FIXTURE-opencode-db-0002" })]);
    db2.close();
    await utimes(dbPath, 1_900_000_000, 1_900_000_000);
    expect((await c.get("opencode", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-opencode-db-0002");
  }, 20_000);

  test("retired identities are rejected without leaking the token", async () => {
    const c = new CredentialCache({ resolveIdentity: async () => ({ name: "id1", label: "id1", configDir: join(work, "claude"), retired: true }) });
    const err = await c.get("claude", "id1").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/retired/);
    expect((err as Error).message).not.toContain("SYNTHETIC_FIXTURE");
  });

  test("claude: a newer pi copy wins, and a 401 on the stale native token refreshes nothing", async () => {
    const piAuth = await registerPi();
    // Native holds T1 (expiresAt 2030); the pi copy expires later, so AIS's selection picks it.
    await writeFile(piAuth, JSON.stringify({ anthropic: { type: "oauth", access: "SYNTHETIC_FIXTURE-claude-pi-0002", refresh: "SYNTHETIC_FIXTURE-claude-pi-refresh", expires: 1_900_000_000_000 } }));
    let calls = 0;
    const c = makeCache(async () => { calls++; return refreshed(); });
    expect((await c.get("claude", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-pi-0002");
    const cred = await c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001");
    expect(cred.accessToken).toBe("SYNTHETIC_FIXTURE-claude-pi-0002");
    expect(calls).toBe(0);
  });

  test("alias: the pi-newer copy is found through an alias with zero refreshes", async () => {
    const piAuth = await registerPi();
    await writeFile(piAuth, JSON.stringify({ anthropic: { type: "oauth", access: "SYNTHETIC_FIXTURE-claude-pi-0002", refresh: "SYNTHETIC_FIXTURE-claude-pi-refresh", expires: 1_900_000_000_000 } }));
    await writeFile(registryOf("claude"), JSON.stringify({ version: 1, identities: [{ name: "id1", label: "id1", aliases: ["al"], configDir: join(work, "claude") }] }));
    let calls = 0;
    const c = new CredentialCache({ claudeRegistryPath: registryOf("claude"), refresh: async () => { calls++; return refreshed(); } });
    expect((await c.get("claude", "al")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-pi-0002");
    expect((await c.refreshAfter401("claude", "al", "SYNTHETIC_FIXTURE-claude-access-0001")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-pi-0002");
    expect(calls).toBe(0);
  });

  test("alias and canonical name share one cooldown", async () => {
    await writeFile(registryOf("claude"), JSON.stringify({ version: 1, identities: [{ name: "id1", label: "id1", aliases: ["al"], configDir: join(work, "claude") }] }));
    let calls = 0;
    const c = new CredentialCache({
      claudeRegistryPath: registryOf("claude"),
      now: () => 1_800_000_000_000,
      refresh: async () => { calls++; await writeClaude("SYNTHETIC_FIXTURE-claude-access-0002", 1_800_000_500); return refreshed(); },
    });
    await c.refreshAfter401("claude", "al", "SYNTHETIC_FIXTURE-claude-access-0001");
    await expect(c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0002")).rejects.toBeInstanceOf(RefreshCooldownError);
    expect(calls).toBe(1);
  });

  test("claude: pi copy changing is noticed through the mtime watch set", async () => {
    const piAuth = await registerPi();
    await utimes(claudeFile(), 1_700_000_000, 1_700_000_000);
    const c = makeCache();
    expect((await c.get("claude", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0001");
    await writeFile(piAuth, JSON.stringify({ anthropic: { type: "oauth", access: "SYNTHETIC_FIXTURE-claude-pi-0002", refresh: "SYNTHETIC_FIXTURE-claude-pi-refresh", expires: 1_900_000_000_000 } }));
    await utimes(piAuth, 1_750_000_000, 1_750_000_000);
    expect((await c.get("claude", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-pi-0002");
  });

  test("claude: a pi copy rewrite is noticed even when its mtime is older than the native store's", async () => {
    const piAuth = await registerPi();
    // Native pinned far in the future and the pi copy given an explicit older mtime: a single newest-mtime key would never move.
    await utimes(claudeFile(), 2_000_000_000, 2_000_000_000);
    const c = makeCache();
    expect((await c.get("claude", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-0001");
    await writeFile(piAuth, JSON.stringify({ anthropic: { type: "oauth", access: "SYNTHETIC_FIXTURE-claude-pi-0002", refresh: "SYNTHETIC_FIXTURE-claude-pi-refresh", expires: 1_900_000_000_000 } }));
    await utimes(piAuth, 1_700_000_000, 1_700_000_000);
    expect((await c.get("claude", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-pi-0002");
  });

  test("kimi: the freshest store wins and the stale native token needs no refresh", async () => {
    const piAuth = await registerPi();
    await writeFile(piAuth, JSON.stringify({ "kimi-coding": { type: "oauth", access: "SYNTHETIC_FIXTURE-kimi-pi-0002", refresh: "SYNTHETIC_FIXTURE-kimi-pi-refresh", expires: 1_900_000_000_000 } }));
    await writeFile(registryOf("kimi"), JSON.stringify({ version: 1, identities: [{ name: "id1", label: "id1", configDir: join(work, "kimi") }] }));
    let calls = 0;
    const c = makeCache(async () => { calls++; return refreshed(); });
    expect((await c.get("kimi", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-kimi-pi-0002");
    expect((await c.refreshAfter401("kimi", "id1", "SYNTHETIC_FIXTURE-kimi-access-0001")).accessToken).toBe("SYNTHETIC_FIXTURE-kimi-pi-0002");
    expect(calls).toBe(0);
  });

  test("grok: with two account entries the one AIS refresh would pick is used", async () => {
    await writeFile(join(work, "grok", "auth.json"), JSON.stringify({
      "SYNTHETIC_FIXTURE-issuer|a": { key: "SYNTHETIC_FIXTURE-grok-a-0001", refresh_token: "SYNTHETIC_FIXTURE-grok-a-refresh", expires_at: 1_893_456_000 },
      "SYNTHETIC_FIXTURE-issuer|b": { key: "SYNTHETIC_FIXTURE-grok-b-0002", refresh_token: "SYNTHETIC_FIXTURE-grok-b-refresh", expires_at: 1_993_456_000 },
    }));
    const c = makeCache();
    expect((await c.get("grok", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-grok-b-0002");
  });

  test("refresh errors are wrapped: a lock timeout leaks no path", async () => {
    const lockPath = join(work, "claude", ".oauth_refresh.lock");
    const c = makeCache(async () => { throw new SwapLockError(`timed out waiting for lock ${lockPath}`, lockPath, true); });
    const err = await c.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001").catch((e: Error) => e);
    expect((err as Error).message).not.toContain("/");
    expect((err as { code?: string }).code).toBe("refresh-lock-timeout");
    expect((err as Error).cause).toBeInstanceOf(SwapLockError);
    const plain = makeCache(async () => { throw new Error(`boom ${lockPath}`); });
    const err2 = await plain.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001").catch((e: Error) => e);
    expect((err2 as { code?: string }).code).toBe("refresh-failed");
    expect((err2 as Error).message).not.toContain("/");
  });

  test("failed refresh and unchanged token raise errors without token values", async () => {
    const failing = makeCache(async () => refreshed({ outcome: "failed", detail: "endpoint said no" }));
    const err = await failing.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001").catch((e: Error) => e);
    expect((err as Error).message).toContain("refresh-failed");
    expect((err as Error).message).not.toContain("endpoint said no");
    expect((err as Error).message).not.toContain("SYNTHETIC_FIXTURE-claude-access-0001");
    const noop = makeCache(async () => refreshed());
    const err2 = await noop.refreshAfter401("claude", "id1", "SYNTHETIC_FIXTURE-claude-access-0001").catch((e: Error) => e);
    expect((err2 as Error).message).toMatch(/token-unchanged/);
    expect((err2 as Error).message).not.toContain("SYNTHETIC_FIXTURE-claude-access-0001");
  });

  test("non-refreshable providers (zai, ali, opencode) surface a clear error", async () => {
    let calls = 0;
    const c = makeCache(async () => { calls++; return refreshed(); });
    for (const p of ["zai", "ali", "opencode"] as const) {
      const err = await c.refreshAfter401(p, "id1", "x").catch((e: Error) => e);
      expect(err).toBeInstanceOf(NotRefreshableError);
      expect((err as Error).message).toContain(p);
      expect((err as Error).message).toMatch(/API key/);
    }
    expect(calls).toBe(0);
  });

  test("missing identity or credential gives a clear error", async () => {
    const c = new CredentialCache({ resolveConfigDir: async () => undefined });
    await expect(c.get("claude", "nope")).rejects.toThrow(/unknown-identity/);
    const d = new CredentialCache({ resolveConfigDir: async () => join(work, "empty") });
    await expect(d.get("claude", "id1")).rejects.toThrow(/login-dead/);
  });
});

describe("CredentialCache never serves a gateway app token upstream", () => {
  const GW = "aisg_SYNTHETIC_FIXTURE_gateway_token_0001";
  const writeHybrid = () => writeFile(claudeFile(), JSON.stringify({ claudeAiOauth: { accessToken: GW, refreshToken: "SYNTHETIC_FIXTURE-claude-refresh-0001", expiresAt: 4_102_444_800_000 } }));

  test("a hybrid member store is refreshed before the first send", async () => {
    await writeHybrid();
    const seen: string[] = [];
    const c = makeCache(async (_t, _i, opts) => {
      seen.push(opts?.expectedAccessToken ?? "");
      await writeClaude("SYNTHETIC_FIXTURE-claude-access-NEW", 1_800_000_100);
      return refreshed();
    });
    expect((await c.get("claude", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-NEW");
    expect(seen).toEqual([GW]);
  });

  test("a hybrid store whose refresh fails is an error, never the gateway token", async () => {
    await writeHybrid();
    const c = makeCache(async () => refreshed({ outcome: "failed" }));
    await expect(c.get("claude", "id1")).rejects.toBeInstanceOf(GatewayCredentialError);
  });

  test("an expired access token is refreshed first; if that fails the old token is still returned", async () => {
    await writeFile(claudeFile(), JSON.stringify({ claudeAiOauth: { accessToken: "SYNTHETIC_FIXTURE-claude-access-OLD", refreshToken: "SYNTHETIC_FIXTURE-claude-refresh-0001", expiresAt: 1000 } }));
    const c = makeCache(async () => refreshed({ outcome: "failed" }));
    expect((await c.get("claude", "id1")).accessToken).toBe("SYNTHETIC_FIXTURE-claude-access-OLD");
  });
});
