import { describe, expect, test } from "bun:test";
import type { OAuthGrant } from "../../src/identities/oauth-reconcile.ts";
import { grantFingerprint } from "../../src/identities/oauth-reconcile.ts";
import { OAuthRefreshError, type IdentityGrantRefresh } from "../../src/identities/oauth-refresh.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { guardRefresh, MemoryRefreshBackend, RefreshGuardRetryable, type RefreshGuardBackend } from "../../src/gateway/refresh-guard.ts";

const ID = { name: "acct1", label: "acct1", configDir: "/x" } as never;
const ACCOUNT = { provider: "claude", identity: "acct1" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake provider and store: every POST rotates the refresh token, and a reused token is counted. A non-forced call is a no-op pass. */
function world(opts: { postMs?: number; failWrite?: boolean; crashAfterPost?: boolean } = {}) {
  let seq = 1;
  let grant: OAuthGrant = { access_token: "SYNTHETIC_FIXTURE-access-1", refresh_token: "SYNTHETIC_FIXTURE-refresh-1", expires_at: 1000 };
  const spent = new Set<string>();
  const w = {
    posts: 0,
    reusedTokenPosts: 0,
    get grant() {
      return grant;
    },
    set grant(g: OAuthGrant) {
      grant = g;
    },
    read: async () => ({ ...grant }),
    refresh: (async (
      tool: string,
      id: { name: string },
      o?: { force?: boolean; expectedAccessToken?: string; beforePost?: (i: { fingerprint: string }) => Promise<void> },
    ): Promise<IdentityGrantRefresh> => {
      const base = { tool, identity: id.name, written: [], writeFailures: [], detail: "" } as never as IdentityGrantRefresh;
      if (!o?.force) return { ...base, outcome: "skipped-fresh", detail: "not due" };
      if (o.expectedAccessToken !== undefined && o.expectedAccessToken !== grant.access_token) return { ...base, outcome: "skipped-fresh" };
      await o.beforePost?.({ fingerprint: grantFingerprint(grant) });
      const used = grant.refresh_token as string;
      w.posts += 1;
      if (spent.has(used)) w.reusedTokenPosts += 1;
      spent.add(used);
      await sleep(opts.postMs ?? 5);
      if (opts.crashAfterPost) throw new Error("process died");
      seq += 1;
      const next: OAuthGrant = { access_token: `SYNTHETIC_FIXTURE-access-${seq}`, refresh_token: `SYNTHETIC_FIXTURE-refresh-${seq}`, expires_at: 1000 + seq };
      const before = grantFingerprint(grant);
      if (opts.failWrite) return { ...base, outcome: "failed", beforeFingerprint: before, afterFingerprint: grantFingerprint(next) };
      grant = next;
      return { ...base, outcome: "refreshed", beforeFingerprint: before, afterFingerprint: grantFingerprint(next) };
    }) as never,
  };
  return w;
}

const metricsOf = () => new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });

/** Leaves a claim unresolved, as a pod that died mid-refresh would. */
async function seedOpenClaim(backend: MemoryRefreshBackend, fp: string): Promise<void> {
  const lock = await backend.acquire(ACCOUNT, 1000);
  await lock.claim(fp, "dead-pod:1");
  await lock.release();
}

describe("refresh guard", () => {
  test("concurrent refreshes of one account make exactly one token request", async () => {
    const w = world({ postMs: 30 });
    const backend = new MemoryRefreshBackend();
    const metrics = metricsOf();
    const guards = [1, 2, 3].map(() => guardRefresh(w.refresh, { backend, metrics, readGrant: w.read }));
    const stale = w.grant.access_token;
    const results = await Promise.all(guards.map((g) => g("claude", ID, { force: true, expectedAccessToken: stale })));
    expect(w.posts).toBe(1);
    expect(w.reusedTokenPosts).toBe(0);
    expect(results.filter((r) => r.outcome === "refreshed")).toHaveLength(1);
    const text = metrics.render();
    expect(text).toContain('ais_gateway_refresh_attempts_total{provider="claude",identity="acct1"} 3');
    expect(text).toContain('ais_gateway_refresh_successes_total{provider="claude",identity="acct1"} 3');
    expect(text).toContain('ais_gateway_refresh_lock_waits_total{provider="claude",identity="acct1"} 2');
    expect(text).toContain("ais_gateway_refresh_lock_wait_seconds_total");
    expect(text).not.toContain("ais_gateway_refresh_failures_total{");
  });

  test("a stale reader adopts the newer grant without a token request or a journal row", async () => {
    const w = world();
    const backend = new MemoryRefreshBackend();
    const held = await backend.acquire(ACCOUNT, 1000);
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read });
    const pending = guard("claude", ID, { force: true });
    await sleep(20);
    w.grant = { access_token: "SYNTHETIC_FIXTURE-access-9", refresh_token: "SYNTHETIC_FIXTURE-refresh-9", expires_at: 5000 };
    await held.release();
    const res = await pending;
    expect(w.posts).toBe(0);
    expect(res.outcome).toBe("skipped-fresh");
    expect(res.detail).toContain("adopted");
    expect(backend.entries).toHaveLength(0);
  });

  test("a caller whose access token was already rotated adopts without a request", async () => {
    const w = world();
    const guard = guardRefresh(w.refresh, { backend: new MemoryRefreshBackend(), metrics: metricsOf(), readGrant: w.read });
    const res = await guard("claude", ID, { force: true, expectedAccessToken: "SYNTHETIC_FIXTURE-access-old" });
    expect(w.posts).toBe(0);
    expect(res.detail).toContain("adopted");
  });

  test("the journal holds fingerprints only, never a token", async () => {
    const w = world();
    const backend = new MemoryRefreshBackend();
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read });
    const first = w.grant;
    await guard("claude", ID, { force: true });
    expect(backend.entries[0]).toMatchObject({ outcome: "refreshed", oldFp: grantFingerprint(first), newFp: grantFingerprint(w.grant) });
    expect(JSON.stringify(backend.entries)).not.toContain("SYNTHETIC_FIXTURE");
  });

  test("A: a pass that sends nothing journals nothing, so a failed journal write cannot strand the account", async () => {
    const w = world();
    const backend = new MemoryRefreshBackend();
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read, warn: () => {} });
    const ka = await guard("claude", ID, {});
    expect(ka.outcome).toBe("skipped-fresh");
    expect(backend.entries).toHaveLength(0);
    const res = await guard("claude", ID, { force: true });
    expect(res.outcome).toBe("refreshed");
    expect(w.posts).toBe(1);
  });

  test("crash mid-refresh: the open claim is closed as interrupted and exactly one retry is journalled", async () => {
    const w = world();
    const backend = new MemoryRefreshBackend();
    await seedOpenClaim(backend, grantFingerprint(w.grant));
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read });
    const res = await guard("claude", ID, { force: true });
    expect(res.outcome).toBe("refreshed");
    expect(w.posts).toBe(1);
    expect(backend.entries.map((e) => e.outcome)).toEqual(["interrupted", "refreshed"]);
  });

  test("A2: repeated unknown outcomes keep retrying and alert from the second; the token is never refused for it", async () => {
    const w = world();
    const backend = new MemoryRefreshBackend();
    const fp = grantFingerprint(w.grant);
    await seedOpenClaim(backend, fp);
    await seedOpenClaim(backend, fp);
    const counts: number[] = [];
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read, onInterrupted: (_a, n) => void counts.push(n) });
    const res = await guard("claude", ID, { force: true });
    expect(res.outcome).toBe("refreshed");
    expect(w.posts).toBe(1);
    expect(counts[0]).toBe(2); // alert level reached, request still sent
    expect(counts.at(-1)).toBe(0); // cleared on success
  });

  test("A2 (network blips): two blips between claim and resolve do not strand a token the provider never received", async () => {
    const state = { down: false };
    const w = world();
    const inner = new MemoryRefreshBackend();
    let blips = 2;
    const refresh = (async (tool: string, id: { name: string }, o?: { force?: boolean; beforePost?: (i: { fingerprint: string }) => Promise<void> }) => {
      await o?.beforePost?.({ fingerprint: grantFingerprint(w.grant) });
      if (blips-- > 0) {
        state.down = true;
        throw new Error("ECONNREFUSED (request never left the pod)");
      }
      return (w.refresh as unknown as (...a: unknown[]) => Promise<unknown>)(tool, id, { ...o, beforePost: undefined });
    }) as never;
    const backend: RefreshGuardBackend = {
      acquire: async (a, t) => {
        const h = await inner.acquire(a, t);
        // The lock's own connection is broken while the blip lasts; fresh-connection retries still work.
        return { ...h, resolve: async (...x) => { if (state.down) throw new Error("conn reset"); return h.resolve(...x); } };
      },
    };
    const guard = guardRefresh(refresh, { backend, metrics: metricsOf(), readGrant: w.read, warn: () => {}, callTimeoutMs: 50 });
    await expect(guard("claude", ID, { force: true })).rejects.toThrow(/ECONNREFUSED/);
    state.down = false;
    await expect(guard("claude", ID, { force: true })).rejects.toThrow(/ECONNREFUSED/);
    state.down = false;
    const third = await guard("claude", ID, { force: true });
    expect(third.outcome).toBe("refreshed");
    expect(w.posts).toBe(1);
  });

  test("crash recovery: when the newer grant reached the stores the stale claim is recovered and the newest token is used", async () => {
    const w = world();
    const backend = new MemoryRefreshBackend();
    await seedOpenClaim(backend, grantFingerprint(w.grant));
    w.grant = { access_token: "SYNTHETIC_FIXTURE-access-7", refresh_token: "SYNTHETIC_FIXTURE-refresh-7", expires_at: 1007 };
    const recoveredFp = grantFingerprint(w.grant);
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read });
    const res = await guard("claude", ID, { force: true });
    expect(backend.entries[0]).toMatchObject({ outcome: "recovered", newFp: recoveredFp });
    expect(w.reusedTokenPosts).toBe(0);
    expect(res.outcome).toBe("refreshed");
  });

  test("a rotated-out refresh token in the stores is never reused", async () => {
    const w = world();
    const guard = guardRefresh(w.refresh, { backend: new MemoryRefreshBackend(), metrics: metricsOf(), readGrant: w.read });
    const old = w.grant;
    await guard("claude", ID, { force: true });
    w.grant = old;
    await expect(guard("claude", ID, { force: true })).rejects.toThrow(/rotated out/);
    expect(w.posts).toBe(1);
    expect(w.reusedTokenPosts).toBe(0);
  });

  test("a refresh whose write-through failed is journalled lost, and the next attempt is sent once for the provider to judge", async () => {
    const w = world({ failWrite: true });
    const backend = new MemoryRefreshBackend();
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read });
    const res = await guard("claude", ID, { force: true });
    expect(res.outcome).toBe("failed");
    expect(backend.entries[0]?.outcome).toBe("lost");
    const again = await guard("claude", ID, { force: true });
    expect(again.outcome).toBe("failed");
    expect(w.posts).toBe(2);
  });

  test("C: an acquire that completes after the outer bound releases its late handle instead of leaking the account lock", async () => {
    const w = world();
    const inner = new MemoryRefreshBackend();
    let slow = true;
    const backend: RefreshGuardBackend = {
      acquire: async (a, t) => {
        const h = await inner.acquire(a, t);
        if (slow) {
          slow = false;
          await sleep(120);
        }
        return h;
      },
    };
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read, warn: () => {}, lockTimeoutMs: 50, callTimeoutMs: 20 });
    const first = await guard("claude", ID, { force: true }); // the outer bound fires: degraded refresh
    expect(first.outcome).toBe("refreshed");
    await sleep(100); // the late handle arrives and is released
    const second = await guard("claude", ID, { force: true });
    expect(second.outcome).not.toBeUndefined();
    expect(inner.entries.some((e) => e.outcome === "refreshed")).toBe(true);
  });

  test("the degraded alert says why: error name, code and a masked, short message", async () => {
    const w = world();
    const reasons: string[] = [];
    const err = Object.assign(new Error("unsupported startup parameter: statement_timeout (postgres://user:pw@host/db)"), { name: "ConnectionError", code: "ERR_CONNECT" });
    const backend: RefreshGuardBackend = { acquire: async () => { throw err; } };
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read, onDegraded: (_a, why) => void reasons.push(why) });
    await guard("claude", ID, { force: true });
    expect(reasons[0]).toBe("ConnectionError ERR_CONNECT - unsupported startup parameter: statement_timeout (<url>");
    expect(reasons[0]).not.toContain("pw");
  });

  test("alert reasons: a PostgresError gives name, code, SQLSTATE and the server message; other errors are masked", async () => {
    const reasonFor = async (err: Error): Promise<string> => {
      const w = world();
      const out: string[] = [];
      const backend: RefreshGuardBackend = { acquire: async () => { throw err; } };
      await guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read, onDegraded: (_a, why) => void out.push(why) })("claude", ID, { force: true });
      return out[0] as string;
    };
    const pg = Object.assign(new Error('unsupported startup parameter: statement_timeout'), { name: "PostgresError", code: "ERR_POSTGRES_SERVER_ERROR", errno: "08P01" });
    expect(await reasonFor(pg)).toBe("PostgresError ERR_POSTGRES_SERVER_ERROR 08P01 - unsupported startup parameter: statement_timeout");
    const HOSTPART = ["db", "internal"].join("."); // built at run time: no host literal in the repository
    const other = new Error(`connect failed {"password":"hunter2","host":"db"} for dsn user:s3cret@${HOSTPART}:5432 key \'abc123\' and "quoted-secret" token=zzz`);
    const text = await reasonFor(other);
    for (const leak of ["hunter2", "s3cret", "abc123", "quoted-secret", "zzz", "db.internal"]) expect(text).not.toContain(leak);
    expect(text.startsWith("Error - connect failed")).toBe(true);
  });

  test("a journal read error still refuses a token this process saw rotated out", async () => {
    const w = world();
    const inner = new MemoryRefreshBackend();
    let breakJournal = false;
    const backend: RefreshGuardBackend = {
      acquire: async (a, t) => {
        const h = await inner.acquire(a, t);
        return { ...h, findByOldFp: async (fp) => { if (breakJournal) throw new Error("conn reset"); return h.findByOldFp(fp); } };
      },
    };
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read, warn: () => {} });
    const old = w.grant;
    await guard("claude", ID, { force: true });
    w.grant = old;
    breakJournal = true;
    await expect(guard("claude", ID, { force: true })).rejects.toThrow(/rotated out/);
    expect(w.posts).toBe(1);
  });

  test("degraded mode still refuses a token this process saw rotated out", async () => {
    const w = world();
    let down = false;
    const inner = new MemoryRefreshBackend();
    const backend: RefreshGuardBackend = {
      acquire: async (a, t) => {
        if (down) throw new Error("connect refused");
        return inner.acquire(a, t);
      },
    };
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read });
    const old = w.grant;
    await guard("claude", ID, { force: true });
    w.grant = old;
    down = true;
    await expect(guard("claude", ID, { force: true })).rejects.toThrow(/rotated out/);
    expect(w.posts).toBe(1);
  });

  test("a failed token request is journalled failed, leaves the token usable and counts a failure", async () => {
    const w = world();
    const metrics = metricsOf();
    const backend = new MemoryRefreshBackend();
    const guard = guardRefresh((async (_t: string, _i: unknown, o?: { beforePost?: (i: { fingerprint: string }) => Promise<void> }) => {
      await o?.beforePost?.({ fingerprint: grantFingerprint(w.grant) });
      throw new OAuthRefreshError("token refresh rejected (HTTP 500)", false);
    }) as never, { backend, metrics, readGrant: w.read });
    await expect(guard("claude", ID, { force: true })).rejects.toBeInstanceOf(OAuthRefreshError);
    await expect(guard("claude", ID, { force: true })).rejects.toBeInstanceOf(OAuthRefreshError);
    expect(backend.entries.map((e) => e.outcome)).toEqual(["failed", "failed"]);
    expect(metrics.render()).toContain('ais_gateway_refresh_failures_total{provider="claude",identity="acct1"} 2');
  });

  test("B: a grant read error under the lock fails retryably and never sends an unjournalled request", async () => {
    const w = world();
    let n = 0;
    const backend = new MemoryRefreshBackend();
    const guard = guardRefresh(w.refresh, {
      backend,
      metrics: metricsOf(),
      readGrant: async () => {
        n += 1;
        if (n === 2) throw new Error("EBUSY");
        return w.read();
      },
      warn: () => {},
    });
    await expect(guard("claude", ID, { force: true })).rejects.toBeInstanceOf(RefreshGuardRetryable);
    expect(w.posts).toBe(0);
    await guard("claude", ID, { force: true });
    expect(w.posts).toBe(1);
    expect(backend.entries.map((e) => e.outcome)).toEqual(["refreshed"]);
  });

  test("an unavailable database falls back to the file-lock refresh, with an alert and a metric", async () => {
    const w = world();
    const broken: RefreshGuardBackend = {
      acquire: async () => {
        throw new Error("connect refused");
      },
    };
    const metrics = metricsOf();
    const raised: string[] = [];
    const guard = guardRefresh(w.refresh, { backend: broken, metrics, readGrant: w.read, onDegraded: (a, why) => void raised.push(`${a.provider}/${a.identity}:${why}`) });
    const res = await guard("claude", ID, { force: true });
    expect(res.outcome).toBe("refreshed");
    expect(w.posts).toBe(1);
    expect(raised).toEqual(["claude/acct1:Error - connect refused"]);
    expect(metrics.render()).toContain('ais_gateway_refresh_guard_degraded_total{provider="claude",identity="acct1"} 1');
  });

  test("a journal that fails or hangs is bounded and the refresh still goes ahead, degraded", async () => {
    const w = world();
    const backend = new MemoryRefreshBackend();
    const orig = backend.acquire.bind(backend);
    backend.acquire = async (...a) => ({ ...(await orig(...a)), claim: () => new Promise<number>(() => {}) });
    const raised: string[] = [];
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read, callTimeoutMs: 40, onDegraded: (_a, why) => void raised.push(why) });
    const res = await guard("claude", ID, { force: true });
    expect(res.outcome).toBe("refreshed");
    expect(w.posts).toBe(1);
    expect(raised).toHaveLength(1);
  });

  test("a resolve write that fails once is retried", async () => {
    const w = world();
    const backend = new MemoryRefreshBackend();
    const orig = backend.acquire.bind(backend);
    let failures = 1;
    backend.acquire = async (...a) => {
      const h = await orig(...a);
      return {
        ...h,
        resolve: async (...r) => {
          if (failures-- > 0) throw new Error("connection reset");
          return h.resolve(...r);
        },
      };
    };
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read, warn: () => {} });
    await guard("claude", ID, { force: true });
    expect(backend.entries.map((e) => e.outcome)).toEqual(["refreshed"]);
  });

  test("resolve retries go through a fresh connection when the lock's own one is broken", async () => {
    const w = world();
    const backend = new MemoryRefreshBackend();
    const orig = backend.acquire.bind(backend);
    backend.acquire = async (...a) => {
      const h = await orig(...a);
      return { ...h, resolve: async () => { throw new Error("conn reset"); }, resolveFresh: (...r) => h.resolve(...r) };
    };
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read, warn: () => {} });
    await guard("claude", ID, { force: true });
    expect(backend.entries.map((e) => e.outcome)).toEqual(["refreshed"]);
  });

  test("lock wait beyond the timeout is a timed-out lock error", async () => {
    const w = world();
    const backend = new MemoryRefreshBackend();
    await backend.acquire(ACCOUNT, 100);
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read, lockTimeoutMs: 30 });
    await expect(guard("claude", ID, { force: true })).rejects.toMatchObject({ timedOut: true });
    expect(w.posts).toBe(0);
  });

  test("different accounts do not block each other", async () => {
    const w = world({ postMs: 40 });
    const guard = guardRefresh(w.refresh, { backend: new MemoryRefreshBackend(), metrics: metricsOf(), readGrant: w.read });
    const t0 = Date.now();
    await Promise.all([guard("claude", ID, { force: true }), guard("codex", { name: "other", label: "o", configDir: "/y" } as never, { force: true })]);
    expect(Date.now() - t0).toBeLessThan(75);
  });

  test("retention drops old resolved rows but keeps open claims and rotated-out evidence", async () => {
    const backend = new MemoryRefreshBackend();
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    for (let i = 0; i < 80; i += 1) backend.entries.push({ id: i + 1, ts: old, ...ACCOUNT, holder: "h", oldFp: `f${i}`, outcome: "failed" });
    backend.entries.push({ id: 100, ts: old, ...ACCOUNT, holder: "h", oldFp: "lostfp", outcome: "lost" });
    backend.entries.push({ id: 101, ts: old, ...ACCOUNT, holder: "h", oldFp: "openfp" });
    const removed = await backend.prune(30 * 86_400_000);
    expect(removed).toBe(80 - 48);
    expect(backend.entries.some((e) => e.oldFp === "lostfp")).toBe(true);
    backend.entries.push({ id: 102, ts: new Date(Date.now() - 400 * 86_400_000).toISOString(), ...ACCOUNT, holder: "h", oldFp: "ancient", newFp: "z", outcome: "refreshed" });
    backend.entries.push({ id: 103, ts: new Date(Date.now() - 90 * 86_400_000).toISOString(), ...ACCOUNT, holder: "h", oldFp: "evidence", newFp: "y", outcome: "refreshed" });
    for (let i = 0; i < 60; i += 1) backend.entries.push({ id: 200 + i, ts: new Date().toISOString(), ...ACCOUNT, holder: "h", oldFp: `n${i}`, outcome: "failed" });
    await backend.prune(30 * 86_400_000);
    expect(backend.entries.some((e) => e.oldFp === "evidence")).toBe(true); // rotated-out evidence outlives ordinary rows
    expect(backend.entries.some((e) => e.oldFp === "ancient")).toBe(false);
    expect(backend.entries.some((e) => e.oldFp === "openfp")).toBe(true);
  });
});
