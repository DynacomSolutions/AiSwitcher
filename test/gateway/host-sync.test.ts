import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { grantFreshness, isFresher } from "../../src/gateway/home-mirror.ts";
import { PgHomeStore } from "../../src/gateway/home-store.ts";
import { describeHostSync, hostStoreConfig, hostSyncOnce, startHostSync } from "../../src/gateway/host-sync.ts";
import { migrate } from "../../src/gateway/pg-store.ts";
import { MemoryRefreshBackend } from "../../src/gateway/refresh-guard.ts";
import { createStoreSyncSupervisor, storeSyncConfigured, type SupervisedChild } from "../../src/sync/store-sync-supervisor.ts";

const KEY = Buffer.alloc(32, 5);
const grant = (refresh: string, expiresAtMs: number): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: `SYNTHETIC_FIXTURE-a-${refresh}`, refreshToken: `SYNTHETIC_FIXTURE-${refresh}`, expiresAt: expiresAtMs, refreshTokenExpiresAt: 2_100_000_000_000 } });
/** What Claude Code leaves after a failed refresh: tokens blanked, the refresh token's own expiry kept. */
const blanked = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0, refreshTokenExpiresAt: 2_100_000_000_000 } });

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), "ais-host-sync-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("grant freshness ignores the refresh token's own expiry", () => {
  test("a blanked login has no freshness and never beats a live grant", () => {
    expect(grantFreshness(blanked)).toBeUndefined();
    expect(grantFreshness(grant("r1", 2_000_000_000_000))).toBe(2_000_000_000);
    expect(isFresher(blanked, grant("r1", 2_000_000_000_000))).toBe(false);
    expect(isFresher(grant("r1", 2_000_000_000_000), blanked)).toBe(true);
    expect(grantFreshness(JSON.stringify({ refresh_token_expires_at: 2_100_000_000 }))).toBeUndefined();
  });
});

describe("host store config", () => {
  test("off without a database URL; env first, then ~/.secrets; the key may come from a file; errors never echo values", async () => {
    const d = await tmp();
    const secrets = join(d, "secrets");
    expect(await hostStoreConfig({}, secrets)).toBeUndefined();
    expect(await storeSyncConfigured({}, secrets)).toBe(false);
    const fromEnv = await hostStoreConfig({ AIS_GATEWAY_STORE_DATABASE_URL: "postgres://u@db.example.test/x", AIS_GATEWAY_STORE_KEY: KEY.toString("base64") }, secrets);
    expect(fromEnv?.databaseUrl).toBe("postgres://u@db.example.test/x");
    expect(fromEnv?.key.equals(KEY)).toBe(true);
    await writeFile(join(d, "key.txt"), `${KEY.toString("base64")}\n`);
    await writeFile(secrets, `export AIS_GATEWAY_STORE_DATABASE_URL="postgres://u@db.example.test/y"\nAIS_GATEWAY_STORE_KEY_FILE=${join(d, "key.txt")}\n`);
    expect(await storeSyncConfigured({}, secrets)).toBe(true);
    const fromFile = await hostStoreConfig({}, secrets);
    expect(fromFile?.databaseUrl).toBe("postgres://u@db.example.test/y");
    expect(fromFile?.key.equals(KEY)).toBe(true);
    await writeFile(secrets, "AIS_GATEWAY_STORE_DATABASE_URL=postgres://u:SYNTHETIC_FIXTURE-pw@db.example.test/y\n");
    const err = await hostStoreConfig({}, secrets).then(() => undefined, (e: Error) => e);
    expect(err?.message).toContain("AIS_GATEWAY_STORE_KEY is required");
    expect(err?.message).not.toContain("SYNTHETIC_FIXTURE");
  });
});

describe("store sync supervisor", () => {
  const fakeChild = (): SupervisedChild & { exit: (code: number) => void; signals: string[] } => {
    let exit!: (code: number) => void;
    const exited = new Promise<number>((r) => (exit = r));
    const signals: string[] = [];
    return { exited, exit, signals, kill: (s) => void signals.push(s ?? "SIGTERM") };
  };

  test("starts nothing unconfigured; one child while configured; restarts after a backoff; stops it when unconfigured or stopped", async () => {
    let t = 0;
    let configured = false;
    const children: ReturnType<typeof fakeChild>[] = [];
    const sup = createStoreSyncSupervisor({
      configured: async () => configured,
      spawn: () => {
        const c = fakeChild();
        children.push(c);
        return c;
      },
      now: () => t,
      log: () => undefined,
    });
    await sup.tick();
    expect(children).toHaveLength(0);
    configured = true;
    t += 60_000;
    await sup.tick();
    await sup.tick();
    expect(children).toHaveLength(1);
    expect(sup.running()).toBe(true);
    children[0]!.exit(1);
    await Bun.sleep(0);
    expect(sup.running()).toBe(false);
    await sup.tick();
    expect(children).toHaveLength(1); // still backing off
    t += 30_000;
    await sup.tick();
    expect(children).toHaveLength(2);
    configured = false;
    t += 60_000;
    await sup.tick();
    expect(children[1]!.signals).toEqual(["SIGTERM"]);
    configured = true;
    t += 60_000;
    await sup.tick();
    sup.stop();
    expect(children[1]!.signals.length).toBeGreaterThanOrEqual(2);
  });
});

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";

if (!url && process.env.CI && !optOut) {
  test("host sync tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  test.skip("host sync tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) throw new Error(`refusing to use database "${dbName}": its name must contain "test"`);
  const stores: PgHomeStore[] = [];
  afterAll(async () => {
    for (const s of stores) await s.close().catch(() => undefined);
  });
  const fresh = async (): Promise<PgHomeStore> => {
    await migrate(url);
    const sql = new SQL(url);
    await sql`DELETE FROM gateway_home_files`;
    await sql`DELETE FROM gateway_refresh_journal`;
    await sql.close();
    const store = new PgHomeStore(url, KEY);
    stores.push(store);
    return store;
  };
  const put = async (home: string, rel: string, text: string): Promise<void> => {
    await mkdir(dirname(join(home, rel)), { recursive: true });
    await writeFile(join(home, rel), text);
  };
  const MEMBER = ".ais/gateway-members/claude/a1/.credentials.json";
  const GROK = ".grok/identities/g1/auth.json";
  const NEW = ".kimi/identities/k1/credentials/kimi-code.json";
  const row = async (store: PgHomeStore, rel: string): Promise<string> => (await store.get([rel]))[0]!.content.toString();

  describe("host store sync", () => {
    test("a gateway refresh lands in the host file; a new host login reaches the store; a blanked host login never replaces the live one", async () => {
      const store = await fresh();
      const home = await tmp();
      // The gateway refreshed a1 and g1 (the store moved past the host files).
      await put(home, MEMBER, grant("old", 2_000_000_000_000));
      await put(home, GROK, blanked);
      await store.put(MEMBER, Buffer.from(grant("new", 2_000_000_300_000)), { account: "claude/a1", kind: "login", expectedVersion: null });
      await store.put(GROK, Buffer.from(grant("g-live", 2_000_000_300_000)), { account: "grok/g1", kind: "login", expectedVersion: null });
      // A login made on the host only.
      await put(home, NEW, grant("k-host", 2_000_000_100_000));
      const lock = new MemoryRefreshBackend();
      const r = await hostSyncOnce(undefined, { home, store, lock, importEntries: async () => [{ abs: join(home, NEW), account: "kimi/k1", kind: "login" }, { abs: join(home, GROK), account: "grok/g1", kind: "login" }] });
      expect(await readFile(join(home, MEMBER), "utf8")).toContain("SYNTHETIC_FIXTURE-new");
      expect(await readFile(join(home, GROK), "utf8")).toContain("SYNTHETIC_FIXTURE-g-live");
      expect(await row(store, GROK)).toContain("SYNTHETIC_FIXTURE-g-live");
      expect(await row(store, NEW)).toContain("SYNTHETIC_FIXTURE-k-host");
      expect(r.imported.added).toEqual([NEW]);
      expect(r.wrote).toBe(2);
      const line = describeHostSync(r);
      expect(line).not.toContain("SYNTHETIC_FIXTURE");
      expect(line).toContain("2 written from the store");
    });

    test("a host refresh newer than the store is pushed; an older one is overwritten (newest token wins)", async () => {
      const store = await fresh();
      const home = await tmp();
      await store.put(MEMBER, Buffer.from(grant("s1", 2_000_000_100_000)), { account: "claude/a1", kind: "login", expectedVersion: null });
      await store.put(GROK, Buffer.from(grant("s2", 2_000_000_500_000)), { account: "grok/g1", kind: "login", expectedVersion: null });
      await put(home, MEMBER, grant("h1", 2_000_000_200_000));
      await put(home, GROK, grant("h2", 2_000_000_400_000));
      await hostSyncOnce(undefined, { home, store, lock: new MemoryRefreshBackend(), importEntries: async () => [] });
      expect(await row(store, MEMBER)).toContain("SYNTHETIC_FIXTURE-h1");
      expect(await readFile(join(home, GROK), "utf8")).toContain("SYNTHETIC_FIXTURE-s2");
      expect(await row(store, GROK)).toContain("SYNTHETIC_FIXTURE-s2");
    });

    test("the running sync follows later gateway refreshes and pushes later host edits", async () => {
      const store = await fresh();
      const home = await tmp();
      await store.put(MEMBER, Buffer.from(grant("v1", 2_000_000_100_000)), { account: "claude/a1", kind: "login", expectedVersion: null });
      const sync = startHostSync(undefined, { home, store, lock: new MemoryRefreshBackend(), importEntries: async () => [], pollMs: 50, warn: () => undefined });
      await sync.ready;
      expect(await readFile(join(home, MEMBER), "utf8")).toContain("v1");
      const [cur] = await store.get([MEMBER]);
      await store.put(MEMBER, Buffer.from(grant("v2", 2_000_000_200_000)), { account: "claude/a1", kind: "login", expectedVersion: cur!.version });
      for (let i = 0; i < 60 && !(await readFile(join(home, MEMBER), "utf8")).includes("v2"); i++) await Bun.sleep(50);
      expect(await readFile(join(home, MEMBER), "utf8")).toContain("v2");
      await put(home, MEMBER, grant("v3", 2_000_000_300_000));
      for (let i = 0; i < 60 && !(await row(store, MEMBER)).includes("v3"); i++) await Bun.sleep(50);
      expect(await row(store, MEMBER)).toContain("v3");
      await sync.stop();
    });
  });
}
