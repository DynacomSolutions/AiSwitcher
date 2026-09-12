import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANTHROPIC_TOKEN_URL,
  DEFAULT_EXPIRY_WINDOW_HOURS,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_TOKEN_URL,
  OAuthRefreshError,
  grantFromTokenResponse,
  postRefreshTokenGrant,
  refreshIdentityOAuthGrant,
  shouldAttemptOAuthRefresh,
} from "../../src/identities/oauth-refresh.ts";
import { grantFingerprint } from "../../src/identities/oauth-reconcile.ts";
import { CLAUDE_CONFIG, CODEX_CONFIG, GROK_CONFIG, KIMI_CONFIG, PI_CONFIG } from "../../src/identities/tool-configs.ts";
import type { Identity, ToolConfig } from "../../src/identities/types.ts";

// The refreshers resolve every registry by same-named identity, so the
// tests build real temp registries and repoint each tool's
// identitiesJsonPath for the duration of every test. The real ~/.claude,
// ~/.codex, ~/.grok, ~/.kimi-code and ~/.pi registries are never touched;
// afterEach restores the original paths. All fixture token values are
// short synthetic strings (<12 chars) and any JWT is built at runtime —
// no credential-shaped literal ever appears in this file.
const tempDirs: string[] = [];
const savedPaths: Record<string, string> = {};

let dirs: Record<"claude" | "codex" | "grok" | "kimi" | "pi", string> = {} as never;

const ACME = "acme";

const CLAUDE_FILE = () => join(dirs.claude, ".credentials.json");
const CODEX_FILE = () => join(dirs.codex, "auth.json");
const GROK_FILE = () => join(dirs.grok, "auth.json");
const KIMI_FILE = () => join(dirs.kimi, "credentials", "kimi-code.json");
const PI_AUTH = () => join(dirs.pi, "auth.json");

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "ais-oauth-refresh-"));
  tempDirs.push(root);
  dirs = {
    claude: join(root, "claude-identities", ACME),
    codex: join(root, "codex-identities", ACME),
    grok: join(root, "grok-identities", ACME),
    kimi: join(root, "kimi-identities", ACME),
    pi: join(root, "pi-identities", ACME),
  };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  for (const [tool, path] of [
    ["claude", CLAUDE_CONFIG],
    ["codex", CODEX_CONFIG],
    ["grok", GROK_CONFIG],
    ["kimi", KIMI_CONFIG],
    ["pi", PI_CONFIG],
  ] as const) {
    savedPaths[tool] = path.identitiesJsonPath;
    (path as { identitiesJsonPath: string }).identitiesJsonPath = join(root, `${tool}-identities.json`);
    await writeFile(
      path.identitiesJsonPath,
      JSON.stringify({ version: 1, identities: [{ name: ACME, label: "Acme", configDir: dirs[tool] }] }),
    );
  }
});

afterEach(async () => {
  for (const [tool, path] of [
    ["claude", CLAUDE_CONFIG],
    ["codex", CODEX_CONFIG],
    ["grok", GROK_CONFIG],
    ["kimi", KIMI_CONFIG],
    ["pi", PI_CONFIG],
  ] as const) {
    if (savedPaths[tool]) (path as { identitiesJsonPath: string }).identitiesJsonPath = savedPaths[tool];
  }
  const roots = tempDirs.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** A runtime-built JWT-looking token (never a literal in this file): the
 * codex/xai readers decode iat/exp claims from it. */
function fakeJwt(claims: { iat?: number; exp?: number }): string {
  const enc = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(claims)}.syn`;
}

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

const NOW = 1_789_200_000; // fixed epoch seconds; fixtures pin times around it

function identityIn(dir: string): Identity {
  return { name: ACME, label: "Acme", configDir: dir };
}

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

/** A fetch stub that answers OIDC discovery then a token exchange, and
 * records every call for request-shape assertions. */
function stubFetch(responseBodies: unknown[], statusCodes: number[] = []): {
  calls: RecordedRequest[];
  fetchImpl: typeof fetch;
} {
  const calls: RecordedRequest[] = [];
  let index = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const status = statusCodes[index] ?? 200;
    const body = responseBodies[Math.min(index, responseBodies.length - 1)];
    index += 1;
    return new Response(body === undefined ? "{}" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function tokenResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    access_token: fakeJwt({ iat: NOW, exp: NOW + 3600 }),
    expires_in: 3600,
    ...overrides,
  };
}

/* ----------------------------- pure pieces ----------------------------- */

describe("grantFromTokenResponse", () => {
  test("mints now, honours expires_in, and adopts a rotated refresh token", () => {
    const grant = grantFromTokenResponse(
      { access_token: "old", refresh_token: "rt-old-1" },
      { access_token: fakeJwt({ exp: NOW + 60 }), refresh_token: "rt-new-1", expires_in: 1800 },
      NOW,
    );
    expect(grant.access_token).toContain("syn");
    expect(grant.refresh_token).toBe("rt-new-1");
    expect(grant.expires_at).toBe(NOW + 1800);
    expect(grant.minted_at).toBe(NOW);
  });

  test("keeps the previous refresh token when the provider did not rotate", () => {
    const grant = grantFromTokenResponse(
      { access_token: "old", refresh_token: "rt-keep-1" },
      { access_token: fakeJwt({ exp: NOW + 60 }) },
      NOW,
    );
    expect(grant.refresh_token).toBe("rt-keep-1");
    // No expires_in: the access token's JWT exp is the fallback.
    expect(grant.expires_at).toBe(NOW + 60);
  });

  test("rejects a response without an access token", () => {
    expect(() => grantFromTokenResponse({ access_token: "old" }, {}, NOW)).toThrow(OAuthRefreshError);
  });
});

describe("shouldAttemptOAuthRefresh (scheduler cadence)", () => {
  test("refreshes when the access token is inside the expiry window", () => {
    const decision = shouldAttemptOAuthRefresh(
      { access_token: "x", expires_at: NOW + 3600 },
      { expiryWindowHours: 24, lastSuccessAt: new Date((NOW - 60) * 1000).toISOString(), nowSeconds: NOW },
    );
    expect(decision.attempt).toBe(true);
    expect(decision.reason).toContain("expires in 1.0h");
  });

  test("refreshes an already-expired token regardless of recency", () => {
    const decision = shouldAttemptOAuthRefresh(
      { access_token: "x", expires_at: NOW - 7200 },
      { expiryWindowHours: 24, lastSuccessAt: new Date((NOW - 60) * 1000).toISOString(), nowSeconds: NOW },
    );
    expect(decision.attempt).toBe(true);
    expect(decision.reason).toContain("expired 2.0h ago");
  });

  test("skips a fresh token refreshed recently", () => {
    const decision = shouldAttemptOAuthRefresh(
      { access_token: "x", expires_at: NOW + 10 * 86_400 },
      { expiryWindowHours: 24, lastSuccessAt: new Date((NOW - 3 * 3600) * 1000).toISOString(), nowSeconds: NOW },
    );
    expect(decision.attempt).toBe(false);
  });

  test("the daily keep-alive floor refreshes a fresh token last refreshed over 24h ago", () => {
    const decision = shouldAttemptOAuthRefresh(
      { access_token: "x", expires_at: NOW + 10 * 86_400 },
      { expiryWindowHours: 24, lastSuccessAt: new Date((NOW - 30 * 3600) * 1000).toISOString(), nowSeconds: NOW },
    );
    expect(decision.attempt).toBe(true);
    expect(decision.reason).toContain("daily keep-alive");
  });

  test("a token with no known expiry is refreshed by the daily floor alone", () => {
    expect(
      shouldAttemptOAuthRefresh({ access_token: "x" }, { lastSuccessAt: null, nowSeconds: NOW }).attempt,
    ).toBe(true);
  });

  test("force overrides every skip", () => {
    const decision = shouldAttemptOAuthRefresh(
      { access_token: "x", expires_at: NOW + 10 * 86_400 },
      { force: true, lastSuccessAt: new Date((NOW - 60) * 1000).toISOString(), nowSeconds: NOW },
    );
    expect(decision.attempt).toBe(true);
    expect(decision.reason).toContain("manual");
  });

  test("default window is 24 hours", () => {
    expect(DEFAULT_EXPIRY_WINDOW_HOURS).toBe(24);
  });
});

describe("postRefreshTokenGrant", () => {
  test("sends the RFC 6749 refresh grant as a form POST", async () => {
    const { calls, fetchImpl } = stubFetch([tokenResponse()]);
    const response = await postRefreshTokenGrant(OPENAI_CODEX_TOKEN_URL, { client_id: OPENAI_CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: "rt-syn-1" }, { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(OPENAI_CODEX_TOKEN_URL);
    expect(calls[0]!.init.method).toBe("POST");
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-syn-1");
    expect(body.get("client_id")).toBe(OPENAI_CODEX_CLIENT_ID);
    expect(response.access_token).toBeDefined();
  });

  test("a 400 invalid_grant is classified revoked", async () => {
    const { fetchImpl } = stubFetch([{ error: "invalid_grant" }], [400]);
    try {
      await postRefreshTokenGrant(OPENAI_CODEX_TOKEN_URL, { refresh_token: "rt-dead-1" }, { fetchImpl });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthRefreshError);
      expect((err as OAuthRefreshError).revoked).toBe(true);
    }
  });

  test("a 5xx is transient, not revoked", async () => {
    const { fetchImpl } = stubFetch([{ error: "server_error" }], [503]);
    try {
      await postRefreshTokenGrant(OPENAI_CODEX_TOKEN_URL, { refresh_token: "rt-syn-1" }, { fetchImpl });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as OAuthRefreshError).revoked).toBe(false);
    }
  });
});

/* --------------------------- provider refreshes ------------------------ */

describe("refreshIdentityOAuthGrant: openai-codex", () => {
  test("exchanges at the codex token endpoint and writes both stores in each store's shape", async () => {
    await json(CODEX_FILE(), {
      OPENAI_API_KEY: null,
      tokens: { access_token: fakeJwt({ iat: NOW - 7200, exp: NOW - 3600 }), refresh_token: "rt-old-1" },
      last_refresh: new Date((NOW - 7200) * 1000).toISOString(),
    });
    await json(PI_AUTH(), {
      "openai-codex": { type: "oauth", access: fakeJwt({ iat: NOW - 7200, exp: NOW - 3600 }), refresh: "rt-old-1", expires: (NOW - 3600) * 1000 },
    });

    const { calls, fetchImpl } = stubFetch([tokenResponse({ refresh_token: "rt-new-1" })]);
    const result = await refreshIdentityOAuthGrant("codex", identityIn(dirs.codex), { force: true, fetchImpl, now: () => NOW * 1000 });

    expect(result.outcome).toBe("refreshed");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(OPENAI_CODEX_TOKEN_URL);
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get("client_id")).toBe(OPENAI_CODEX_CLIENT_ID);
    expect(body.get("refresh_token")).toBe("rt-old-1");

    // Native store, codex's own shape: tokens updated, last_refresh truthful.
    const native = await readJson<{ tokens: { access_token: string; refresh_token: string }; last_refresh: string }>(CODEX_FILE());
    expect(native.tokens.refresh_token).toBe("rt-new-1");
    expect(native.tokens.access_token).not.toContain("rt-");
    expect(new Date(native.last_refresh).getTime() / 1000).toBe(NOW);

    // pi's projected copy, pi's own shape (expires in ms).
    const pi = await readJson<Record<string, { access: string; refresh: string; expires: number }>>(PI_AUTH());
    expect(pi["openai-codex"]!.refresh).toBe("rt-new-1");
    expect(pi["openai-codex"]!.expires).toBe((NOW + 3600) * 1000);

    // The refreshed grant is a different credential from the one that went in.
    expect(result.beforeFingerprint).toBeDefined();
    expect(result.afterFingerprint).not.toBe(result.beforeFingerprint);
    expect(result.expiresAt).toBe(NOW + 3600);
    expect(result.written).toHaveLength(2);

    // Credentials files stay 0600.
    expect((await stat(CODEX_FILE())).mode & 0o777).toBe(0o600);
    expect((await stat(PI_AUTH())).mode & 0o777).toBe(0o600);
  });

  test("a pi-side fresher copy is the one refreshed (and lands back in the native store too)", async () => {
    // Native copy is 10 days staler than pi's.
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: NOW - 10 * 86_400, exp: NOW - 9 * 86_400 }), refresh_token: "rt-old-1" },
      last_refresh: new Date((NOW - 10 * 86_400) * 1000).toISOString(),
    });
    await json(PI_AUTH(), {
      "openai-codex": { type: "oauth", access: fakeJwt({ iat: NOW - 60, exp: NOW + 3000 }), refresh: "rt-pi-1", expires: (NOW + 3000) * 1000 },
    });

    const { calls, fetchImpl } = stubFetch([tokenResponse({ refresh_token: "rt-new-1" })]);
    const result = await refreshIdentityOAuthGrant("codex", identityIn(dirs.codex), { force: true, fetchImpl, now: () => NOW * 1000 });

    expect(result.outcome).toBe("refreshed");
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get("refresh_token")).toBe("rt-pi-1");
    const native = await readJson<{ tokens: { refresh_token: string } }>(CODEX_FILE());
    expect(native.tokens.refresh_token).toBe("rt-new-1");
  });

  test("a revoked grant throws the re-login error pinned to the grant's fingerprint", async () => {
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: NOW - 7200, exp: NOW - 3600 }), refresh_token: "rt-dead-1" },
    });
    const { fetchImpl } = stubFetch([{ error: "invalid_grant" }], [400]);
    try {
      await refreshIdentityOAuthGrant("codex", identityIn(dirs.codex), { force: true, fetchImpl, now: () => NOW * 1000 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthRefreshError);
      expect((err as OAuthRefreshError).revoked).toBe(true);
      expect((err as OAuthRefreshError).message).toContain("re-login required");
      expect((err as OAuthRefreshError).refreshFingerprint).toBe(grantFingerprint({ access_token: "x", refresh_token: "rt-dead-1" }));
    }
  });

  test("an identity without a refreshable grant is an honest no-grant skip", async () => {
    await json(CODEX_FILE(), { OPENAI_API_KEY: "sk-synthetic" });
    const result = await refreshIdentityOAuthGrant("codex", identityIn(dirs.codex), { force: true, fetchImpl: stubFetch([]).fetchImpl });
    expect(result.outcome).toBe("no-grant");
    expect(result.detail).toContain("no refreshable OAuth grant");
  });
});

describe("refreshIdentityOAuthGrant: anthropic", () => {
  test("exchanges at the platform token endpoint and preserves unknown credential keys", async () => {
    await json(CLAUDE_FILE(), {
      claudeAiOauth: {
        accessToken: "at-syn-cla",
        refreshToken: "rt-old-1",
        expiresAt: (NOW - 3600) * 1000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    });
    await json(PI_AUTH(), {
      anthropic: { type: "oauth", access: "at-syn-cla", refresh: "rt-old-1", expires: (NOW - 3600) * 1000 },
    });

    const { calls, fetchImpl } = stubFetch([tokenResponse({ refresh_token: "rt-new-1" })]);
    const result = await refreshIdentityOAuthGrant("claude", identityIn(dirs.claude), { force: true, fetchImpl, now: () => NOW * 1000 });

    expect(result.outcome).toBe("refreshed");
    expect(calls[0]!.url).toBe(ANTHROPIC_TOKEN_URL);
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get("grant_type")).toBe("refresh_token");

    const native = await readJson<{ claudeAiOauth: Record<string, unknown> }>(CLAUDE_FILE());
    expect(native.claudeAiOauth.refreshToken).toBe("rt-new-1");
    expect(native.claudeAiOauth.scopes).toEqual(["user:inference"]);
    expect(native.claudeAiOauth.subscriptionType).toBe("max");
    expect(native.claudeAiOauth.expiresAt).toBe((NOW + 3600) * 1000);

    const pi = await readJson<Record<string, { refresh: string }>>(PI_AUTH());
    expect(pi.anthropic!.refresh).toBe("rt-new-1");
  });
});

describe("refreshIdentityOAuthGrant: xai (grok)", () => {
  test("discovers the token endpoint from the account entry and rewrites the right entry, siblings untouched", async () => {
    const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
    await json(GROK_FILE(), {
      "https://auth.x.ai::acc-syn-1": {
        key: fakeJwt({ iat: NOW - 7200, exp: NOW - 3600 }),
        auth_mode: "oauth2",
        refresh_token: "rt-old-1",
        expires_at: iso(NOW - 3600),
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "syn-client-1",
        email: "acme@example.invalid",
      },
      "https://auth.x.ai::acc-syn-2": {
        key: fakeJwt({ iat: NOW - 60, exp: NOW + 3000 }),
        auth_mode: "oauth2",
        refresh_token: "rt-sib-1",
        expires_at: iso(NOW + 3000),
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "syn-client-1",
      },
    });
    // pi holds a copy of account 1 (same refresh token): its fingerprint is
    // how the multi-account store picks the RIGHT entry to refresh.
    await json(PI_AUTH(), {
      xai: { type: "oauth", access: fakeJwt({ iat: NOW - 7200, exp: NOW - 3600 }), refresh: "rt-old-1", expires: (NOW - 3600) * 1000 },
    });

    const { calls, fetchImpl } = stubFetch([
      { token_endpoint: "https://auth.x.ai/oauth2/token" },
      tokenResponse({ refresh_token: "rt-new-1" }),
    ]);
    const result = await refreshIdentityOAuthGrant("grok", identityIn(dirs.grok), { force: true, fetchImpl, now: () => NOW * 1000 });

    expect(result.outcome).toBe("refreshed");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://auth.x.ai/.well-known/openid-configuration");
    expect(calls[1]!.url).toBe("https://auth.x.ai/oauth2/token");
    const body = new URLSearchParams(String(calls[1]!.init.body));
    expect(body.get("client_id")).toBe("syn-client-1");
    expect(body.get("refresh_token")).toBe("rt-old-1");

    const store = await readJson<Record<string, { refresh_token?: string; key?: string; expires_at?: string }>>(GROK_FILE());
    // The matching entry was rewritten; the healthy sibling is untouched.
    expect(store["https://auth.x.ai::acc-syn-1"]!.refresh_token).toBe("rt-new-1");
    expect(store["https://auth.x.ai::acc-syn-1"]!.expires_at).toBe(iso(NOW + 3600));
    expect(store["https://auth.x.ai::acc-syn-2"]!.refresh_token).toBe("rt-sib-1");
    // The rotated grant landed in pi's projected copy too.
    const pi = await readJson<Record<string, { refresh: string }>>(PI_AUTH());
    expect(pi.xai!.refresh).toBe("rt-new-1");
  });

  test("an OAuth entry without OIDC metadata throws the honest cannot-refresh error", async () => {
    await json(GROK_FILE(), {
      "https://auth.x.ai::acc-syn-1": {
        key: fakeJwt({ iat: NOW - 7200, exp: NOW - 3600 }),
        auth_mode: "oauth2",
        refresh_token: "rt-old-1",
      },
    });
    try {
      await refreshIdentityOAuthGrant("grok", identityIn(dirs.grok), { force: true, fetchImpl: stubFetch([]).fetchImpl });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthRefreshError);
      expect((err as OAuthRefreshError).message).toContain("oidc_issuer");
      expect((err as OAuthRefreshError).revoked).toBe(false);
    }
  });
});

describe("refreshIdentityOAuthGrant: kimi (existing machinery)", () => {
  test("reuses the kimi token endpoint and the kimi-store write-through", async () => {
    await mkdir(join(dirs.kimi, "credentials"), { recursive: true });
    await json(KIMI_FILE(), { access_token: "at-syn-kim", refresh_token: "rt-old-1", expires_at: NOW - 3600 });
    await json(PI_AUTH(), {
      "kimi-coding": { type: "oauth", access: "at-syn-kim", refresh: "rt-old-1", expires: (NOW - 3600) * 1000 },
    });

    const { calls, fetchImpl } = stubFetch([
      { access_token: "at-syn-new", refresh_token: "rt-new-1", expires_in: 3600 },
    ]);
    const result = await refreshIdentityOAuthGrant("kimi", identityIn(dirs.kimi), { force: true, fetchImpl, now: () => NOW * 1000 });

    expect(result.outcome).toBe("refreshed");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://auth.kimi.com/api/oauth/token");
    const body = new URLSearchParams(String(calls[0]!.init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-old-1");

    const native = await readJson<{ access_token: string; refresh_token: string; expires_at: number }>(KIMI_FILE());
    expect(native.refresh_token).toBe("rt-new-1");
    expect(native.access_token).toBe("at-syn-new");
    // kimi's own machinery stamps expires_at from the real clock.
    expect(Math.abs(native.expires_at - 3600 - Date.now() / 1000)).toBeLessThan(30);
    const pi = await readJson<Record<string, { refresh: string }>>(PI_AUTH());
    expect(pi["kimi-coding"]!.refresh).toBe("rt-new-1");
  });
});

describe("revoked grants are skipped, never retried", () => {
  test("a matching revokedFingerprint short-circuits before any endpoint call", async () => {
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: NOW - 7200, exp: NOW - 3600 }), refresh_token: "rt-dead-1" },
    });
    const { calls, fetchImpl } = stubFetch([tokenResponse()]);
    const fingerprint = grantFingerprint({ access_token: "x", refresh_token: "rt-dead-1" });
    const result = await refreshIdentityOAuthGrant("codex", identityIn(dirs.codex), {
      force: true,
      fetchImpl,
      revokedFingerprint: fingerprint,
    });
    expect(result.outcome).toBe("skipped-revoked");
    expect(result.detail).toContain("re-login required");
    expect(calls).toHaveLength(0);
  });

  test("a re-login (different refresh token) resumes refreshing", async () => {
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: NOW - 7200, exp: NOW - 3600 }), refresh_token: "rt-relog-1" },
    });
    const { calls, fetchImpl } = stubFetch([tokenResponse({ refresh_token: "rt-new-1" })]);
    const result = await refreshIdentityOAuthGrant("codex", identityIn(dirs.codex), {
      force: true,
      fetchImpl,
      revokedFingerprint: grantFingerprint({ access_token: "x", refresh_token: "rt-dead-1" }),
    });
    expect(result.outcome).toBe("refreshed");
    expect(calls).toHaveLength(1);
  });
});

describe("cadence inside refreshIdentityOAuthGrant", () => {
  test("a fresh token with a recent refresh is skipped", async () => {
    await json(CODEX_FILE(), {
      tokens: { access_token: fakeJwt({ iat: NOW - 60, exp: NOW + 10 * 86_400 }), refresh_token: "rt-fresh-1" },
      last_refresh: new Date((NOW - 60) * 1000).toISOString(),
    });
    const { calls, fetchImpl } = stubFetch([tokenResponse()]);
    const result = await refreshIdentityOAuthGrant("codex", identityIn(dirs.codex), {
      expiryWindowHours: 24,
      lastSuccessAt: new Date((NOW - 3600) * 1000).toISOString(),
      fetchImpl,
      now: () => NOW * 1000,
    });
    expect(result.outcome).toBe("skipped-fresh");
    expect(calls).toHaveLength(0);
  });
});

describe("write failures are reported, never thrown", () => {
  test("a pi-only xai copy without a native entry cannot refresh and says why", async () => {
    // No native grok store: the xai path needs the native entry for its
    // OIDC metadata, so the refresh throws the honest cannot-refresh error.
    await json(PI_AUTH(), {
      xai: { type: "oauth", access: fakeJwt({ iat: NOW - 7200, exp: NOW - 3600 }), refresh: "rt-old-1", expires: (NOW - 3600) * 1000 },
    });
    try {
      await refreshIdentityOAuthGrant("grok", identityIn(dirs.grok), { force: true, fetchImpl: stubFetch([]).fetchImpl });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthRefreshError);
      expect((err as OAuthRefreshError).message).toContain("oidc_issuer");
    }
  });
});

/** Config-shaped guard: the refreshable tool set stays in sync with the
 * registries these tests repoint. */
describe("registry wiring", () => {
  test("every refreshable tool's config resolves through TOOL_CONFIGS-shaped registries", async () => {
    for (const config of [CLAUDE_CONFIG, CODEX_CONFIG, GROK_CONFIG, KIMI_CONFIG, PI_CONFIG] as ToolConfig[]) {
      const file = JSON.parse(await readFile(config.identitiesJsonPath, "utf8")) as { identities: Identity[] };
      expect(file.identities.map((identity) => identity.name)).toContain(ACME);
    }
  });
});
