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

    /** A stand-in pooler in front of the test database. `rule` sees each client chunk: reject the startup, drop the link, or forward. */
    function startPooler(rule: (chunk: Buffer, first: boolean) => "reject" | "drop" | "swallow" | "forward") {
      const target = new URL(url as string);
      const proxy = Bun.listen<{ up?: Awaited<ReturnType<typeof Bun.connect>>; first: boolean }>({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          open(sock) {
            sock.data = { first: true };
          },
          async data(sock, chunk) {
            const first = sock.data.first;
            sock.data.first = false;
            const verdict = rule(Buffer.from(chunk), first);
            if (verdict === "reject") {
              const msg = Buffer.from("unsupported startup parameter: statement_timeout\0");
              const fields = Buffer.concat([Buffer.from("SFATAL\0C08P01\0M"), msg, Buffer.from("\0")]);
              const head = Buffer.alloc(5);
              head.write("E");
              head.writeInt32BE(4 + fields.length, 1);
              sock.write(Buffer.concat([head, fields]));
              sock.end();
              return;
            }
            if (verdict === "swallow") return; // never answered: the client's request hangs on a live connection
            if (verdict === "drop") {
              sock.data.up?.end();
              sock.end();
              return;
            }
            if (first) {
              sock.data.up = await Bun.connect({
                hostname: target.hostname,
                port: Number(target.port),
                socket: {
                  data(_up, d) {
                    sock.write(d);
                  },
                  close() {
                    sock.end();
                  },
                },
              });
            }
            sock.data.up?.write(chunk);
          },
          close(sock) {
            sock.data.up?.end();
          },
        },
      });
      const via = new URL(url as string);
      via.hostname = "127.0.0.1";
      via.port = String(proxy.port);
      return { proxy, via: via.toString() };
    }

    test("works through a pooler that rejects startup parameters (PgBouncer): no statement_timeout is sent at startup", async () => {
      await prepare();
      const { proxy, via } = startPooler((chunk, first) => (first && chunk.includes("statement_timeout") ? "reject" : "forward"));
      try {
        const backend = new PgRefreshBackend(via);
        opened.push(backend);
        const lock = await backend.acquire(account, 3000);
        const id = await lock.claim("pool0001", "pod-1");
        await lock.resolve(id, "failed");
        expect((await lock.findByOldFp("pool0001"))[0]).toMatchObject({ outcome: "failed" });
        await lock.release();
        // And the pooler really does refuse what the old code sent, so this test would have caught it.
        const old = new SQL(via, { connection: { statement_timeout: 5000 } });
        await expect(old`SELECT 1`).rejects.toThrow(/unsupported startup parameter/);
        await old.close().catch(() => undefined);
      } finally {
        proxy.stop(true);
      }
    });

    test("a connection whose RESET statement_timeout fails is closed, not returned to the pool", async () => {
      await prepare();
      let resets = 0;
      const { proxy, via } = startPooler((chunk) => {
        if (chunk.includes("RESET statement_timeout")) {
          resets += 1;
          return "swallow";
        }
        return "forward";
      });
      try {
        const backend = new PgRefreshBackend(via, 300);
        opened.push(backend);
        // More cycles than the pool has connections: a broken connection handed back would poison later acquires.
        for (let i = 0; i < 12; i += 1) {
          const lock = await backend.acquire(account, 3000);
          await lock.release();
        }
        expect(resets).toBe(12);
        const lock = await backend.acquire(account, 3000);
        const id = await lock.claim("reset001", "pod-1");
        expect(id).toBeGreaterThan(0);
        await lock.release();
      } finally {
        proxy.stop(true);
      }
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

    test("acquires that time out never leak a connection or the lock", async () => {
      await prepare();
      const holder = open();
      const waiter = open();
      const held = await holder.acquire(account, 1000);
      // More timed-out acquires than the pool has connections: a leak would exhaust it.
      for (let i = 0; i < 14; i += 1) await expect(waiter.acquire(account, 120)).rejects.toMatchObject({ timedOut: true });
      await held.release();
      const got = await waiter.acquire(account, 2000);
      await got.release();
      // A deadline that has already passed never reserves or locks anything.
      await expect(waiter.acquire(account, 0)).rejects.toMatchObject({ timedOut: true });
      const again = await waiter.acquire(account, 2000);
      await again.release();
    });

    test("resolveFresh writes through the pool, not the lock's connection", async () => {
      await prepare();
      const lock = await open().acquire(account, 1000);
      const id = await lock.claim("fresh001", "pod-1");
      await lock.resolveFresh?.(id, "failed");
      expect((await lock.findByOldFp("fresh001"))[0]).toMatchObject({ outcome: "failed" });
      await lock.release();
    });

    test("retention removes old resolved rows but keeps open claims and rotated-out evidence for longer", async () => {
      await prepare();
      const backend = open();
      const admin = new SQL(url as string);
      const old = async (fp: string, outcome: string | null, days: number): Promise<void> => {
        await admin`INSERT INTO gateway_refresh_journal (provider, identity, holder, old_fp, new_fp, outcome, ts, resolved_at)
          VALUES ('claude', 'ret', 'h', ${fp}, ${outcome === "refreshed" ? "n" : null}, ${outcome}, now() - make_interval(days => ${days}), ${outcome === null ? null : new Date()})`;
      };
      try {
        await old("evid90", "refreshed", 90);
        await old("evid400", "refreshed", 400);
        await old("lostfp", "lost", 90);
        await old("openfp", null, 90);
        for (let i = 0; i < 60; i += 1) await old(`plain${i}`, "failed", 90);
        for (let i = 0; i < 50; i += 1) await old(`new${i}`, "failed", 0);
        const removed = await backend.prune(30 * 86_400_000);
        expect(removed).toBe(61); // 60 plain rows and evid400; evid90, lost and open stay
        const left = (await admin`SELECT old_fp FROM gateway_refresh_journal WHERE identity = 'ret'`).map((r: { old_fp: string }) => r.old_fp);
        for (const keep of ["evid90", "lostfp", "openfp", "new0"]) expect(left).toContain(keep);
        expect(left).not.toContain("evid400");
        expect(left).not.toContain("plain3");
      } finally {
        await admin.close();
      }
    }, 30_000);

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
