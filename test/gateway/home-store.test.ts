import { afterAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { credentialStoreFromEnv, replicaUrlFromEnv } from "../../src/cli/gateway/dispatch.ts";
import { grantFreshness, HomeMirror, isFresher, refreshFingerprints } from "../../src/gateway/home-mirror.ts";
import { createOwnershipCheck, decryptFile, encryptFile, parseStoreKey, PgHomeStore } from "../../src/gateway/home-store.ts";
import { PgLeader } from "../../src/gateway/pg-leader.ts";
import { migrate } from "../../src/gateway/pg-store.ts";

const KEY = Buffer.alloc(32, 3);
const grant = (refresh: string, expiresAtMs: number): string => JSON.stringify({ claudeAiOauth: { accessToken: `SYNTHETIC_FIXTURE-a-${refresh}`, refreshToken: `SYNTHETIC_FIXTURE-${refresh}`, expiresAt: expiresAtMs } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("store key and encryption", () => {
  test("base64 and hex keys of 32 bytes parse; others are refused without echoing the value", () => {
    expect(parseStoreKey(KEY.toString("base64")).equals(KEY)).toBe(true);
    expect(parseStoreKey(KEY.toString("hex")).equals(KEY)).toBe(true);
    expect(() => parseStoreKey(undefined)).toThrow("AIS_GATEWAY_STORE_KEY is required");
    expect(() => parseStoreKey("c2hvcnQ=")).toThrow("must decode to 32 bytes");
  });

  test("a row decrypts only with its key and at its own path", () => {
    const c = encryptFile(KEY, "a/b.json", Buffer.from("secret"));
    expect(decryptFile(KEY, "a/b.json", c).toString()).toBe("secret");
    expect(() => decryptFile(Buffer.alloc(32, 4), "a/b.json", c)).toThrow("does not decrypt");
    expect(() => decryptFile(KEY, "a/other.json", c)).toThrow("does not decrypt");
  });
});

describe("grant freshness", () => {
  test("reads claude ms expiries, codex last_refresh and JWT exp, and refresh-token fingerprints", () => {
    expect(grantFreshness(grant("r1", 2_000_000_000_000))).toBe(2_000_000_000);
    const jwt = `x.${Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString("base64url")}.y`;
    expect(grantFreshness(JSON.stringify({ tokens: { access_token: jwt, refresh_token: "SYNTHETIC_FIXTURE-r" }, last_refresh: "2026-01-01T00:00:00Z" }))).toBe(1_900_000_000);
    expect(isFresher(grant("r2", 2_000_000_000_001), grant("r1", 2_000_000_000_000))).toBe(true);
    expect(isFresher(grant("r1", 2_000_000_000_000), grant("r2", 2_000_000_000_000))).toBe(false);
    expect(refreshFingerprints(grant("r1", 1))).toHaveLength(1);
  });
});

describe("env", () => {
  test("files is the default; pg needs the key; the replica URL comes from POD_IP", () => {
    expect(credentialStoreFromEnv({})).toBeUndefined();
    expect(() => credentialStoreFromEnv({ AIS_GATEWAY_CREDENTIAL_STORE: "pg" })).toThrow("AIS_GATEWAY_STORE_KEY");
    expect(() => credentialStoreFromEnv({ AIS_GATEWAY_CREDENTIAL_STORE: "nfs" })).toThrow('"pg" or "files"');
    const s = credentialStoreFromEnv({ AIS_GATEWAY_CREDENTIAL_STORE: "pg", AIS_GATEWAY_STORE_KEY: KEY.toString("base64"), AIS_GATEWAY_FILE_STORE: "1" });
    expect(s?.fileStore).toBe(true);
    expect(s?.importOnStart).toBe(false);
    expect(replicaUrlFromEnv({}, 47131)).toBeUndefined();
    expect(replicaUrlFromEnv({ POD_IP: "192.0.2.4" }, 47131)).toBe("http://192.0.2.4:47131");
    expect(replicaUrlFromEnv({ POD_IP: "2001:db8::1" }, 47131)).toBe("http://[2001:db8::1]:47131");
    expect(replicaUrlFromEnv({ AIS_GATEWAY_REPLICA_URL: "http://gw-0.example.test:47131/" }, 1)).toBe("http://gw-0.example.test:47131");
  });
});

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";

if (!url && process.env.CI && !optOut) {
  test("home store tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  test.skip("home store tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) throw new Error(`refusing to use database "${dbName}": its name must contain "test"`);
  const dirs: string[] = [];
  const stores: PgHomeStore[] = [];
  afterAll(async () => {
    for (const s of stores) await s.close().catch(() => undefined);
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const fresh = async (): Promise<{ store: PgHomeStore; home: () => Promise<string> }> => {
    await migrate(url);
    const sql = new SQL(url);
    await sql`DELETE FROM gateway_home_files`;
    await sql.close();
    const store = new PgHomeStore(url, KEY);
    stores.push(store);
    return {
      store,
      home: async () => {
        const d = await mkdtemp(join(tmpdir(), "ais-home-store-"));
        dirs.push(d);
        return d;
      },
    };
  };
  const put = async (home: string, rel: string, text: string): Promise<void> => {
    await mkdir(dirname(join(home, rel)), { recursive: true });
    await writeFile(join(home, rel), text);
  };
  const LOGIN = ".ais/gateway-members/claude/a1/.credentials.json";

  describe("HomeMirror", () => {
    test("compare-and-swap: a stale writer is refused and told the current version", async () => {
      const { store } = await fresh();
      const first = await store.put("x.json", Buffer.from("1"), { account: null, kind: "registry", expectedVersion: null });
      expect(first.ok).toBe(true);
      expect((await store.put("x.json", Buffer.from("2"), { account: null, kind: "registry", expectedVersion: null })).ok).toBe(false);
      const v = first.ok ? first.version : 0;
      expect((await store.put("x.json", Buffer.from("2"), { account: null, kind: "registry", expectedVersion: v })).ok).toBe(true);
      const stale = await store.put("x.json", Buffer.from("3"), { account: null, kind: "registry", expectedVersion: v });
      expect(stale.ok).toBe(false);
    });

    test("scratch replicas follow the store; a local refresh is pushed; NOTIFY carries it to the other replica", async () => {
      const { store, home } = await fresh();
      await store.put(LOGIN, Buffer.from(grant("r0", 2_000_000_000_000)), { account: "claude/a1", kind: "login", expectedVersion: null });
      const [ha, hb] = [await home(), await home()];
      const a = new HomeMirror(store, { home: ha });
      const b = new HomeMirror(store, { home: hb });
      await a.pullAll();
      await b.pullAll();
      await b.start(60_000);
      expect(await readFile(join(hb, LOGIN), "utf8")).toContain("r0");
      // A refresh on A writes the file and pushes it.
      await put(ha, LOGIN, grant("r1", 2_000_000_100_000));
      await a.push([join(ha, LOGIN)], "claude/a1", "login");
      for (let i = 0; i < 40 && !(await readFile(join(hb, LOGIN), "utf8")).includes("r1"); i++) await sleep(50);
      expect(await readFile(join(hb, LOGIN), "utf8")).toContain("r1");
      await b.stop();
      expect((await store.ownedAccounts()).has("claude/a1")).toBe(true);
    });

    test("a push that loses the race keeps the fresher grant; an older local copy is overwritten", async () => {
      const { store, home } = await fresh();
      await store.put(LOGIN, Buffer.from(grant("r0", 2_000_000_000_000)), { account: "claude/a1", kind: "login", expectedVersion: null });
      const ha = await home();
      const a = new HomeMirror(store, { home: ha });
      await a.pullAll();
      // Another replica moved the store to r2 meanwhile; A's local r1 is older than r2.
      await store.put(LOGIN, Buffer.from(grant("r2", 2_000_000_200_000)), { account: "claude/a1", kind: "login" });
      await put(ha, LOGIN, grant("r1", 2_000_000_100_000));
      await a.push([join(ha, LOGIN)], "claude/a1", "login");
      expect(await readFile(join(ha, LOGIN), "utf8")).toContain("r2");
      expect((await store.get([LOGIN]))[0]!.content.toString()).toContain("r2");
    });

    test("file store: host registries win, a fresher store grant is written back, derived files never land on the host", async () => {
      const { store, home } = await fresh();
      const h = await home();
      await put(h, ".claude/identities.json", '{"host":true}');
      await put(h, LOGIN, grant("r0", 2_000_000_000_000));
      await store.put(".claude/identities.json", Buffer.from('{"store":true}'), { account: null, kind: "registry", expectedVersion: null });
      await store.put(LOGIN, Buffer.from(grant("r5", 2_000_000_500_000)), { account: "claude/a1", kind: "login", expectedVersion: null });
      await store.put(".opencode/identities/o1/data/opencode/ais-gateway-key.json", Buffer.from("{}"), { account: "opencode/o1", kind: "derived", expectedVersion: null });
      const m = new HomeMirror(store, { home: h, fileStore: true });
      await m.pullAll();
      expect(await readFile(join(h, ".claude/identities.json"), "utf8")).toBe('{"host":true}');
      expect((await store.get([".claude/identities.json"]))[0]!.content.toString()).toBe('{"host":true}');
      expect(await readFile(join(h, LOGIN), "utf8")).toContain("r5");
      expect(m.has(".opencode/identities/o1/data/opencode/ais-gateway-key.json")).toBe(false);
      // A login made on the host later (fresher) is imported by the next pass.
      await put(h, LOGIN, grant("r9", 2_000_000_900_000));
      await m.pushDirty();
      expect((await store.get([LOGIN]))[0]!.content.toString()).toContain("r9");
    });

    test("the console's ownership check lists store-owned logins and fails closed when unreachable", async () => {
      const { store } = await fresh();
      await store.put(LOGIN, Buffer.from(grant("r0", 1)), { account: "claude/a1", kind: "login", expectedVersion: null });
      const ok = createOwnershipCheck(url);
      expect((await ok.owned())?.has("claude/a1")).toBe(true);
      await ok.close();
      const down = createOwnershipCheck("postgres://postgres@127.0.0.1:1/gateway_test");
      expect(await down.owned()).toBeUndefined();
      await down.close();
    });
  });

  describe("shared pi auth.json, stop and bad rows", () => {
    const PI = ".pi/agent/auth.json";
    const entry = (name: string, expires: number) => ({ type: "oauth", refresh: `SYNTHETIC_FIXTURE-${name}`, access: `SYNTHETIC_FIXTURE-access-${name}`, expires });
    const pi = (a: number, c: number, an = "an", cx = "cx") => JSON.stringify({ anthropic: entry(an, a), "openai-codex": entry(cx, c) });

    test("two replicas rotating different provider entries both survive", async () => {
      const { store, home } = await fresh();
      await store.put(PI, Buffer.from(pi(1_000, 1_000)), { account: "pi/p1", kind: "login", expectedVersion: null });
      const [ha, hb] = [await home(), await home()];
      const a = new HomeMirror(store, { home: ha });
      const b = new HomeMirror(store, { home: hb });
      await a.pullAll();
      await b.pullAll();
      await put(ha, PI, pi(2_000, 1_000, "an2"));
      await put(hb, PI, pi(1_000, 2_000, "an", "cx2"));
      await a.push([join(ha, PI)], "pi/p1", "login");
      await b.push([join(hb, PI)], "pi/p1", "login");
      const row = JSON.parse((await store.get([PI]))[0]!.content.toString());
      expect(row.anthropic.refresh).toBe("SYNTHETIC_FIXTURE-an2");
      expect(row["openai-codex"].refresh).toBe("SYNTHETIC_FIXTURE-cx2");
      expect(JSON.parse(await readFile(join(hb, PI), "utf8")).anthropic.refresh).toBe("SYNTHETIC_FIXTURE-an2");
    });

    test("push throws when the store refuses and the conflict is not resolved", async () => {
      const { store, home } = await fresh();
      await store.put(LOGIN, Buffer.from(grant("r0", 2_000_000_000_000)), { account: "claude/a1", kind: "login", expectedVersion: null });
      const h = await home();
      const m = new HomeMirror(store, { home: h });
      await m.pullAll();
      await put(h, LOGIN, grant("r1", 2_000_000_100_000));
      const real = store.put.bind(store);
      store.put = async () => ({ ok: false });
      await expect(m.push([join(h, LOGIN)], "claude/a1", "login")).rejects.toThrow();
      store.put = real;
    });

    test("stop pushes a rotation whose push failed earlier; pushAccountDirty pushes only the account's files", async () => {
      const { store, home } = await fresh();
      await store.put(LOGIN, Buffer.from(grant("r0", 2_000_000_000_000)), { account: "claude/a1", kind: "login", expectedVersion: null });
      const h = await home();
      const m = new HomeMirror(store, { home: h });
      await m.pullAll();
      await put(h, LOGIN, grant("r1", 2_000_000_100_000));
      await m.pushAccountDirty("claude/other");
      expect((await store.get([LOGIN]))[0]!.content.toString()).toContain("r0");
      await m.stop();
      expect((await store.get([LOGIN]))[0]!.content.toString()).toContain("r1");
    });

    test("a row that does not decrypt is skipped and the others are returned", async () => {
      const { store } = await fresh();
      const warns: string[] = [];
      const other = new PgHomeStore(url, Buffer.alloc(32, 9), "t", (m) => void warns.push(m));
      stores.push(other);
      const mine = new PgHomeStore(url, KEY, "t", (m) => void warns.push(m));
      stores.push(mine);
      await store.put(LOGIN, Buffer.from(grant("r0", 1)), { account: "claude/a1", kind: "login", expectedVersion: null });
      await other.put("bad/path.json", Buffer.from("x"), { account: "claude/a1", kind: "login", expectedVersion: null });
      const got = await mine.get([LOGIN, "bad/path.json"]);
      expect(got.map((r) => r.path)).toEqual([LOGIN]);
      expect((await mine.getAccount("claude/a1")).map((r) => r.path)).toEqual([LOGIN]);
      expect(warns.length).toBeGreaterThan(0);
      expect(warns.join("\n")).toContain("bad/path.json");
      expect(warns.join("\n")).not.toContain("SYNTHETIC_FIXTURE");
    });
  });

  describe("PgLeader", () => {
    test("one leader at a time; the next takes over when it goes", async () => {
      const a = new PgLeader(url, 60_000);
      const b = new PgLeader(url, 60_000);
      const [la, lb] = [await a.tick(), await b.tick()];
      expect([la, lb].filter(Boolean)).toHaveLength(1);
      const [leader, other] = la ? [a, b] : [b, a];
      await leader.stop();
      expect(await other.tick()).toBe(true);
      await other.stop();
    });
  });
}
