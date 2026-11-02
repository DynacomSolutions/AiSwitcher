import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CredentialCache, NotRefreshableError, RefreshCooldownError, type RefreshFn } from "../../src/gateway/credentials.ts";
import { refreshIdentityOAuthGrant } from "../../src/identities/oauth-refresh.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "gateway");
const SCRATCH = join(import.meta.dir, ".tmp");
const ANTHROPIC_TOKEN_HOST = "platform.claude.com";

let work = "";
beforeEach(async () => {
  await mkdir(SCRATCH, { recursive: true });
  work = await mkdtemp(join(SCRATCH, "gw-cred-"));
  await cp(FIXTURES, work, { recursive: true });
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

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
  });

  test("retired identities are rejected without leaking the token", async () => {
    const c = new CredentialCache({ resolveIdentity: async () => ({ name: "id1", label: "id1", configDir: join(work, "claude"), retired: true }) });
    const err = await c.get("claude", "id1").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/retired/);
    expect((err as Error).message).not.toContain("SYNTHETIC_FIXTURE");
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
    await expect(d.get("claude", "id1")).rejects.toThrow(/no-credential/);
  });
});
