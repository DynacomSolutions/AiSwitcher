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

  test("a token whose attempts were interrupted twice is refused, not retried forever", async () => {
    const w = world();
    const backend = new MemoryRefreshBackend();
    const fp = grantFingerprint(w.grant);
    await seedOpenClaim(backend, fp);
    await seedOpenClaim(backend, fp);
    const guard = guardRefresh(w.refresh, { backend, metrics: metricsOf(), readGrant: w.read });
    await expect(guard("claude", ID, { force: true })).rejects.toThrow(/never finished twice/);
    expect(w.posts).toBe(0);
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

  test("a refresh whose write-through failed blocks reuse of the spent token", async () => {
    const w = world({ failWrite: true });
    const guard = guardRefresh(w.refresh, { backend: new MemoryRefreshBackend(), metrics: metricsOf(), readGrant: w.read });
    const res = await guard("claude", ID, { force: true });
    expect(res.outcome).toBe("failed");
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
    expect(raised).toEqual(["claude/acct1:Error"]);
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
    expect(backend.entries.some((e) => e.oldFp === "openfp")).toBe(true);
  });
});
