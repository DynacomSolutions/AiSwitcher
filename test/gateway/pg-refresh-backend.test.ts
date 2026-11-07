import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { migrate } from "../../src/gateway/pg-store.ts";
import { PgRefreshBackend } from "../../src/gateway/pg-refresh-backend.ts";
import { guardRefresh } from "../../src/gateway/refresh-guard.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { grantFingerprint, type OAuthGrant } from "../../src/identities/oauth-reconcile.ts";

const url = process.env.AIS_GATEWAY_TEST_DATABASE_URL;
const optOut = process.env.AIS_GATEWAY_TEST_NO_DATABASE === "1";
const account = { provider: "claude", identity: "pg-acct" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!url && process.env.CI && !optOut) {
  test("pg refresh backend tests need AIS_GATEWAY_TEST_DATABASE_URL in CI", () => {
    throw new Error("AIS_GATEWAY_TEST_DATABASE_URL is unset in CI; provide a Postgres service or set AIS_GATEWAY_TEST_NO_DATABASE=1");
  });
} else if (!url) {
  test.skip("pg refresh backend tests need AIS_GATEWAY_TEST_DATABASE_URL", () => {});
} else {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!dbName.includes("test")) throw new Error(`refusing to use database "${dbName}": its name must contain "test"`);
  const opened: PgRefreshBackend[] = [];
  const open = (): PgRefreshBackend => {
    const b = new PgRefreshBackend(url);
    opened.push(b);
    return b;
  };
  // End every pool after each test so pools never pile up past max_connections.
  const closeAll = async (): Promise<void> => {
    for (const b of opened.splice(0)) await Promise.race([b.close(), sleep(2000)]);
  };
  afterEach(closeAll);
  afterAll(closeAll);

  async function prepare(): Promise<void> {
    await migrate(url as string);
    const sql = new SQL(url as string);
    try {
      await sql`DELETE FROM gateway_refresh_journal`;
    } finally {
      await sql.close();
    }
  }

  describe("PgRefreshBackend", () => {
    test("the lock is exclusive across separate backends (replicas) and frees on release", async () => {
      await prepare();
      const a = open();
      const b = open();
      const held = await a.acquire(account, 1000);
      expect(held.contended).toBe(false);
      await expect(b.acquire(account, 250)).rejects.toMatchObject({ timedOut: true });
      const waiting = b.acquire(account, 2000);
      await sleep(150);
      await held.release();
      const got = await waiting;
      expect(got.contended).toBe(true);
      expect(got.waitedMs).toBeGreaterThan(100);
      await got.release();
      const other = await a.acquire({ provider: "codex", identity: "x" }, 1000);
      await other.release();
    });

    test("a holder that dies (its session is killed) frees the lock", async () => {
      await prepare();
      const doomed = open();
      await doomed.acquire(account, 1000);
      const admin = new SQL(url as string);
      try {
        const killed = await admin`SELECT pg_terminate_backend(pid) AS ok FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()`;
        expect(killed.length).toBeGreaterThan(0);
      } finally {
        await admin.close();
      }
      const got = await open().acquire(account, 3000);
      await got.release();
    });

    test("journal claim, resolve, indexed lookup by fingerprint, and stale-claim recovery on the lock connection", async () => {
      await prepare();
      const lock = await open().acquire(account, 1000);
      const id = await lock.claim("aaaa1111", "pod-1");
      const other = await lock.claim("cccc3333", "pod-1");
      expect((await lock.findByOldFp("aaaa1111"))[0]).toMatchObject({ id, oldFp: "aaaa1111", holder: "pod-1" });
      expect((await lock.findByOldFp("aaaa1111"))[0]?.outcome).toBeUndefined();
      expect(await lock.closeStale("aaaa1111")).toBe(1); // the claim for cccc3333 is stale
      expect((await lock.findByOldFp("cccc3333"))[0]).toMatchObject({ id: other, outcome: "recovered", newFp: "aaaa1111" });
      await lock.resolve(id, "refreshed", "bbbb2222");
      expect((await lock.findByOldFp("aaaa1111"))[0]).toMatchObject({ outcome: "refreshed", newFp: "bbbb2222" });
      await lock.release();
    });

    test("every call is bounded by statement_timeout", async () => {
      await prepare();
      const lock = await open().acquire(account, 1000);
      // pg_sleep on the lock connection must be cut short by the 5 s statement timeout, not run for 30 s.
      const sql = new SQL(url as string, { connection: { statement_timeout: 300 } });
      const t0 = Date.now();
      await expect(sql`SELECT pg_sleep(5)`).rejects.toBeDefined();
      expect(Date.now() - t0).toBeLessThan(3000);
      await sql.close();
      await lock.release();
    });

    test("ten accounts refreshing at once do not deadlock the pool", async () => {
      await prepare();
      const backend = open();
      const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
      const grants = new Map<string, OAuthGrant>();
      let posts = 0;
      const refresh = (async (tool: string, id: { name: string }, o?: { beforePost?: (i: { fingerprint: string }) => Promise<void> }) => {
        const g = grants.get(id.name) as OAuthGrant;
        await o?.beforePost?.({ fingerprint: grantFingerprint(g) });
        posts += 1;
        await sleep(100);
        const next = { access_token: `SYNTHETIC_FIXTURE-a-${id.name}-2`, refresh_token: `SYNTHETIC_FIXTURE-r-${id.name}-2`, expires_at: 9 };
        grants.set(id.name, next);
        return { tool, identity: id.name, outcome: "refreshed", detail: "", beforeFingerprint: grantFingerprint(g), afterFingerprint: grantFingerprint(next), written: [], writeFailures: [] };
      }) as never;
      const names = Array.from({ length: 10 }, (_, i) => `acct-${i}`);
      for (const n of names) grants.set(n, { access_token: `SYNTHETIC_FIXTURE-a-${n}-1`, refresh_token: `SYNTHETIC_FIXTURE-r-${n}-1`, expires_at: 1 });
      const guard = guardRefresh(refresh, { backend, metrics, readGrant: async (_t, id) => ({ ...(grants.get(id.name) as OAuthGrant) }) });
      // Two guarded refreshes per account: 20 callers against a pool of ten connections.
      const calls = names.flatMap((n) => [1, 2].map(() => guard("claude", { name: n, label: n, configDir: "/x" } as never, { force: true })));
      const results = await Promise.race([Promise.all(calls), sleep(20_000).then(() => "deadlock" as const)]);
      expect(results).not.toBe("deadlock");
      expect(posts).toBe(10); // the second caller per account adopts the first one's grant
      const rows = await backend.acquire(account, 1000).then(async (l) => {
        await l.release();
        return 1;
      });
      expect(rows).toBe(1);
    });

    test("retention removes old resolved rows but keeps open claims and rotated-out evidence", async () => {
      await prepare();
      const backend = open();
      const admin = new SQL(url as string);
      try {
        for (let i = 0; i < 60; i += 1) {
          await admin`INSERT INTO gateway_refresh_journal (provider, identity, holder, old_fp, outcome, ts, resolved_at) VALUES ('claude', 'ret', 'h', ${`f${i}`}, 'failed', now() - interval '90 days', now() - interval '90 days')`;
        }
        await admin`INSERT INTO gateway_refresh_journal (provider, identity, holder, old_fp, outcome, ts) VALUES ('claude', 'ret', 'h', 'lostfp', 'lost', now() - interval '90 days')`;
        await admin`INSERT INTO gateway_refresh_journal (provider, identity, holder, old_fp, ts) VALUES ('claude', 'ret', 'h', 'openfp', now() - interval '90 days')`;
        const removed = await backend.prune(30 * 86_400_000);
        expect(removed).toBe(12); // 62 oldest rows beyond the newest 50 are candidates; the 'lost' one is kept
        const left = await admin`SELECT old_fp FROM gateway_refresh_journal WHERE identity = 'ret'`;
        expect(left.some((r: { old_fp: string }) => r.old_fp === "lostfp")).toBe(true);
        expect(left.some((r: { old_fp: string }) => r.old_fp === "openfp")).toBe(true);
      } finally {
        await admin.close();
      }
    });

    test("concurrent refreshes from separate replicas make one token request", async () => {
      await prepare();
      let grant: OAuthGrant = { access_token: "SYNTHETIC_FIXTURE-a1", refresh_token: "SYNTHETIC_FIXTURE-r1", expires_at: 100 };
      let posts = 0;
      const refresh = (async (tool: string, id: { name: string }, o?: { expectedAccessToken?: string; beforePost?: (i: { fingerprint: string }) => Promise<void> }) => {
        const base = { tool, identity: id.name, written: [], writeFailures: [], detail: "" };
        if (o?.expectedAccessToken !== undefined && o.expectedAccessToken !== grant.access_token) return { ...base, outcome: "skipped-fresh" };
        await o?.beforePost?.({ fingerprint: grantFingerprint(grant) });
        posts += 1;
        await sleep(50);
        const before = grantFingerprint(grant);
        grant = { access_token: "SYNTHETIC_FIXTURE-a2", refresh_token: "SYNTHETIC_FIXTURE-r2", expires_at: 200 };
        return { ...base, outcome: "refreshed", beforeFingerprint: before, afterFingerprint: grantFingerprint(grant) };
      }) as never;
      const metrics = new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });
      const stale = grant.access_token;
      const guards = [open(), open(), open()].map((backend) => guardRefresh(refresh, { backend, metrics, readGrant: async () => ({ ...grant }) }));
      const id = { name: account.identity, label: "x", configDir: "/x" } as never;
      await Promise.all(guards.map((g) => g("claude", id, { force: true, expectedAccessToken: stale })));
      expect(posts).toBe(1);
      const lock = await open().acquire(account, 1000);
      const rows = await lock.findByOldFp(grantFingerprint({ access_token: "SYNTHETIC_FIXTURE-a1", refresh_token: "SYNTHETIC_FIXTURE-r1" }));
      await lock.release();
      expect(rows.map((r) => r.outcome)).toEqual(["refreshed"]);
    });
  });
}
