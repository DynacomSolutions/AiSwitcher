import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminApp } from "../../src/gateway/admin.ts";
import { createAlerter } from "../../src/gateway/alerts.ts";
import { CredentialCache, GatewayCredentialError } from "../../src/gateway/credentials.ts";
import { PrometheusMetrics } from "../../src/gateway/metrics.ts";
import { guardRefresh, MemoryRefreshBackend, RefreshGuardRetryable, type RefreshGuardBackend } from "../../src/gateway/refresh-guard.ts";
import { buildRenewalReport } from "../../src/gateway/renewal.ts";
import { instrumentRefresh, keepAliveOnce } from "../../src/gateway/serve.ts";
import { MemoryGatewayStore } from "../../src/gateway/store.ts";
import { grantFingerprint, type OAuthGrant } from "../../src/identities/oauth-reconcile.ts";
import { ANTHROPIC_TOKEN_URL, OAuthRefreshError, refreshIdentityOAuthGrant, shouldAttemptOAuthRefresh, type IdentityGrantRefresh } from "../../src/identities/oauth-refresh.ts";
import type { Identity } from "../../src/identities/types.ts";

/**
 * A fake OAuth token server with the behaviour of a rotating provider: every refresh token works once and is replaced.
 * Presenting a rotated-out token answers invalid_grant AND revokes the whole token family (the live token included).
 */
class FakeOAuthServer {
  posts = 0;
  readonly sent: string[] = [];
  private seq = 0;
  private readonly tokens = new Map<string, { family: number; spent: boolean }>();
  private readonly revoked = new Set<number>();
  private readonly current = new Map<number, string>();

  /** Registers a live refresh token (the one a login holds) and returns it. */
  enroll(family: number, token: string): string {
    this.tokens.set(token, { family, spent: false });
    this.current.set(family, token);
    return token;
  }

  /** Registers an already rotated-out token of a family. */
  enrollSpent(family: number, token: string): string {
    this.tokens.set(token, { family, spent: true });
    return token;
  }

  liveToken(family: number): string | undefined {
    return this.current.get(family);
  }

  familyRevoked(family: number): boolean {
    return this.revoked.has(family);
  }

  readonly fetch = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.posts += 1;
    const body = new URLSearchParams(String(init?.body ?? ""));
    const presented = body.get("refresh_token") ?? "";
    this.sent.push(presented);
    const dead = (): Response => new Response(JSON.stringify({ error: "invalid_grant", error_description: "refresh token is not valid" }), { status: 400, headers: { "Content-Type": "application/json" } });
    const rec = this.tokens.get(presented);
    if (!rec || this.revoked.has(rec.family)) return dead();
    if (rec.spent) {
      // Reuse of a rotated-out token: the provider treats it as theft and kills the whole family.
      this.revoked.add(rec.family);
      return dead();
    }
    rec.spent = true;
    this.seq += 1;
    const next = `rt-fake-${rec.family}-${this.seq}`;
    this.tokens.set(next, { family: rec.family, spent: false });
    this.current.set(rec.family, next);
    return new Response(JSON.stringify({ access_token: `at-fake-${this.seq}`, refresh_token: next, expires_in: 28_800 }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("the fake OAuth server", () => {
  test("rotates on every use and revokes the whole family when a rotated-out token comes back", async () => {
    const server = new FakeOAuthServer();
    const first = server.enroll(1, "rt-seed-1");
    const post = (token: string) => server.fetch(ANTHROPIC_TOKEN_URL, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token }) });
    const ok = await post(first);
    expect(ok.status).toBe(200);
    const next = ((await ok.json()) as { refresh_token: string }).refresh_token;
    expect(next).not.toBe(first);
    // The old token is now spent: reusing it fails and kills the family, so the live token dies too.
    const reuse = await post(first);
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe("invalid_grant");
    expect(server.familyRevoked(1)).toBe(true);
    expect((await post(next)).status).toBe(400);
    expect(server.posts).toBe(3);
  });

  test("an unknown token is invalid_grant without revoking another family", async () => {
    const server = new FakeOAuthServer();
    const live = server.enroll(2, "rt-seed-2");
    const res = await server.fetch(ANTHROPIC_TOKEN_URL, { method: "POST", body: new URLSearchParams({ refresh_token: "rt-nobody" }) });
    expect(res.status).toBe(400);
    expect(server.familyRevoked(2)).toBe(false);
    expect((await server.fetch(ANTHROPIC_TOKEN_URL, { method: "POST", body: new URLSearchParams({ refresh_token: live }) })).status).toBe(200);
  });
});

const NOW = 1_789_200_000;
let root: string;
let configDir: string;
let registry: string;
const ID = (): Identity => ({ name: "acct-a", label: "acct-a", configDir });
const savedMemberStore = process.env.AIS_GATEWAY_MEMBER_STORE;

beforeAll(() => {
  // Another test file may have switched the member store on for the whole process: these tests use plain identity folders.
  process.env.AIS_GATEWAY_MEMBER_STORE = "0";
});
afterAll(() => {
  if (savedMemberStore === undefined) delete process.env.AIS_GATEWAY_MEMBER_STORE;
  else process.env.AIS_GATEWAY_MEMBER_STORE = savedMemberStore;
});

// The gateway process alone refreshes a claude login (every live claude identity is gateway managed), so these tests run as it.
let savedOwnerRole: string | undefined;
beforeEach(async () => {
  savedOwnerRole = process.env.AIS_GATEWAY_OWNER;
  process.env.AIS_GATEWAY_OWNER = "1";
  root = await mkdtemp(join(tmpdir(), "ais-single-refresher-"));
  configDir = join(root, "identities", "acct-a");
  await mkdir(configDir, { recursive: true });
  registry = join(root, "claude-identities.json");
  await writeFile(registry, JSON.stringify({ version: 1, identities: [{ name: "acct-a", label: "acct-a", configDir }] }));
});
afterEach(async () => {
  if (savedOwnerRole === undefined) delete process.env.AIS_GATEWAY_OWNER;
  else process.env.AIS_GATEWAY_OWNER = savedOwnerRole;
  await rm(root, { recursive: true, force: true });
});

const writeLogin = (refresh: string, access: string, expiresAtSeconds: number): Promise<void> =>
  writeFile(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: expiresAtSeconds * 1000 } }));
const readLogin = async (): Promise<{ refresh: string; access: string }> => {
  const parsed = JSON.parse(await readFile(join(configDir, ".credentials.json"), "utf8")) as { claudeAiOauth: { accessToken: string; refreshToken: string } };
  return { refresh: parsed.claudeAiOauth.refreshToken, access: parsed.claudeAiOauth.accessToken };
};

/** The real AIS refresh, pointed at the fake token server and this test's identity folder. */
const realRefresh = (server: FakeOAuthServer) =>
  ((tool, identity, opts) => refreshIdentityOAuthGrant(tool, identity, { ...opts, fetchImpl: server.fetch, claudeRegistryPath: registry, now: () => NOW * 1000 })) as typeof refreshIdentityOAuthGrant;

const metricsOf = () => new PrometheusMetrics({ ledgerDepth: () => 0, ledgerDropped: () => 0 });

describe("one refresher per login", () => {
  test("two replicas refreshing at once make exactly one token exchange; the loser reuses the winner's token", async () => {
    const server = new FakeOAuthServer();
    await writeLogin(server.enroll(1, "rt-seed-1"), "at-seed-1", NOW + 600);
    const backend = new MemoryRefreshBackend();
    const refresh = realRefresh(server);
    const replicaA = guardRefresh(refresh, { backend, metrics: metricsOf(), holder: "pod-a:1" });
    const replicaB = guardRefresh(refresh, { backend, metrics: metricsOf(), holder: "pod-b:1" });
    const results = await Promise.all([
      replicaA("claude", ID(), { force: true, expectedAccessToken: "at-seed-1" }),
      replicaB("claude", ID(), { force: true, expectedAccessToken: "at-seed-1" }),
    ]);
    expect(server.posts).toBe(1);
    expect(results.map((r) => r.outcome).sort()).toEqual(["refreshed", "skipped-fresh"]);
    expect(server.familyRevoked(1)).toBe(false);
    const stored = await readLogin();
    expect(stored.refresh).toBe(server.liveToken(1) as string);
    expect(stored.access).toBe("at-fake-1");
    expect(backend.entries.map((e) => e.outcome)).toEqual(["refreshed"]);
    // A later pass on either replica finds the fresh grant and sends nothing.
    await replicaB("claude", ID(), { force: true, expectedAccessToken: "at-seed-1" });
    expect(server.posts).toBe(1);
  });

  test("a guard failure with a database backend sends nothing (lock, connection and journal errors)", async () => {
    const server = new FakeOAuthServer();
    await writeLogin(server.enroll(1, "rt-seed-1"), "at-seed-1", NOW + 600);
    const down: RefreshGuardBackend = { acquire: async () => Promise.reject(new Error("connect refused")) };
    const degraded: string[] = [];
    const g1 = guardRefresh(realRefresh(server), { backend: down, metrics: metricsOf(), onDegraded: (_a, why) => void degraded.push(why) });
    await expect(g1("claude", ID(), { force: true })).rejects.toBeInstanceOf(RefreshGuardRetryable);

    const inner = new MemoryRefreshBackend();
    const journalDown: RefreshGuardBackend = {
      acquire: async (a, t) => ({ ...(await inner.acquire(a, t)), findByOldFp: async () => Promise.reject(new Error("conn reset")) }),
    };
    const g2 = guardRefresh(realRefresh(server), { backend: journalDown, metrics: metricsOf(), warn: () => {} });
    await expect(g2("claude", ID(), { force: true })).rejects.toBeInstanceOf(RefreshGuardRetryable);

    const claimDown: RefreshGuardBackend = {
      acquire: async (a, t) => ({ ...(await inner.acquire(a, t)), claim: async () => Promise.reject(new Error("conn reset")) }),
    };
    const g3 = guardRefresh(realRefresh(server), { backend: claimDown, metrics: metricsOf(), warn: () => {} });
    await expect(g3("claude", ID(), { force: true })).rejects.toBeInstanceOf(RefreshGuardRetryable);

    expect(server.posts).toBe(0);
    expect(degraded).toHaveLength(1);
    expect((await readLogin()).refresh).toBe("rt-seed-1");
  });

  test("after a dead answer the grant is journalled dead and a second replica sends nothing", async () => {
    const server = new FakeOAuthServer();
    // The stored token is a rotated-out one: the provider answers invalid_grant (and revokes the family).
    await writeLogin(server.enrollSpent(1, "rt-spent-1"), "at-seed-1", NOW + 600);
    const backend = new MemoryRefreshBackend();
    const dead: Array<{ code: string; fresh: boolean; fingerprint: string }> = [];
    const mk = (holder: string) => guardRefresh(realRefresh(server), { backend, metrics: metricsOf(), holder, onDead: (_a, info) => void dead.push(info) });
    const replicaA = mk("pod-a:1");
    const replicaB = mk("pod-b:1");
    const fp = grantFingerprint({ access_token: "x", refresh_token: "rt-spent-1" });

    await expect(replicaA("claude", ID(), { force: true })).rejects.toMatchObject({ revoked: true, oauthCode: "invalid_grant" });
    expect(server.posts).toBe(1);
    expect(backend.entries).toHaveLength(1);
    expect(backend.entries[0]).toMatchObject({ outcome: "dead", code: "invalid_grant", oldFp: fp });
    expect(dead).toEqual([{ code: "invalid_grant", fresh: true, fingerprint: fp }]);

    // Every later attempt, on any replica and by any path, is refused before the request.
    await expect(replicaB("claude", ID(), { force: true })).rejects.toMatchObject({ revoked: true, oauthCode: "invalid_grant" });
    await expect(replicaB("claude", ID(), { force: true, expectedAccessToken: "at-seed-1" })).rejects.toMatchObject({ oauthCode: "invalid_grant" });
    await expect(replicaA("claude", ID(), { force: true })).rejects.toMatchObject({ oauthCode: "invalid_grant" });
    expect(server.posts).toBe(1);
    expect(backend.entries).toHaveLength(1);
    expect(dead.slice(1).every((d) => d.fresh === false && d.fingerprint === fp)).toBe(true);
  });

  test("a new login (a different refresh token) is seen by onGrantSeen and sends again", async () => {
    const server = new FakeOAuthServer();
    await writeLogin(server.enrollSpent(1, "rt-spent-1"), "at-seed-1", NOW + 600);
    const backend = new MemoryRefreshBackend();
    const seen: string[] = [];
    const guard = guardRefresh(realRefresh(server), { backend, metrics: metricsOf(), onGrantSeen: (_a, fp) => void seen.push(fp) });
    await expect(guard("claude", ID(), { force: true })).rejects.toMatchObject({ oauthCode: "invalid_grant" });
    // The owner logs in again: a new family and a new refresh token.
    await writeLogin(server.enroll(2, "rt-seed-2"), "at-seed-2", NOW + 600);
    const res = await guard("claude", ID(), { force: true, expectedAccessToken: "at-seed-2" });
    expect(res.outcome).toBe("refreshed");
    expect(seen).toEqual([grantFingerprint({ access_token: "x", refresh_token: "rt-spent-1" }), grantFingerprint({ access_token: "x", refresh_token: "rt-seed-2" })]);
    expect(server.posts).toBe(2);
  });
});

describe("the credential cache stops resending a dead grant", () => {
  test("the 401 path and ensureUsable send nothing after the first dead answer", async () => {
    const server = new FakeOAuthServer();
    await writeLogin(server.enrollSpent(1, "rt-spent-1"), "at-expired", 1000); // access token long expired
    const backend = new MemoryRefreshBackend();
    const guard = guardRefresh(realRefresh(server), { backend, metrics: metricsOf() });
    const cache = new CredentialCache({
      resolveConfigDir: async () => configDir,
      claudeRegistryPath: registry,
      refresh: guard,
    });
    // ensureUsable: the token is expired, so a refresh runs once; it fails and the expired token is served.
    expect((await cache.get("claude", "acct-a")).accessToken).toBe("at-expired");
    expect(server.posts).toBe(1);
    // More requests and a 401: still one request in total.
    for (let i = 0; i < 3; i += 1) await cache.get("claude", "acct-a");
    await expect(cache.refreshAfter401("claude", "acct-a", "at-expired")).rejects.toMatchObject({ code: "login-dead" });
    await expect(cache.refreshAfter401("claude", "acct-a", "at-expired")).rejects.toBeInstanceOf(GatewayCredentialError);
    expect(server.posts).toBe(1);
    // A new login changes the stored token: refreshing works again.
    await writeLogin(server.enroll(2, "rt-seed-2"), "at-new-login", 1000);
    expect((await cache.get("claude", "acct-a")).accessToken).toBe("at-fake-1");
    expect(server.posts).toBe(2);
  });
});

describe("renew at half the access-token lifetime", () => {
  const at = (expiresInSeconds: number, minted?: number) => ({ access_token: "a", refresh_token: "r", expires_at: NOW + expiresInSeconds, ...(minted !== undefined ? { minted_at: NOW + expiresInSeconds - minted } : {}) });
  const decide = (tool: "claude" | "grok" | "codex" | "kimi", grant: OAuthGrant, extra: { renewFraction?: number; lastSuccessAt?: string | null } = { renewFraction: 0.5, lastSuccessAt: null }) =>
    shouldAttemptOAuthRefresh(grant, { tool, nowSeconds: NOW, lastSuccessAt: tool === "codex" || tool === "kimi" ? new Date(NOW * 1000).toISOString() : null, ...extra });
  const ago = (seconds: number): string => new Date((NOW - seconds) * 1000).toISOString();

  test("claude: the provider default (8 h) gives a 4 h window when the mint time is unknown", () => {
    expect(decide("claude", at(4 * 3600 + 120)).attempt).toBe(false);
    expect(decide("claude", at(4 * 3600 - 120)).attempt).toBe(true);
  });
  test("claude: a known mint time sets the lifetime (2 h lifetime renews with 1 h left)", () => {
    expect(decide("claude", at(3600 + 60, 7200)).attempt).toBe(false);
    expect(decide("claude", at(3600 - 60, 7200)).attempt).toBe(true);
  });
  test("grok: 6 h default gives a 3 h window", () => {
    expect(decide("grok", at(3 * 3600 + 120)).attempt).toBe(false);
    expect(decide("grok", at(3 * 3600 - 120)).attempt).toBe(true);
  });
  test("the window never drops below the keep-alive tick margin", () => {
    // A 10 minute lifetime would give a 5 minute window: it stays 20 minutes, above the 10 minute tick.
    expect(decide("claude", at(19 * 60, 600)).attempt).toBe(true);
    expect(decide("claude", at(21 * 60, 600)).attempt).toBe(false);
  });
  test("without the gateway option claude keeps the one hour window; codex and kimi keep their rules", () => {
    expect(decide("claude", at(2 * 3600), {}).attempt).toBe(false);
    expect(decide("claude", at(50 * 60), {}).attempt).toBe(true);
    expect(decide("codex", at(5 * 86_400), {}).attempt).toBe(false); // a recent success and a far expiry: nothing to do
    expect(decide("kimi", at(600), {}).attempt).toBe(false); // kimi never uses an expiry window
  });
  test("the lifetime is observed from the last refresh: a 1 h token is not renewed every tick", () => {
    // The refresh that made this token ran 10 minutes ago and it expires in 50 minutes: the lifetime is 1 h, the window 30 min.
    expect(decide("claude", at(50 * 60), { renewFraction: 0.5, lastSuccessAt: ago(10 * 60) }).attempt).toBe(false);
    expect(decide("claude", at(25 * 60), { renewFraction: 0.5, lastSuccessAt: ago(35 * 60) }).attempt).toBe(true);
    // Whatever the stored expiry says, no renewal ahead within half the lifetime of the last success.
    expect(decide("claude", at(10 * 60), { renewFraction: 0.5, lastSuccessAt: ago(60) }).attempt).toBe(false);
    // An expired token is always renewed.
    expect(decide("claude", at(-60), { renewFraction: 0.5, lastSuccessAt: ago(60) }).attempt).toBe(true);
  });
  test("the keep-alive passes the fraction for claude and grok only", async () => {
    const seen: Record<string, number | undefined> = {};
    const refresh = (async (tool: string, id: { name: string }, o?: { renewFraction?: number }) => {
      seen[tool] = o?.renewFraction;
      return { tool, identity: id.name, outcome: "skipped-fresh", detail: "", written: [], writeFailures: [] };
    }) as never;
    const acct = { name: "a", label: "a", configDir: "/x" };
    await keepAliveOnce({ refresh, accounts: async () => [acct], metrics: { keepAlive() {} }, tools: ["claude", "grok", "codex", "kimi"] });
    expect(seen).toEqual({ claude: 0.5, grok: 0.5, codex: undefined, kimi: undefined });
  });
});

describe("the refresh log line", () => {
  const acct = { name: "acct-a", label: "acct-a", configDir: "/x" } as Identity;
  const run = async (refresh: unknown, opts: Record<string, unknown> = { force: true }) => {
    const lines: string[] = [];
    const wrapped = instrumentRefresh(refresh as never, { metrics: metricsOf(), alerter: createAlerter(() => {}), log: (l) => void lines.push(l), replica: "pod-x" });
    await wrapped("claude", acct, opts as never).catch(() => undefined);
    return lines;
  };

  test("one JSON line per result with provider, identity, replica, outcome, expiry and code", async () => {
    const lines = await run(async () => ({ tool: "claude", identity: "acct-a", outcome: "refreshed", expiresAt: 1_789_228_800, detail: "grant refreshed", written: [], writeFailures: [] }));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({ event: "refresh", provider: "claude", identity: "acct-a", replica: "pod-x", outcome: "refreshed", expiresAt: new Date(1_789_228_800 * 1000).toISOString(), code: null });
  });

  test("a dead answer logs outcome dead with the OAuth code, and carries no token", async () => {
    const secret = ["sk", "ant", "SYNTHETIC", "refresh", "value"].join("-");
    const lines = await run(async () => {
      throw new OAuthRefreshError(`token refresh rejected (HTTP 400 invalid_grant) ${secret}`, true, "ab12cd34", "invalid_grant");
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ outcome: "dead", code: "invalid_grant", expiresAt: null });
    expect(lines[0]).not.toContain(secret);
    expect(Object.keys(JSON.parse(lines[0] as string)).sort()).toEqual(["code", "event", "expiresAt", "identity", "outcome", "provider", "replica"]);
  });

  test("a journal refusal of a dead token logs refused-dead, has its own metric outcome, and raises no refresh-failed alert", async () => {
    const { RefreshRefused } = await import("../../src/gateway/refresh-guard.ts");
    const lines: string[] = [];
    const alerts: string[] = [];
    const metrics = metricsOf();
    const wrapped = instrumentRefresh((async () => {
      throw new RefreshRefused("refresh refused: dead", true, "ab12cd34", "invalid_grant", "dead");
    }) as never, { metrics, alerter: createAlerter((a) => void alerts.push(a.kind)), log: (l) => void lines.push(l), replica: "pod-x" });
    await wrapped("claude", acct, { force: true } as never).catch(() => undefined);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ outcome: "refused-dead", code: "invalid_grant" });
    expect(alerts).toEqual([]);
    expect(metrics.render()).toContain('ais_gateway_refresh_total{provider="claude",outcome="refused-dead"} 1');
    expect(metrics.render()).not.toContain('outcome="failed"');
  });

  test("a transport failure logs code transport; a pass that sent nothing logs nothing", async () => {
    const lines = await run(async () => {
      throw new OAuthRefreshError("token endpoint unreachable: connect refused", false);
    });
    expect(JSON.parse(lines[0] as string)).toMatchObject({ outcome: "failed", code: "transport" });
    expect(await run(async () => ({ tool: "claude", identity: "acct-a", outcome: "skipped-fresh", detail: "not due", written: [], writeFailures: [] }))).toEqual([]);
  });
});

describe("renewal metrics and the admin route", () => {
  test("the metrics carry the contract names and labels", () => {
    const m = metricsOf();
    m.refreshSucceededAt("claude", "acct-a", 1_789_200_000);
    m.refreshSucceededAt("claude", "acct-a", 1_789_100_000); // an older value never replaces the newest
    m.loginState("claude", "acct-a", { expiresAtSeconds: 1_789_228_800, lifetimeSeconds: 28_800, revoked: false });
    m.deadGrant("claude", "acct-a", "invalid_grant");
    m.loginState("claude", "acct-a", { revoked: true });
    const text = m.render();
    expect(text).toContain('ais_gateway_refresh_last_success_timestamp_seconds{provider="claude",identity="acct-a"} 1789200000');
    expect(text).toContain('ais_gateway_login_expiry_timestamp_seconds{provider="claude",identity="acct-a"} 1789228800');
    expect(text).toContain('ais_gateway_login_lifetime_seconds{provider="claude",identity="acct-a"} 28800');
    expect(text).toContain('ais_gateway_login_revoked{provider="claude",identity="acct-a"} 1');
    expect(text).toContain('ais_gateway_refresh_dead_grant_total{provider="claude",identity="acct-a",code="invalid_grant"} 1');
  });

  test("the renewal report joins the journal with the stored login", async () => {
    await writeLogin("rt-live-1", "at-live-1", NOW + 8 * 3600);
    const backend = new MemoryRefreshBackend();
    const lock = await backend.acquire({ provider: "claude", identity: "acct-a" }, 1000);
    const failed = await lock.claim("fp-old-1", "pod-1:7");
    await lock.resolve(failed, "failed", undefined, "transport");
    const ok = await lock.claim("fp-old-2", "pod-2:9");
    await lock.resolve(ok, "refreshed", "fp-new-2");
    await lock.release();
    const report = await buildRenewalReport({ tools: ["claude"], accounts: async () => [ID()], summary: () => backend.summary() });
    expect(report).toHaveLength(1);
    const row = report[0]!;
    expect(row).toMatchObject({ provider: "claude", identity: "acct-a", renewedBy: "gateway", lastRefreshReplica: "pod-2", lastError: null, revoked: false });
    expect(row.expiresAt).toBe(new Date((NOW + 8 * 3600) * 1000).toISOString());
    // 8 h default lifetime, renewed at half of it.
    expect(row.nextRefreshAt).toBe(new Date((NOW + 4 * 3600) * 1000).toISOString());

    // A dead answer for the stored login's refresh token, newer than the last success, shows as revoked with its code.
    const lock2 = await backend.acquire({ provider: "claude", identity: "acct-a" }, 1000);
    const dead = await lock2.claim(grantFingerprint({ access_token: "x", refresh_token: "rt-live-1" }), "pod-3:1");
    await lock2.resolve(dead, "dead", undefined, "invalid_grant");
    await lock2.release();
    const after = (await buildRenewalReport({ tools: ["claude"], accounts: async () => [ID()], summary: () => backend.summary() }))[0]!;
    expect(after.revoked).toBe(true);
    expect(after.nextRefreshAt).toBeNull();
    expect(after.lastError).toMatchObject({ code: "invalid_grant" });
    expect(JSON.stringify(after)).not.toContain("rt-live-1");
  });

  test("GET /logins/renewal needs the admin token and returns the report", async () => {
    const ADMIN = "adm-test-value-0002-0123456789abcdef";
    const logins = [{ provider: "claude", identity: "acct-a", renewedBy: "gateway", lastRefreshAt: null, lastRefreshReplica: null, lastError: null, expiresAt: null, nextRefreshAt: null, revoked: false }];
    const app = createAdminApp({ store: new MemoryGatewayStore(), adminToken: ADMIN, now: () => new Date(), renewal: async () => logins as never });
    expect((await app.request("/logins/renewal")).status).toBe(401);
    const ok = await app.request("/logins/renewal", { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ logins });
  });
});
